-- =====================================================================================
-- 008 – Production Order Line Items + Delete Support
-- Run in Supabase SQL Editor (safe to re-run: IF NOT EXISTS guards throughout)
-- =====================================================================================

-- -----------------------------------------------------------------------
-- 1. Line items table
--    Each production order can now have 1..N SKU line items.
--    The sku_id/quantity/unit_code columns on production_orders are kept
--    for backward compatibility with existing rows but are no longer used
--    for new orders (items live here instead).
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_order_items (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid          NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  sku_id       uuid          NOT NULL REFERENCES skus(id),
  sku_code     text          NOT NULL,          -- denormalised for fast display
  display_name text          NOT NULL,          -- denormalised
  unit_code    text          NOT NULL DEFAULT 'PCS',
  quantity     numeric(14,2) NOT NULL CHECK (quantity > 0),
  notes        text,
  created_at   timestamptz   NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------
-- 2. RLS
-- -----------------------------------------------------------------------
ALTER TABLE production_order_items ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'production_order_items' AND policyname = 'poi_prod_select'
  ) THEN
    CREATE POLICY poi_prod_select ON production_order_items
      FOR SELECT TO authenticated
      USING (has_permission('transactions.view'));

    CREATE POLICY poi_prod_insert ON production_order_items
      FOR INSERT TO authenticated
      WITH CHECK (has_permission('transactions.create'));

    CREATE POLICY poi_prod_delete ON production_order_items
      FOR DELETE TO authenticated
      USING (has_permission('transactions.create'));
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 3. Allow deleting production orders
--    (RLS policy for DELETE on production_orders)
-- -----------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'production_orders' AND policyname = 'prod_delete'
  ) THEN
    CREATE POLICY prod_delete ON production_orders
      FOR DELETE TO authenticated
      USING (has_permission('transactions.create'));
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 4. Helper view: orders with their items as JSON array
--    Used by the app to load everything in one query.
-- -----------------------------------------------------------------------
CREATE OR REPLACE VIEW v_production_orders
WITH (security_invoker = on) AS
SELECT
  po.*,
  COALESCE(
    json_agg(
      json_build_object(
        'id',           poi.id,
        'sku_id',       poi.sku_id,
        'sku_code',     poi.sku_code,
        'display_name', poi.display_name,
        'unit_code',    poi.unit_code,
        'quantity',     poi.quantity,
        'notes',        poi.notes
      ) ORDER BY poi.created_at
    ) FILTER (WHERE poi.id IS NOT NULL),
    '[]'::json
  ) AS items
FROM production_orders po
LEFT JOIN production_order_items poi ON poi.order_id = po.id
GROUP BY po.id;
