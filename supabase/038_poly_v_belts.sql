-- =====================================================================================
-- 038  Poly V Belts — a fourth product type
--
--   Poly V belts are stocked exactly like timing belts, but a piece is measured in RIBS, not in
--   millimetres:
--       Full Sleeve / Cut Pcs lots, each with its own rib count
--       inward and outward are  RIBS x PCS ; cutting a sleeve leaves a Cut Pcs remainder
--       purchase orders, production orders, Mismatch and Physical inventory behave the same way
--
--   What this file does
--     1. allows product_type POLY_V_BELT on skus and product_families
--     2. adds the unit RIB
--     3. is_lot_type(): "is this a lot-tracked type?" (timing belt or poly V belt) and makes
--        every function / view that used to ask "is it a timing belt?" ask that instead
--
-- Safe to run more than once. Run after 037.
-- =====================================================================================

-- 1. the new product type -------------------------------------------------------------
DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname FROM pg_constraint
   WHERE conrelid = 'skus'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%product_type%';
  IF v_conname IS NOT NULL THEN EXECUTE format('ALTER TABLE skus DROP CONSTRAINT %I', v_conname); END IF;
  ALTER TABLE skus ADD CONSTRAINT skus_product_type_check
    CHECK (product_type IN ('TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT', 'POLY_V_BELT'));

  SELECT conname INTO v_conname FROM pg_constraint
   WHERE conrelid = 'product_families'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%product_type%';
  IF v_conname IS NOT NULL THEN EXECUTE format('ALTER TABLE product_families DROP CONSTRAINT %I', v_conname); END IF;
  ALTER TABLE product_families ADD CONSTRAINT product_families_product_type_check
    CHECK (product_type IN ('TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT', 'POLY_V_BELT'));
END $$;

-- 2. the unit ---------------------------------------------------------------------------
INSERT INTO units (code, name, decimals) VALUES ('RIB', 'Ribs', 0)
ON CONFLICT (code) DO NOTHING;

