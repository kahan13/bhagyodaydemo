-- =====================================================================================
-- 029  Roll length is no longer fixed on the product - every entry is  QTY x MM
--
--   * A timing belt is lot-tracked because of its PRODUCT TYPE, not because it has a roll length.
--     skus.roll_length_mm stays in the table but nothing depends on it any more.
--   * Every lot carries its own length (sku_lots.roll_length_mm / inward_qty) - typed at entry time.
--   * Inward / PO receipt rows are  {rolls: QTY, roll_length: MM, cut: true|false}
--       cut = false (default)  -> QTY Full Sleeve lots of MM each
--       cut = true             -> QTY Cut Pcs lots of MM each
--   * PO lines remember what was ordered:  ordered_pieces x ordered_length_mm (+ cut flag).
--     ordered_qty stays the total in mm, so received / left logic is unchanged.
--   * Stock-count "+" adjustments and reconciliation create ONE cut piece of the added length.
--
-- Safe to re-run. Run after 028.
-- =====================================================================================

-- 0) helper: which products are tracked in lots
CREATE OR REPLACE FUNCTION is_lot_tracked(p_sku_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM skus WHERE id = p_sku_id AND product_type = 'TIMING_BELT');
$$;
GRANT EXECUTE ON FUNCTION is_lot_tracked(uuid) TO authenticated;

-- 1) lots that were received / created as cut pieces stay Cut Pcs even while whole
ALTER TABLE sku_lots ADD COLUMN IF NOT EXISTS is_cut boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION trg_lot_keep_cut()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_cut AND NEW.status = 'FULL_SLEEVE' THEN NEW.status := 'CUT_PCS'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lot_keep_cut ON sku_lots;
CREATE TRIGGER lot_keep_cut BEFORE INSERT OR UPDATE ON sku_lots
  FOR EACH ROW EXECUTE FUNCTION trg_lot_keep_cut();

-- 2) create_inward_lot: new optional flag for cut pieces
DROP FUNCTION IF EXISTS create_inward_lot(uuid, uuid, numeric, int, text);
CREATE OR REPLACE FUNCTION create_inward_lot(
  p_movement_id   uuid,
  p_sku_id        uuid,
  p_qty_per_roll  numeric,
  p_num_rolls     int     DEFAULT 1,
  p_notes         text    DEFAULT NULL,
  p_is_cut        boolean DEFAULT false
)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lot_id  uuid;
  v_lot_ids uuid[] := '{}';
  i         int;
BEGIN
  FOR i IN 1..p_num_rolls LOOP
    INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, is_cut, inward_movement_id, notes)
    VALUES (generate_lot_no(), p_sku_id, p_qty_per_roll, p_qty_per_roll, p_qty_per_roll,
            CASE WHEN COALESCE(p_is_cut, false) THEN 'CUT_PCS' ELSE 'FULL_SLEEVE' END,
            COALESCE(p_is_cut, false), p_movement_id, p_notes)
    RETURNING id INTO v_lot_id;
    v_lot_ids := v_lot_ids || v_lot_id;
  END LOOP;
  RETURN v_lot_ids;
END $$;
GRANT EXECUTE ON FUNCTION create_inward_lot(uuid, uuid, numeric, int, text, boolean) TO authenticated;

-- 3) opening lots (import): length comes from the sheet row, never from the product
CREATE OR REPLACE FUNCTION create_opening_lot(
  p_sku_id        uuid,
  p_qty           numeric,
  p_status        text    DEFAULT 'FULL_SLEEVE',
  p_roll_length   numeric DEFAULT NULL,
  p_notes         text    DEFAULT 'Opening balance'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_len    numeric := COALESCE(p_roll_length, p_qty);
  v_lot_id uuid;
BEGIN
  INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, is_cut, inward_movement_id, notes)
  VALUES (generate_lot_no(), p_sku_id, v_len,
          CASE p_status WHEN 'CUT_PCS' THEN GREATEST(v_len, p_qty) ELSE p_qty END,
          p_qty, p_status, (p_status = 'CUT_PCS'), NULL, p_notes)
  RETURNING id INTO v_lot_id;
  RETURN v_lot_id;
END $$;
GRANT EXECUTE ON FUNCTION create_opening_lot(uuid, numeric, text, numeric, text) TO authenticated;

-- 4) lots follow every movement (no fixed roll length any more)
CREATE OR REPLACE FUNCTION trg_movement_sync_lots()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku   skus;
  v_delta numeric;
  v_no    text;
  v_brk   jsonb;
