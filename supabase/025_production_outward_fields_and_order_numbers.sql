-- =====================================================================================
-- 025  Production outward: Operated by + Invoice no  |  PROyy-n/dd-mm order numbers
--
--   1. record_production_outward_with_lots gets p_invoice_no and p_operated_by
--      (saved on the movement, so they show in Transactions).
--   2. Production order numbers become  PRO26-1/02-10
--        PRO + 2-digit year + '-' + that day's running number + '/' + DD-MM   (IST day)
--      The counter restarts every day and every year (PRO27-1/01-01 ...).
--      Applies to regular and direct orders (both use next_production_order_no()).
--   3. ALL existing orders are renumbered in that format by their created date/time,
--      and the PRO: reference on their outward movements is updated to match.
-- Safe to re-run. Run after 020-024.
-- =====================================================================================

DROP FUNCTION IF EXISTS record_production_outward_with_lots(uuid, text, text);
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

  -- 1) Normal ledger entry + fulfilled flag
  v_result := record_production_outward(p_poi_id, p_notes, p_channel);
  v_mov_id := NULLIF(v_result->>'movement_id','')::uuid;

  -- who handled it and the invoice it went out on (allowed: only ledger columns are locked)
  IF v_mov_id IS NOT NULL AND (NULLIF(btrim(p_invoice_no),'') IS NOT NULL OR p_operated_by IS NOT NULL) THEN
    UPDATE inventory_movements
       SET invoice_no = NULLIF(btrim(p_invoice_no),''),
           operated_by_user_id = p_operated_by
     WHERE id = v_mov_id;
  END IF;

  IF v_planned THEN
    -- 2a) Drain each planned lot
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
  ELSIF v_poi.sku_id IS NOT NULL AND EXISTS (SELECT 1 FROM skus WHERE id = v_poi.sku_id AND roll_length_mm > 0) THEN
    -- 2b) No plan on file: same cut-first rule as any other outward
    v_break := auto_drain_lots(v_poi.sku_id, v_poi.quantity, v_mov_id);
  END IF;

  RETURN v_result || jsonb_build_object('lots_drained', v_drained, 'lot_breakdown', v_break);
END $$;
GRANT EXECUTE ON FUNCTION record_production_outward_with_lots(uuid, text, text, text, uuid) TO authenticated;

-- ── new number generator ──
CREATE OR REPLACE FUNCTION next_production_order_no()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_day     date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_prefix  text := 'PRO' || to_char(v_day, 'YY') || '-';
  v_suffix  text := '/' || to_char(v_day, 'DD-MM');
  v_n       int;
  v_no      text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('production_order_no'));
  SELECT COALESCE(MAX(split_part(substr(order_no, length(v_prefix) + 1), '/', 1)::int), 0) + 1
    INTO v_n
    FROM production_orders
   WHERE order_no LIKE v_prefix || '%' || v_suffix;
  v_no := v_prefix || v_n || v_suffix;
  RETURN v_no;
END $$;
GRANT EXECUTE ON FUNCTION next_production_order_no() TO authenticated;

-- ── renumber everything that exists ──
DO $$
DECLARE
  v_map record;
BEGIN
  CREATE TEMP TABLE _ord_map ON COMMIT DROP AS
  SELECT id, order_no AS old_no,
         'PRO' || to_char((created_at AT TIME ZONE 'Asia/Kolkata'), 'YY') || '-' ||
         row_number() OVER (PARTITION BY (created_at AT TIME ZONE 'Asia/Kolkata')::date ORDER BY created_at, id) ||
         '/' || to_char((created_at AT TIME ZONE 'Asia/Kolkata'), 'DD-MM') AS new_no
    FROM production_orders;

  -- two steps so a unique constraint on order_no can never collide mid-way
  UPDATE production_orders p SET order_no = 'TMP-' || p.id::text FROM _ord_map m WHERE m.id = p.id;
  UPDATE production_orders p SET order_no = m.new_no            FROM _ord_map m WHERE m.id = p.id;

  -- movements raised from these orders keep pointing at the right order
  FOR v_map IN SELECT m.id, m.old_no, m.new_no, po.customer_name
                 FROM _ord_map m JOIN production_orders po ON po.id = m.id LOOP
    UPDATE inventory_movements mv
       SET reference = 'PRO:' || v_map.new_no || COALESCE(' / ' || v_map.customer_name, ''),
           notes     = CASE WHEN mv.notes LIKE '%' || v_map.old_no || '%'
                            THEN replace(mv.notes, v_map.old_no, v_map.new_no) ELSE mv.notes END
     WHERE mv.source_poi_id IN (SELECT id FROM production_order_items WHERE order_id = v_map.id);
  END LOOP;
END $$;

SELECT order_no, created_at FROM production_orders ORDER BY created_at DESC LIMIT 10;
