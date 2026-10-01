-- =====================================================================================
-- 010 – Physical Production Stock
--
-- WHAT THIS DOES:
--   Maintains a separate `physical_prod_stock` on each SKU row that tracks
--   what is physically available for production order creation.
--
--   Book inventory  (skus.current_stock)   → only moves when INWARD/OUTWARD posted
--   Physical stock  (skus.physical_prod_stock) → moves when production orders are
--                                                 created, cancelled, or deleted
--
-- RULES (fully automatic, no human intervention):
--   1. On fresh start  → physical_prod_stock = current_stock (both equal)
--   2. Production order item created  → physical_prod_stock -= quantity
--   3. Production order CANCELLED or item deleted → physical_prod_stock += quantity
--   4. INWARD recorded  → physical_prod_stock += qty  (both rise together)
--   5. OUTWARD recorded → if physical > new_book_stock → physical syncs DOWN to new_book_stock
--      (i.e. the outward "consumed" production units; physical can never exceed book)
--   6. OUTWARD reversed → physical_prod_stock += reversal_qty  (mirrors book reversal)
--
-- MISMATCH:
--   physical_prod_stock < current_stock → MISMATCH (production has consumed stock
--   that hasn't been formalised as an OUTWARD entry yet)
--   Shown as a dedicated pane on the production orders page with which order caused
--   the drop and a one-click "Record Outward" button.
--
-- CANCELLED status:
--   Added to production_orders. Cancelling an order restores physical stock.
--
-- Safe to re-run: IF NOT EXISTS / OR REPLACE guards throughout.
-- =====================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Ensure 009 columns exist on production_order_items
--    Safe no-op if 009_soft_allocation.sql was already run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE production_order_items
  ADD COLUMN IF NOT EXISTS reserved_qty  numeric(14,2) NOT NULL DEFAULT 0
    CHECK (reserved_qty >= 0),
  ADD COLUMN IF NOT EXISTS is_fulfilled  boolean       NOT NULL DEFAULT false;

-- Back-fill: existing rows get reserved_qty = quantity
UPDATE production_order_items
SET reserved_qty = quantity
WHERE reserved_qty = 0 AND quantity > 0;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add physical_prod_stock to skus
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE skus
  ADD COLUMN IF NOT EXISTS physical_prod_stock numeric(14,2) NOT NULL DEFAULT 0;

-- On first run, seed physical = book stock (clean slate as agreed)
UPDATE skus
SET physical_prod_stock = current_stock
WHERE physical_prod_stock = 0;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add CANCELLED to production_orders status check
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE production_orders
  DROP CONSTRAINT IF EXISTS production_orders_status_check;

ALTER TABLE production_orders
  ADD CONSTRAINT production_orders_status_check
    CHECK (status IN ('CREATED','SENT','IN_PROGRESS','COMPLETED','CANCELLED'));


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Add source_production_order_item_id to inventory_movements
--    So we can link an OUTWARD entry back to the production order item that
--    caused it — used in the mismatch UI's "Record Outward" button.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS source_poi_id uuid REFERENCES production_order_items(id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Trigger: production_order_items INSERT → decrement physical stock
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_poi_physical_stock()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_order_status text;
BEGIN
  -- INSERT: check parent order is not cancelled/completed, then decrement
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_order_status
    FROM production_orders WHERE id = NEW.order_id;

    IF v_order_status NOT IN ('CANCELLED','COMPLETED') THEN
      UPDATE skus
      SET physical_prod_stock = physical_prod_stock - NEW.quantity,
          updated_at = now()
      WHERE id = NEW.sku_id;
    END IF;

  -- DELETE: restore physical stock (order deleted or item removed)
  ELSIF TG_OP = 'DELETE' THEN
    SELECT status INTO v_order_status
    FROM production_orders WHERE id = OLD.order_id;

    -- Only restore if the order wasn't already cancelled/completed
    -- (those paths restore via their own trigger)
    IF v_order_status NOT IN ('CANCELLED','COMPLETED') THEN
      UPDATE skus
      SET physical_prod_stock = physical_prod_stock + OLD.quantity,
          updated_at = now()
      WHERE id = OLD.sku_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS poi_physical_stock ON production_order_items;
CREATE TRIGGER poi_physical_stock
  AFTER INSERT OR DELETE ON production_order_items
  FOR EACH ROW EXECUTE FUNCTION trg_poi_physical_stock();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Trigger: production_orders status → CANCELLED → restore physical stock
--    (also handles COMPLETED → still frees ATP via existing 009 trigger)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_po_status_physical()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Order just became CANCELLED: restore physical stock for all open items
  -- Cap at current_stock so physical never exceeds book (e.g. outward was posted
  -- after the order was created, reducing book, then order is cancelled).
  IF NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED' THEN
    UPDATE skus s
    SET physical_prod_stock = LEAST(s.current_stock, s.physical_prod_stock + poi.quantity),
        updated_at = now()
    FROM production_order_items poi
    WHERE poi.order_id = NEW.id
      AND s.id = poi.sku_id
      AND poi.is_fulfilled = false;
  END IF;

  -- If reverting FROM cancelled back to an active status (edge case)
  IF OLD.status = 'CANCELLED' AND NEW.status NOT IN ('CANCELLED','COMPLETED') THEN
    UPDATE skus s
    SET physical_prod_stock = physical_prod_stock - poi.quantity,
        updated_at = now()
    FROM production_order_items poi
    WHERE poi.order_id = NEW.id
      AND s.id = poi.sku_id
      AND poi.is_fulfilled = false;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS po_status_physical ON production_orders;
CREATE TRIGGER po_status_physical
  AFTER UPDATE OF status ON production_orders
  FOR EACH ROW EXECUTE FUNCTION trg_po_status_physical();


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Trigger: inventory_movements INSERT → sync physical_prod_stock
--
--   INWARD  (txn_mode = 'NORMAL'):
--     physical += qty  (both rise together)
--
--   OUTWARD (txn_mode = 'NORMAL'):
--     if physical_prod_stock > new_book_stock → sync physical DOWN to new_book_stock
--     (the outward "consumed" what production had allocated)
--
--   REVERSAL of OUTWARD (txn_mode = 'REVERSAL', txn_type = 'INWARD' because
--     reversing an OUTWARD adds stock back):
--     physical += qty  (mirrors the book reversal)
--
--   REVERSAL of INWARD (txn_mode = 'REVERSAL', txn_type = 'OUTWARD'):
--     if physical > new_book_stock → sync physical DOWN to new_book_stock
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_movement_sync_physical()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_sku skus;
BEGIN
  SELECT * INTO v_sku FROM skus WHERE id = NEW.sku_id;

  -- INWARD (normal stock receipt) → add to physical as well
  IF NEW.txn_type = 'INWARD' AND NEW.txn_mode = 'NORMAL' THEN
    UPDATE skus
    SET physical_prod_stock = physical_prod_stock + NEW.quantity,
        updated_at = now()
    WHERE id = NEW.sku_id;

  -- OUTWARD (normal goods out) → clamp physical down to new book stock if needed
  ELSIF NEW.txn_type = 'OUTWARD' AND NEW.txn_mode = 'NORMAL' THEN
    UPDATE skus
    SET physical_prod_stock = LEAST(physical_prod_stock, NEW.new_stock),
        updated_at = now()
    WHERE id = NEW.sku_id;

  -- REVERSAL of OUTWARD (txn_type = INWARD, txn_mode = REVERSAL)
  -- Book went UP; physical should go UP too
  ELSIF NEW.txn_type = 'INWARD' AND NEW.txn_mode = 'REVERSAL' THEN
    UPDATE skus
    SET physical_prod_stock = physical_prod_stock + NEW.quantity,
        updated_at = now()
    WHERE id = NEW.sku_id;

  -- REVERSAL of INWARD (txn_type = OUTWARD, txn_mode = REVERSAL)
  -- Book went DOWN; clamp physical if it's now above book
  ELSIF NEW.txn_type = 'OUTWARD' AND NEW.txn_mode = 'REVERSAL' THEN
    UPDATE skus
    SET physical_prod_stock = LEAST(physical_prod_stock, NEW.new_stock),
        updated_at = now()
    WHERE id = NEW.sku_id;

  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS movement_sync_physical ON inventory_movements;
CREATE TRIGGER movement_sync_physical
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_movement_sync_physical();


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. v_production_stock_status  –  per-SKU mismatch view
--    Joins skus with their open (non-fulfilled, non-cancelled) production items
--    to show which orders are causing the mismatch.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_production_stock_status
WITH (security_invoker = on) AS
SELECT
  s.id                                                    AS sku_id,
  s.sku_code,
  s.display_name,
  s.unit_code,
  s.current_stock,
  s.physical_prod_stock,
  -- Gap: how much physical is below book (positive = physical is lower = mismatch)
  s.current_stock - s.physical_prod_stock                 AS stock_gap,
  -- A mismatch exists when physical < book (production has consumed stock
  -- that hasn't been posted as OUTWARD yet)
  s.physical_prod_stock < s.current_stock                 AS is_mismatched,
  -- Aggregate open production order items that are consuming this SKU's physical stock
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
        'created_at',   po.created_at
      ) ORDER BY po.created_at
    ) FILTER (
      WHERE poi.id IS NOT NULL
        AND poi.is_fulfilled = false
        AND po.status NOT IN ('COMPLETED','CANCELLED')
    ),
    '[]'::json
  )                                                       AS open_order_items
