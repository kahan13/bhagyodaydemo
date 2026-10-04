-- =====================================================================================
-- 028  Lots and book stock can never drift apart again
--
-- WHY IT HAPPENED
--   * Reversing a "marked as waste" entry gave the quantity back to BOOK stock but the lot stayed
--     WASTED (fixed for new reversals in 027, but old ones left a gap).
--   * A stock-count "Adjust" (and its reversal) changed BOOK stock without touching any lot.
--
-- WHAT THIS DOES
--   1. Adjust (+ / -) and reversal of an Adjust now move lots too: a plus creates a cut piece
--      (or full sleeves if it is whole rolls), a minus drains cut pieces first.
--   2. Mark-as-waste tells the lot trigger that it manages the lot itself (no double drain).
--   3. repair_lot_drift(): one-time repair, run at the bottom. For every roll-tracked product whose
--      lots differ from book stock:  book higher -> add Full Sleeve / Cut Pcs lot(s) for the gap
--      ("Reconciled to book stock");  lots higher -> drain the extra, cut pieces first.
--   4. A hard check at the end of every transaction: if a movement would leave a roll-tracked
--      product with lots <> book stock, the whole thing is rolled back with a clear message.
-- Safe to re-run. Run after 027.
-- =====================================================================================

-- 1) lot trigger now also covers ADJUSTMENT movements (count corrections and their reversals)
CREATE OR REPLACE FUNCTION trg_movement_sync_lots()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku   skus;
  v_delta numeric;
  v_n     int;
  v_rem   numeric;
  v_no    text;
  v_st    text;
  v_inw   numeric;
  v_brk   jsonb;
BEGIN
  IF COALESCE(current_setting('app.lot_managed', true), '') = '1' THEN RETURN NEW; END IF;  -- caller manages lots itself
  IF NEW.txn_mode <> 'NORMAL' AND NEW.txn_type <> 'ADJUSTMENT' THEN RETURN NEW; END IF;     -- inward/outward reversals have their own triggers

  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF v_sku.roll_length_mm IS NULL OR v_sku.roll_length_mm <= 0 THEN RETURN NEW; END IF;      -- not roll-tracked

  IF NEW.txn_type = 'INWARD' THEN
    IF NEW.quantity >= v_sku.roll_length_mm AND mod(NEW.quantity, v_sku.roll_length_mm) = 0 THEN
      PERFORM create_inward_lot(NEW.id, v_sku.id, v_sku.roll_length_mm, (NEW.quantity / v_sku.roll_length_mm)::int, NEW.notes);
    ELSE
      PERFORM create_inward_lot(NEW.id, v_sku.id, NEW.quantity, 1, NEW.notes);
    END IF;

  ELSIF NEW.txn_type = 'OUTWARD' THEN
    PERFORM auto_drain_lots(v_sku.id, NEW.quantity, NEW.id);

  ELSIF NEW.txn_type = 'ADJUSTMENT' THEN
    -- a waste reversal already put its quantity back into its own lot
    IF NEW.txn_mode = 'REVERSAL' THEN
      SELECT lot_breakdown INTO v_brk FROM inventory_movements WHERE id = NEW.id;
      IF v_brk IS NOT NULL AND v_brk->0->>'restored' = 'true' THEN RETURN NEW; END IF;
    END IF;

    v_delta := NEW.new_stock - NEW.previous_stock;
    IF v_delta > 0 THEN
      v_brk := '[]'::jsonb;
      v_n   := floor(v_delta / v_sku.roll_length_mm)::int;
      v_rem := v_delta - v_n * v_sku.roll_length_mm;
      WHILE v_n > 0 LOOP
        v_no := generate_lot_no();
        INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, notes)
        VALUES (v_no, v_sku.id, v_sku.roll_length_mm, v_sku.roll_length_mm, v_sku.roll_length_mm, 'FULL_SLEEVE', 'Stock count adjustment');
        v_brk := v_brk || jsonb_build_object('lot_no', v_no, 'status', 'FULL_SLEEVE', 'qty', v_sku.roll_length_mm, 'new_lot', true);
        v_n := v_n - 1;
      END LOOP;
      IF v_rem > 0 THEN
        v_no := generate_lot_no(); v_inw := v_sku.roll_length_mm; v_st := derive_lot_status(v_rem, v_inw);
        INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, notes)
        VALUES (v_no, v_sku.id, v_sku.roll_length_mm, v_inw, v_rem, v_st, 'Stock count adjustment');
        v_brk := v_brk || jsonb_build_object('lot_no', v_no, 'status', v_st, 'qty', v_rem, 'new_lot', true);
      END IF;
      UPDATE inventory_movements SET lot_breakdown = v_brk WHERE id = NEW.id;
    ELSIF v_delta < 0 THEN
      PERFORM auto_drain_lots(v_sku.id, -v_delta, NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS movement_sync_lots ON inventory_movements;
CREATE TRIGGER movement_sync_lots AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_movement_sync_lots();

-- 2) mark_lot_wasted manages its own lot
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
  PERFORM set_config('app.lot_managed', '1', true);
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

