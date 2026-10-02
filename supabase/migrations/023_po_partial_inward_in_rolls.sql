-- =====================================================================================
-- 023 – Purchase orders: partial receive + partial "Record Inward", in ROLLS (timing belts)
--
-- BEFORE: "Record Inward" only appeared once the WHOLE order was received, and it posted a
--         plain quantity (no rolls).
-- NOW:    * Receive records each delivery as a receipt: timing belts as rolls
--           (e.g. 4 x 50 mm, plus an optional one-off row like 1 x 45 mm); V-belt / conveyor
--           as a plain PCS quantity.
--         * "Record Inward" posts every receipt not yet posted, at any time — so 4 of 8 rolls
--           can go into stock (book + physical) while the other 4 are still on the way.
--         * Timing-belt inward creates one Full Sleeve lot PER ROLL, via record_inward_with_lots.
--         * Receive and Record Inward stay two separate steps.
--
-- Legacy: PO items received before this migration get ONE receipt marked as already
--         inwarded (so nothing can be posted twice). If you never posted inward for an old
--         PO, post it manually from Inventory.
--
-- Safe to re-run.
-- =====================================================================================

ALTER TABLE purchase_order_receipts
  ADD COLUMN IF NOT EXISTS rolls                jsonb,        -- [{"rolls":4,"roll_length":50}, ...] (timing belts)
  ADD COLUMN IF NOT EXISTS inwarded_at          timestamptz,
  ADD COLUMN IF NOT EXISTS inwarded_movement_id uuid REFERENCES inventory_movements(id);

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS inwarded_qty numeric(14,2) NOT NULL DEFAULT 0;

-- Legacy backfill: one already-inwarded receipt for items that were received before this
INSERT INTO purchase_order_receipts (order_item_id, qty_received, received_at, notes, inwarded_at)
SELECT i.id, i.received_qty, i.created_at, 'Received before partial inward existed', now()
  FROM purchase_order_items i
 WHERE i.received_qty > 0
   AND NOT EXISTS (SELECT 1 FROM purchase_order_receipts r WHERE r.order_item_id = i.id);

UPDATE purchase_order_items i
   SET inwarded_qty = COALESCE((SELECT sum(qty_received) FROM purchase_order_receipts r
                                 WHERE r.order_item_id = i.id AND r.inwarded_at IS NOT NULL), 0);

-- ── Receive: one delivery against one PO line ──
CREATE OR REPLACE FUNCTION receive_po_item(
  p_item_id uuid,
  p_qty     numeric DEFAULT NULL,      -- plain quantity (V-belt / conveyor)
  p_rolls   jsonb   DEFAULT NULL,      -- timing belt: [{"rolls":N,"roll_length":L}, ...]
  p_notes   text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item   purchase_order_items;
  v_sku    skus;
  v_qty    numeric := 0;
  v_grp    jsonb;
  v_new    numeric;
  v_status text;
  v_order  text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  SELECT * INTO v_item FROM purchase_order_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Purchase order item not found.'; END IF;
  SELECT * INTO v_sku FROM skus WHERE id = v_item.sku_id;

  IF p_rolls IS NOT NULL AND jsonb_typeof(p_rolls) = 'array' AND jsonb_array_length(p_rolls) > 0 THEN
    FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rolls) LOOP
      IF COALESCE((v_grp->>'rolls')::int, 0) < 1 OR COALESCE((v_grp->>'roll_length')::numeric, 0) <= 0 THEN
        RAISE EXCEPTION 'Each roll row needs a roll count of 1 or more and a length above zero.';
      END IF;
      v_qty := v_qty + (v_grp->>'rolls')::int * (v_grp->>'roll_length')::numeric;
    END LOOP;
  ELSE
    v_qty := p_qty;
    -- roll-tracked SKU received as a plain number: split into standard rolls
    IF v_sku.roll_length_mm > 0 AND v_qty >= v_sku.roll_length_mm AND mod(v_qty, v_sku.roll_length_mm) = 0 THEN
      p_rolls := jsonb_build_array(jsonb_build_object('rolls', (v_qty / v_sku.roll_length_mm)::int, 'roll_length', v_sku.roll_length_mm));
    END IF;
  END IF;

  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter what was received.'; END IF;
  IF v_item.received_qty + v_qty > v_item.ordered_qty THEN
    RAISE EXCEPTION 'Only % is still to receive on this line (asked for %).', v_item.ordered_qty - v_item.received_qty, v_qty;
  END IF;

  INSERT INTO purchase_order_receipts (order_item_id, qty_received, rolls, received_by, notes)
  VALUES (p_item_id, v_qty, p_rolls, auth.uid(), p_notes);

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

-- ── Record Inward: post every receipt of this line that is not in stock yet ──
CREATE OR REPLACE FUNCTION record_po_item_inward(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item  purchase_order_items;
  v_sku   skus;
  v_po    text;
  v_rec   record;
  v_mov   jsonb;
  v_mov_id uuid;
  v_total numeric := 0;
  v_count int := 0;
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
    IF v_sku.roll_length_mm > 0 THEN
      -- timing belt: one Full Sleeve lot per roll (movement + lots + book + physical)
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

SELECT (SELECT count(*) FROM purchase_order_receipts) AS receipts,
       (SELECT count(*) FROM purchase_order_receipts WHERE inwarded_at IS NULL) AS waiting_to_inward;
