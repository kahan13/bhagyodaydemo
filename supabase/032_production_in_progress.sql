-- =====================================================================================
-- 032  Production Order in Progress
--
--   1. "Sent" is gone. Orders go  CREATED → IN_PROGRESS → COMPLETED  (or CANCELLED).
--      Existing SENT orders become CREATED.
--   2. Marking an order COMPLETED no longer marks its items as "outward posted".
--      An item stays open — and its Record Outward button stays in Mismatch — until the
--      outward is really recorded. (The old trigger flipped the flag and the button vanished.)
--   3. Items of completed-but-not-yet-posted orders keep their lot plan reserved, so the
--      same rolls cannot be promised twice.
--   4. Deleting an order gives back the physical stock of every item whose outward has not
--      been posted (completed orders included).
--   5. Workshop staff can move an order forward without being able to edit orders:
--        set_production_order_status(order, 'IN_PROGRESS' | 'COMPLETED')
--   6. Per-user "unread" for the staff inbox:  production_order_reads  +
--        mark_production_order_read(order, true | false)
--   7. One-time repair: items that the old trigger flipped to "fulfilled" without any
--      outward being posted are re-opened (only while that SKU still shows a book/physical gap).
--
-- Safe to run more than once.  Run after 031.
-- =====================================================================================

-- ── 1. Remove SENT ───────────────────────────────────────────────────────────────────
-- (the auto-fulfil trigger goes first so this UPDATE cannot touch any item)
DROP TRIGGER  IF EXISTS po_auto_fulfill ON production_orders;
DROP FUNCTION IF EXISTS trg_po_auto_fulfill();

UPDATE production_orders SET status = 'CREATED' WHERE status = 'SENT';

ALTER TABLE production_orders DROP CONSTRAINT IF EXISTS production_orders_status_check;
ALTER TABLE production_orders
  ADD CONSTRAINT production_orders_status_check
  CHECK (status IN ('CREATED','IN_PROGRESS','COMPLETED','CANCELLED'));

