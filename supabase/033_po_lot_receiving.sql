-- =====================================================================================
-- 033  Purchase orders: receive lot by lot
--
--   A timing-belt line is ordered as  MM × PCS  (e.g. 500 mm × 2 pcs).  Each piece that
--   arrives closes ONE ordered piece, whatever its real length:
--
--        ordered 2 × 500 mm   →   one roll arrives at 485 mm, "Receive & mark complete"
--        counted:      485 mm in stock
--        shortfall:    the 15 mm simply disappears — it is never shown as outstanding
--        still to come: 1 × 500 mm   (the other lot)
--        later 490 mm arrives the same way → the line is complete
--
--   Other products (V-belt, conveyor) stay quantity-based. A line can also be closed
--   early ("no more coming") — the remainder disappears, nothing stays outstanding.
--
--   New columns on purchase_order_items
--     received_pieces  how many of the ordered pieces have arrived (lot-wise lines)
--     variance_qty     received − ordered, filled when the line closes (information only)
--     closed_at        when the line was completed or closed
--
-- Safe to run more than once.  Run after 032.
-- =====================================================================================

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS received_pieces int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS variance_qty    numeric     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS closed_at       timestamptz;

-- Existing lines: count the pieces that were already received.
UPDATE purchase_order_items i
   SET received_pieces = LEAST(i.ordered_pieces, COALESCE((
         SELECT sum((g->>'rolls')::int)
           FROM purchase_order_receipts r, jsonb_array_elements(r.rolls) g
          WHERE r.order_item_id = i.id AND r.rolls IS NOT NULL), 0))
 WHERE i.ordered_pieces > 0 AND i.received_pieces = 0 AND i.received_qty > 0;

UPDATE purchase_order_items
   SET received_pieces = ordered_pieces,
       closed_at       = COALESCE(closed_at, now()),
       variance_qty    = received_qty - ordered_qty
 WHERE status = 'FULFILLED' AND closed_at IS NULL;

-- ── receive ────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS receive_po_item(uuid, numeric, jsonb, text);