-- 3. lot-tracked types --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_lot_type(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_type IN ('TIMING_BELT', 'POLY_V_BELT') $$;
GRANT EXECUTE ON FUNCTION is_lot_type(text) TO authenticated, anon;

-- the word used in messages: MM for timing belts, RIBS for poly V belts
CREATE OR REPLACE FUNCTION lot_unit_word(p_sku_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN (SELECT unit_code FROM skus WHERE id = p_sku_id) = 'RIB' THEN 'RIBS' ELSE 'MM' END
$$;
GRANT EXECUTE ON FUNCTION lot_unit_word(uuid) TO authenticated;

-- dashboard_summary()
CREATE OR REPLACE FUNCTION public.dashboard_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'total_skus',   (select count(*) from skus where is_active),
    'timing_skus',  (select count(*) from skus where is_active and is_lot_type(product_type)),
    'vbelt_skus',   (select count(*) from skus where is_active and product_type='V_BELT'),
    'low_stock',    (select count(*) from skus where is_active and current_stock>0 and current_stock<min_stock_level),
    'out_of_stock', (select count(*) from skus where is_active and current_stock<=0),
    'today_inward', (select count(*) from inventory_movements where txn_type='INWARD' and occurred_at>=date_trunc('day', now() at time zone 'Asia/Kolkata')),
    'today_outward',(select count(*) from inventory_movements where txn_type='OUTWARD' and occurred_at>=date_trunc('day', now() at time zone 'Asia/Kolkata')),
    'today_adjust', (select count(*) from inventory_movements where txn_type='ADJUSTMENT' and occurred_at>=date_trunc('day', now() at time zone 'Asia/Kolkata')),
    'month_moves',  (select count(*) from inventory_movements where occurred_at>=date_trunc('month', now() at time zone 'Asia/Kolkata')),
    'total_moves',  (select count(*) from inventory_movements)
  )
$function$;

-- trg_movement_sync_lots()
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
  v_brk   jsonb;
BEGIN
  IF COALESCE(current_setting('app.lot_managed', true), '') = '1' THEN RETURN NEW; END IF;
  IF NEW.txn_mode <> 'NORMAL' AND NEW.txn_type <> 'ADJUSTMENT' THEN RETURN NEW; END IF;

  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF NOT is_lot_type(v_sku.product_type) THEN RETURN NEW; END IF;      -- not lot-tracked

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
END $function$;

-- record_po_item_inward(uuid)
CREATE OR REPLACE FUNCTION public.record_po_item_inward(p_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Nothing waiting to be recorded for this line.'; END IF;
  UPDATE purchase_order_items SET inwarded_qty = inwarded_qty + v_total WHERE id = p_item_id;
  RETURN jsonb_build_object('item_id', p_item_id, 'posted', v_total, 'receipts', v_count);
END $function$;

-- repair_lot_drift()
CREATE OR REPLACE FUNCTION public.repair_lot_drift()
 RETURNS TABLE(sku_code text, book numeric, lots_before numeric, action text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r      record;
  v_diff numeric;
BEGIN
  FOR r IN
    SELECT s.id, s.sku_code AS code, s.current_stock AS bk,
           COALESCE((SELECT sum(l.current_qty) FROM sku_lots l
                      WHERE l.sku_id = s.id AND l.status IN ('FULL_SLEEVE','CUT_PCS')), 0) AS lots
      FROM skus s
     WHERE is_lot_type(s.product_type)
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
END $function$;

-- trg_check_lots_match_book()
CREATE OR REPLACE FUNCTION public.trg_check_lots_match_book()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sku  skus;
  v_lots numeric;
BEGIN
  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;
  IF NOT is_lot_type(v_sku.product_type) THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(current_qty), 0) INTO v_lots
    FROM sku_lots WHERE sku_id = NEW.sku_id AND status IN ('FULL_SLEEVE','CUT_PCS');
  IF v_lots <> v_sku.current_stock THEN
    RAISE EXCEPTION 'Not saved: % would end with % in rolls/cut pieces but % in book stock. Nothing was changed.',
      v_sku.sku_code, v_lots, v_sku.current_stock;
  END IF;
  RETURN NULL;
END $function$;

-- is_lot_tracked(uuid)
CREATE OR REPLACE FUNCTION public.is_lot_tracked(p_sku_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM skus WHERE id = p_sku_id AND is_lot_type(product_type));
$function$;

-- record_outward_with_lots(text,jsonb,text,text,text,text,uuid)
CREATE OR REPLACE FUNCTION public.record_outward_with_lots(p_sku_code text, p_rows jsonb, p_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_channel text DEFAULT 'WEB'::text, p_invoice_no text DEFAULT NULL::text, p_operated_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF NOT is_lot_type(v_sku.product_type) THEN
    RAISE EXCEPTION 'MM × PCS / RIBS × PCS outward is for timing belts and poly V belts only.';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Enter at least one % × PCS row.', lot_unit_word(v_sku.id);
  END IF;

  FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_pcs := COALESCE((v_grp->>'rolls')::int, 0);
    v_mm  := COALESCE((v_grp->>'roll_length')::numeric, 0);
    IF v_pcs < 1 OR v_mm <= 0 THEN
      RAISE EXCEPTION 'Each row needs a PCS of 1 or more and % above zero.', lot_unit_word(v_sku.id);
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
        RAISE EXCEPTION 'No % of % % or more is left in stock (% more piece(s) needed). Try % instead, or fewer pieces.',
          CASE v_src WHEN 'CUT_PCS' THEN 'Cut Pcs piece' ELSE 'Full Sleeve' END,
          v_mm, lower(lot_unit_word(v_sku.id)), v_pcs - v_i + 1,
          CASE v_src WHEN 'CUT_PCS' THEN 'Full Sleeve' ELSE 'Cut Pcs' END;
      END IF;

      PERFORM drain_lot(v_lot.id, v_mm);
      v_break := v_break || jsonb_build_object('lot_no', v_lot.lot_no, 'status', v_lot.status, 'qty', v_mm);
    END LOOP;
  END LOOP;

  UPDATE inventory_movements SET lot_breakdown = v_break WHERE id = v_mov_id;

  RETURN v_movement || jsonb_build_object('lot_breakdown', v_break, 'rows', p_rows);
END $function$;

-- receive_po_item(uuid,numeric,jsonb,text,boolean)
CREATE OR REPLACE FUNCTION public.receive_po_item(p_item_id uuid, p_qty numeric DEFAULT NULL::numeric, p_rolls jsonb DEFAULT NULL::jsonb, p_notes text DEFAULT NULL::text, p_complete boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        RAISE EXCEPTION 'Each row needs a PCS of 1 or more and % above zero.', lot_unit_word(v_item.sku_id);
      END IF;
      v_qty := v_qty + (v_grp->>'rolls')::int * (v_grp->>'roll_length')::numeric;
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
    -- Lot-wise: every piece that arrives completes one ordered piece, whatever its length.
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
END $function$;

-- record_inward_with_lots(text,numeric,jsonb,text,text,text,text,uuid)
CREATE OR REPLACE FUNCTION public.record_inward_with_lots(p_sku_code text, p_quantity numeric, p_rolls jsonb DEFAULT NULL::jsonb, p_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_channel text DEFAULT 'WEB'::text, p_invoice_no text DEFAULT NULL::text, p_operated_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      RAISE EXCEPTION 'Each row needs a QTY of 1 or more and % above zero.', lot_unit_word(v_sku.id);
    END IF;
    v_total := v_total + v_rolls * v_len;
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
END $function$;

-- v_movements
CREATE OR REPLACE VIEW v_movements WITH (security_invoker = on) AS
 SELECT m.id,
    m.txn_no,
    m.occurred_at,
    m.txn_type,
    m.txn_mode,
    m.quantity,
    m.unit_code,
    m.previous_stock,
    m.new_stock,
    m.reference,
    m.invoice_no,
    m.notes,
    m.channel,
    m.user_id,
    m.user_name,
    m.reversal_of,
    m.reversed_by,
    m.is_reversed,
    m.operated_by_user_id,
    op.full_name AS operated_by_name,
    s.sku_code,
    s.display_name,
    s.product_type,
    s.exact_size,
    b.name AS brand_name,
    f.code AS family_code,
    m.lot_breakdown,
    is_lot_type(s.product_type) AS lot_tracked,
    m.lot_state
   FROM ((((inventory_movements m
     JOIN skus s ON ((s.id = m.sku_id)))
     JOIN brands b ON ((b.id = s.brand_id)))
     JOIN product_families f ON ((f.id = s.family_id)))
     LEFT JOIN app_users op ON ((op.id = m.operated_by_user_id)));

-- v_sku_status
CREATE OR REPLACE VIEW v_sku_status WITH (security_invoker = on) AS
 SELECT s.id,
    s.sku_code,
    s.product_type,
    s.display_name,
    s.exact_size,
    s.hier_l1,
    s.hier_l2,
    s.hier_l3,
    s.search_text,
    b.code AS brand_code,
    b.name AS brand_name,
    f.code AS family_code,
    f.name AS family_name,
    f.profile_group,
    s.belt_form,
    s.construction,
    s.standard,
    s.pitch_mm,
    s.pitch_length_mm,
    s.width_mm,
    s.teeth,
    s.nominal_length,
    s.length_designation,
    s.rack_location,
    s.unit_code,
    s.opening_stock,
    s.current_stock,
    s.min_stock_level,
    s.supplier_moq,
    s.reorder_quantity,
    s.is_active,
    sup.name AS supplier_name,
        CASE
            WHEN (e.eff <= (0)::numeric) THEN 'OUT_OF_STOCK'::text
            WHEN (e.eff < s.min_stock_level) THEN 'LOW_STOCK'::text
            ELSE 'OK'::text
        END AS stock_status,
    GREATEST((s.min_stock_level - e.eff), (0)::numeric) AS shortfall,
        CASE
            WHEN (e.eff < s.min_stock_level) THEN GREATEST(s.supplier_moq, (s.min_stock_level - e.eff))
            ELSE (0)::numeric
        END AS suggested_purchase_qty,
    s.roll_length_mm,
    s.section,
    s.colour,
    s.length_mm,
    s.thickness_mm,
    s.remarks,
    s.created_via,
    e.eff AS stock_pieces,
    s.missing_fields
   FROM ((((skus s
     JOIN brands b ON ((b.id = s.brand_id)))
     JOIN product_families f ON ((f.id = s.family_id)))
     LEFT JOIN suppliers sup ON ((sup.id = s.default_supplier_id)))
     LEFT JOIN LATERAL ( SELECT
                CASE
                    WHEN is_lot_type(s.product_type) THEN (( SELECT count(*) AS count
                       FROM sku_lots l
                      WHERE ((l.sku_id = s.id) AND (l.status = ANY (ARRAY['FULL_SLEEVE'::text, 'CUT_PCS'::text])) AND (l.current_qty > (0)::numeric))))::numeric
                    ELSE s.current_stock
                END AS eff) e ON (true));

SELECT 'ok' AS status;