-- ── 2. Re-open items the old trigger closed without an outward ───────────────────────
-- Newest orders first; stop once the SKU's book-vs-physical gap is covered.
WITH cand AS (
  SELECT poi.id,
         poi.quantity,
         GREATEST(s.current_stock - s.physical_prod_stock, 0) AS gap,
         COALESCE(sum(poi.quantity) OVER (
           PARTITION BY poi.sku_id ORDER BY po.created_at DESC, poi.created_at DESC
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_qty
    FROM production_order_items poi
    JOIN production_orders po ON po.id = poi.order_id
    JOIN skus s               ON s.id  = poi.sku_id
   WHERE po.status = 'COMPLETED'
     AND poi.is_fulfilled
     AND NOT EXISTS (SELECT 1 FROM inventory_movements m
                      WHERE m.source_poi_id = poi.id AND m.txn_type = 'OUTWARD')
)
UPDATE production_order_items poi
   SET is_fulfilled = false
  FROM cand
 WHERE cand.id = poi.id
   AND cand.gap > 0
   AND cand.before_qty < cand.gap;

-- ── 3. Open = not posted and not cancelled (COMPLETED orders stay open until posted) ──
-- (dropped first: older databases still hold the 009 version with different columns)
DROP VIEW IF EXISTS v_sku_atp;
CREATE VIEW v_sku_atp
WITH (security_invoker = on) AS
SELECT
  s.id                      AS sku_id,
  s.sku_code,
  s.current_stock,
  s.physical_prod_stock,
  s.physical_prod_stock      AS atp_stock,
  COALESCE(
    SUM(poi.reserved_qty) FILTER (
      WHERE poi.is_fulfilled = false
        AND po.status <> 'CANCELLED'
    ),
    0
  )                          AS reserved_qty
FROM skus s
LEFT JOIN production_order_items poi ON poi.sku_id = s.id
LEFT JOIN production_orders      po  ON po.id      = poi.order_id
GROUP BY s.id, s.sku_code, s.current_stock, s.physical_prod_stock;
GRANT SELECT ON v_sku_atp TO authenticated;

CREATE OR REPLACE VIEW v_production_stock_status
WITH (security_invoker = on) AS
SELECT
  s.id                                                    AS sku_id,
  s.sku_code,
  s.display_name,
  s.unit_code,
  s.current_stock,
  s.physical_prod_stock,
  s.current_stock - s.physical_prod_stock - COALESCE(pa.pending_net, 0) AS stock_gap,
  (s.current_stock - s.physical_prod_stock - COALESCE(pa.pending_net, 0)) <> 0 AS is_mismatched,
  COALESCE(
    json_agg(
      json_build_object(
        'poi_id',       poi.id,
        'order_id',     po.id,
        'order_no',     po.order_no,
        'customer_name',po.customer_name,
        'order_status', po.status,
        'quantity',     poi.quantity,
        'unit_code',    poi.unit_code,
        'pieces',       poi.pieces,
        'length_mm',    poi.length_mm,
        'created_at',   po.created_at
      ) ORDER BY po.created_at
    ) FILTER (
      WHERE poi.id IS NOT NULL
        AND poi.is_fulfilled = false
        AND po.status <> 'CANCELLED'
    ),
    '[]'::json
  )                                                       AS open_order_items,
  COALESCE(pa.pending_net, 0)                             AS pending_net,
  count(poi.id) FILTER (
    WHERE poi.is_fulfilled = false AND po.status <> 'CANCELLED')::int AS open_item_count
FROM skus s
LEFT JOIN production_order_items poi ON poi.sku_id = s.id
LEFT JOIN production_orders      po  ON po.id = poi.order_id
LEFT JOIN (
  SELECT sku_id, sum(delta) AS pending_net
    FROM prod_pending_adjustments WHERE resolved_at IS NULL GROUP BY sku_id
) pa ON pa.sku_id = s.id
WHERE s.is_active = true
GROUP BY s.id, s.sku_code, s.display_name, s.unit_code,
         s.current_stock, s.physical_prod_stock, pa.pending_net;
GRANT SELECT ON v_production_stock_status TO authenticated;

CREATE OR REPLACE VIEW v_lot_free
WITH (security_invoker = on) AS
SELECT
  l.id, l.lot_no, l.sku_id, l.status, l.roll_length_mm, l.inward_qty, l.current_qty, l.created_at,
  l.current_qty - COALESCE(sum(la.allocated_qty) FILTER (
      WHERE i.is_fulfilled = false AND po.status <> 'CANCELLED'), 0) AS free_qty
FROM sku_lots l
LEFT JOIN lot_allocations        la ON la.lot_id = l.id
LEFT JOIN production_order_items i  ON i.id = la.item_id
LEFT JOIN production_orders      po ON po.id = i.order_id
WHERE l.status IN ('FULL_SLEEVE','CUT_PCS') AND l.current_qty > 0
GROUP BY l.id;
GRANT SELECT ON v_lot_free TO authenticated;

-- Lot plan check: other orders' plans (including completed-but-not-posted ones) are excluded.
CREATE OR REPLACE FUNCTION set_item_lot_allocations(
  p_item_id     uuid,
  p_allocations jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_poi   production_order_items;
  v_order production_orders;
  v_alloc jsonb;
  v_lot   sku_lots;
  v_total numeric := 0;
  v_qty   numeric;
  v_other numeric;
BEGIN
  SELECT * INTO v_poi FROM production_order_items WHERE id = p_item_id FOR UPDATE;
  IF v_poi.id IS NULL THEN RAISE EXCEPTION 'Production order item not found.'; END IF;
  IF v_poi.is_fulfilled THEN
    RAISE EXCEPTION 'Cannot change lot allocation: this item has already been fulfilled.';
  END IF;

  SELECT * INTO v_order FROM production_orders WHERE id = v_poi.order_id;
  IF v_order.status IN ('COMPLETED','CANCELLED') THEN
    RAISE EXCEPTION 'Cannot change lot allocation: order is %.', v_order.status;
  END IF;

  IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' THEN
    RAISE EXCEPTION 'Allocations must be a JSON array.';
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    SELECT * INTO v_lot FROM sku_lots WHERE id = (v_alloc->>'lot_id')::uuid FOR UPDATE;
    IF v_lot.id IS NULL THEN RAISE EXCEPTION 'Lot not found.'; END IF;
    IF v_lot.sku_id <> v_poi.sku_id THEN
      RAISE EXCEPTION 'Lot % does not belong to this item''s SKU.', v_lot.lot_no;
    END IF;
    IF v_lot.status IN ('WASTED','EXHAUSTED') THEN
      RAISE EXCEPTION 'Lot % is % and cannot be allocated from.', v_lot.lot_no, v_lot.status;
    END IF;

    v_qty := (v_alloc->>'qty')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Allocation quantity must be greater than zero.';
    END IF;

    SELECT COALESCE(sum(la.allocated_qty), 0) INTO v_other
      FROM lot_allocations la
      JOIN production_order_items i ON i.id = la.item_id
      JOIN production_orders po     ON po.id = i.order_id
     WHERE la.lot_id = v_lot.id AND la.item_id <> p_item_id
       AND i.is_fulfilled = false AND po.status <> 'CANCELLED';

    IF v_qty > v_lot.current_qty - v_other THEN
      RAISE EXCEPTION 'Lot % has only % free (% already planned on other orders), cannot allocate %.',
        v_lot.lot_no, v_lot.current_qty - v_other, v_other, v_qty;
    END IF;

    v_total := v_total + v_qty;
  END LOOP;

  IF v_total <> v_poi.quantity THEN
    RAISE EXCEPTION 'Allocations add up to % but the item needs %.', v_total, v_poi.quantity;
  END IF;

  DELETE FROM lot_allocations WHERE item_id = p_item_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    INSERT INTO lot_allocations (item_id, lot_id, allocated_qty)
    VALUES (p_item_id, (v_alloc->>'lot_id')::uuid, (v_alloc->>'qty')::numeric);
  END LOOP;

  RETURN jsonb_build_object('item_id', p_item_id, 'total_allocated', v_total);
END $$;
GRANT EXECUTE ON FUNCTION set_item_lot_allocations(uuid, jsonb) TO authenticated;

-- ── 4. Deleting an order / item gives back what was never posted ─────────────────────
CREATE OR REPLACE FUNCTION trg_poi_physical_stock()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_order_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_order_status FROM production_orders WHERE id = NEW.order_id;
    IF v_order_status NOT IN ('CANCELLED','COMPLETED') THEN
      UPDATE skus
         SET physical_prod_stock = physical_prod_stock - NEW.quantity, updated_at = now()
       WHERE id = NEW.sku_id;
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    -- When the whole order is deleted the parent row is already gone, so a missing status
    -- counts as "not cancelled".  Cancelled orders restored their stock when cancelled;
    -- posted items left through the outward.  Everything else is given back.
    SELECT status INTO v_order_status FROM production_orders WHERE id = OLD.order_id;
    IF COALESCE(v_order_status, '') <> 'CANCELLED' AND NOT OLD.is_fulfilled THEN
      UPDATE skus
         SET physical_prod_stock = physical_prod_stock + OLD.quantity, updated_at = now()
       WHERE id = OLD.sku_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

-- ── 5. Staff move an order forward (no edit rights needed) ───────────────────────────
CREATE OR REPLACE FUNCTION set_production_order_status(p_order_id uuid, p_status text)
RETURNS production_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  app_users;
  v_order production_orders;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;

  SELECT * INTO v_order FROM production_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found.'; END IF;

  IF NOT ((v_order.status = 'CREATED'     AND p_status = 'IN_PROGRESS')
       OR (v_order.status = 'IN_PROGRESS' AND p_status = 'COMPLETED')) THEN
    RAISE EXCEPTION 'An order that is % cannot be moved to %.', v_order.status, p_status;
  END IF;

  UPDATE production_orders SET status = p_status, updated_at = now()
   WHERE id = p_order_id RETURNING * INTO v_order;

  PERFORM log_audit('UPDATE', 'PRODUCTION_ORDER', v_order.id::text, v_order.order_no,
                    NULL, p_status, 'WEB',
                    'Production order ' || v_order.order_no || ' marked ' || p_status);
  RETURN v_order;
END $$;
REVOKE ALL ON FUNCTION set_production_order_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_production_order_status(uuid, text) TO authenticated;

-- ── 6. Unread / read per user (staff inbox) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_order_reads (
  order_id uuid        NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  user_id  uuid        NOT NULL REFERENCES app_users(id)         ON DELETE CASCADE,
  read_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, user_id)
);
ALTER TABLE production_order_reads ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'production_order_reads' AND policyname = 'por_own_select') THEN
    CREATE POLICY por_own_select ON production_order_reads
      FOR SELECT TO authenticated
      USING (user_id = (SELECT u.id FROM current_app_user() u));
  END IF;
END $$;
GRANT SELECT ON production_order_reads TO authenticated;

CREATE OR REPLACE FUNCTION mark_production_order_read(p_order_id uuid, p_read boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user app_users;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF p_read THEN
    INSERT INTO production_order_reads (order_id, user_id) VALUES (p_order_id, v_user.id)
    ON CONFLICT (order_id, user_id) DO NOTHING;
  ELSE
    DELETE FROM production_order_reads WHERE order_id = p_order_id AND user_id = v_user.id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION mark_production_order_read(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_production_order_read(uuid, boolean) TO authenticated;

-- Orders that already exist count as read for everybody; only NEW orders arrive unread.
INSERT INTO production_order_reads (order_id, user_id)
SELECT po.id, u.id FROM production_orders po CROSS JOIN app_users u
ON CONFLICT (order_id, user_id) DO NOTHING;

-- ── Verify ───────────────────────────────────────────────────────────────────────────
SELECT 'ok' AS status,
       (SELECT count(*) FROM production_orders WHERE status = 'SENT')                         AS sent_left,
       (SELECT count(*) FROM production_order_items poi
          JOIN production_orders po ON po.id = poi.order_id
         WHERE po.status = 'COMPLETED' AND NOT poi.is_fulfilled)                              AS completed_not_posted,
       (SELECT count(*) FROM v_production_stock_status WHERE is_mismatched)                   AS mismatches;
