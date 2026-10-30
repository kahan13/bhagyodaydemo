-- =====================================================================================
-- 039  Production orders: one line per SKU, split into MM × PCS segments, each from a chosen roll
--
--   A line for a roll-tracked SKU (timing belt, poly V belt) is no longer "one quantity".
--   It is one or more SEGMENTS, each saying:   MM × PCS   taken from THIS roll.
--
--       H-480 PIX                 total 250 mm
--         segment 1:  25 mm × 9 pcs = 225 mm   from LOT-20261018-0187
--         segment 2:  25 mm × 1 pcs =  25 mm   from LOT-20261018-0201   (extension)
--
--   All segments of a line live on ONE production_order_items row, so:
--     • one "Record Outward" posts one movement and drains every chosen roll by its own part
--     • the Mismatch tab shows ONE row for the line, not one per roll
--
--   New columns on lot_allocations:  seg_no, seg_mm, seg_pcs   (allocated_qty = seg_mm × seg_pcs)
--   Older allocations keep these empty and are shown by their quantity only.
--
--   create_production_order_full(jsonb)
--     Creates the order, every line and every roll choice in ONE database transaction.
--     If any roll is no longer free (someone else took it a moment ago) NOTHING is created and
--     the message says which roll is short — no half-made orders.
--     The WhatsApp message may contain the token {{ORDER_NO}}; it is replaced by the real number.
--
-- Safe to run more than once.  Run after 038.
-- =====================================================================================

ALTER TABLE lot_allocations
  ADD COLUMN IF NOT EXISTS seg_no  int,
  ADD COLUMN IF NOT EXISTS seg_mm  numeric,
  ADD COLUMN IF NOT EXISTS seg_pcs int;

