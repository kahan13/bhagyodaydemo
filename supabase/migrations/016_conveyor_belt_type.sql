-- =====================================================================================
-- 016 – Add CONVEYOR_BELT as a third product type
--
-- WHY
--   The real KAHAN workbook has three relevant sheets: Timing Belt, V-Belt and
--   Conveyor Belt. The app currently only allows product_type IN
--   ('TIMING_BELT','V_BELT') on skus and product_families (a CHECK constraint),
--   so a Conveyor Belt row can't be inserted no matter what the import screen
--   lets you map. This migration only widens those two constraints and adds
--   one new nullable column — nothing existing is touched or renamed.
--
-- WHAT THIS DOES
--   1. Widens the product_type CHECK constraint on `skus` to also allow
--      'CONVEYOR_BELT'.
--   2. Widens the same CHECK constraint on `product_families`.
--   3. Adds a nullable `colour` text column on `skus` (Conveyor Belt rows have
--      a COLOUR column with no existing home — every other product type just
--      leaves it NULL, so nothing else is affected).
--
-- WHAT THIS DOES NOT DO
--   - Does not touch any existing row.
--   - Does not add a has_conveyor_belts-style flag on `brands` — not needed:
--     brand type flags are informational display hints only, nothing reads
--     them to gate import or SKU logic.
--   - Does not change any trigger, function, or RLS policy.
--
-- Safe to re-run: constraint drops use IF EXISTS, and the column add uses
-- IF NOT EXISTS.
-- =====================================================================================

-- Drops whatever CHECK constraint currently governs product_type on a table
-- (by inspecting its actual definition, not by guessing its name — Supabase
-- may have auto-named it differently from the usual <table>_<col>_check
-- convention), then adds the widened one back under a known name.
DO $$
DECLARE
  v_conname text;
BEGIN
  -- ── 1. skus.product_type ──
  SELECT conname INTO v_conname
    FROM pg_constraint
   WHERE conrelid = 'skus'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%product_type%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE skus DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE skus ADD CONSTRAINT skus_product_type_check
    CHECK (product_type IN ('TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT'));

  -- ── 2. product_families.product_type ──
  SELECT conname INTO v_conname
    FROM pg_constraint
   WHERE conrelid = 'product_families'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%product_type%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE product_families DROP CONSTRAINT %I', v_conname);
  END IF;
  ALTER TABLE product_families ADD CONSTRAINT product_families_product_type_check
    CHECK (product_type IN ('TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT'));
END $$;

-- ── 3. New nullable colour column for Conveyor Belt rows ──
ALTER TABLE skus ADD COLUMN IF NOT EXISTS colour text;

-- ── 4. Verify ──
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname IN ('skus_product_type_check', 'product_families_product_type_check');