BEGIN
  IF COALESCE(current_setting('app.lot_managed', true), '') = '1' THEN RETURN NEW; END IF;
  IF NEW.txn_mode <> 'NORMAL' AND NEW.txn_type <> 'ADJUSTMENT' THEN RETURN NEW; END IF;

  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF v_sku.product_type <> 'TIMING_BELT' THEN RETURN NEW; END IF;      -- not lot-tracked

  IF NEW.txn_type = 'INWARD' THEN
    -- no breakdown was given: one lot of the whole quantity
    PERFORM create_inward_lot(NEW.id, v_sku.id, NEW.quantity, 1, NEW.notes);

  ELSIF NEW.txn_type = 'OUTWARD' THEN
    PERFORM auto_drain_lots(v_sku.id, NEW.quantity, NEW.id);

  ELSIF NEW.txn_type = 'ADJUSTMENT' THEN
    IF NEW.txn_mode = 'REVERSAL' THEN
      SELECT lot_breakdown INTO v_brk FROM inventory_movements WHERE id = NEW.id;
      IF v_brk IS NOT NULL AND v_brk->0->>'restored' = 'true' THEN RETURN NEW; END IF;
    END IF;

    v_delta := NEW.new_stock - NEW.previous_stock;
    IF v_delta > 0 THEN
      v_no := generate_lot_no();
      INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, is_cut, notes)
      VALUES (v_no, v_sku.id, v_delta, v_delta, v_delta, 'CUT_PCS', true, 'Stock count adjustment');
      UPDATE inventory_movements
         SET lot_breakdown = jsonb_build_array(jsonb_build_object('lot_no', v_no, 'status', 'CUT_PCS', 'qty', v_delta, 'new_lot', true))
       WHERE id = NEW.id;
    ELSIF v_delta < 0 THEN
      PERFORM auto_drain_lots(v_sku.id, -v_delta, NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS movement_sync_lots ON inventory_movements;
CREATE TRIGGER movement_sync_lots AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_movement_sync_lots();

-- 5) Inward with QTY x MM rows:  p_rolls = [{"rolls":3,"roll_length":470,"cut":false}, ...]
CREATE OR REPLACE FUNCTION record_inward_with_lots(
  p_sku_code    text,
  p_quantity    numeric,
  p_rolls       jsonb   DEFAULT NULL,
  p_reference   text    DEFAULT NULL,
  p_notes       text    DEFAULT NULL,
  p_channel     text    DEFAULT 'WEB',
  p_invoice_no  text    DEFAULT NULL,
  p_operated_by uuid    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku      skus;
  v_groups   jsonb;
  v_grp      jsonb;
  v_rolls    int;
  v_len      numeric;
  v_total    numeric := 0;
  v_movement jsonb;
  v_mov_id   uuid;
  v_lot_ids  uuid[] := '{}';
  v_new_ids  uuid[];
BEGIN
  PERFORM set_config('app.lot_managed','1',true);
  SELECT * INTO v_sku FROM skus WHERE sku_code = p_sku_code;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'Unknown product.'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero.';
  END IF;

  IF p_rolls IS NOT NULL AND jsonb_typeof(p_rolls) = 'array' AND jsonb_array_length(p_rolls) > 0 THEN
    v_groups := p_rolls;
  ELSE
    v_groups := jsonb_build_array(jsonb_build_object('rolls', 1, 'roll_length', p_quantity, 'cut', false));
  END IF;

  FOR v_grp IN SELECT * FROM jsonb_array_elements(v_groups) LOOP
    v_rolls := (v_grp->>'rolls')::int;
    v_len   := (v_grp->>'roll_length')::numeric;
    IF v_rolls IS NULL OR v_rolls < 1 OR v_len IS NULL OR v_len <= 0 THEN
      RAISE EXCEPTION 'Each row needs a QTY of 1 or more and an MM above zero.';
    END IF;
    v_total := v_total + v_rolls * v_len;
  END LOOP;

  IF v_total <> p_quantity THEN
    RAISE EXCEPTION 'QTY x MM adds up to % but the quantity is %.', v_total, p_quantity;
  END IF;

  v_movement := record_movement(
    v_sku.sku_code, 'INWARD', p_quantity, v_sku.unit_code,
    p_reference, p_notes, COALESCE(p_channel, 'WEB'), p_invoice_no, p_operated_by
  );
  SELECT id INTO v_mov_id FROM inventory_movements WHERE txn_no = (v_movement->>'txn_no');

  FOR v_grp IN SELECT * FROM jsonb_array_elements(v_groups) LOOP
    v_new_ids := create_inward_lot(
      v_mov_id, v_sku.id,
      (v_grp->>'roll_length')::numeric,
      (v_grp->>'rolls')::int,
      p_notes,
      COALESCE((v_grp->>'cut')::boolean, false)
    );
    v_lot_ids := v_lot_ids || v_new_ids;
  END LOOP;

  IF array_length(v_lot_ids, 1) = 1 THEN
    UPDATE inventory_movements SET lot_id = v_lot_ids[1] WHERE id = v_mov_id;
  END IF;

  RETURN v_movement || jsonb_build_object(
    'lot_ids',  to_jsonb(v_lot_ids),
    'lot_nos',  (SELECT COALESCE(jsonb_agg(lot_no ORDER BY created_at, lot_no), '[]'::jsonb)
                   FROM sku_lots WHERE id = ANY(v_lot_ids)),
    'lots_summary', v_groups
  );
END $$;
GRANT EXECUTE ON FUNCTION record_inward_with_lots(text,numeric,jsonb,text,text,text,text,uuid) TO authenticated;

-- 6) Purchase orders remember what was ordered: QTY x MM (+ cut pieces flag)
ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS ordered_pieces    int,
  ADD COLUMN IF NOT EXISTS ordered_length_mm numeric,
  ADD COLUMN IF NOT EXISTS ordered_is_cut    boolean NOT NULL DEFAULT false;

