-- =====================================================================================
-- 034  Record Outward for timing belts as  MM × PCS, from Full Sleeve or Cut Pcs
--
--   Each row says: take PCS pieces of MM length, either from a Full Sleeve or from Cut Pcs.
--       230 mm × 2 pcs   from Full Sleeve   →  two 230 mm pieces are cut from sleeves in stock;
--                                              what is left of each sleeve becomes a Cut Pcs lot
--       150 mm × 1 pcs   from Cut Pcs       →  one cut piece of at least 150 mm is used;
--                                              what is left of it stays a Cut Pcs lot
--   A piece is taken from the best fit: an exact-length piece first, otherwise the smallest piece
--   that is long enough. Pieces planned on other open production orders are left alone while
--   other pieces are available.
--
--   Rows use the same shape as inward:  [{"rolls": PCS, "roll_length": MM, "cut": false|true}]
--   (cut = true means "take from Cut Pcs", false means "take from Full Sleeve").
--
-- Safe to run more than once. Run after 033.
-- =====================================================================================

CREATE OR REPLACE FUNCTION record_outward_with_lots(
  p_sku_code    text,
  p_rows        jsonb,
  p_reference   text    DEFAULT NULL,
  p_notes       text    DEFAULT NULL,
  p_channel     text    DEFAULT 'WEB',
  p_invoice_no  text    DEFAULT NULL,
  p_operated_by uuid    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku      skus;
  v_grp      jsonb;
  v_pcs      int;
  v_mm       numeric;
  v_src      text;
  v_total    numeric := 0;
  v_i        int;
  v_lot      record;
  v_movement jsonb;
  v_mov_id   uuid;
  v_break    jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.lot_managed','1',true);

  SELECT * INTO v_sku FROM skus WHERE sku_code = p_sku_code;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'Unknown product.'; END IF;
  IF v_sku.product_type <> 'TIMING_BELT' THEN
    RAISE EXCEPTION 'MM × PCS outward is for timing belts only.';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Enter at least one MM × PCS row.';
  END IF;

  FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_pcs := COALESCE((v_grp->>'rolls')::int, 0);
    v_mm  := COALESCE((v_grp->>'roll_length')::numeric, 0);
    IF v_pcs < 1 OR v_mm <= 0 THEN
      RAISE EXCEPTION 'Each row needs a PCS of 1 or more and an MM above zero.';
    END IF;
    v_total := v_total + v_pcs * v_mm;
  END LOOP;

  -- book stock first (permission, unit and negative-stock checks all live in record_movement)
  v_movement := record_movement(
    v_sku.sku_code, 'OUTWARD', v_total, v_sku.unit_code,
    p_reference, p_notes, COALESCE(p_channel, 'WEB'), p_invoice_no, p_operated_by
  );
  SELECT id INTO v_mov_id FROM inventory_movements WHERE txn_no = (v_movement->>'txn_no');

  -- then the lots, piece by piece
  FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_pcs := (v_grp->>'rolls')::int;
    v_mm  := (v_grp->>'roll_length')::numeric;
    v_src := CASE WHEN COALESCE((v_grp->>'cut')::boolean, false) THEN 'CUT_PCS' ELSE 'FULL_SLEEVE' END;

    FOR v_i IN 1..v_pcs LOOP
      SELECT f.id, f.lot_no, f.status, f.current_qty
        INTO v_lot
        FROM v_lot_free f
       WHERE f.sku_id = v_sku.id
         AND f.status = v_src
         AND f.current_qty >= v_mm
       ORDER BY (f.free_qty >= v_mm) DESC,      -- not promised to another open order
                (f.current_qty = v_mm) DESC,    -- exact length first
                f.current_qty,                  -- then the smallest that is long enough
                f.created_at, f.lot_no
       LIMIT 1;

      IF v_lot.id IS NULL THEN
        RAISE EXCEPTION 'No % of % mm or longer is left in stock (% more piece(s) needed). Try % instead, or fewer pieces.',
          CASE v_src WHEN 'CUT_PCS' THEN 'Cut Pcs piece' ELSE 'Full Sleeve' END,
          v_mm, v_pcs - v_i + 1,
          CASE v_src WHEN 'CUT_PCS' THEN 'Full Sleeve' ELSE 'Cut Pcs' END;
      END IF;

      PERFORM drain_lot(v_lot.id, v_mm);
      v_break := v_break || jsonb_build_object('lot_no', v_lot.lot_no, 'status', v_lot.status, 'qty', v_mm);
    END LOOP;
  END LOOP;

  UPDATE inventory_movements SET lot_breakdown = v_break WHERE id = v_mov_id;

  RETURN v_movement || jsonb_build_object('lot_breakdown', v_break, 'rows', p_rows);
END $$;
REVOKE ALL ON FUNCTION record_outward_with_lots(text, jsonb, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_outward_with_lots(text, jsonb, text, text, text, text, uuid) TO authenticated;

SELECT 'ok' AS status;
