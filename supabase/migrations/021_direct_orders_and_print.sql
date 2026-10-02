-- =====================================================================================
-- 021 – Direct (drop-ship) production orders + lot snapshot for printing
--
-- 1. Direct orders: the supplier ships straight to the customer, so there is no SKU and
--    no stock effect. production_orders.is_direct marks them; items may have no sku_id
--    (the typed product name goes in display_name, sku_code = 'DIRECT').
--    Staff are reminded to post the inward and outward entries by hand; the two
--    "done" ticks (who/when) live on the order and are set by set_direct_step().
--    Order numbers come from the same next_production_order_no() sequence as any order.
--
-- 2. lot_allocations remembers the lot's status and size AT PLANNING TIME
--    (e.g. Cut Pcs, 50 mm). After outward a Full Sleeve becomes a Cut Pcs, so without
--    this a printed order would later show the wrong classification.
--
-- Safe to re-run.
-- =====================================================================================

ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS is_direct          boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS direct_inward_at   timestamptz,
  ADD COLUMN IF NOT EXISTS direct_inward_by   text,
  ADD COLUMN IF NOT EXISTS direct_outward_at  timestamptz,
  ADD COLUMN IF NOT EXISTS direct_outward_by  text;

ALTER TABLE production_order_items ALTER COLUMN sku_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION set_direct_step(p_order_id uuid, p_step text, p_done boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text;
  v_direct boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF p_step NOT IN ('INWARD','OUTWARD') THEN RAISE EXCEPTION 'Unknown step %.', p_step; END IF;
  SELECT is_direct INTO v_direct FROM production_orders WHERE id = p_order_id;
  IF v_direct IS NULL THEN RAISE EXCEPTION 'Order not found.'; END IF;
  IF NOT v_direct THEN RAISE EXCEPTION 'Only direct orders use this.'; END IF;
  SELECT full_name INTO v_name FROM app_users WHERE id = auth.uid() LIMIT 1;

  IF p_step = 'INWARD' THEN
    UPDATE production_orders
       SET direct_inward_at  = CASE WHEN p_done THEN now() END,
           direct_inward_by  = CASE WHEN p_done THEN v_name END,
           updated_at = now()
     WHERE id = p_order_id;
  ELSE
    UPDATE production_orders
       SET direct_outward_at = CASE WHEN p_done THEN now() END,
           direct_outward_by = CASE WHEN p_done THEN v_name END,
           updated_at = now()
     WHERE id = p_order_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION set_direct_step(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_direct_step(uuid, text, boolean) TO authenticated;

-- ── Lot snapshot for printing ──
ALTER TABLE lot_allocations
  ADD COLUMN IF NOT EXISTS lot_status text,
  ADD COLUMN IF NOT EXISTS piece_qty  numeric(14,2);

CREATE OR REPLACE FUNCTION trg_lot_alloc_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lot_status IS NULL THEN
    SELECT status, current_qty INTO NEW.lot_status, NEW.piece_qty FROM sku_lots WHERE id = NEW.lot_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lot_alloc_snapshot ON lot_allocations;
CREATE TRIGGER lot_alloc_snapshot
  BEFORE INSERT ON lot_allocations
  FOR EACH ROW EXECUTE FUNCTION trg_lot_alloc_snapshot();

-- Existing plans: record the lot's current state (best available)
UPDATE lot_allocations la
   SET lot_status = l.status, piece_qty = l.current_qty
  FROM sku_lots l
 WHERE l.id = la.lot_id AND la.lot_status IS NULL;

SELECT (SELECT count(*) FROM production_orders WHERE is_direct) AS direct_orders,
       (SELECT count(*) FROM lot_allocations WHERE lot_status IS NULL) AS unsnapshotted;
