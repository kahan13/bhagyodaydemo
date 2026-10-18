-- =====================================================================================
-- 031  MSL (minimum stock level) in pieces for timing belts  +  "needs attention" flag
--
--   1. skus.missing_fields   text[]  — which identity fields an import could not fill
--                                       (e.g. {Make}); empty = complete. The product is
--                                       created anyway with the value 'UNSPECIFIED'.
--   2. v_sku_status          — stock_pieces + missing_fields appended at the end, and
--                              the low / out-of-stock test now compares MSL against
--                                 timing belts : number of pieces (lots) in stock
--                                 others       : stock, exactly as before
--                              min_stock_level itself is the MSL column (no new field).
--
-- Safe to run more than once.
-- =====================================================================================

ALTER TABLE skus ADD COLUMN IF NOT EXISTS missing_fields text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_skus_missing ON skus((cardinality(missing_fields) > 0)) WHERE cardinality(missing_fields) > 0;

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
  CASE WHEN e.eff <= 0 THEN 'OUT_OF_STOCK'
       WHEN e.eff < s.min_stock_level THEN 'LOW_STOCK'
       ELSE 'OK' END AS stock_status,
  GREATEST(s.min_stock_level - e.eff, 0) AS shortfall,
  CASE WHEN e.eff < s.min_stock_level
       THEN GREATEST(s.supplier_moq, s.min_stock_level - e.eff) ELSE 0 END
       AS suggested_purchase_qty,
  s.roll_length_mm,
  s.section, s.colour, s.length_mm, s.thickness_mm, s.remarks, s.created_via,
  e.eff AS stock_pieces,
  s.missing_fields
FROM skus s
JOIN brands b ON b.id = s.brand_id
JOIN product_families f ON f.id = s.family_id
LEFT JOIN suppliers sup ON sup.id = s.default_supplier_id
LEFT JOIN LATERAL (
  SELECT CASE WHEN s.product_type = 'TIMING_BELT'
              THEN (SELECT count(*) FROM sku_lots l
                     WHERE l.sku_id = s.id
                       AND l.status IN ('FULL_SLEEVE', 'CUT_PCS')
                       AND l.current_qty > 0)::numeric
              ELSE s.current_stock END AS eff
) e ON true;

GRANT SELECT ON v_sku_status TO authenticated;

SELECT 'ok' AS status,
       (SELECT count(*) FROM v_sku_status) AS products,
       (SELECT count(*) FROM skus WHERE cardinality(missing_fields) > 0) AS needing_attention;
