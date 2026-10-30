-- =====================================================================================
-- 040  Purchase orders: one window = one PO, receive and record inward for the whole PO
--
--   • Everything added in one "New Order" window is ONE purchase order with many lines.
--       create_purchase_order_full(supplier, notes, items)        one transaction, one PO number
--   • PO numbers come from a sequence (PO-0001, PO-0002 …). The old "count + 1" could hand out
--     a number twice after an order was deleted.
--   • Receive many lines of one PO in one go (only the lines that arrived are filled in):
--       receive_po_items(order, lines)                            all lines saved, or none
--   • Record Inward for a PO (or chosen lines):
--       record_po_inward(order, item_ids)
--     Every received delivery of every SKU is posted as ITS OWN movement — its own TXN number,
--     with the PO number as the reference — so one SKU can be reversed on its own.
--   • Reversing such a movement puts that delivery back to "received, waiting to be recorded"
--     on the PO (before this, the PO kept saying "Recorded").
--
-- Safe to run more than once.  Run after 039.
-- =====================================================================================

-- ── PO numbers ──────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_max  int;
  v_next int;
BEGIN
  SELECT COALESCE(MAX(substring(order_no FROM '^PO-(\d+)$')::int), 0) INTO v_max FROM purchase_orders;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'purchase_order_no_seq') THEN
    EXECUTE format('CREATE SEQUENCE purchase_order_no_seq START %s', v_max + 1);
  ELSE
    SELECT GREATEST(v_max + 1, CASE WHEN is_called THEN last_value + 1 ELSE last_value END)
      INTO v_next FROM purchase_order_no_seq;
    PERFORM setval('purchase_order_no_seq', v_next, false);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION next_purchase_order_no() RETURNS text
LANGUAGE sql AS $$ SELECT 'PO-' || lpad(nextval('purchase_order_no_seq')::text, 4, '0') $$;

