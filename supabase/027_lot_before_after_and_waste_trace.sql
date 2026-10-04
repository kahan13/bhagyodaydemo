-- =====================================================================================
-- 027  Lot-wise before/after on every movement + proper "Marked as waste" trace
--
--   * inventory_movements.lot_state = {"before":[...], "after":[...]} where each entry is
--       {"status":"CUT_PCS"|"FULL_SLEEVE","each":<qty of one piece/roll>,"count":<how many>}
--     e.g. before: 1 x 260 cut piece + 4 x 460 full sleeves, after: 1 x 15 cut piece + 3 x 460.
--     Taken for every movement on a roll-tracked SKU from now on (older movements stay blank).
--   * Marking a lot as waste now posts its movement FIRST (so "before" is right) and stores which
--     lot / status / quantity was written off in lot_breakdown, notes start with "Marked as waste".
--   * Reversing a waste entry puts the quantity back into THAT lot, with its old status.
--   * v_movements exposes lot_state.
-- Safe to re-run. Run after 020-026.
-- =====================================================================================

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS lot_state jsonb;

-- 1) snapshot of a SKU's live lots, grouped
CREATE OR REPLACE FUNCTION lot_snapshot(p_sku_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('status', status, 'each', current_qty, 'count', cnt)
                            ORDER BY (status = 'FULL_SLEEVE'), current_qty), '[]'::jsonb)
    FROM (SELECT status, current_qty, count(*) AS cnt
            FROM sku_lots
           WHERE sku_id = p_sku_id AND status IN ('FULL_SLEEVE','CUT_PCS') AND current_qty > 0
           GROUP BY status, current_qty) x;
$$;
GRANT EXECUTE ON FUNCTION lot_snapshot(uuid) TO authenticated;

-- 2) "before" is taken the moment the movement is written (before any lot is touched).
--    Trigger name starts with aa_ so it fires ahead of the other lot triggers.
CREATE OR REPLACE FUNCTION trg_mov_state_before()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM skus WHERE id = NEW.sku_id AND roll_length_mm IS NOT NULL AND roll_length_mm > 0) THEN
    v := lot_snapshot(NEW.sku_id);
    UPDATE inventory_movements SET lot_state = jsonb_build_object('before', v, 'after', v) WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aa_movement_state_before ON inventory_movements;
CREATE TRIGGER aa_movement_state_before AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_mov_state_before();

-- 3) "after" is refreshed every time the movement's lot trace is written (always the last step)
CREATE OR REPLACE FUNCTION trg_mov_state_after()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.lot_state IS NULL THEN RETURN NEW; END IF;
  UPDATE inventory_movements
     SET lot_state = jsonb_set(NEW.lot_state, '{after}', lot_snapshot(NEW.sku_id))
   WHERE id = NEW.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zz_movement_state_after ON inventory_movements;
CREATE TRIGGER zz_movement_state_after AFTER UPDATE OF lot_breakdown ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_mov_state_after();

-- 4) Mark as waste: movement first, then the lot; remember exactly which lot it was
CREATE OR REPLACE FUNCTION mark_lot_wasted(p_lot_id uuid, p_reason text DEFAULT 'Marked as waste')
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lot      sku_lots;
  v_sku      skus;
  v_uid      uuid;
  v_writeoff numeric;
  v_res      jsonb;
  v_mov      uuid;
BEGIN
  SELECT * INTO v_lot FROM sku_lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lot % not found.', p_lot_id; END IF;
  IF v_lot.status IN ('WASTED','EXHAUSTED') THEN
    RAISE EXCEPTION 'Lot % is already % — cannot waste.', v_lot.lot_no, v_lot.status;
  END IF;

  v_writeoff := v_lot.current_qty;
  SELECT * INTO v_sku FROM skus WHERE id = v_lot.sku_id;
  SELECT id INTO v_uid FROM current_app_user();

  IF v_writeoff > 0 THEN
    v_res := record_movement(
      v_sku.sku_code, 'ADJUSTMENT', -v_writeoff, v_sku.unit_code, NULL,
      'Marked as waste · Lot ' || v_lot.lot_no || ' wasted: ' || p_reason,
      'WEB', NULL, NULL);
    SELECT id INTO v_mov FROM inventory_movements WHERE txn_no = (v_res->>'txn_no');
  END IF;

  UPDATE sku_lots
     SET status = 'WASTED', current_qty = 0, wasted_at = now(), wasted_by = v_uid, waste_reason = p_reason
   WHERE id = p_lot_id;

  IF v_mov IS NOT NULL THEN
    UPDATE inventory_movements
       SET lot_breakdown = jsonb_build_array(jsonb_build_object(
             'lot_no', v_lot.lot_no, 'status', 'WASTED', 'was', v_lot.status,
             'qty', v_writeoff, 'roll_length', v_lot.roll_length_mm))
     WHERE id = v_mov;
  END IF;
  RETURN v_writeoff;
END $$;
GRANT EXECUTE ON FUNCTION mark_lot_wasted(uuid, text) TO authenticated;

-- 5) Reversing a waste entry puts the quantity back into the same lot
CREATE OR REPLACE FUNCTION trg_reverse_waste_lot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_orig  inventory_movements;
  v_lotno text;
  v_lot   sku_lots;
  v_qty   numeric;
  v_st    text;
BEGIN
  IF NEW.txn_mode <> 'REVERSAL' OR NEW.txn_type <> 'ADJUSTMENT' OR NEW.reversal_of IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_orig FROM inventory_movements WHERE id = NEW.reversal_of;
  v_lotno := COALESCE(v_orig.lot_breakdown->0->>'lot_no', substring(v_orig.notes from 'Lot (\S+) wasted:'));
  IF v_lotno IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_lot FROM sku_lots WHERE lot_no = v_lotno AND sku_id = NEW.sku_id AND status = 'WASTED';
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_qty := LEAST(NEW.quantity, v_lot.inward_qty);
  v_st  := derive_lot_status(v_qty, v_lot.inward_qty);
  UPDATE sku_lots
     SET current_qty = v_qty, status = v_st, wasted_at = NULL, wasted_by = NULL, waste_reason = NULL
   WHERE id = v_lot.id;
  UPDATE inventory_movements
     SET lot_breakdown = jsonb_build_array(jsonb_build_object(
           'lot_no', v_lotno, 'status', v_st, 'qty', v_qty, 'restored', true))
   WHERE id = NEW.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS movement_reverse_waste ON inventory_movements;
CREATE TRIGGER movement_reverse_waste AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_reverse_waste_lot();

-- 6) view
CREATE OR REPLACE VIEW v_movements WITH (security_invoker = on) AS
SELECT
  m.id, m.txn_no, m.occurred_at, m.txn_type, m.txn_mode, m.quantity, m.unit_code,
  m.previous_stock, m.new_stock, m.reference, m.invoice_no, m.notes, m.channel,
  m.user_id, m.user_name, m.reversal_of, m.reversed_by, m.is_reversed,
  m.operated_by_user_id,
  op.full_name AS operated_by_name,
  s.sku_code, s.display_name, s.product_type, s.exact_size,
  b.name AS brand_name, f.code AS family_code,
  m.lot_breakdown,
  (s.roll_length_mm IS NOT NULL AND s.roll_length_mm > 0) AS lot_tracked,
  m.lot_state
FROM inventory_movements m
JOIN skus s  ON s.id = m.sku_id
JOIN brands b ON b.id = s.brand_id
JOIN product_families f ON f.id = s.family_id
LEFT JOIN app_users op ON op.id = m.operated_by_user_id;

SELECT 'ok' AS status;
