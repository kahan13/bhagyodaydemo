-- =====================================================================================
-- 018 – Product & inventory fields redesigned around the real KAHAN sheets
--
-- WHAT CHANGES
--   1. Third product type CONVEYOR_BELT (widens both product_type CHECKs).
--      Includes everything migration 016 did, so you don't need 016 separately.
--   2. New SKU columns that mirror the sheets:
--        section        Timing / V-Belt: "SECTION OF ... BELT" (MXL, L, A, B ...)
--        colour         Conveyor: COLOUR
--        length_mm      Conveyor: L
--        thickness_mm   Conveyor: T      (conveyor width reuses existing width_mm)
--        remarks        manual remark shown in Inventory
--        identity_key   one normalised string per physical product, UNIQUE.
--                       This is how both imports (and manual adds) recognise
--                       "this is the same SKU" without relying on the SKU code.
--        created_via    MANUAL | SKU_IMPORT | INVENTORY_IMPORT
--   3. v_sku_status exposes the new columns (appended at the end = safe replace).
--   4. wipe_catalog_type(type) / wipe_inventory_type(type): the engines behind
--      "Overwrite". Both REFUSE (with a plain message) if the SKUs already have
--      movements, purchase-order lines or production-order lines, so history is
--      never half-deleted. Use 015_full_demo_reset.sql for a true clean slate.
--   5. Removes stale 'hierarchy_labels' overrides saved by the old importer
--      (they would override the new Family -> Section -> Size headings).
--
-- Safe to re-run.
-- =====================================================================================

-- ── 1. product_type CHECKs ──
DO $$
DECLARE v_conname text;
BEGIN
  SELECT conname INTO v_conname FROM pg_constraint
   WHERE conrelid = 'skus'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%product_type%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE skus DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE skus ADD CONSTRAINT skus_product_type_check
    CHECK (product_type IN ('TIMING_BELT','V_BELT','CONVEYOR_BELT'));

  SELECT conname INTO v_conname FROM pg_constraint
   WHERE conrelid = 'product_families'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%product_type%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE product_families DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE product_families ADD CONSTRAINT product_families_product_type_check
    CHECK (product_type IN ('TIMING_BELT','V_BELT','CONVEYOR_BELT'));
END $$;

-- ── 2. New SKU columns ──
ALTER TABLE skus ADD COLUMN IF NOT EXISTS section       text;
ALTER TABLE skus ADD COLUMN IF NOT EXISTS colour        text;
ALTER TABLE skus ADD COLUMN IF NOT EXISTS length_mm     numeric(12,2);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS thickness_mm  numeric(10,2);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS remarks       text;
ALTER TABLE skus ADD COLUMN IF NOT EXISTS identity_key  text;
ALTER TABLE skus ADD COLUMN IF NOT EXISTS created_via   text NOT NULL DEFAULT 'MANUAL';

CREATE UNIQUE INDEX IF NOT EXISTS uq_skus_identity_key
  ON skus(identity_key) WHERE identity_key IS NOT NULL;

-- ── 3. Units the new model relies on (timing belts count in MM, others in PCS) ──
INSERT INTO units (code, name, decimals) VALUES
  ('PCS',  'Pieces',      0),
  ('MM',   'Millimeters', 0),
  ('MTR',  'Meters',      2),
  ('ROLL', 'Rolls',       0),
  ('SET',  'Sets',        0),
  ('KG',   'Kilograms',   2)
ON CONFLICT (code) DO NOTHING;

-- ── 4. v_sku_status: append the new columns at the END ──
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
  s.roll_length_mm,
  s.section, s.colour, s.length_mm, s.thickness_mm, s.remarks, s.created_via
FROM skus s
JOIN brands b ON b.id = s.brand_id
JOIN product_families f ON f.id = s.family_id
LEFT JOIN suppliers sup ON sup.id = s.default_supplier_id;

GRANT SELECT ON v_sku_status TO authenticated;

-- ── 5. Overwrite engines ──
-- Both raise a readable exception when history exists. Service-role only.