CREATE OR REPLACE FUNCTION receive_po_item(
  p_item_id  uuid,
  p_qty      numeric DEFAULT NULL,     -- plain quantity (V-belt / conveyor)
  p_rolls    jsonb   DEFAULT NULL,     -- timing belt: [{"rolls":PCS,"roll_length":MM,"cut":bool}, ...]
  p_notes    text    DEFAULT NULL,
  p_complete boolean DEFAULT false     -- plain lines: close the line now even if short
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item   purchase_order_items;
  v_qty    numeric := 0;
  v_pcs    int     := 0;
  v_grp    jsonb;
  v_new    numeric;
  v_newp   int;
  v_status text;
  v_order  text;
  v_done   boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role cannot receive purchase orders.';
  END IF;

  SELECT * INTO v_item FROM purchase_order_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Purchase order item not found.'; END IF;
  IF v_item.status = 'FULFILLED' THEN RAISE EXCEPTION 'This line is already complete.'; END IF;

  IF p_rolls IS NOT NULL AND jsonb_typeof(p_rolls) = 'array' AND jsonb_array_length(p_rolls) > 0 THEN
    FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rolls) LOOP
      IF COALESCE((v_grp->>'rolls')::int, 0) < 1 OR COALESCE((v_grp->>'roll_length')::numeric, 0) <= 0 THEN
        RAISE EXCEPTION 'Each row needs a PCS of 1 or more and an MM above zero.';
      END IF;
      v_qty := v_qty + (v_grp->>'rolls')::int * (v_grp->>'roll_length')::numeric;
      v_pcs := v_pcs + (v_grp->>'rolls')::int;
    END LOOP;
  ELSE
    v_qty := p_qty;
    p_rolls := NULL;
    IF v_item.ordered_pieces > 0 THEN
      RAISE EXCEPTION 'This line is ordered as MM × PCS — enter what arrived as MM × PCS.';
    END IF;
  END IF;

  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter what was received.'; END IF;

  IF v_item.ordered_pieces > 0 THEN
    -- Lot-wise: every piece that arrives completes one ordered piece, whatever its length.
    IF v_pcs = 0 THEN
      RAISE EXCEPTION 'Enter what arrived as MM × PCS.';
    END IF;
    IF v_item.received_pieces + v_pcs > v_item.ordered_pieces THEN
      RAISE EXCEPTION 'Only % piece(s) are still to come on this line, but % were entered.',
        v_item.ordered_pieces - v_item.received_pieces, v_pcs;
    END IF;
    v_newp := v_item.received_pieces + v_pcs;
    v_done := v_newp >= v_item.ordered_pieces;
  ELSE
    -- Quantity-based (V-belt, conveyor, old lines)
    IF v_item.received_qty + v_qty > v_item.ordered_qty THEN
      RAISE EXCEPTION 'Only % is still to receive on this line (asked for %).',
        v_item.ordered_qty - v_item.received_qty, v_qty;
    END IF;
    v_newp := v_item.received_pieces;
    v_done := p_complete OR (v_item.received_qty + v_qty >= v_item.ordered_qty);
  END IF;

  INSERT INTO purchase_order_receipts (order_item_id, qty_received, rolls, received_by, notes)
  VALUES (p_item_id, v_qty, p_rolls, (SELECT id FROM current_app_user()), p_notes);

  v_new    := v_item.received_qty + v_qty;
  v_status := CASE WHEN v_done THEN 'FULFILLED' ELSE 'PARTIAL' END;

  UPDATE purchase_order_items
     SET received_qty    = v_new,
         received_pieces = v_newp,
         status          = v_status,
         closed_at       = CASE WHEN v_done THEN now() ELSE closed_at END,
         variance_qty    = CASE WHEN v_done THEN v_new - ordered_qty ELSE variance_qty END,
         notes           = COALESCE(p_notes, notes)
   WHERE id = p_item_id;

  SELECT CASE
           WHEN bool_and(status = 'FULFILLED') THEN 'FULFILLED'
           WHEN bool_or(status IN ('PARTIAL','FULFILLED')) THEN 'PARTIAL'
           ELSE 'PLACED' END
    INTO v_order FROM purchase_order_items WHERE order_id = v_item.order_id;
  UPDATE purchase_orders SET status = v_order, updated_at = now() WHERE id = v_item.order_id;

  RETURN jsonb_build_object('item_id', p_item_id, 'received', v_qty, 'pieces', v_pcs, 'item_status', v_status);
END $$;
REVOKE ALL ON FUNCTION receive_po_item(uuid, numeric, jsonb, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION receive_po_item(uuid, numeric, jsonb, text, boolean) TO authenticated;

-- ── close a line early ("no more coming") ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_po_item(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item  purchase_order_items;
  v_order text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role cannot close purchase order lines.';
  END IF;

  SELECT * INTO v_item FROM purchase_order_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Purchase order item not found.'; END IF;
  IF v_item.status = 'FULFILLED' THEN RETURN jsonb_build_object('item_id', p_item_id, 'item_status', 'FULFILLED'); END IF;
  IF v_item.received_qty <= 0 THEN
    RAISE EXCEPTION 'Nothing has been received on this line yet — delete the order instead.';
  END IF;

  UPDATE purchase_order_items
     SET status = 'FULFILLED', closed_at = now(), variance_qty = received_qty - ordered_qty
   WHERE id = p_item_id;

  SELECT CASE
           WHEN bool_and(status = 'FULFILLED') THEN 'FULFILLED'
           WHEN bool_or(status IN ('PARTIAL','FULFILLED')) THEN 'PARTIAL'
           ELSE 'PLACED' END
    INTO v_order FROM purchase_order_items WHERE order_id = v_item.order_id;
  UPDATE purchase_orders SET status = v_order, updated_at = now() WHERE id = v_item.order_id;

  RETURN jsonb_build_object('item_id', p_item_id, 'item_status', 'FULFILLED');
END $$;
REVOKE ALL ON FUNCTION close_po_item(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION close_po_item(uuid) TO authenticated;

SELECT 'ok' AS status,
       (SELECT count(*) FROM purchase_order_items WHERE status <> 'FULFILLED') AS open_lines;
