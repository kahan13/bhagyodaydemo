-- =====================================================================================
-- 022 – Every stock movement keeps the lots in step (Cut Pcs / Full Sleeve)
--
-- THE PROBLEM THIS FIXES
--   Lots (rolls / cut pieces) were only updated by two special functions
--   (record_production_outward_with_lots when a plan existed, record_inward_with_lots).
--   Any other outward (Inventory page, dashboard dialog, an order whose lot plan did not
--   save) lowered BOOK stock but left the lots untouched, so the Inventory view kept
--   showing 4 x 50 + 1 x 50 although only 180 mm was left.
--
-- THE RULE NOW (enforced in the database, not the screen)
--   * INWARD  on a roll-tracked SKU   -> new FULL_SLEEVE lot(s)           [as before]
--   * OUTWARD on a roll-tracked SKU   -> drains Cut Pcs first, then the oldest Full Sleeve;
--                                        a Full Sleeve that is used becomes Cut Pcs with
--                                        the remainder; a used-up piece becomes EXHAUSTED
--   * Production outward drains exactly the lots planned on the order item; if no plan
--     exists it falls back to the same cut-first rule.
--   * Each movement records WHAT it took in inventory_movements.lot_breakdown, e.g.
--     [{"lot_no":"LOT-…","status":"CUT_PCS","qty":50},{"lot_no":"LOT-…","status":"FULL_SLEEVE","qty":20}]
--   * Waste / adjustments are unchanged (mark_lot_wasted already closes its own lot).
--
-- ALSO
--   plan_item_lots(): plans an order line's lots server-side from the chosen classification,
--   so a lot plan can no longer be lost because the browser could not save it.
--
-- ONE-TIME REPAIR at the bottom: lots that hold more than the book stock (because earlier
-- outwards never touched them) are drained, cut pieces first.
--
-- Safe to re-run.
-- =====================================================================================

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS lot_breakdown jsonb;

