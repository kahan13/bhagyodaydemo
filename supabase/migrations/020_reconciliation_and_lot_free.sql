-- =====================================================================================
-- 020 – Traceable book-vs-physical reconciliation + free (unplanned) lot quantities
--
-- 1. prod_pending_adjustments
--    Every ADJUSTMENT movement (lot waste, stock-count correction, reversal of one)
--    moves BOOK stock only. A row is written here for it, pointing at the exact
--    movement, so the Production Orders "Mismatch" pane can say WHERE a difference
--    came from (e.g. "Lot LOT-… wasted: 7 mm") and reconcile it with one click:
--    resolve_prod_adjustment() applies the same delta to physical stock.
--    Inward and outward keep their existing automatic handling (migration 010).
--
-- 2. v_production_stock_status
--    stock_gap is now (book - physical - unresolved adjustments), i.e. only the
--    part still explained by pending OUTWARDS. Positive = pending outward,
--    negative = physical above book with nothing tracing it.
--
-- 3. v_lot_free / v_sku_lot_groups_free
--    A lot's quantity minus what open (unfulfilled) production orders already plan
--    to take from it. The order screen reads these, so a planned cut piece is not
--    offered a second time.
--
-- 4. set_item_lot_allocations enforces the same free-quantity rule.
--
-- Safe to re-run.
-- =====================================================================================

-- ── 1. Pending book-only movements ──
CREATE TABLE IF NOT EXISTS prod_pending_adjustments (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id  uuid          NOT NULL UNIQUE REFERENCES inventory_movements(id) ON DELETE CASCADE,
  sku_id       uuid          NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  delta        numeric(14,2) NOT NULL,          -- change made to BOOK stock (negative = removed)
  source       text          NOT NULL,          -- 'WASTE' | 'ADJUSTMENT'
  lot_no       text,
  reason       text,
  created_by   text,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid          REFERENCES app_users(id)
);
CREATE INDEX IF NOT EXISTS idx_ppa_open ON prod_pending_adjustments(sku_id) WHERE resolved_at IS NULL;

ALTER TABLE prod_pending_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ppa_select ON prod_pending_adjustments;
CREATE POLICY ppa_select ON prod_pending_adjustments FOR SELECT TO authenticated USING (true);
GRANT SELECT ON prod_pending_adjustments TO authenticated;

CREATE OR REPLACE FUNCTION trg_movement_pending_adjustment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_delta numeric := NEW.new_stock - NEW.previous_stock;
  v_lot   text    := substring(COALESCE(NEW.notes,'') from 'Lot (\S+) wasted');
BEGIN
  IF NEW.txn_type = 'ADJUSTMENT' AND v_delta <> 0 THEN
    INSERT INTO prod_pending_adjustments (movement_id, sku_id, delta, source, lot_no, reason, created_by, created_at)
    VALUES (NEW.id, NEW.sku_id, v_delta,
            CASE WHEN v_lot IS NOT NULL THEN 'WASTE' ELSE 'ADJUSTMENT' END,
            v_lot, NEW.notes, NEW.user_name, NEW.occurred_at)
    ON CONFLICT (movement_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS movement_pending_adjustment ON inventory_movements;
CREATE TRIGGER movement_pending_adjustment
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION trg_movement_pending_adjustment();

CREATE OR REPLACE FUNCTION resolve_prod_adjustment(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row prod_pending_adjustments;
  v_uid uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  SELECT * INTO v_row FROM prod_pending_adjustments WHERE id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Pending movement not found.'; END IF;
  IF v_row.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'Already reconciled.'; END IF;

  UPDATE skus
     SET physical_prod_stock = GREATEST(0, physical_prod_stock + v_row.delta),
         updated_at = now()
   WHERE id = v_row.sku_id;

  SELECT id INTO v_uid FROM app_users WHERE id = auth.uid() LIMIT 1;
  UPDATE prod_pending_adjustments SET resolved_at = now(), resolved_by = v_uid WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'sku_id', v_row.sku_id, 'applied_delta', v_row.delta);
END $$;
REVOKE ALL ON FUNCTION resolve_prod_adjustment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION resolve_prod_adjustment(uuid) TO authenticated;

-- ── 2. Mismatch view: explained-by-adjustment part removed ──
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
        'created_at',   po.created_at
      ) ORDER BY po.created_at
    ) FILTER (
      WHERE poi.id IS NOT NULL
        AND poi.is_fulfilled = false
        AND po.status NOT IN ('COMPLETED','CANCELLED')
    ),
    '[]'::json
  )                                                       AS open_order_items,
  COALESCE(pa.pending_net, 0)                             AS pending_net
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

-- ── 3. Free lot quantities ──
CREATE OR REPLACE VIEW v_lot_free
WITH (security_invoker = on) AS
SELECT
  l.id, l.lot_no, l.sku_id, l.status, l.roll_length_mm, l.inward_qty, l.current_qty, l.created_at,
  l.current_qty - COALESCE(sum(la.allocated_qty) FILTER (
      WHERE i.is_fulfilled = false AND po.status NOT IN ('COMPLETED','CANCELLED')), 0) AS free_qty
FROM sku_lots l
LEFT JOIN lot_allocations        la ON la.lot_id = l.id
LEFT JOIN production_order_items i  ON i.id = la.item_id
LEFT JOIN production_orders      po ON po.id = i.order_id
WHERE l.status IN ('FULL_SLEEVE','CUT_PCS') AND l.current_qty > 0
GROUP BY l.id;
GRANT SELECT ON v_lot_free TO authenticated;

CREATE OR REPLACE VIEW v_sku_lot_groups_free
WITH (security_invoker = on) AS
SELECT sku_id, status, current_qty AS piece_qty,
       count(*)::int AS pieces, sum(free_qty) AS total_qty
  FROM v_lot_free
 WHERE free_qty > 0
 GROUP BY sku_id, status, current_qty;
GRANT SELECT ON v_sku_lot_groups_free TO authenticated;

-- ── 4. Allocation check uses free quantity (other open orders' plans excluded) ──
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
       AND i.is_fulfilled = false AND po.status NOT IN ('COMPLETED','CANCELLED');

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

-- ── Verify ──
SELECT (SELECT count(*) FROM v_production_stock_status WHERE is_mismatched) AS mismatches,
       (SELECT count(*) FROM v_sku_lot_groups_free) AS free_groups;