CREATE OR REPLACE FUNCTION wipe_inventory_type(p_type text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_hist int;
BEGIN
  SELECT count(*) INTO v_hist FROM inventory_movements m
    JOIN skus s ON s.id = m.sku_id WHERE s.product_type = p_type;
  IF v_hist > 0 THEN
    RAISE EXCEPTION 'Cannot overwrite % inventory: % movement(s) already exist for these products. Run the full reset script (015) first, or use "Add" mode.', p_type, v_hist;
  END IF;

  SELECT count(*) INTO v_hist FROM lot_allocations la
    JOIN sku_lots l ON l.id = la.lot_id
    JOIN skus s ON s.id = l.sku_id WHERE s.product_type = p_type;
  IF v_hist > 0 THEN
    RAISE EXCEPTION 'Cannot overwrite % inventory: % lot allocation(s) exist on production orders. Run the full reset script (015) first, or use "Add" mode.', p_type, v_hist;
  END IF;

  DELETE FROM sku_lots WHERE sku_id IN (SELECT id FROM skus WHERE product_type = p_type);
  UPDATE skus SET opening_stock = 0, current_stock = 0, updated_at = now()
   WHERE product_type = p_type;
END $$;

CREATE OR REPLACE FUNCTION wipe_catalog_type(p_type text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_hist int;
BEGIN
  SELECT count(*) INTO v_hist FROM inventory_movements m
    JOIN skus s ON s.id = m.sku_id WHERE s.product_type = p_type;
  IF v_hist > 0 THEN
    RAISE EXCEPTION 'Cannot overwrite % products: % movement(s) already reference them. Run the full reset script (015) first, or use "Add new only" mode.', p_type, v_hist;
  END IF;

  SELECT count(*) INTO v_hist FROM production_order_items i
    JOIN skus s ON s.id = i.sku_id WHERE s.product_type = p_type;
  IF v_hist > 0 THEN
    RAISE EXCEPTION 'Cannot overwrite % products: % production-order line(s) reference them. Run the full reset script (015) first, or use "Add new only" mode.', p_type, v_hist;
  END IF;

  SELECT count(*) INTO v_hist FROM purchase_order_items i
    JOIN skus s ON s.id = i.sku_id WHERE s.product_type = p_type;
  IF v_hist > 0 THEN
    RAISE EXCEPTION 'Cannot overwrite % products: % purchase-order line(s) reference them. Run the full reset script (015) first, or use "Add new only" mode.', p_type, v_hist;
  END IF;

  DELETE FROM sku_lots WHERE sku_id IN (SELECT id FROM skus WHERE product_type = p_type);
  DELETE FROM skus WHERE product_type = p_type;
  DELETE FROM product_families
   WHERE product_type = p_type
     AND NOT EXISTS (SELECT 1 FROM skus s WHERE s.family_id = product_families.id);
END $$;

-- Read-only helper so the import PREVIEW can warn before you click Import:
-- how many records would block an Overwrite for this product type.
CREATE OR REPLACE FUNCTION type_history_count(p_type text)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (SELECT count(*) FROM inventory_movements m JOIN skus s ON s.id = m.sku_id WHERE s.product_type = p_type)
  + (SELECT count(*) FROM production_order_items i JOIN skus s ON s.id = i.sku_id WHERE s.product_type = p_type)
  + (SELECT count(*) FROM purchase_order_items i JOIN skus s ON s.id = i.sku_id WHERE s.product_type = p_type)
  + (SELECT count(*) FROM lot_allocations la JOIN sku_lots l ON l.id = la.lot_id
       JOIN skus s ON s.id = l.sku_id WHERE s.product_type = p_type)
$$;

REVOKE ALL ON FUNCTION wipe_inventory_type(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wipe_catalog_type(text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION type_history_count(text)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wipe_inventory_type(text) TO service_role;
GRANT EXECUTE ON FUNCTION wipe_catalog_type(text)   TO service_role;
GRANT EXECUTE ON FUNCTION type_history_count(text)  TO service_role;

-- ── 6. Drop stale heading overrides from the old importer ──
DELETE FROM app_settings WHERE key = 'hierarchy_labels';

-- Verify
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'skus' AND column_name IN
   ('section','colour','length_mm','thickness_mm','remarks','identity_key','created_via')
 ORDER BY column_name;
