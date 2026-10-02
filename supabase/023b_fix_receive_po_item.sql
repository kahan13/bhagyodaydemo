-- Hotfix: received_by must be the app_users id, not the auth id.
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