-- ── create ONE purchase order with all its lines ────────────────────────────────────
CREATE OR REPLACE FUNCTION create_purchase_order_full(
  p_supplier text, p_notes text, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  app_users;
  v_order purchase_orders;
  v_item  jsonb;
  v_sku   skus;
  v_qty   numeric;
  v_pcs   int;
  v_len   numeric;
  v_n     int := 0;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role cannot create purchase orders.';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one product.';
  END IF;

  INSERT INTO purchase_orders (order_no, supplier_name, notes, status, created_by)
  VALUES (next_purchase_order_no(), NULLIF(btrim(p_supplier), ''), NULLIF(btrim(p_notes), ''), 'PLACED', v_user.id)
  RETURNING * INTO v_order;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_sku FROM skus WHERE id = (v_item->>'sku_id')::uuid;
    IF v_sku.id IS NULL THEN RAISE EXCEPTION 'A product on this order no longer exists.'; END IF;

    v_pcs := NULLIF(v_item->>'pieces', '')::int;
    v_len := NULLIF(v_item->>'length_mm', '')::numeric;
    IF v_pcs IS NOT NULL AND v_pcs > 0 AND v_len IS NOT NULL AND v_len > 0 THEN
      v_qty := v_pcs * v_len;
    ELSE
      v_pcs := NULL; v_len := NULL;
      v_qty := NULLIF(v_item->>'qty', '')::numeric;
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Enter a quantity for %.', v_sku.sku_code;
    END IF;

    INSERT INTO purchase_order_items
      (order_id, sku_id, ordered_qty, ordered_pieces, ordered_length_mm, ordered_is_cut, received_qty, status)
    VALUES
      (v_order.id, v_sku.id, v_qty, v_pcs, v_len, COALESCE((v_item->>'cut')::boolean, false), 0, 'PENDING');
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no, 'lines', v_n);
END $$;
REVOKE ALL ON FUNCTION create_purchase_order_full(text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_purchase_order_full(text, text, jsonb) TO authenticated;

-- ── receive several lines of one PO at once ─────────────────────────────────────────
-- lines: [{"item_id":…, "rolls":[{"rolls":PCS,"roll_length":MM,"cut":bool}], "qty":n, "complete":bool, "notes":"…"}]
CREATE OR REPLACE FUNCTION receive_po_items(p_order_id uuid, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_line  jsonb;
  v_item  purchase_order_items;
  v_n     int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role cannot receive purchase orders.';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Enter what was received on at least one line.';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO v_item FROM purchase_order_items WHERE id = (v_line->>'item_id')::uuid;
    IF v_item.id IS NULL OR v_item.order_id <> p_order_id THEN
      RAISE EXCEPTION 'A line does not belong to this purchase order.';
    END IF;
    PERFORM receive_po_item(
      v_item.id,
      NULLIF(v_line->>'qty', '')::numeric,
      CASE WHEN jsonb_typeof(v_line->'rolls') = 'array' AND jsonb_array_length(v_line->'rolls') > 0
           THEN v_line->'rolls' END,
      NULLIF(v_line->>'notes', ''),
      COALESCE((v_line->>'complete')::boolean, false)
    );
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('order_id', p_order_id, 'lines_received', v_n);
END $$;
REVOKE ALL ON FUNCTION receive_po_items(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_po_items(uuid, jsonb) TO authenticated;

-- ── record_po_item_inward: same as 038, but also reports the TXN numbers it created ──
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
  v_txns   jsonb := '[]'::jsonb;
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
    IF is_lot_type(v_sku.product_type) THEN
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
    v_txns  := v_txns || jsonb_build_object('txn_no', v_mov->>'txn_no', 'sku_code', v_sku.sku_code, 'qty', v_rec.qty_received);
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Nothing waiting to be recorded for this line.'; END IF;
  UPDATE purchase_order_items SET inwarded_qty = inwarded_qty + v_total WHERE id = p_item_id;
  RETURN jsonb_build_object('item_id', p_item_id, 'posted', v_total, 'receipts', v_count, 'transactions', v_txns);
END $$;

-- ── record inward for a whole PO (or chosen lines): all or nothing, one movement per delivery ──
CREATE OR REPLACE FUNCTION record_po_inward(p_order_id uuid, p_item_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item  record;
  v_res   jsonb;
  v_lines int := 0;
  v_txns  jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role cannot record inward.';
  END IF;

  FOR v_item IN
    SELECT i.id FROM purchase_order_items i
     WHERE i.order_id = p_order_id
       AND (p_item_ids IS NULL OR i.id = ANY (p_item_ids))
       AND EXISTS (SELECT 1 FROM purchase_order_receipts r WHERE r.order_item_id = i.id AND r.inwarded_at IS NULL)
     ORDER BY i.created_at, i.id
  LOOP
    v_res   := record_po_item_inward(v_item.id);
    v_lines := v_lines + 1;
    v_txns  := v_txns || (v_res->'transactions');
  END LOOP;

  IF v_lines = 0 THEN RAISE EXCEPTION 'Nothing received is waiting to be recorded.'; END IF;
  RETURN jsonb_build_object('order_id', p_order_id, 'lines', v_lines, 'transactions', v_txns);
END $$;
REVOKE ALL ON FUNCTION record_po_inward(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_po_inward(uuid, uuid[]) TO authenticated;

-- ── reversing a PO inward re-opens that delivery on the PO ──────────────────────────
CREATE OR REPLACE FUNCTION trg_po_receipt_reopen_on_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  WITH u AS (
    UPDATE purchase_order_receipts
       SET inwarded_at = NULL, inwarded_movement_id = NULL
     WHERE inwarded_movement_id = NEW.reversal_of
    RETURNING order_item_id, qty_received
  )
  UPDATE purchase_order_items i
     SET inwarded_qty = GREATEST(0, i.inwarded_qty - s.q)
    FROM (SELECT order_item_id, sum(qty_received) AS q FROM u GROUP BY order_item_id) s
   WHERE i.id = s.order_item_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS po_receipt_reopen_on_reversal ON inventory_movements;
CREATE TRIGGER po_receipt_reopen_on_reversal
  AFTER INSERT ON inventory_movements
  FOR EACH ROW
  WHEN (NEW.txn_mode = 'REVERSAL' AND NEW.reversal_of IS NOT NULL)
  EXECUTE FUNCTION trg_po_receipt_reopen_on_reversal();

SELECT 'ok' AS status;
