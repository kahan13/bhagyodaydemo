-- =====================================================================================
-- 043  Open Roll / Rubber — a fifth product type, measured in TWO directions
--
--   A rubber roll has a WIDTH (mm) and a LENGTH (metres on screen). Every roll — and every
--   leftover piece — is its own row in sku_lots with its own width and length. Nothing is fixed.
--
--   Storage (so nothing needs a new decimal column): lengths and widths are kept in mm,
--   and the STOCK QUANTITY of an Open Roll is its AREA in square millimetres (unit MM2),
--   shown as "sq m" on screen.  A roll's length is simply  area ÷ width.
--
--   Cutting  LENGTH × WIDTH × PCS  from a roll (pieces laid end to end along the length):
--       the roll gets shorter by LENGTH × PCS
--       if the cut is narrower than the roll, the side strip stays in stock as a new piece
--       the piece itself leaves stock: area out = LENGTH × WIDTH × PCS
--   Leftovers stay until they are marked as waste. There is no Full Sleeve / Cut Pcs split.
--
--   Purchase orders, inward, production orders, outward and Mismatch all carry
--   LENGTH × WIDTH × PCS (rolls: WIDTH × LENGTH × number of rolls).
--
-- Safe to run more than once. Run after 042.
-- =====================================================================================

-- 1. the new product type -------------------------------------------------------------
DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname FROM pg_constraint
   WHERE conrelid = 'skus'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%product_type%';
  IF v_conname IS NOT NULL THEN EXECUTE format('ALTER TABLE skus DROP CONSTRAINT %I', v_conname); END IF;
  ALTER TABLE skus ADD CONSTRAINT skus_product_type_check
    CHECK (product_type IN ('TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT', 'POLY_V_BELT', 'OPEN_ROLL'));

  SELECT conname INTO v_conname FROM pg_constraint
   WHERE conrelid = 'product_families'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%product_type%';
  IF v_conname IS NOT NULL THEN EXECUTE format('ALTER TABLE product_families DROP CONSTRAINT %I', v_conname); END IF;
  ALTER TABLE product_families ADD CONSTRAINT product_families_product_type_check
    CHECK (product_type IN ('TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT', 'POLY_V_BELT', 'OPEN_ROLL'));
END $$;

-- 2. the unit: area in square millimetres ------------------------------------------------
INSERT INTO units (code, name, decimals) VALUES ('MM2', 'Sq mm (area)', 0)
ON CONFLICT (code) DO NOTHING;

-- 3. width columns --------------------------------------------------------------------------
ALTER TABLE sku_lots              ADD COLUMN IF NOT EXISTS width_mm          numeric(14,2);
ALTER TABLE lot_allocations       ADD COLUMN IF NOT EXISTS seg_width_mm      numeric;
ALTER TABLE lot_allocations       ADD COLUMN IF NOT EXISTS piece_width_mm    numeric;   -- the roll's width when the order was made
ALTER TABLE production_order_items ADD COLUMN IF NOT EXISTS width_mm         numeric;
ALTER TABLE purchase_order_items  ADD COLUMN IF NOT EXISTS ordered_width_mm  numeric;

