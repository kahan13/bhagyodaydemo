-- =====================================================================================
-- 012 – Inward creates Lots (Step 4)
--
-- WHAT THIS DOES
--   1. FIX: adds roll_length_mm to v_sku_status (SKU Master + catalog read it from there;
--      migration 011 added the column to `skus` but not to this view).
--   2. purchase_order_items.received_rolls – remembers "3 rolls x 400mm" for each receipt,
--      so "Record Inward" can create the right lots later.
--   3. record_inward_with_lots() – ONE atomic call: posts the normal INWARD movement
--      (record_movement, untouched) AND creates one FULL_SLEEVE lot per roll.
--   4. Reversal trigger – reversing an inward closes its lots, but is BLOCKED if any of
--      those lots has already been used (cut) or wasted.
--   5. purge_transactional_data() made lot-aware so a demo-data reset does not hit FK errors.
--
-- NOTHING existing is modified: record_movement, receive_purchase_order_item,
-- reverse_movement and the production triggers are left exactly as they are.
-- Safe to re-run.
-- =====================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. v_sku_status + roll_length_mm  (new column appended at the END = safe replace)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_sku_status
WITH (security_invoker = on) AS
SELECT
  s.id, s.sku_code, s.product_type, s.display_name, s.exact_size,
  s.hier_l1, s.hier_l2, s.hier_l3, s.search_text,
  b.code AS brand_code, b.name AS brand_name,
  f.code AS family_code, f.name AS family_name, f.profile_group,
  s.belt_form, s.construction, s.standard, s.pitch_mm, s.pitch_length_mm,
  s.width_mm, s.teeth, s.nominal_length, s.length_designation, s.rack_location,
  s.unit_code, s.opening_stock, s.current_stock, s.min_stock_level,
  s.supplier_moq, s.reorder_quantity, s.is_active,
  sup.name AS supplier_name,
  CASE WHEN s.current_stock <= 0 THEN 'OUT_OF_STOCK'
       WHEN s.current_stock < s.min_stock_level THEN 'LOW_STOCK'
       ELSE 'OK' END AS stock_status,
  GREATEST(s.min_stock_level - s.current_stock, 0) AS shortfall,
  CASE WHEN s.current_stock < s.min_stock_level
       THEN GREATEST(s.supplier_moq, s.min_stock_level - s.current_stock) ELSE 0 END
       AS suggested_purchase_qty,
  s.roll_length_mm
FROM skus s
JOIN brands b ON b.id = s.brand_id
JOIN product_families f ON f.id = s.family_id
LEFT JOIN suppliers sup ON sup.id = s.default_supplier_id;

GRANT SELECT ON v_sku_status TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Remember roll breakdown per PO receipt
--    Format: [{"rolls":3,"roll_length":400}, {"rolls":1,"roll_length":200}]
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS received_rolls jsonb NOT NULL DEFAULT '[]';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. record_inward_with_lots
--    p_rolls  = [{"rolls":N,"roll_length":L}, ...]  (optional)
--    If p_rolls is omitted (voice entry, old screens, API callers):
--      - SKU has roll_length_mm and qty is an exact multiple  -> that many full rolls
--      - otherwise                                            -> ONE roll of the full qty
--    If p_rolls is given, it MUST add up to p_quantity (protects the stock invariant).
--    Returns the normal movement json PLUS lot_ids / lot_nos / lots_summary.
-- ─────────────────────────────────────────────────────────────────────────────
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


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Reversing an INWARD closes its lots – but only if none was touched.
--    (Reversal rows are OUTWARD + txn_mode REVERSAL + reversal_of = original id.)
--    Legacy inwards have no lots, so nothing happens for them.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_reverse_inward_lots()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bad sku_lots;
BEGIN
  IF NEW.txn_mode <> 'REVERSAL' OR NEW.txn_type <> 'OUTWARD' OR NEW.reversal_of IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_bad
    FROM sku_lots
   WHERE inward_movement_id = NEW.reversal_of
     AND (status <> 'FULL_SLEEVE' OR current_qty <> inward_qty)
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot reverse this inward: lot % is already % (% of % left). Use Adjust or Mark as Waste instead.',
      v_bad.lot_no, v_bad.status, v_bad.current_qty, v_bad.inward_qty;
  END IF;

  UPDATE sku_lots
     SET current_qty = 0,
         status      = 'EXHAUSTED',
         notes       = trim(both ' ' from COALESCE(notes || ' · ', '') || 'Inward reversed')
   WHERE inward_movement_id = NEW.reversal_of;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS movement_reverse_lots ON inventory_movements;
CREATE TRIGGER movement_reverse_lots
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_reverse_inward_lots();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. purge_transactional_data – detach lots from movements first (FK-safe)
--    Lots themselves are kept; only their links to the deleted movements are cleared.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purge_transactional_data()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('bhagyoday.allow_purge','on', true);
  UPDATE sku_lots SET inward_movement_id = NULL WHERE inward_movement_id IS NOT NULL;
  UPDATE inventory_movements SET lot_id = NULL WHERE lot_id IS NOT NULL;
  UPDATE inventory_movements SET reversed_by = NULL, is_reversed = FALSE;
  DELETE FROM inventory_movements;
  PERFORM setval('movement_no_seq', 1, false);
  PERFORM set_config('bhagyoday.allow_purge','off', true);
END $$;