-- receive: rows are QTY x MM (+cut). No guessing from a product roll length.
CREATE OR REPLACE FUNCTION receive_po_item(
  p_item_id uuid,
  p_qty     numeric DEFAULT NULL,
  p_rolls   jsonb   DEFAULT NULL,
  p_notes   text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item   purchase_order_items;
  v_qty    numeric := 0;
  v_grp    jsonb;
  v_new    numeric;
  v_status text;
  v_order  text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  SELECT * INTO v_item FROM purchase_order_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Purchase order item not found.'; END IF;

  IF p_rolls IS NOT NULL AND jsonb_typeof(p_rolls) = 'array' AND jsonb_array_length(p_rolls) > 0 THEN
    FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rolls) LOOP
      IF COALESCE((v_grp->>'rolls')::int, 0) < 1 OR COALESCE((v_grp->>'roll_length')::numeric, 0) <= 0 THEN
        RAISE EXCEPTION 'Each row needs a QTY of 1 or more and an MM above zero.';
      END IF;
      v_qty := v_qty + (v_grp->>'rolls')::int * (v_grp->>'roll_length')::numeric;
    END LOOP;
  ELSE
    v_qty := p_qty;
    p_rolls := NULL;
  END IF;

  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter what was received.'; END IF;
  IF v_item.received_qty + v_qty > v_item.ordered_qty THEN
    RAISE EXCEPTION 'Only % is still to receive on this line (asked for %).', v_item.ordered_qty - v_item.received_qty, v_qty;
  END IF;

  INSERT INTO purchase_order_receipts (order_item_id, qty_received, rolls, received_by, notes)
  VALUES (p_item_id, v_qty, p_rolls, (SELECT id FROM current_app_user()), p_notes);

  v_new := v_item.received_qty + v_qty;
  v_status := CASE WHEN v_new >= v_item.ordered_qty THEN 'FULFILLED' ELSE 'PARTIAL' END;
  UPDATE purchase_order_items SET received_qty = v_new, status = v_status, notes = COALESCE(p_notes, notes)
   WHERE id = p_item_id;

  SELECT CASE
           WHEN bool_and(status = 'FULFILLED') THEN 'FULFILLED'
           WHEN bool_or(status IN ('PARTIAL','FULFILLED')) THEN 'PARTIAL'
           ELSE 'PLACED' END
    INTO v_order FROM purchase_order_items WHERE order_id = v_item.order_id;
  UPDATE purchase_orders SET status = v_order, updated_at = now() WHERE id = v_item.order_id;

  RETURN jsonb_build_object('item_id', p_item_id, 'received', v_qty, 'item_status', v_status);