-- ── Helper: drain a SKU's lots, cut pieces first, then oldest full sleeve ──
CREATE OR REPLACE FUNCTION auto_drain_lots(p_sku_id uuid, p_qty numeric, p_movement_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_need  numeric := p_qty;
  v_take  numeric;
  v_row   record;
  v_out   jsonb := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT f.id, f.lot_no, f.status, f.current_qty, f.free_qty
      FROM v_lot_free f
     WHERE f.sku_id = p_sku_id
     ORDER BY (f.free_qty > 0) DESC,             -- lots not planned on other orders first
              (f.status = 'CUT_PCS') DESC,       -- cut pieces before full sleeves
              f.created_at, f.lot_no
  LOOP
    EXIT WHEN v_need <= 0;
    v_take := LEAST(v_need, v_row.current_qty);
    IF v_take > 0 THEN
      PERFORM drain_lot(v_row.id, v_take);
      v_out := v_out || jsonb_build_object('lot_no', v_row.lot_no, 'status', v_row.status, 'qty', v_take);
      v_need := v_need - v_take;
    END IF;
  END LOOP;

  IF p_movement_id IS NOT NULL AND jsonb_array_length(v_out) > 0 THEN
    UPDATE inventory_movements
       SET lot_breakdown = COALESCE(lot_breakdown, '[]'::jsonb) || v_out
     WHERE id = p_movement_id;
  END IF;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION auto_drain_lots(uuid, numeric, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auto_drain_lots(uuid, numeric, uuid) TO authenticated;

-- ── Trigger: plain movements keep lots in step ──
CREATE OR REPLACE FUNCTION trg_movement_sync_lots()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku skus;
BEGIN
  IF NEW.txn_mode <> 'NORMAL' THEN RETURN NEW; END IF;                          -- reversals have their own triggers
  IF COALESCE(current_setting('app.lot_managed', true), '') = '1' THEN RETURN NEW; END IF;  -- caller manages lots itself
  IF NEW.txn_type NOT IN ('INWARD','OUTWARD') THEN RETURN NEW; END IF;

  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF v_sku.roll_length_mm IS NULL OR v_sku.roll_length_mm <= 0 THEN RETURN NEW; END IF;  -- not roll-tracked

  IF NEW.txn_type = 'INWARD' THEN
    IF NEW.quantity >= v_sku.roll_length_mm AND mod(NEW.quantity, v_sku.roll_length_mm) = 0 THEN
      PERFORM create_inward_lot(NEW.id, v_sku.id, v_sku.roll_length_mm, (NEW.quantity / v_sku.roll_length_mm)::int, NEW.notes);
    ELSE
      PERFORM create_inward_lot(NEW.id, v_sku.id, NEW.quantity, 1, NEW.notes);
    END IF;
  ELSE
    PERFORM auto_drain_lots(v_sku.id, NEW.quantity, NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS movement_sync_lots ON inventory_movements;
CREATE TRIGGER movement_sync_lots
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_movement_sync_lots();

-- ── record_inward_with_lots: same as 012, plus the "I manage the lots" flag ──
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
  PERFORM set_config('app.lot_managed','1',true);  -- lots are created below; the movement trigger must stay out
  SELECT * INTO v_sku FROM skus WHERE sku_code = p_sku_code;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'Unknown product.'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero.';
  END IF;

  -- Decide the roll groups
  IF p_rolls IS NOT NULL AND jsonb_typeof(p_rolls) = 'array' AND jsonb_array_length(p_rolls) > 0 THEN
    v_groups := p_rolls;
  ELSIF v_sku.roll_length_mm IS NOT NULL AND v_sku.roll_length_mm > 0
        AND p_quantity >= v_sku.roll_length_mm
        AND mod(p_quantity, v_sku.roll_length_mm) = 0 THEN
    v_groups := jsonb_build_array(jsonb_build_object(
      'rolls', (p_quantity / v_sku.roll_length_mm)::int,
      'roll_length', v_sku.roll_length_mm));
  ELSE
    v_groups := jsonb_build_array(jsonb_build_object('rolls', 1, 'roll_length', p_quantity));
  END IF;

  -- Validate groups and make sure they add up to the movement qty
  FOR v_grp IN SELECT * FROM jsonb_array_elements(v_groups) LOOP
    v_rolls := (v_grp->>'rolls')::int;
    v_len   := (v_grp->>'roll_length')::numeric;
    IF v_rolls IS NULL OR v_rolls < 1 OR v_len IS NULL OR v_len <= 0 THEN
      RAISE EXCEPTION 'Each roll group needs a roll count of 1 or more and a length above zero.';
    END IF;
    v_total := v_total + v_rolls * v_len;
  END LOOP;

  IF v_total <> p_quantity THEN
    RAISE EXCEPTION 'Rolls add up to % but the quantity is %.', v_total, p_quantity;
  END IF;

  -- 1) Normal ledger entry (permissions, stock lock, audit all handled in here)
  v_movement := record_movement(
    v_sku.sku_code, 'INWARD', p_quantity, v_sku.unit_code,
    p_reference, p_notes, COALESCE(p_channel, 'WEB'), p_invoice_no, p_operated_by
  );

  SELECT id INTO v_mov_id FROM inventory_movements WHERE txn_no = (v_movement->>'txn_no');

  -- 2) One FULL_SLEEVE lot per roll
  FOR v_grp IN SELECT * FROM jsonb_array_elements(v_groups) LOOP
    v_new_ids := create_inward_lot(
      v_mov_id, v_sku.id,
      (v_grp->>'roll_length')::numeric,
      (v_grp->>'rolls')::int,
      p_notes
    );
    v_lot_ids := v_lot_ids || v_new_ids;
  END LOOP;

  -- Single-lot inwards link the movement to its lot (multi-lot stays NULL by design)
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

-- ── Production outward: drain the PLANNED lots, record what was taken ──
CREATE OR REPLACE FUNCTION record_production_outward_with_lots(
  p_poi_id  uuid,
  p_notes   text    DEFAULT NULL,
  p_channel text    DEFAULT 'WEB'
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
GRANT EXECUTE ON FUNCTION record_production_outward_with_lots(uuid, text, text) TO authenticated;

-- ── plan_item_lots: allocate an order line from a chosen classification (server-side) ──
CREATE OR REPLACE FUNCTION plan_item_lots(p_item_id uuid, p_status text, p_piece_qty numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_poi   production_order_items;
  v_need  numeric;
  v_take  numeric;
  v_row   record;
  v_plan  jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF p_status NOT IN ('CUT_PCS','FULL_SLEEVE') THEN RAISE EXCEPTION 'Unknown classification %.', p_status; END IF;

  SELECT * INTO v_poi FROM production_order_items WHERE id = p_item_id FOR UPDATE;
  IF v_poi.id IS NULL THEN RAISE EXCEPTION 'Production order item not found.'; END IF;
  IF v_poi.is_fulfilled THEN RAISE EXCEPTION 'This item is already fulfilled.'; END IF;
  IF v_poi.sku_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  v_need := v_poi.quantity;

  FOR v_row IN
    SELECT f.id, f.free_qty
      FROM v_lot_free f
     WHERE f.sku_id = v_poi.sku_id AND f.status = p_status AND f.free_qty > 0
       AND (p_piece_qty IS NULL OR f.current_qty = p_piece_qty)
       AND NOT EXISTS (SELECT 1 FROM lot_allocations x WHERE x.item_id = p_item_id AND x.lot_id = f.id)
     ORDER BY f.created_at, f.lot_no
  LOOP
    EXIT WHEN v_need <= 0;
    v_take := LEAST(v_need, v_row.free_qty);
    v_plan := v_plan || jsonb_build_object('lot_id', v_row.id, 'qty', v_take);
    v_need := v_need - v_take;
  END LOOP;

  IF v_need > 0 THEN
    RAISE EXCEPTION 'Only % of % is free in %.', v_poi.quantity - v_need, v_poi.quantity,
      CASE p_status WHEN 'CUT_PCS' THEN 'Cut Pcs' ELSE 'Full Sleeve' END;
  END IF;

  RETURN set_item_lot_allocations(p_item_id, v_plan);
END $$;
GRANT EXECUTE ON FUNCTION plan_item_lots(uuid, text, numeric) TO authenticated;

-- ── One-time repair: lots holding more than the book stock → drain the excess, cut first ──
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT s.id, s.sku_code, s.current_stock, COALESCE(sum(l.current_qty), 0) AS lots_qty
      FROM skus s
      JOIN sku_lots l ON l.sku_id = s.id AND l.status IN ('FULL_SLEEVE','CUT_PCS')
     WHERE s.roll_length_mm > 0
     GROUP BY s.id
    HAVING COALESCE(sum(l.current_qty), 0) > s.current_stock
  LOOP
    PERFORM auto_drain_lots(r.id, r.lots_qty - r.current_stock, NULL);
    RAISE NOTICE 'Repaired lots for %: drained % mm to match book stock %', r.sku_code, r.lots_qty - r.current_stock, r.current_stock;
  END LOOP;
END $$;

-- ── Verify: both lists should be empty ──
SELECT s.sku_code, s.current_stock AS book, COALESCE(sum(l.current_qty),0) AS in_lots
  FROM skus s
  LEFT JOIN sku_lots l ON l.sku_id = s.id AND l.status IN ('FULL_SLEEVE','CUT_PCS')
 WHERE s.roll_length_mm > 0
 GROUP BY s.id
HAVING COALESCE(sum(l.current_qty),0) <> s.current_stock
 LIMIT 20;