-- 4. type helpers -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_lot_type(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_type IN ('TIMING_BELT', 'POLY_V_BELT', 'OPEN_ROLL') $$;
GRANT EXECUTE ON FUNCTION is_lot_type(text) TO authenticated, anon;

CREATE OR REPLACE FUNCTION is_rubber(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_type = 'OPEN_ROLL' $$;
GRANT EXECUTE ON FUNCTION is_rubber(text) TO authenticated, anon;

-- 5. snapshots for printing: remember the roll's width as well --------------------------------
CREATE OR REPLACE FUNCTION trg_lot_alloc_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lot_status IS NULL THEN
    SELECT status, current_qty, width_mm INTO NEW.lot_status, NEW.piece_qty, NEW.piece_width_mm
      FROM sku_lots WHERE id = NEW.lot_id;
  END IF;
  RETURN NEW;
END $$;

-- the inward trace of a new lot also says how wide and long it is
CREATE OR REPLACE FUNCTION trg_lot_created_trace()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.inward_movement_id IS NOT NULL THEN
    UPDATE inventory_movements
       SET lot_breakdown = COALESCE(lot_breakdown, '[]'::jsonb) ||
             (jsonb_build_object('lot_no', NEW.lot_no, 'status', NEW.status, 'qty', NEW.inward_qty)
              || CASE WHEN NEW.width_mm IS NOT NULL
                      THEN jsonb_build_object('width_mm', NEW.width_mm, 'len_mm', NEW.roll_length_mm)
                      ELSE '{}'::jsonb END)
     WHERE id = NEW.inward_movement_id;
  END IF;
  RETURN NEW;
END $$;

-- 6. views: width travels with every lot ------------------------------------------------------
CREATE OR REPLACE VIEW v_lot_free
WITH (security_invoker = on) AS
SELECT
  l.id, l.lot_no, l.sku_id, l.status, l.roll_length_mm, l.inward_qty, l.current_qty, l.created_at,
  -- Open Roll: a planned cut takes a whole slab (its length x the roll's full width) out of the roll
  l.current_qty - COALESCE(sum(
      CASE WHEN l.width_mm IS NOT NULL AND la.seg_mm IS NOT NULL AND la.seg_pcs IS NOT NULL
           THEN la.seg_mm * la.seg_pcs * l.width_mm
           ELSE la.allocated_qty END
    ) FILTER (WHERE i.is_fulfilled = false AND po.status <> 'CANCELLED'), 0) AS free_qty,
  l.width_mm
FROM sku_lots l
LEFT JOIN lot_allocations        la ON la.lot_id = l.id
LEFT JOIN production_order_items i  ON i.id = la.item_id
LEFT JOIN production_orders      po ON po.id = i.order_id
WHERE l.status IN ('FULL_SLEEVE','CUT_PCS') AND l.current_qty > 0
GROUP BY l.id;
GRANT SELECT ON v_lot_free TO authenticated;

CREATE OR REPLACE VIEW v_sku_lot_groups
WITH (security_invoker = on) AS
SELECT
  l.sku_id,
  l.status,
  l.current_qty            AS piece_qty,
  count(*)::int            AS pieces,
  sum(l.current_qty)       AS total_qty,
  l.width_mm
FROM sku_lots l
WHERE l.status IN ('FULL_SLEEVE','CUT_PCS') AND l.current_qty > 0
GROUP BY l.sku_id, l.status, l.current_qty, l.width_mm;
GRANT SELECT ON v_sku_lot_groups TO authenticated;

CREATE OR REPLACE VIEW v_sku_lot_groups_free
WITH (security_invoker = on) AS
SELECT sku_id, status, current_qty AS piece_qty,
       count(*)::int AS pieces, sum(free_qty) AS total_qty, width_mm
  FROM v_lot_free
 WHERE free_qty > 0
 GROUP BY sku_id, status, current_qty, width_mm;
GRANT SELECT ON v_sku_lot_groups_free TO authenticated;

CREATE OR REPLACE VIEW v_sku_lots
WITH (security_invoker = on) AS
SELECT
  sl.id, sl.lot_no, sl.sku_id, sl.roll_length_mm, sl.inward_qty, sl.current_qty, sl.status,
  sl.inward_movement_id, sl.wasted_at, sl.waste_reason, sl.notes, sl.created_at,
  s.sku_code, s.display_name, s.product_type, s.exact_size, s.unit_code,
  s.hier_l1, s.hier_l2, s.hier_l3,
  b.name  AS brand_name,
  f.code  AS family_code,
  u.full_name AS wasted_by_name,
  ROUND((sl.current_qty / NULLIF(CASE WHEN sl.width_mm IS NULL THEN sl.roll_length_mm ELSE sl.inward_qty END, 0)) * 100, 1) AS pct_remaining,
  sl.width_mm
FROM sku_lots sl
JOIN skus            s ON s.id  = sl.sku_id
JOIN brands          b ON b.id  = s.brand_id
JOIN product_families f ON f.id  = s.family_id
LEFT JOIN app_users  u ON u.id  = sl.wasted_by;
GRANT SELECT ON v_sku_lots TO authenticated;

-- 6b. the Mismatch tab shows each open order line: it needs the width of an Open Roll line too
CREATE OR REPLACE VIEW v_production_stock_status
WITH (security_invoker = on) AS
SELECT
  s.id                                                    AS sku_id,
  s.sku_code,
  s.display_name,
  s.unit_code,
  s.current_stock,
  s.physical_prod_stock,
  s.current_stock - s.physical_prod_stock - COALESCE(pa.pending_net, 0) AS stock_gap,
  (s.current_stock - s.physical_prod_stock - COALESCE(pa.pending_net, 0)) <> 0 AS is_mismatched,
  COALESCE(
    json_agg(
      json_build_object(
        'poi_id',       poi.id,
        'order_id',     po.id,
        'order_no',     po.order_no,
        'customer_name',po.customer_name,
        'order_status', po.status,
        'quantity',     poi.quantity,
        'unit_code',    poi.unit_code,
        'pieces',       poi.pieces,
        'length_mm',    poi.length_mm,
        'width_mm',     poi.width_mm,
        'created_at',   po.created_at
      ) ORDER BY po.created_at
    ) FILTER (
      WHERE poi.id IS NOT NULL
        AND poi.is_fulfilled = false
        AND po.status <> 'CANCELLED'
    ),
    '[]'::json
  )                                                       AS open_order_items,
  COALESCE(pa.pending_net, 0)                             AS pending_net,
  count(poi.id) FILTER (
    WHERE poi.is_fulfilled = false AND po.status <> 'CANCELLED')::int AS open_item_count
FROM skus s
LEFT JOIN production_order_items poi ON poi.sku_id = s.id
LEFT JOIN production_orders      po  ON po.id = poi.order_id
LEFT JOIN (
  SELECT sku_id, sum(delta) AS pending_net
    FROM prod_pending_adjustments WHERE resolved_at IS NULL GROUP BY sku_id
) pa ON pa.sku_id = s.id
WHERE s.is_active = true
GROUP BY s.id, s.sku_code, s.display_name, s.unit_code,
         s.current_stock, s.physical_prod_stock, pa.pending_net;
GRANT SELECT ON v_production_stock_status TO authenticated;

-- 7. helpers: make rolls, cut a piece out of a roll -------------------------------------------
-- p_width_mm x p_length_mm, p_n rolls (the quantity of each is its area)
CREATE OR REPLACE FUNCTION create_rubber_lots(
  p_movement_id uuid, p_sku_id uuid, p_width_mm numeric, p_length_mm numeric, p_n int DEFAULT 1, p_notes text DEFAULT NULL
) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id  uuid;
  v_ids uuid[] := '{}';
  v_area numeric := p_width_mm * p_length_mm;
  i int;
BEGIN
  IF p_width_mm IS NULL OR p_width_mm <= 0 OR p_length_mm IS NULL OR p_length_mm <= 0 THEN
    RAISE EXCEPTION 'Each roll needs a width and a length above zero.';
  END IF;
  FOR i IN 1..p_n LOOP
    INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, width_mm, inward_qty, current_qty, status, is_cut, inward_movement_id, notes)
    VALUES (generate_lot_no(), p_sku_id, p_length_mm, p_width_mm, v_area, v_area, 'FULL_SLEEVE', false, p_movement_id, p_notes)
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END LOOP;
  RETURN v_ids;
END $$;
GRANT EXECUTE ON FUNCTION create_rubber_lots(uuid, uuid, numeric, numeric, int, text) TO authenticated;

-- opening stock from an import sheet: one roll of width x length (mm)
CREATE OR REPLACE FUNCTION create_opening_rubber_lot(p_sku_id uuid, p_width_mm numeric, p_length_mm numeric, p_notes text DEFAULT 'Opening balance')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_width_mm IS NULL OR p_width_mm <= 0 OR p_length_mm IS NULL OR p_length_mm <= 0 THEN
    RAISE EXCEPTION 'A roll needs a width and a length above zero.';
  END IF;
  INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, width_mm, inward_qty, current_qty, status, is_cut, inward_movement_id, notes)
  VALUES (generate_lot_no(), p_sku_id, p_length_mm, p_width_mm, p_width_mm * p_length_mm, p_width_mm * p_length_mm, 'FULL_SLEEVE', false, NULL, p_notes)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION create_opening_rubber_lot(uuid, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_opening_rubber_lot(uuid, numeric, numeric, text) TO authenticated, service_role;

-- Cut p_pcs pieces of p_len_mm x p_width_mm out of ONE roll, end to end along its length.
--   roll gets shorter by len x pcs; a narrower cut leaves a side strip as a new piece in stock.
-- The caller posts the book movement (area out = len x width x pcs).
CREATE OR REPLACE FUNCTION rubber_cut(p_lot_id uuid, p_len_mm numeric, p_width_mm numeric, p_pcs int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lot   sku_lots;
  v_block numeric := p_len_mm * p_pcs;
  v_len   numeric;
  v_new   numeric;
  v_strip numeric;
  v_slab  numeric;
  v_sid   uuid;
  v_sno   text;
BEGIN
  SELECT * INTO v_lot FROM sku_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'Roll not found.'; END IF;
  IF v_lot.status IN ('WASTED','EXHAUSTED') OR v_lot.current_qty <= 0 THEN
    RAISE EXCEPTION 'This roll is already %.', lower(v_lot.status);
  END IF;
  IF v_lot.width_mm IS NULL OR v_lot.width_mm <= 0 THEN RAISE EXCEPTION 'This roll has no width recorded.'; END IF;
  IF p_len_mm IS NULL OR p_len_mm <= 0 OR p_width_mm IS NULL OR p_width_mm <= 0 OR p_pcs IS NULL OR p_pcs < 1 THEN
    RAISE EXCEPTION 'Enter length, width and pieces.';
  END IF;
  IF p_width_mm > v_lot.width_mm THEN
    RAISE EXCEPTION 'A % mm wide piece cannot be cut from a roll that is only % mm wide.', p_width_mm, v_lot.width_mm;
  END IF;
  v_len := v_lot.current_qty / v_lot.width_mm;
  IF v_block > v_len THEN
    RAISE EXCEPTION 'Only % mm of this roll is left, but % mm is needed (% pcs x % mm).', v_len, v_block, p_pcs, p_len_mm;
  END IF;

  v_slab := v_block * v_lot.width_mm;
  v_new  := v_lot.current_qty - v_slab;
  UPDATE sku_lots SET current_qty = v_new, status = derive_lot_status(v_new, v_lot.inward_qty) WHERE id = v_lot.id;

  v_strip := v_lot.width_mm - p_width_mm;
  IF v_strip > 0 THEN
    v_sno := generate_lot_no();
    INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, width_mm, inward_qty, current_qty, status, is_cut, inward_movement_id, notes)
    VALUES (v_sno, v_lot.sku_id, v_block, v_strip, v_strip * v_block, v_strip * v_block, 'CUT_PCS', true, NULL,
            'Side strip left from ' || v_lot.lot_no)
    RETURNING id INTO v_sid;
  END IF;

  RETURN jsonb_build_object(
    'lot_id', v_lot.id, 'lot_no', v_lot.lot_no, 'status', v_lot.status,
    'qty', p_len_mm * p_width_mm * p_pcs,
    'width_mm', p_width_mm, 'len_mm', p_len_mm, 'pcs', p_pcs,
    'from_width_mm', v_lot.width_mm, 'from_len_mm', v_len,
    'left_len_mm', v_new / v_lot.width_mm,
    'strip_lot_no', v_sno, 'strip_width_mm', CASE WHEN v_strip > 0 THEN v_strip END, 'strip_len_mm', CASE WHEN v_strip > 0 THEN v_block END);
END $$;
REVOKE ALL ON FUNCTION rubber_cut(uuid, numeric, numeric, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rubber_cut(uuid, numeric, numeric, int) TO authenticated;

-- 8. plain movements may not change Open Roll stock (they carry no width / length) ---------------
CREATE OR REPLACE FUNCTION public.trg_movement_sync_lots()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sku   skus;
  v_delta numeric;
  v_no    text;
BEGIN
  IF COALESCE(current_setting('app.lot_managed', true), '') = '1' THEN RETURN NEW; END IF;
  IF NEW.txn_mode <> 'NORMAL' AND NEW.txn_type <> 'ADJUSTMENT' THEN RETURN NEW; END IF;

  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF NOT is_lot_type(v_sku.product_type) THEN RETURN NEW; END IF;

  IF is_rubber(v_sku.product_type) AND NEW.txn_mode = 'NORMAL' THEN
    RAISE EXCEPTION 'Open Roll stock changes only with a width and a length — use Inward (width x length), Outward (length x width x pcs) or mark a roll as waste.';
  END IF;

  IF NEW.txn_type = 'INWARD' THEN
    PERFORM create_inward_lot(NEW.id, v_sku.id, NEW.quantity, 1, NEW.notes);

  ELSIF NEW.txn_type = 'OUTWARD' THEN
    PERFORM auto_drain_lots(v_sku.id, NEW.quantity, NEW.id);

  ELSIF NEW.txn_type = 'ADJUSTMENT' THEN
    IF NEW.txn_mode = 'REVERSAL' THEN
      IF (SELECT lot_breakdown->0->>'restored' FROM inventory_movements WHERE id = NEW.id) = 'true' THEN RETURN NEW; END IF;
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
END $function$;

-- reversing an Open Roll OUTWARD is not offered: the leftover strips it created cannot be undone safely.
CREATE OR REPLACE FUNCTION trg_block_rubber_outward_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_type text; v_orig text;
BEGIN
  IF NEW.txn_mode = 'REVERSAL' AND NEW.txn_type = 'INWARD' THEN      -- a reversal of an outward
    SELECT product_type INTO v_type FROM skus WHERE id = NEW.sku_id;
    IF is_rubber(v_type) THEN
      RAISE EXCEPTION 'An Open Roll outward cannot be reversed (it may have left side strips). Add the piece back with Inward (width x length) instead.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aa_block_rubber_outward_reversal ON inventory_movements;
CREATE TRIGGER aa_block_rubber_outward_reversal BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_block_rubber_outward_reversal();

-- 9. inward: rows are {rolls, roll_length (mm), width (mm)} for Open Roll -----------------------------
CREATE OR REPLACE FUNCTION public.record_inward_with_lots(p_sku_code text, p_quantity numeric, p_rolls jsonb DEFAULT NULL::jsonb, p_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_channel text DEFAULT 'WEB'::text, p_invoice_no text DEFAULT NULL::text, p_operated_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sku      skus;
  v_rubber   boolean;
  v_groups   jsonb;
  v_grp      jsonb;
  v_rolls    int;
  v_len      numeric;
  v_wid      numeric;
  v_total    numeric := 0;
  v_movement jsonb;
  v_mov_id   uuid;
  v_lot_ids  uuid[] := '{}';
  v_new_ids  uuid[];
BEGIN
  PERFORM set_config('app.lot_managed','1',true);
  SELECT * INTO v_sku FROM skus WHERE sku_code = p_sku_code;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'Unknown product.'; END IF;
  v_rubber := is_rubber(v_sku.product_type);
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero.';
  END IF;

  IF p_rolls IS NOT NULL AND jsonb_typeof(p_rolls) = 'array' AND jsonb_array_length(p_rolls) > 0 THEN
    v_groups := p_rolls;
  ELSIF v_rubber THEN
    RAISE EXCEPTION 'Enter each roll as width x length x number of rolls.';
  ELSE
    v_groups := jsonb_build_array(jsonb_build_object('rolls', 1, 'roll_length', p_quantity, 'cut', false));
  END IF;

  FOR v_grp IN SELECT * FROM jsonb_array_elements(v_groups) LOOP
    v_rolls := (v_grp->>'rolls')::int;
    v_len   := (v_grp->>'roll_length')::numeric;
    v_wid   := NULLIF(v_grp->>'width', '')::numeric;
    IF v_rolls IS NULL OR v_rolls < 1 OR v_len IS NULL OR v_len <= 0 THEN
      RAISE EXCEPTION 'Each row needs a QTY of 1 or more and % above zero.', lot_unit_word(v_sku.id);
    END IF;
    IF v_rubber AND (v_wid IS NULL OR v_wid <= 0) THEN
      RAISE EXCEPTION 'Each roll needs a width.';
    END IF;
    v_total := v_total + v_rolls * v_len * CASE WHEN v_rubber THEN v_wid ELSE 1 END;
  END LOOP;

  IF v_total <> p_quantity THEN
    RAISE EXCEPTION 'QTY x % adds up to % but the quantity is %.', lot_unit_word(v_sku.id), v_total, p_quantity;
  END IF;

  v_movement := record_movement(
    v_sku.sku_code, 'INWARD', p_quantity, v_sku.unit_code,
    p_reference, p_notes, COALESCE(p_channel, 'WEB'), p_invoice_no, p_operated_by
  );
  SELECT id INTO v_mov_id FROM inventory_movements WHERE txn_no = (v_movement->>'txn_no');

  FOR v_grp IN SELECT * FROM jsonb_array_elements(v_groups) LOOP
    IF v_rubber THEN
      v_new_ids := create_rubber_lots(
        v_mov_id, v_sku.id, (v_grp->>'width')::numeric, (v_grp->>'roll_length')::numeric, (v_grp->>'rolls')::int, p_notes);
    ELSE
      v_new_ids := create_inward_lot(
        v_mov_id, v_sku.id, (v_grp->>'roll_length')::numeric, (v_grp->>'rolls')::int, p_notes,
        COALESCE((v_grp->>'cut')::boolean, false));
    END IF;
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
END $function$;

-- 10. outward by hand: rows are {rolls: PCS, roll_length: length mm, width: width mm} ------------------
CREATE OR REPLACE FUNCTION public.record_outward_with_lots(p_sku_code text, p_rows jsonb, p_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_channel text DEFAULT 'WEB'::text, p_invoice_no text DEFAULT NULL::text, p_operated_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sku      skus;
  v_rubber   boolean;
  v_grp      jsonb;
  v_pcs      int;
  v_mm       numeric;
  v_wid      numeric;
  v_src      text;
  v_total    numeric := 0;
  v_i        int;
  v_lot      record;
  v_cut      jsonb;
  v_movement jsonb;
  v_mov_id   uuid;
  v_break    jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.lot_managed','1',true);

  SELECT * INTO v_sku FROM skus WHERE sku_code = p_sku_code;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'Unknown product.'; END IF;
  IF NOT is_lot_type(v_sku.product_type) THEN
    RAISE EXCEPTION 'MM × PCS / RIBS × PCS outward is for timing belts, poly V belts and Open Roll only.';
  END IF;
  v_rubber := is_rubber(v_sku.product_type);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Enter at least one % × PCS row.', lot_unit_word(v_sku.id);
  END IF;

  FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_pcs := COALESCE((v_grp->>'rolls')::int, 0);
    v_mm  := COALESCE((v_grp->>'roll_length')::numeric, 0);
    v_wid := NULLIF(v_grp->>'width', '')::numeric;
    IF v_pcs < 1 OR v_mm <= 0 THEN
      RAISE EXCEPTION 'Each row needs a PCS of 1 or more and % above zero.', lot_unit_word(v_sku.id);
    END IF;
    IF v_rubber AND (v_wid IS NULL OR v_wid <= 0) THEN
      RAISE EXCEPTION 'Each row needs a width.';
    END IF;
    v_total := v_total + v_pcs * v_mm * CASE WHEN v_rubber THEN v_wid ELSE 1 END;
  END LOOP;

  v_movement := record_movement(
    v_sku.sku_code, 'OUTWARD', v_total, v_sku.unit_code,
    p_reference, p_notes, COALESCE(p_channel, 'WEB'), p_invoice_no, p_operated_by
  );
  SELECT id INTO v_mov_id FROM inventory_movements WHERE txn_no = (v_movement->>'txn_no');

  FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_pcs := (v_grp->>'rolls')::int;
    v_mm  := (v_grp->>'roll_length')::numeric;

    IF v_rubber THEN
      v_wid := (v_grp->>'width')::numeric;
      -- the roll to cut from: wide enough, long enough, not promised elsewhere, then the closest fit
      SELECT f.id INTO v_lot
        FROM v_lot_free f
       WHERE f.sku_id = v_sku.id
         AND f.width_mm >= v_wid
         AND f.current_qty / f.width_mm >= v_mm * v_pcs
       ORDER BY (f.free_qty >= v_mm * v_pcs * f.width_mm) DESC,
                f.width_mm,                         -- narrowest roll that is wide enough
                f.current_qty / f.width_mm,         -- then the shortest that is long enough
                f.created_at, f.lot_no
       LIMIT 1;
      IF v_lot.id IS NULL THEN
        RAISE EXCEPTION 'No roll at least % mm wide and % mm long is left in stock (% pcs x % mm). Try fewer pieces on this row.',
          v_wid, v_mm * v_pcs, v_pcs, v_mm;
      END IF;
      v_cut := rubber_cut(v_lot.id, v_mm, v_wid, v_pcs);
      v_break := v_break || v_cut;
    ELSE
      v_src := CASE WHEN COALESCE((v_grp->>'cut')::boolean, false) THEN 'CUT_PCS' ELSE 'FULL_SLEEVE' END;
      FOR v_i IN 1..v_pcs LOOP
        SELECT f.id, f.lot_no, f.status, f.current_qty
          INTO v_lot
          FROM v_lot_free f
         WHERE f.sku_id = v_sku.id
           AND f.status = v_src
           AND f.current_qty >= v_mm
         ORDER BY (f.free_qty >= v_mm) DESC,
                  (f.current_qty = v_mm) DESC,
                  f.current_qty,
                  f.created_at, f.lot_no
         LIMIT 1;

        IF v_lot.id IS NULL THEN
          RAISE EXCEPTION 'No % of % % or more is left in stock (% more piece(s) needed). Try % instead, or fewer pieces.',
            CASE v_src WHEN 'CUT_PCS' THEN 'Cut Pcs piece' ELSE 'Full Sleeve' END,
            v_mm, lower(lot_unit_word(v_sku.id)), v_pcs - v_i + 1,
            CASE v_src WHEN 'CUT_PCS' THEN 'Full Sleeve' ELSE 'Cut Pcs' END;
        END IF;

        PERFORM drain_lot(v_lot.id, v_mm);
        v_break := v_break || jsonb_build_object('lot_no', v_lot.lot_no, 'status', v_lot.status, 'qty', v_mm);
      END LOOP;
    END IF;
  END LOOP;

  UPDATE inventory_movements SET lot_breakdown = v_break WHERE id = v_mov_id;

  RETURN v_movement || jsonb_build_object('lot_breakdown', v_break, 'rows', p_rows);
END $function$;

-- 11. purchase orders: rolls ordered as width x length x number of rolls ------------------------------------
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
  v_wid   numeric;
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
    v_wid := NULL;
    IF is_rubber(v_sku.product_type) THEN
      v_wid := NULLIF(v_item->>'width_mm', '')::numeric;
      IF v_pcs IS NULL OR v_pcs < 1 OR v_len IS NULL OR v_len <= 0 OR v_wid IS NULL OR v_wid <= 0 THEN
        RAISE EXCEPTION 'Enter width, length and number of rolls for %.', v_sku.sku_code;
      END IF;
      v_qty := v_pcs * v_len * v_wid;
    ELSIF v_pcs IS NOT NULL AND v_pcs > 0 AND v_len IS NOT NULL AND v_len > 0 THEN
      v_qty := v_pcs * v_len;
    ELSE
      v_pcs := NULL; v_len := NULL;
      v_qty := NULLIF(v_item->>'qty', '')::numeric;
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Enter a quantity for %.', v_sku.sku_code;
    END IF;

    INSERT INTO purchase_order_items
      (order_id, sku_id, ordered_qty, ordered_pieces, ordered_length_mm, ordered_width_mm, ordered_is_cut, received_qty, status)
    VALUES
      (v_order.id, v_sku.id, v_qty, v_pcs, v_len, v_wid, COALESCE((v_item->>'cut')::boolean, false), 0, 'PENDING');
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no, 'lines', v_n);
END $$;
REVOKE ALL ON FUNCTION create_purchase_order_full(text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_purchase_order_full(text, text, jsonb) TO authenticated;

-- ...and received the same way: rows are {rolls, roll_length (mm), width (mm)}
CREATE OR REPLACE FUNCTION public.receive_po_item(p_item_id uuid, p_qty numeric DEFAULT NULL::numeric, p_rolls jsonb DEFAULT NULL::jsonb, p_notes text DEFAULT NULL::text, p_complete boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item   purchase_order_items;
  v_rubber boolean;
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
  v_rubber := is_rubber((SELECT product_type FROM skus WHERE id = v_item.sku_id));

  IF p_rolls IS NOT NULL AND jsonb_typeof(p_rolls) = 'array' AND jsonb_array_length(p_rolls) > 0 THEN
    FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rolls) LOOP
      IF COALESCE((v_grp->>'rolls')::int, 0) < 1 OR COALESCE((v_grp->>'roll_length')::numeric, 0) <= 0 THEN
        RAISE EXCEPTION 'Each row needs a PCS of 1 or more and % above zero.', lot_unit_word(v_item.sku_id);
      END IF;
      IF v_rubber AND COALESCE(NULLIF(v_grp->>'width', '')::numeric, 0) <= 0 THEN
        RAISE EXCEPTION 'Each roll needs a width.';
      END IF;
      v_qty := v_qty + (v_grp->>'rolls')::int * (v_grp->>'roll_length')::numeric
                       * CASE WHEN v_rubber THEN (v_grp->>'width')::numeric ELSE 1 END;
      v_pcs := v_pcs + (v_grp->>'rolls')::int;
    END LOOP;
  ELSE
    v_qty := p_qty;
    p_rolls := NULL;
    IF v_item.ordered_pieces > 0 THEN
      RAISE EXCEPTION 'This line is ordered as % × PCS — enter what arrived as % × PCS.', lot_unit_word(v_item.sku_id), lot_unit_word(v_item.sku_id);
    END IF;
  END IF;

  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter what was received.'; END IF;

  IF v_item.ordered_pieces > 0 THEN
    IF v_pcs = 0 THEN
      RAISE EXCEPTION 'Enter what arrived as % × PCS.', lot_unit_word(v_item.sku_id);
    END IF;
    IF v_item.received_pieces + v_pcs > v_item.ordered_pieces THEN
      RAISE EXCEPTION 'Only % piece(s) are still to come on this line, but % were entered.',
        v_item.ordered_pieces - v_item.received_pieces, v_pcs;
    END IF;
    v_newp := v_item.received_pieces + v_pcs;
    v_done := v_newp >= v_item.ordered_pieces;
  ELSE
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
END $function$;

-- 12. production orders: each entry is LENGTH x WIDTH x PCS from a chosen roll ---------------------------------
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
  v_wid     numeric;
  v_rubber  boolean;
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
  -- (Open Roll: a cut takes a slab = length x pcs x the roll's full width out of the roll)
  FOR r IN
    SELECT (sg->>'lot_id')::uuid AS lot_id,
           sum((sg->>'mm')::numeric * (sg->>'pcs')::int) AS need_len
      FROM jsonb_array_elements(v_items) it
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(it->'segments', '[]'::jsonb)) sg
     GROUP BY 1
  LOOP
    SELECT * INTO v_lot FROM sku_lots WHERE id = r.lot_id FOR UPDATE;
    IF v_lot.id IS NULL THEN RAISE EXCEPTION 'A roll you picked no longer exists. Reload and pick again.'; END IF;
    IF v_lot.status NOT IN ('FULL_SLEEVE','CUT_PCS') OR v_lot.current_qty <= 0 THEN
      RAISE EXCEPTION 'That roll is no longer in stock. Pick another roll.';
    END IF;
    SELECT free_qty INTO v_free FROM v_lot_free WHERE id = r.lot_id;
    IF v_lot.width_mm IS NOT NULL THEN
      IF COALESCE(v_free, 0) < r.need_len * v_lot.width_mm THEN
        RAISE EXCEPTION 'The % mm wide roll you picked has only % mm of length free, but % mm was asked from it. Pick another roll or reduce the quantity.',
          v_lot.width_mm, floor(COALESCE(v_free, 0) / v_lot.width_mm), r.need_len;
      END IF;
    ELSIF COALESCE(v_free, 0) < r.need_len THEN
      RAISE EXCEPTION 'Roll % has only % free, but % was asked from it. Pick another roll or reduce the quantity.',
        v_lot.lot_no, COALESCE(v_free, 0), r.need_len;
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
      INSERT INTO production_order_items (order_id, sku_id, sku_code, display_name, unit_code, quantity, pieces, length_mm, width_mm)
      VALUES (v_order.id, NULL, 'DIRECT', btrim(v_item->>'display_name'),
              COALESCE(NULLIF(v_item->>'unit_code', ''), 'PCS'), v_qty,
              NULLIF(v_item->>'pieces', '')::int, NULLIF(v_item->>'length_mm', '')::numeric,
              NULLIF(v_item->>'width_mm', '')::numeric);
      CONTINUE;
    END IF;

    SELECT * INTO v_sku FROM skus WHERE id = (v_item->>'sku_id')::uuid;
    IF v_sku.id IS NULL THEN RAISE EXCEPTION 'A product on this order no longer exists.'; END IF;
    v_rubber := is_rubber(v_sku.product_type);

    IF is_lot_type(v_sku.product_type) THEN
      IF jsonb_typeof(v_segs) <> 'array' OR jsonb_array_length(v_segs) = 0 THEN
        RAISE EXCEPTION '% needs at least one % × PCS entry with a roll picked.', v_sku.sku_code, lot_unit_word(v_sku.id);
      END IF;
      v_qty := 0;
      FOR v_seg IN SELECT * FROM jsonb_array_elements(v_segs) LOOP
        v_mm  := (v_seg->>'mm')::numeric;
        v_pcs := (v_seg->>'pcs')::int;
        v_wid := NULLIF(v_seg->>'width', '')::numeric;
        IF v_mm IS NULL OR v_mm <= 0 OR v_pcs IS NULL OR v_pcs < 1 THEN
          RAISE EXCEPTION 'Each entry on % needs a length above zero and 1 or more pieces.', v_sku.sku_code;
        END IF;
        IF v_rubber AND (v_wid IS NULL OR v_wid <= 0) THEN
          RAISE EXCEPTION 'Each entry on % needs a width.', v_sku.sku_code;
        END IF;
        v_qty := v_qty + v_mm * v_pcs * CASE WHEN v_rubber THEN v_wid ELSE 1 END;
      END LOOP;
    ELSE
      IF jsonb_array_length(v_segs) > 0 THEN
        RAISE EXCEPTION '% is not kept in rolls — it has no roll to pick.', v_sku.sku_code;
      END IF;
      v_qty := (v_item->>'quantity')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter a quantity for % .', v_sku.sku_code; END IF;
    END IF;

    INSERT INTO production_order_items (order_id, sku_id, sku_code, display_name, unit_code, quantity, pieces, length_mm, width_mm)
    VALUES (
      v_order.id, v_sku.id, v_sku.sku_code, v_sku.display_name, v_sku.unit_code, v_qty,
      CASE WHEN jsonb_array_length(v_segs) = 1 THEN (v_segs->0->>'pcs')::int END,
      CASE WHEN jsonb_array_length(v_segs) = 1 THEN (v_segs->0->>'mm')::numeric END,
      CASE WHEN jsonb_array_length(v_segs) = 1 AND v_rubber THEN (v_segs->0->>'width')::numeric END
    ) RETURNING * INTO v_poi;

    v_seg_no := 0;
    FOR v_seg IN SELECT * FROM jsonb_array_elements(v_segs) LOOP
      v_seg_no := v_seg_no + 1;
      SELECT * INTO v_lot FROM sku_lots WHERE id = (v_seg->>'lot_id')::uuid;
      IF v_lot.id IS NULL OR v_lot.sku_id <> v_sku.id THEN
        RAISE EXCEPTION 'The roll picked for % does not belong to that product.', v_sku.sku_code;
      END IF;
      IF v_rubber THEN
        v_wid := (v_seg->>'width')::numeric;
        IF v_wid > v_lot.width_mm THEN
          RAISE EXCEPTION 'The roll picked for % is only % mm wide — a % mm wide piece cannot be cut from it.', v_sku.sku_code, v_lot.width_mm, v_wid;
        END IF;
        IF (v_seg->>'mm')::numeric * (v_seg->>'pcs')::int > v_lot.current_qty / v_lot.width_mm THEN
          RAISE EXCEPTION 'The roll picked for % has only % mm of length left — % pcs x % mm needs more.',
            v_sku.sku_code, v_lot.current_qty / v_lot.width_mm, (v_seg->>'pcs')::int, (v_seg->>'mm')::numeric;
        END IF;
        INSERT INTO lot_allocations (item_id, lot_id, allocated_qty, seg_no, seg_mm, seg_pcs, seg_width_mm)
        VALUES (v_poi.id, v_lot.id, (v_seg->>'mm')::numeric * (v_seg->>'pcs')::int * v_wid,
                v_seg_no, (v_seg->>'mm')::numeric, (v_seg->>'pcs')::int, v_wid);
      ELSE
        IF (v_seg->>'mm')::numeric > v_lot.current_qty THEN
          RAISE EXCEPTION 'Roll % is only % long — a % piece cannot be cut from it.',
            v_lot.lot_no, v_lot.current_qty, (v_seg->>'mm')::numeric;
        END IF;
        INSERT INTO lot_allocations (item_id, lot_id, allocated_qty, seg_no, seg_mm, seg_pcs)
        VALUES (v_poi.id, v_lot.id, (v_seg->>'mm')::numeric * (v_seg->>'pcs')::int,
                v_seg_no, (v_seg->>'mm')::numeric, (v_seg->>'pcs')::int);
      END IF;
    END LOOP;
  END LOOP;

  PERFORM log_audit('CREATE', 'PRODUCTION_ORDER', v_order.id::text, v_order.order_no,
                    NULL, v_order.status, 'WEB', 'Production order ' || v_order.order_no || ' created');

  RETURN jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no);
END $$;
REVOKE ALL ON FUNCTION create_production_order_full(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_production_order_full(jsonb) TO authenticated;

-- 13. production outward: an Open Roll plan is cut piece by piece, leaving its side strips ---------------------
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
  v_cut      jsonb;
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
      SELECT la.lot_id, la.allocated_qty, la.seg_mm, la.seg_pcs, la.seg_width_mm, sl.lot_no, sl.status, sl.width_mm
        FROM lot_allocations la
        JOIN sku_lots        sl ON sl.id = la.lot_id
       WHERE la.item_id = p_poi_id
       ORDER BY la.seg_no NULLS LAST, la.created_at
    LOOP
      IF v_row.width_mm IS NOT NULL AND v_row.seg_width_mm IS NOT NULL THEN
        v_cut := rubber_cut(v_row.lot_id, v_row.seg_mm, v_row.seg_width_mm, v_row.seg_pcs);
        v_drained := v_drained || (v_cut || jsonb_build_object('drained_qty', v_row.allocated_qty));
        v_break := v_break || v_cut;
      ELSE
        v_new_qty := drain_lot(v_row.lot_id, v_row.allocated_qty);
        v_drained := v_drained || jsonb_build_object(
          'lot_id', v_row.lot_id, 'lot_no', v_row.lot_no,
          'drained_qty', v_row.allocated_qty, 'remaining_qty', v_new_qty);
        v_break := v_break || jsonb_build_object('lot_no', v_row.lot_no, 'status', v_row.status, 'qty', v_row.allocated_qty);
      END IF;
    END LOOP;
    IF v_mov_id IS NOT NULL THEN
      UPDATE inventory_movements SET lot_breakdown = v_break WHERE id = v_mov_id;
    END IF;
  ELSIF v_poi.sku_id IS NOT NULL AND is_lot_tracked(v_poi.sku_id) THEN
    IF is_rubber((SELECT product_type FROM skus WHERE id = v_poi.sku_id)) THEN
      RAISE EXCEPTION 'Pick the roll for every Open Roll entry on the order before it is posted.';
    END IF;
    v_break := auto_drain_lots(v_poi.sku_id, v_poi.quantity, v_mov_id);
  END IF;

  RETURN v_result || jsonb_build_object('lots_drained', v_drained, 'lot_breakdown', v_break);
END $$;
GRANT EXECUTE ON FUNCTION record_production_outward_with_lots(uuid, text, text, text, uuid) TO authenticated;

-- 14. Transactions page: the before / after snapshot of an Open Roll also carries each roll's width ------------------
CREATE OR REPLACE FUNCTION lot_snapshot(p_sku_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object('status', status, 'each', current_qty, 'count', cnt)
             || CASE WHEN width_mm IS NOT NULL THEN jsonb_build_object('width_mm', width_mm) ELSE '{}'::jsonb END
           ORDER BY (status = 'FULL_SLEEVE'), width_mm NULLS FIRST, current_qty), '[]'::jsonb)
    FROM (SELECT status, current_qty, width_mm, count(*) AS cnt
            FROM sku_lots
           WHERE sku_id = p_sku_id AND status IN ('FULL_SLEEVE','CUT_PCS') AND current_qty > 0
           GROUP BY status, current_qty, width_mm) x;
$$;
GRANT EXECUTE ON FUNCTION lot_snapshot(uuid) TO authenticated;

SELECT 'ok' AS status;