END $$;
REVOKE ALL ON FUNCTION receive_po_item(uuid, numeric, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_po_item(uuid, numeric, jsonb, text) TO authenticated;

-- record inward of PO receipts: timing belts become lots by product type
CREATE OR REPLACE FUNCTION record_po_item_inward(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item   purchase_order_items;
  v_sku    skus;
  v_po     text;
  v_rec    record;
  v_mov    jsonb;
  v_mov_id uuid;
  v_total  numeric := 0;
  v_count  int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  SELECT * INTO v_item FROM purchase_order_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Purchase order item not found.'; END IF;
  SELECT * INTO v_sku FROM skus WHERE id = v_item.sku_id;
  SELECT order_no INTO v_po FROM purchase_orders WHERE id = v_item.order_id;

  FOR v_rec IN
    SELECT * FROM purchase_order_receipts
     WHERE order_item_id = p_item_id AND inwarded_at IS NULL
     ORDER BY received_at
  LOOP
    IF v_sku.product_type = 'TIMING_BELT' THEN
      v_mov := record_inward_with_lots(
        v_sku.sku_code, v_rec.qty_received, v_rec.rolls, v_po,
        'Received against ' || v_po || COALESCE(' — ' || v_rec.notes, ''), 'WEB', NULL, NULL);
    ELSE
      v_mov := record_movement(
        v_sku.sku_code, 'INWARD', v_rec.qty_received, v_sku.unit_code, v_po,
        'Received against ' || v_po || COALESCE(' — ' || v_rec.notes, ''), 'WEB', NULL, NULL);
    END IF;

    SELECT id INTO v_mov_id FROM inventory_movements WHERE txn_no = (v_mov->>'txn_no');
    UPDATE purchase_order_receipts SET inwarded_at = now(), inwarded_movement_id = v_mov_id WHERE id = v_rec.id;
    v_total := v_total + v_rec.qty_received;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Nothing waiting to be recorded for this line.'; END IF;
  UPDATE purchase_order_items SET inwarded_qty = inwarded_qty + v_total WHERE id = p_item_id;
  RETURN jsonb_build_object('item_id', p_item_id, 'posted', v_total, 'receipts', v_count);
END $$;
REVOKE ALL ON FUNCTION record_po_item_inward(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_po_item_inward(uuid) TO authenticated;

-- 7) lot snapshot "before" (Transactions page) now keys off product type
CREATE OR REPLACE FUNCTION trg_mov_state_before()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF is_lot_tracked(NEW.sku_id) THEN
    v := lot_snapshot(NEW.sku_id);
    UPDATE inventory_movements SET lot_state = jsonb_build_object('before', v, 'after', v) WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aa_movement_state_before ON inventory_movements;
CREATE TRIGGER aa_movement_state_before AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_mov_state_before();

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
  (s.product_type = 'TIMING_BELT') AS lot_tracked,
  m.lot_state
FROM inventory_movements m
JOIN skus s  ON s.id = m.sku_id
JOIN brands b ON b.id = s.brand_id
JOIN product_families f ON f.id = s.family_id
LEFT JOIN app_users op ON op.id = m.operated_by_user_id;

-- 8) reversal of an inward / outward
CREATE OR REPLACE FUNCTION trg_reverse_outward_lots()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_orig   inventory_movements;
  v_e      jsonb;
  v_lot    sku_lots;
  v_qty    numeric;
  v_left   numeric;
  v_out    jsonb := '[]'::jsonb;
BEGIN
  IF NEW.txn_mode <> 'REVERSAL' OR NEW.reversal_of IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_orig FROM inventory_movements WHERE id = NEW.reversal_of;
  IF NOT is_lot_tracked(NEW.sku_id) THEN RETURN NEW; END IF;

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

  -- anything that could not go back to its own lot: one cut piece of that length
  IF v_left > 0 THEN
    INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, is_cut, notes)
    VALUES (generate_lot_no(), NEW.sku_id, v_left, v_left, v_left, 'CUT_PCS', true, 'Restored from reversal of ' || v_orig.txn_no)
    RETURNING * INTO v_lot;
    v_out := v_out || jsonb_build_object('lot_no', v_lot.lot_no, 'status', v_lot.status, 'qty', v_left, 'new_lot', true);
  END IF;

  UPDATE inventory_movements SET lot_breakdown = v_out WHERE id = NEW.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS movement_reverse_outward_lots ON inventory_movements;
CREATE TRIGGER movement_reverse_outward_lots AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_reverse_outward_lots();

