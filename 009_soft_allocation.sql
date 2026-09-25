-- =====================================================================================
-- 009 – Soft Allocation / Available-to-Promise (ATP)
--
-- Problem:  Production orders physically ship before an OUTWARD inventory entry is
--           posted.  Main inventory stays at 100 while 30 mtrs are already gone.
--           Next order sees 100 and over-commits.
--
-- Solution: Every production_order_items row carries reserved_qty (= quantity at
--           creation time) and an is_fulfilled flag (flipped when the matching
--           OUTWARD movement is posted).  A view v_sku_atp subtracts open
--           reservations from current_stock to give Available-to-Promise (ATP).
--           Main inventory_movements is never touched until goods physically move.
--
-- Safe to re-run: IF NOT EXISTS / OR REPLACE guards throughout.
-- =====================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. New columns on production_order_items
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE production_order_items
  ADD COLUMN IF NOT EXISTS reserved_qty  numeric(14,2) NOT NULL DEFAULT 0
    CHECK (reserved_qty >= 0),
  ADD COLUMN IF NOT EXISTS is_fulfilled  boolean       NOT NULL DEFAULT false;

-- Back-fill: existing rows get reserved_qty = quantity so they count correctly.
UPDATE production_order_items
SET    reserved_qty = quantity
WHERE  reserved_qty = 0
  AND  quantity > 0;

-- Mark items belonging to already-COMPLETED orders as fulfilled so they don't
-- keep reducing ATP forever.
UPDATE production_order_items poi
SET    is_fulfilled = true
FROM   production_orders po
WHERE  po.id    = poi.order_id
  AND  po.status = 'COMPLETED'
  AND  poi.is_fulfilled = false;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. v_sku_atp  –  per-SKU Available-to-Promise
--
--    atp_stock  = current_stock  −  SUM(reserved_qty on open, unfulfilled orders)
--
--    "Open" means status NOT IN ('COMPLETED', 'CANCELLED').
--    is_fulfilled = false means the matching OUTWARD entry hasn't been posted yet.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_sku_atp
WITH (security_invoker = on) AS
SELECT
  s.id                                          AS sku_id,
  s.sku_code,
  s.current_stock,
  COALESCE(
    SUM(poi.reserved_qty) FILTER (
      WHERE poi.is_fulfilled = false
        AND po.status NOT IN ('COMPLETED', 'CANCELLED')
    ),
    0
  )                                             AS reserved_qty,
  s.current_stock - COALESCE(
    SUM(poi.reserved_qty) FILTER (
      WHERE poi.is_fulfilled = false
        AND po.status NOT IN ('COMPLETED', 'CANCELLED')
    ),
    0
  )                                             AS atp_stock
FROM skus s
LEFT JOIN production_order_items poi ON poi.sku_id = s.id
LEFT JOIN production_orders      po  ON po.id      = poi.order_id
GROUP BY s.id, s.sku_code, s.current_stock;

GRANT SELECT ON v_sku_atp TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helper function: fulfill_production_order_items(order_id uuid)
--
--    Call this AFTER you post the OUTWARD inventory_movement for an order.
--    Sets is_fulfilled = true on all items so they drop out of ATP calculation.
--    Returns the count of rows updated.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fulfill_production_order_items(p_order_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE production_order_items
  SET    is_fulfilled = true
  WHERE  order_id     = p_order_id
    AND  is_fulfilled = false;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

GRANT EXECUTE ON FUNCTION fulfill_production_order_items(uuid) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Trigger: auto-set reserved_qty = quantity on INSERT
--
--    So the app doesn't have to pass reserved_qty explicitly—it's always
--    equal to quantity at creation time.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_poi_set_reserved()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- On insert, mirror quantity → reserved_qty
  IF TG_OP = 'INSERT' THEN
    NEW.reserved_qty := NEW.quantity;
  END IF;

  -- On update of quantity (before fulfillment), keep reserved_qty in sync
  IF TG_OP = 'UPDATE' AND NEW.is_fulfilled = false THEN
    NEW.reserved_qty := NEW.quantity;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS poi_set_reserved ON production_order_items;

CREATE TRIGGER poi_set_reserved
  BEFORE INSERT OR UPDATE ON production_order_items
  FOR EACH ROW
  EXECUTE FUNCTION trg_poi_set_reserved();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Trigger: auto-fulfill items when order status → COMPLETED
--
--    When someone marks an order COMPLETED (status advance in the UI),
--    is_fulfilled is set automatically.  The OUTWARD inventory entry is still
--    a separate manual step—but at minimum the ATP is freed once the order
--    is marked done, preventing double-counting.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_po_auto_fulfill()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED' THEN
    UPDATE production_order_items
    SET    is_fulfilled = true
    WHERE  order_id     = NEW.id
      AND  is_fulfilled = false;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS po_auto_fulfill ON production_orders;

CREATE TRIGGER po_auto_fulfill
  AFTER UPDATE OF status ON production_orders
  FOR EACH ROW
  EXECUTE FUNCTION trg_po_auto_fulfill();


-- ─────────────────────────────────────────────────────────────────────────────
-- Done.
--
-- Flow summary:
--   1. New PRO created  →  trg_poi_set_reserved fires, reserved_qty = quantity
--   2. v_sku_atp shows  →  current_stock − Σ(reserved_qty on open orders)
--   3. Order marked COMPLETED → trg_po_auto_fulfill fires, is_fulfilled = true
--      ATP is freed immediately (even before OUTWARD entry).
--   4. Operator posts OUTWARD inventory_movement  →  current_stock drops
--      ATP stays the same (reservation already freed in step 3).
--
-- If you prefer not to free ATP at COMPLETED status and want it only at the
-- OUTWARD entry moment, remove trigger #5 and call
--   SELECT fulfill_production_order_items('<order_id>')
-- in your OUTWARD entry handler instead.
-- =====================================================================================