-- 3) one-time repair
CREATE OR REPLACE FUNCTION repair_lot_drift()
RETURNS TABLE (sku_code text, book numeric, lots_before numeric, action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r      record;
  v_diff numeric;
  v_n    int;
  v_rem  numeric;
BEGIN
  FOR r IN
    SELECT s.id, s.sku_code AS code, s.current_stock AS bk, s.roll_length_mm AS roll,
           COALESCE((SELECT sum(l.current_qty) FROM sku_lots l
                      WHERE l.sku_id = s.id AND l.status IN ('FULL_SLEEVE','CUT_PCS')), 0) AS lots
      FROM skus s
     WHERE s.roll_length_mm IS NOT NULL AND s.roll_length_mm > 0
  LOOP
    v_diff := r.bk - r.lots;
    CONTINUE WHEN v_diff = 0;
    IF v_diff > 0 THEN
      v_n   := floor(v_diff / r.roll)::int;
      v_rem := v_diff - v_n * r.roll;
      WHILE v_n > 0 LOOP
        INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, notes)
        VALUES (generate_lot_no(), r.id, r.roll, r.roll, r.roll, 'FULL_SLEEVE', 'Reconciled to book stock');
        v_n := v_n - 1;
      END LOOP;
      IF v_rem > 0 THEN
        INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, notes)
        VALUES (generate_lot_no(), r.id, r.roll, r.roll, v_rem, derive_lot_status(v_rem, r.roll), 'Reconciled to book stock');
      END IF;
      sku_code := r.code; book := r.bk; lots_before := r.lots; action := 'added ' || v_diff || ' to lots';
    ELSE
      PERFORM auto_drain_lots(r.id, -v_diff, NULL);
      sku_code := r.code; book := r.bk; lots_before := r.lots; action := 'drained ' || (-v_diff) || ' from lots';
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION repair_lot_drift() FROM PUBLIC, anon;

SELECT * FROM repair_lot_drift();      -- shows what was repaired (empty = nothing was off)

-- 4) hard check: lots must equal book stock at the end of every transaction
CREATE OR REPLACE FUNCTION trg_check_lots_match_book()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku  skus;
  v_lots numeric;
BEGIN
  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF v_sku.roll_length_mm IS NULL OR v_sku.roll_length_mm <= 0 THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(current_qty), 0) INTO v_lots
    FROM sku_lots WHERE sku_id = NEW.sku_id AND status IN ('FULL_SLEEVE','CUT_PCS');
  IF v_lots <> v_sku.current_stock THEN
    RAISE EXCEPTION 'Not saved: % would end with % in rolls/cut pieces but % in book stock. Nothing was changed.',
      v_sku.sku_code, v_lots, v_sku.current_stock;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS zz_check_lots_match_book ON inventory_movements;
CREATE CONSTRAINT TRIGGER zz_check_lots_match_book AFTER INSERT ON inventory_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_check_lots_match_book();

-- verify: must return no rows
SELECT s.sku_code, s.current_stock AS book,
       COALESCE((SELECT sum(l.current_qty) FROM sku_lots l WHERE l.sku_id = s.id AND l.status IN ('FULL_SLEEVE','CUT_PCS')),0) AS in_lots
  FROM skus s
 WHERE s.roll_length_mm > 0
   AND s.current_stock <> COALESCE((SELECT sum(l.current_qty) FROM sku_lots l WHERE l.sku_id = s.id AND l.status IN ('FULL_SLEEVE','CUT_PCS')),0)
 LIMIT 20;
