-- =====================================================================================
-- 024  Lot trace on every movement + exact-lot reversal
--
--   * Every INWARD records the roll lots it created in inventory_movements.lot_breakdown
--     (outward/production outward already record the lots they used - migration 022).
--   * Reversing an OUTWARD puts the quantity back into the SAME lots it came from
--     (a used-up piece comes back as that piece, a sleeve that became a cut piece
--     becomes a full sleeve again). If a lot can no longer take it (wasted / over
--     capacity) or the old outward has no record, a new lot is created so that
--     stock and lots never drift apart.
--   * Reversing an INWARD already closes its lots (012) - the reversal row now also
--     lists which lots were closed.
--   * v_movements exposes lot_breakdown so the Transactions page can show it.
-- Safe to re-run. Run after 020-023.
-- =====================================================================================

-- 1) inward movements list the lots they created
CREATE OR REPLACE FUNCTION trg_lot_created_trace()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.inward_movement_id IS NOT NULL THEN
    UPDATE inventory_movements
       SET lot_breakdown = COALESCE(lot_breakdown, '[]'::jsonb) ||
             jsonb_build_object('lot_no', NEW.lot_no, 'status', 'FULL_SLEEVE', 'qty', NEW.inward_qty)
     WHERE id = NEW.inward_movement_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sku_lot_created_trace ON sku_lots;
CREATE TRIGGER sku_lot_created_trace AFTER INSERT ON sku_lots
  FOR EACH ROW EXECUTE FUNCTION trg_lot_created_trace();

-- back-fill existing inwards
UPDATE inventory_movements m
   SET lot_breakdown = x.b
  FROM (SELECT l.inward_movement_id AS mid,
               jsonb_agg(jsonb_build_object('lot_no', l.lot_no, 'status', 'FULL_SLEEVE', 'qty', l.inward_qty)
                         ORDER BY l.created_at, l.lot_no) AS b
          FROM sku_lots l WHERE l.inward_movement_id IS NOT NULL GROUP BY l.inward_movement_id) x
 WHERE m.id = x.mid AND m.lot_breakdown IS NULL;

-- 2) reversal of an OUTWARD restores the exact lots
CREATE OR REPLACE FUNCTION trg_reverse_outward_lots()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_orig   inventory_movements;
  v_sku    skus;
  v_e      jsonb;
  v_lot    sku_lots;
  v_qty    numeric;
  v_left   numeric;
  v_out    jsonb := '[]'::jsonb;
  v_inw    numeric;
BEGIN
  IF NEW.txn_mode <> 'REVERSAL' OR NEW.reversal_of IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_orig FROM inventory_movements WHERE id = NEW.reversal_of;
  SELECT * INTO v_sku  FROM skus WHERE id = NEW.sku_id;
  IF v_sku.roll_length_mm IS NULL OR v_sku.roll_length_mm <= 0 THEN RETURN NEW; END IF;

  -- reversal of an inward: lots were closed by trg_reverse_inward_lots; just record which
  IF NEW.txn_type = 'OUTWARD' THEN
    IF v_orig.lot_breakdown IS NOT NULL THEN
      UPDATE inventory_movements
         SET lot_breakdown = (SELECT jsonb_agg(e || jsonb_build_object('status', 'EXHAUSTED'))
                                FROM jsonb_array_elements(v_orig.lot_breakdown) e)
       WHERE id = NEW.id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.txn_type <> 'INWARD' THEN RETURN NEW; END IF;

  v_left := NEW.quantity;
  IF v_orig.lot_breakdown IS NOT NULL AND jsonb_typeof(v_orig.lot_breakdown) = 'array' THEN
    FOR v_e IN SELECT * FROM jsonb_array_elements(v_orig.lot_breakdown) LOOP
      v_qty := (v_e->>'qty')::numeric;
      EXIT WHEN v_left <= 0;
      v_qty := LEAST(v_qty, v_left);
      SELECT * INTO v_lot FROM sku_lots WHERE lot_no = v_e->>'lot_no' AND sku_id = NEW.sku_id;
      IF FOUND AND v_lot.status <> 'WASTED' AND v_lot.current_qty + v_qty <= v_lot.inward_qty THEN
        PERFORM restore_lot(v_lot.id, v_qty);
        v_out := v_out || jsonb_build_object('lot_no', v_lot.lot_no,
                   'status', (SELECT status FROM sku_lots WHERE id = v_lot.id), 'qty', v_qty);
        v_left := v_left - v_qty;
      END IF;
    END LOOP;
  END IF;

  -- anything that could not go back to its own lot (or an old outward with no record)
  IF v_left > 0 THEN
    v_inw := GREATEST(v_left, v_sku.roll_length_mm);
    INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, notes)
    VALUES (generate_lot_no(), NEW.sku_id, v_sku.roll_length_mm, v_inw, v_left,
            derive_lot_status(v_left, v_inw), 'Restored from reversal of ' || v_orig.txn_no)
    RETURNING * INTO v_lot;
    v_out := v_out || jsonb_build_object('lot_no', v_lot.lot_no, 'status', v_lot.status, 'qty', v_left, 'new_lot', true);
  END IF;

  UPDATE inventory_movements SET lot_breakdown = v_out WHERE id = NEW.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS movement_reverse_outward_lots ON inventory_movements;
CREATE TRIGGER movement_reverse_outward_lots AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_reverse_outward_lots();

-- 3) Transactions page reads the trace
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
  (s.roll_length_mm IS NOT NULL AND s.roll_length_mm > 0) AS lot_tracked
FROM inventory_movements m
JOIN skus s  ON s.id = m.sku_id
JOIN brands b ON b.id = s.brand_id
JOIN product_families f ON f.id = s.family_id
LEFT JOIN app_users op ON op.id = m.operated_by_user_id;

SELECT 'ok' AS status;
