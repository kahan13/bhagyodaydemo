-- =====================================================================================
-- 015 – Full Demo Data Reset
--
-- Wipes EVERYTHING demo/catalog/transactional, so you can re-import your real
-- KAHAN sheet into a genuinely blank slate. Does NOT touch:
--   - roles, permissions, role_permissions, app_users  (your logins stay intact)
--   - units, app_settings                               (system config / UI prefs)
--
-- Runs in the order FK constraints require. Uses the existing
-- purge_transactional_data() (001/012, service-role only) for inventory_movements,
-- since that's the one place a trigger (guard_movement_write) blocks a plain
-- DELETE unless a special flag is set — reusing it instead of duplicating that
-- logic here.
--
-- Run this in the Supabase SQL Editor (it runs as a privileged role there, so
-- purge_transactional_data's service-role-only grant is fine).
-- Safe to re-run — every step is a DELETE, not a DROP, so running it twice on
-- an already-empty set of tables just deletes zero rows each time.
-- =====================================================================================


-- ── 1. Transactional ledger first (clears inventory_movements + unlinks sku_lots) ──
SELECT purge_transactional_data();

-- ── 2. Production orders (cascades lot_allocations automatically) ──
DELETE FROM production_order_items;
DELETE FROM production_orders;

-- ── 3. Purchase orders ──
DELETE FROM purchase_order_receipts;
DELETE FROM purchase_order_items;
DELETE FROM purchase_orders;

-- ── 4. Lots, then SKUs (lots reference skus) ──
DELETE FROM sku_lots;
DELETE FROM skus;

-- ── 5. Catalog structure (skus referenced these, so they come after) ──
DELETE FROM product_families;
DELETE FROM brands;
DELETE FROM suppliers;

-- ── 6. History / logs (optional but you asked for everything) ──
DELETE FROM import_batches;
DELETE FROM audit_logs;

-- ── 7. Reset sequences so new order numbers / lot numbers start from 1 again ──
SELECT setval('lot_no_seq', 1, false);
SELECT setval('purchase_order_no_seq', 1, false);
SELECT setval('production_order_no_seq', 1, false);
-- movement_no_seq is already reset inside purge_transactional_data() above.

-- ── 8. Verify — every count below should read 0 ──
SELECT
  (SELECT count(*) FROM skus)                  AS skus,
  (SELECT count(*) FROM brands)                AS brands,
  (SELECT count(*) FROM product_families)      AS families,
  (SELECT count(*) FROM suppliers)             AS suppliers,
  (SELECT count(*) FROM sku_lots)              AS lots,
  (SELECT count(*) FROM inventory_movements)   AS movements,
  (SELECT count(*) FROM purchase_orders)       AS purchase_orders,
  (SELECT count(*) FROM production_orders)     AS production_orders,
  (SELECT count(*) FROM lot_allocations)       AS lot_allocations,
  (SELECT count(*) FROM import_batches)        AS import_batches,
  (SELECT count(*) FROM audit_logs)            AS audit_logs;