CREATE OR REPLACE FUNCTION create_production_order_full(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    app_users;
  v_direct  boolean := COALESCE((p_order->>'is_direct')::boolean, false);
  v_items   jsonb   := p_order->'items';
  v_item    jsonb;
  v_seg     jsonb;
  v_sku     skus;
  v_lot     sku_lots;
  v_order   production_orders;
  v_poi     production_order_items;
  v_no      text;
  v_msg     text;
  v_qty     numeric;
  v_pcs     int;
  v_mm      numeric;
  v_segs    jsonb;
  v_seg_no  int;
  v_desc    text[] := '{}';
  v_free    numeric;
  r         record;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role cannot create production orders.';
  END IF;
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one product.';
  END IF;

  -- ── Pass 1: every roll asked for must still have that much free, summed over the whole order ──
  FOR r IN
    SELECT (sg->>'lot_id')::uuid AS lot_id,
           sum((sg->>'mm')::numeric * (sg->>'pcs')::int) AS need
      FROM jsonb_array_elements(v_items) it
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(it->'segments', '[]'::jsonb)) sg
     GROUP BY 1
  LOOP
    SELECT * INTO v_lot FROM sku_lots WHERE id = r.lot_id FOR UPDATE;
    IF v_lot.id IS NULL THEN RAISE EXCEPTION 'A roll you picked no longer exists. Reload and pick again.'; END IF;
    IF v_lot.status NOT IN ('FULL_SLEEVE','CUT_PCS') OR v_lot.current_qty <= 0 THEN
      RAISE EXCEPTION 'Roll % is no longer in stock (%). Pick another roll.', v_lot.lot_no, v_lot.status;
    END IF;
    SELECT free_qty INTO v_free FROM v_lot_free WHERE id = r.lot_id;
    IF COALESCE(v_free, 0) < r.need THEN
      RAISE EXCEPTION 'Roll % has only % free, but % was asked from it. Pick another roll or reduce the quantity.',
        v_lot.lot_no, COALESCE(v_free, 0), r.need;
    END IF;
  END LOOP;

  -- ── the order ──
  v_no := next_production_order_no();
  v_msg := replace(COALESCE(p_order->>'whatsapp_message', ''), '{{ORDER_NO}}', v_no);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_desc := v_desc || COALESCE(NULLIF(btrim(v_item->>'display_name'), ''), 'Item');
  END LOOP;

  INSERT INTO production_orders (
    order_no, customer_name, product_description, time_tag, delivery_mode, delivery_note,
    assigned_to, notes, whatsapp_number, whatsapp_message, is_direct, status, created_by
  ) VALUES (
    v_no,
    NULLIF(btrim(p_order->>'customer_name'), ''),
    array_to_string(v_desc, ', '),
    NULLIF(p_order->>'time_tag', ''),
    NULLIF(p_order->>'delivery_mode', ''),
    NULLIF(p_order->>'delivery_note', ''),
    NULLIF(btrim(p_order->>'assigned_to'), ''),
    NULLIF(p_order->>'notes', ''),
    NULLIF(p_order->>'whatsapp_number', ''),
    NULLIF(v_msg, ''),
    v_direct,
    'CREATED',
    v_user.id
  ) RETURNING * INTO v_order;

  -- ── the lines ──
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_segs := COALESCE(v_item->'segments', '[]'::jsonb);

    IF v_direct THEN
      v_qty := (v_item->>'quantity')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter a quantity for every product.'; END IF;
      INSERT INTO production_order_items (order_id, sku_id, sku_code, display_name, unit_code, quantity, pieces, length_mm)
      VALUES (v_order.id, NULL, 'DIRECT', btrim(v_item->>'display_name'),
              COALESCE(NULLIF(v_item->>'unit_code', ''), 'PCS'), v_qty,
              NULLIF(v_item->>'pieces', '')::int, NULLIF(v_item->>'length_mm', '')::numeric);
      CONTINUE;
    END IF;

    SELECT * INTO v_sku FROM skus WHERE id = (v_item->>'sku_id')::uuid;
    IF v_sku.id IS NULL THEN RAISE EXCEPTION 'A product on this order no longer exists.'; END IF;

    IF is_lot_type(v_sku.product_type) THEN
      IF jsonb_typeof(v_segs) <> 'array' OR jsonb_array_length(v_segs) = 0 THEN
        RAISE EXCEPTION '% needs at least one % × PCS entry with a roll picked.', v_sku.sku_code, lot_unit_word(v_sku.id);
      END IF;
      v_qty := 0;
      FOR v_seg IN SELECT * FROM jsonb_array_elements(v_segs) LOOP
        v_mm  := (v_seg->>'mm')::numeric;
        v_pcs := (v_seg->>'pcs')::int;
        IF v_mm IS NULL OR v_mm <= 0 OR v_pcs IS NULL OR v_pcs < 1 THEN
          RAISE EXCEPTION 'Each entry on % needs a length above zero and 1 or more pieces.', v_sku.sku_code;
        END IF;
        v_qty := v_qty + v_mm * v_pcs;
      END LOOP;
    ELSE
      IF jsonb_array_length(v_segs) > 0 THEN
        RAISE EXCEPTION '% is not kept in rolls — it has no roll to pick.', v_sku.sku_code;
      END IF;
      v_qty := (v_item->>'quantity')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter a quantity for % .', v_sku.sku_code; END IF;
    END IF;

    INSERT INTO production_order_items (order_id, sku_id, sku_code, display_name, unit_code, quantity, pieces, length_mm)
    VALUES (
      v_order.id, v_sku.id, v_sku.sku_code, v_sku.display_name, v_sku.unit_code, v_qty,
      -- a single MM × PCS entry keeps the plain "470 mm × 2 pcs" form; several entries live on their segments
      CASE WHEN jsonb_array_length(v_segs) = 1 THEN (v_segs->0->>'pcs')::int END,
      CASE WHEN jsonb_array_length(v_segs) = 1 THEN (v_segs->0->>'mm')::numeric END
    ) RETURNING * INTO v_poi;

    v_seg_no := 0;
    FOR v_seg IN SELECT * FROM jsonb_array_elements(v_segs) LOOP
      v_seg_no := v_seg_no + 1;
      SELECT * INTO v_lot FROM sku_lots WHERE id = (v_seg->>'lot_id')::uuid;
      IF v_lot.id IS NULL OR v_lot.sku_id <> v_sku.id THEN
        RAISE EXCEPTION 'The roll picked for % does not belong to that product.', v_sku.sku_code;
      END IF;
      IF (v_seg->>'mm')::numeric > v_lot.current_qty THEN
        RAISE EXCEPTION 'Roll % is only % long — a % piece cannot be cut from it.',
          v_lot.lot_no, v_lot.current_qty, (v_seg->>'mm')::numeric;
      END IF;
      INSERT INTO lot_allocations (item_id, lot_id, allocated_qty, seg_no, seg_mm, seg_pcs)
      VALUES (v_poi.id, v_lot.id, (v_seg->>'mm')::numeric * (v_seg->>'pcs')::int,
              v_seg_no, (v_seg->>'mm')::numeric, (v_seg->>'pcs')::int);
    END LOOP;
  END LOOP;

  PERFORM log_audit('CREATE', 'PRODUCTION_ORDER', v_order.id::text, v_order.order_no,
                    NULL, v_order.status, 'WEB', 'Production order ' || v_order.order_no || ' created');

  RETURN jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no);
END $$;
REVOKE ALL ON FUNCTION create_production_order_full(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_production_order_full(jsonb) TO authenticated;

SELECT 'ok' AS status;