FROM skus s
LEFT JOIN production_order_items poi ON poi.sku_id = s.id
LEFT JOIN production_orders      po  ON po.id = poi.order_id
WHERE s.is_active = true
GROUP BY s.id, s.sku_code, s.display_name, s.unit_code,
         s.current_stock, s.physical_prod_stock;

GRANT SELECT ON v_production_stock_status TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Updated v_production_orders: include sku_code on items + physical context
-- ─────────────────────────────────────────────────────────────────────────────

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
        'reserved_qty', poi.reserved_qty,
        'is_fulfilled', poi.is_fulfilled,
        'notes',        poi.notes
      ) ORDER BY poi.created_at
    ) FILTER (WHERE poi.id IS NOT NULL),
    '[]'::json
  ) AS items
FROM production_orders po
LEFT JOIN production_order_items poi ON poi.order_id = po.id
GROUP BY po.id;


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. record_production_outward(poi_id, notes, channel)
--    One-click function called from the "Record Outward" button in the mismatch
--    pane. Looks up the production order item, records a proper OUTWARD movement
--    tied back to the order reference, and marks the item as fulfilled.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION record_production_outward(
  p_poi_id  uuid,
  p_notes   text    DEFAULT NULL,
  p_channel text    DEFAULT 'WEB'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      app_users;
  v_poi       production_order_items;
  v_order     production_orders;
  v_sku       skus;
  v_prev      numeric(14,2);
  v_new       numeric(14,2);
  v_txn_no    text;
  v_mov_id    uuid;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role does not allow recording outward transactions.';
  END IF;

  -- Fetch production order item
  SELECT * INTO v_poi FROM production_order_items WHERE id = p_poi_id FOR UPDATE;
  IF v_poi.id IS NULL THEN RAISE EXCEPTION 'Production order item not found.'; END IF;
  IF v_poi.is_fulfilled THEN RAISE EXCEPTION 'This item has already been fulfilled.'; END IF;

  -- Fetch parent order
  SELECT * INTO v_order FROM production_orders WHERE id = v_poi.order_id;
  IF v_order.status IN ('CANCELLED') THEN
    RAISE EXCEPTION 'Cannot record outward for a cancelled order.';
  END IF;

  -- Fetch SKU with lock
  SELECT * INTO v_sku FROM skus WHERE id = v_poi.sku_id FOR UPDATE;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'SKU not found.'; END IF;

  -- Validate sufficient book stock
  IF v_sku.current_stock < v_poi.quantity THEN
    RAISE EXCEPTION 'Insufficient book stock: need %, have % %.',
      v_poi.quantity, v_sku.current_stock, v_sku.unit_code;
  END IF;

  v_prev   := v_sku.current_stock;
  v_new    := v_prev - v_poi.quantity;
  v_txn_no := 'TXN-' || to_char(now(),'YYYYMM') || '-' ||
              lpad(nextval('movement_no_seq')::text, 5, '0');

  -- Insert the movement
  INSERT INTO inventory_movements(
    txn_no, sku_id, txn_type, txn_mode, quantity, unit_code,
    previous_stock, new_stock, occurred_at, user_id, user_name,
    channel, reference, notes, source_poi_id
  ) VALUES (
    v_txn_no, v_sku.id, 'OUTWARD', 'NORMAL', v_poi.quantity, v_sku.unit_code,
    v_prev, v_new, now(), v_user.id, v_user.full_name,
    p_channel,
    'PRO:' || v_order.order_no || COALESCE(' / ' || v_order.customer_name, ''),
    COALESCE(p_notes, 'Production outward for ' || v_order.order_no),
    p_poi_id
  ) RETURNING id INTO v_mov_id;

  -- Update book stock
  UPDATE skus SET current_stock = v_new, updated_at = now() WHERE id = v_sku.id;
  -- NOTE: the movement_sync_physical trigger will handle physical stock sync automatically.

  -- Mark item as fulfilled
  UPDATE production_order_items SET is_fulfilled = true WHERE id = p_poi_id;

  -- Audit
  PERFORM log_audit('CREATE','TRANSACTION', v_txn_no, v_sku.display_name,
    v_prev::text, v_new::text, p_channel,
    'Production OUTWARD ' || v_poi.quantity || ' ' || v_sku.unit_code ||
    ' for ' || v_order.order_no);

  RETURN jsonb_build_object(
    'txn_no',        v_txn_no,
    'sku_code',      v_sku.sku_code,
    'display_name',  v_sku.display_name,
    'quantity',      v_poi.quantity,
    'unit_code',     v_sku.unit_code,
    'previous_stock',v_prev,
    'new_stock',     v_new,
    'order_no',      v_order.order_no,
    'movement_id',   v_mov_id
  );
END $$;

GRANT EXECUTE ON FUNCTION record_production_outward(uuid, text, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. v_sku_atp updated to use physical_prod_stock instead of current_stock
--     as the base for ATP (so production page shows true available-to-promise)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_sku_atp
WITH (security_invoker = on) AS
SELECT
  s.id                      AS sku_id,
  s.sku_code,
  s.current_stock,
  s.physical_prod_stock,
  -- ATP is physical_prod_stock (already reduced by open production orders)
  -- No need to subtract reservations separately because physical_prod_stock
  -- IS the physical reality — it decrements on order creation directly.
  s.physical_prod_stock      AS atp_stock,
  -- reserved_qty kept for display compatibility (sum of open unfulfilled items)
  COALESCE(
    SUM(poi.reserved_qty) FILTER (
      WHERE poi.is_fulfilled = false
        AND po.status NOT IN ('COMPLETED','CANCELLED')
    ),
    0
  )                          AS reserved_qty
FROM skus s
LEFT JOIN production_order_items poi ON poi.sku_id = s.id
LEFT JOIN production_orders      po  ON po.id      = poi.order_id
GROUP BY s.id, s.sku_code, s.current_stock, s.physical_prod_stock;

GRANT SELECT ON v_sku_atp TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Done.
--
-- FLOW SUMMARY:
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │  ACTION                    │ current_stock │ physical_prod_stock        │
-- ├─────────────────────────────────────────────────────────────────────────┤
-- │  Start (fresh)             │     100       │       100   (MATCHED)      │
-- │  Create PRO order 30 mtrs  │     100       │        70   (MISMATCH)     │
-- │  Create PRO order 20 mtrs  │     100       │        50   (MISMATCH)     │
-- │  Record OUTWARD 50 mtrs    │      50       │        50   (MATCHED) ✓    │
-- │  Record INWARD  40 mtrs    │      90       │        90   (MATCHED) ✓    │
-- │  Cancel PRO order (20 mtrs)│      90       │        90→+20=110? NO—     │
-- │   → only if physical<book  │               │  physical was 90, +20=110  │
-- │   → but book=90, so clamp  │               │  → LEAST(110,90) on next   │
-- │   Actually: cancel restores│               │  physical directly = 90+20 │
-- │   but physical can't exceed│               │  hmm, we need extra guard  │
-- ├─────────────────────────────────────────────────────────────────────────┤
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Drop old clamp trigger if it exists from a previous run of this file.
--     The clamp was removed because it incorrectly suppressed INWARD increases.
--     Physical stock is now only capped inside the cancel-restore path itself.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS skus_clamp_physical ON skus;
DROP FUNCTION IF EXISTS trg_clamp_physical_stock();


-- ─────────────────────────────────────────────────────────────────────────────
-- 12. One-time repair: fix any SKUs where physical < book AND no open
--     production order items explain the gap (i.e. the gap was caused by the
--     now-removed clamp trigger incorrectly suppressing an INWARD).
--     This re-syncs physical = book for those SKUs only.
--     SKUs with a legitimate mismatch (open production orders) are left alone.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE skus s
SET physical_prod_stock = s.current_stock,
    updated_at = now()
WHERE s.physical_prod_stock < s.current_stock
  AND NOT EXISTS (
    SELECT 1
    FROM production_order_items poi
    JOIN production_orders po ON po.id = poi.order_id
    WHERE poi.sku_id = s.id
      AND poi.is_fulfilled = false
      AND po.status NOT IN ('COMPLETED','CANCELLED')
  );