-- 9) production outward: no-plan fallback keys off product type
CREATE OR REPLACE FUNCTION record_production_outward_with_lots(
  p_poi_id  uuid,
  p_notes   text    DEFAULT NULL,
  p_channel text    DEFAULT 'WEB',
  p_invoice_no  text DEFAULT NULL,
  p_operated_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result   jsonb;
  v_row      record;
  v_new_qty  numeric;
  v_drained  jsonb := '[]'::jsonb;
  v_break    jsonb := '[]'::jsonb;
  v_poi      production_order_items;
  v_mov_id   uuid;
  v_planned  boolean;
BEGIN
  PERFORM set_config('app.lot_managed','1',true);

  SELECT * INTO v_poi FROM production_order_items WHERE id = p_poi_id;
  SELECT EXISTS (SELECT 1 FROM lot_allocations WHERE item_id = p_poi_id) INTO v_planned;

  v_result := record_production_outward(p_poi_id, p_notes, p_channel);
  v_mov_id := NULLIF(v_result->>'movement_id','')::uuid;

  IF v_mov_id IS NOT NULL AND (NULLIF(btrim(p_invoice_no),'') IS NOT NULL OR p_operated_by IS NOT NULL) THEN
    UPDATE inventory_movements
       SET invoice_no = NULLIF(btrim(p_invoice_no),''),
           operated_by_user_id = p_operated_by
     WHERE id = v_mov_id;
  END IF;

  IF v_planned THEN
    FOR v_row IN
      SELECT la.lot_id, la.allocated_qty, sl.lot_no, sl.status
        FROM lot_allocations la
        JOIN sku_lots        sl ON sl.id = la.lot_id
       WHERE la.item_id = p_poi_id
    LOOP
      v_new_qty := drain_lot(v_row.lot_id, v_row.allocated_qty);
      v_drained := v_drained || jsonb_build_object(
        'lot_id', v_row.lot_id, 'lot_no', v_row.lot_no,
        'drained_qty', v_row.allocated_qty, 'remaining_qty', v_new_qty);
      v_break := v_break || jsonb_build_object('lot_no', v_row.lot_no, 'status', v_row.status, 'qty', v_row.allocated_qty);
    END LOOP;
    IF v_mov_id IS NOT NULL THEN
      UPDATE inventory_movements SET lot_breakdown = v_break WHERE id = v_mov_id;
    END IF;
  ELSIF v_poi.sku_id IS NOT NULL AND is_lot_tracked(v_poi.sku_id) THEN
    v_break := auto_drain_lots(v_poi.sku_id, v_poi.quantity, v_mov_id);
  END IF;

  RETURN v_result || jsonb_build_object('lots_drained', v_drained, 'lot_breakdown', v_break);
END $$;
GRANT EXECUTE ON FUNCTION record_production_outward_with_lots(uuid, text, text, text, uuid) TO authenticated;

-- 10) repair + hard check now cover every timing belt
CREATE OR REPLACE FUNCTION repair_lot_drift()
RETURNS TABLE (sku_code text, book numeric, lots_before numeric, action text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r      record;
  v_diff numeric;
BEGIN
  FOR r IN
    SELECT s.id, s.sku_code AS code, s.current_stock AS bk,
           COALESCE((SELECT sum(l.current_qty) FROM sku_lots l
                      WHERE l.sku_id = s.id AND l.status IN ('FULL_SLEEVE','CUT_PCS')), 0) AS lots
      FROM skus s
     WHERE s.product_type = 'TIMING_BELT'
  LOOP
    v_diff := r.bk - r.lots;
    CONTINUE WHEN v_diff = 0;
    IF v_diff > 0 THEN
      INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, inward_qty, current_qty, status, is_cut, notes)
      VALUES (generate_lot_no(), r.id, v_diff, v_diff, v_diff, 'CUT_PCS', true, 'Reconciled to book stock');
      sku_code := r.code; book := r.bk; lots_before := r.lots; action := 'added ' || v_diff || ' to lots';
    ELSE
      PERFORM auto_drain_lots(r.id, -v_diff, NULL);
      sku_code := r.code; book := r.bk; lots_before := r.lots; action := 'drained ' || (-v_diff) || ' from lots';
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION repair_lot_drift() FROM PUBLIC, anon;

SELECT * FROM repair_lot_drift();   -- shows what was reconciled (existing timing belts that had stock but no lots)

CREATE OR REPLACE FUNCTION trg_check_lots_match_book()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku  skus;
  v_lots numeric;
BEGIN
  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF v_sku.product_type <> 'TIMING_BELT' THEN RETURN NULL; END IF;
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
 WHERE s.product_type = 'TIMING_BELT'
   AND s.current_stock <> COALESCE((SELECT sum(l.current_qty) FROM sku_lots l WHERE l.sku_id = s.id AND l.status IN ('FULL_SLEEVE','CUT_PCS')),0)
 LIMIT 20;
