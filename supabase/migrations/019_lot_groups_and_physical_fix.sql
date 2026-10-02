-- =====================================================================================
-- 019 – Lot groups view, physical-stock repair, V-belt regrouping
--
-- 1. WHY EVERY SKU SHOWED "STOCK MISMATCH" / "0 avail"
--    The inventory import set skus.current_stock (book stock) but left
--    skus.physical_prod_stock (what production can actually use, see 010) at 0.
--    Production Orders compares the two, so all 62 SKUs looked mismatched and
--    the order search showed 0 available. This migration repairs the data;
--    the updated importer now keeps both in step.
--    Only SKUs with NO production-order lines are touched, so a real
--    reservation is never overwritten.
--
-- 2. v_sku_lot_groups
--    One row per (SKU, Full Sleeve / Cut Pcs, piece length):
--      L-165 OPTI | FULL_SLEEVE | 50 | 4 pieces | 200
--      L-165 OPTI | CUT_PCS     | 50 | 1 piece  |  50
--    Used by the Inventory view and the order SKU search to show each
--    classification separately.
--
-- 3. V-belt grouping: Product Family -> Make -> Section / Size
--    Existing V-belt rows had hier_l2 = Section; they become hier_l2 = Make and
--    hier_l3 = Size (Section stays in its own column). No re-import needed.
--
-- 4. wipe_inventory_type() now also resets physical stock.
--
-- Safe to re-run.
-- =====================================================================================

-- ── 1. Repair physical stock ──
UPDATE skus s
   SET physical_prod_stock = s.current_stock
 WHERE s.physical_prod_stock <> s.current_stock
   AND NOT EXISTS (SELECT 1 FROM production_order_items i WHERE i.sku_id = s.id);

-- ── 2. Lot groups ──
CREATE OR REPLACE VIEW v_sku_lot_groups
WITH (security_invoker = on) AS
SELECT
  l.sku_id,
  l.status,
  l.current_qty            AS piece_qty,
  count(*)::int            AS pieces,
  sum(l.current_qty)       AS total_qty
FROM sku_lots l
WHERE l.status IN ('FULL_SLEEVE','CUT_PCS') AND l.current_qty > 0
GROUP BY l.sku_id, l.status, l.current_qty;

GRANT SELECT ON v_sku_lot_groups TO authenticated;

-- ── 3. V-belt regrouping (Family > Make > Section/Size) ──
UPDATE skus s
   SET hier_l2 = b.name,
       hier_l3 = substr(s.exact_size, length(s.section) + 2)
  FROM brands b
 WHERE b.id = s.brand_id
   AND s.product_type = 'V_BELT'
   AND s.section IS NOT NULL
   AND s.exact_size LIKE s.section || '-%';

-- ── 4. wipe_inventory_type also resets physical stock ──
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
  UPDATE skus SET opening_stock = 0, current_stock = 0, physical_prod_stock = 0, updated_at = now()
   WHERE product_type = p_type;
END $$;

REVOKE ALL ON FUNCTION wipe_inventory_type(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wipe_inventory_type(text) TO service_role;

-- ── Verify: mismatches should now be 0, and lot groups should list your lots ──
SELECT
  (SELECT count(*) FROM skus WHERE physical_prod_stock <> current_stock) AS still_mismatched,
  (SELECT count(*) FROM v_sku_lot_groups) AS lot_groups;
