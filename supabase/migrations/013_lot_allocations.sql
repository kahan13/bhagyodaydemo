-- =====================================================================================
-- 013 – Lot Allocations for Production Orders (Step 6, rebuilt clean)
--
-- REPLACES a broken attempt at this migration that:
--   1. Selected s.brand_name directly on `skus` — that column only exists on `brands`
--      (joined as b.name). This is what threw "column s.brand_name does not exist".
--   2. Guarded allocation changes on production_orders.status = 'DRAFT' — a status
--      that never exists in this schema (001/006/010 only ever allow CREATED, SENT,
--      IN_PROGRESS, COMPLETED, CANCELLED). That guard would never have passed, ever.
-- This migration tears down anything the broken version may have partially created
-- and rebuilds it correctly. Safe to re-run.
--
-- DESIGN (mirrors the existing soft-allocation / physical-stock pattern in 009/010):
--   - Choosing which lots to pull from happens at order-item creation time, but the
--     chosen lots are NOT drained yet — same as physical_prod_stock dropping
--     immediately while current_stock (book ledger) only moves at actual OUTWARD.
--   - sku_lots are only drained when record_production_outward_with_lots() runs
--     (the "Record Outward" button), exactly when the book ledger movement posts.
--   - This keeps the core invariant intact:
--       SUM(sku_lots.current_qty WHERE sku_id = X AND status <> 'WASTED')
--         = skus.current_stock for SKU X
--   - Nothing in 001–012 is modified. record_production_outward (010) is wrapped,
--     not changed.
-- =====================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Tear down anything the broken 013 attempt may have left behind
--    Guarded: "DROP TRIGGER IF EXISTS x ON lot_allocations" still needs the
--    TABLE lot_allocations to exist — IF EXISTS only covers the trigger name,
--    not the table. The Supabase SQL editor runs a pasted script as one
--    transaction, so when the old migration's later CREATE VIEW failed, its
--    earlier CREATE TABLE was rolled back too — meaning lot_allocations may
--    genuinely not exist yet. Only attempt the trigger drops if the table
--    is actually there.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'lot_allocations'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_lock_allocs_on_non_draft_insert ON lot_allocations';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_lock_allocs_on_non_draft_delete ON lot_allocations';
  END IF;
END $$;

DROP FUNCTION IF EXISTS check_order_is_draft_for_allocation() CASCADE;
DROP VIEW IF EXISTS v_production_order_items_with_lots;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. lot_allocations table
--    Links one production_order_items row to one or more sku_lots, recording
--    how much of that item's quantity is planned to come from each lot.
--    (production_order_items.lot_allocations jsonb from migration 011 is left
--    in place but unused — this proper child table replaces it: it gives FK
--    integrity against sku_lots and is far easier to query/validate.)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lot_allocations (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid          NOT NULL,
  lot_id        uuid          NOT NULL REFERENCES sku_lots(id) ON DELETE RESTRICT,
  allocated_qty numeric(14,2) NOT NULL CHECK (allocated_qty > 0),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lot_allocations_item_id ON lot_allocations(item_id);
CREATE INDEX IF NOT EXISTS idx_lot_allocations_lot_id  ON lot_allocations(lot_id);

-- FK to production_order_items with CASCADE (idempotent re-add)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'lot_allocations_item_id_fkey'
      AND table_name      = 'lot_allocations'
  ) THEN
    ALTER TABLE lot_allocations DROP CONSTRAINT lot_allocations_item_id_fkey;
  END IF;
END $$;

ALTER TABLE lot_allocations
  ADD CONSTRAINT lot_allocations_item_id_fkey
  FOREIGN KEY (item_id)
  REFERENCES production_order_items(id)
  ON DELETE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RLS — same pattern as every other transactional table in this codebase
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE lot_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lot_allocations_select" ON lot_allocations;
CREATE POLICY "lot_allocations_select"
  ON lot_allocations FOR SELECT TO authenticated
  USING (has_permission('transactions.view'));

DROP POLICY IF EXISTS "lot_allocations_insert" ON lot_allocations;
CREATE POLICY "lot_allocations_insert"
  ON lot_allocations FOR INSERT TO authenticated
  WITH CHECK (has_permission('transactions.create'));

DROP POLICY IF EXISTS "lot_allocations_update" ON lot_allocations;
CREATE POLICY "lot_allocations_update"
  ON lot_allocations FOR UPDATE TO authenticated
  USING (has_permission('transactions.create'));

DROP POLICY IF EXISTS "lot_allocations_delete" ON lot_allocations;
CREATE POLICY "lot_allocations_delete"
  ON lot_allocations FOR DELETE TO authenticated
  USING (has_permission('transactions.create'));


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. updated_at trigger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_lot_allocations_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lot_allocations_updated_at ON lot_allocations;
CREATE TRIGGER trg_lot_allocations_updated_at
  BEFORE UPDATE ON lot_allocations
  FOR EACH ROW EXECUTE FUNCTION set_lot_allocations_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Lock guard — REAL statuses this time.
--    Blocks changes once the item is fulfilled, or its order is COMPLETED/
--    CANCELLED. No such thing as 'DRAFT' anywhere in this schema.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION check_item_open_for_allocation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fulfilled boolean;
  v_status    text;
BEGIN
  SELECT poi.is_fulfilled, po.status
    INTO v_fulfilled, v_status
    FROM production_order_items poi
    JOIN production_orders      po ON po.id = poi.order_id
   WHERE poi.id = COALESCE(NEW.item_id, OLD.item_id);

  IF v_fulfilled THEN
    RAISE EXCEPTION 'Lot allocations are locked: this item has already been fulfilled.';
  END IF;
  IF v_status IN ('COMPLETED','CANCELLED') THEN
    RAISE EXCEPTION 'Lot allocations are locked: order is %.', v_status;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_lock_allocs_on_closed_item ON lot_allocations;
CREATE TRIGGER trg_lock_allocs_on_closed_item
  BEFORE INSERT OR UPDATE OR DELETE ON lot_allocations
  FOR EACH ROW EXECUTE FUNCTION check_item_open_for_allocation();


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. set_item_lot_allocations(item_id, allocations)
--    Validates and (re)writes the full allocation plan for one order item in
--    one atomic call. allocations format: [{"lot_id":"uuid","qty":25}, ...]
--    Must add up exactly to the item's quantity. Each lot must belong to the
--    item's SKU, not be WASTED/EXHAUSTED, and have enough current_qty.
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- Validate every row before writing anything
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    SELECT * INTO v_lot FROM sku_lots WHERE id = (v_alloc->>'lot_id')::uuid FOR UPDATE;
    IF v_lot.id IS NULL THEN
      RAISE EXCEPTION 'Lot not found.';
    END IF;
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
    IF v_qty > v_lot.current_qty THEN
      RAISE EXCEPTION 'Lot % only has % available, cannot allocate %.', v_lot.lot_no, v_lot.current_qty, v_qty;
    END IF;

    v_total := v_total + v_qty;
  END LOOP;

  IF v_total <> v_poi.quantity THEN
    RAISE EXCEPTION 'Allocations add up to % but the item needs %.', v_total, v_poi.quantity;
  END IF;

  -- Replace the plan atomically
  DELETE FROM lot_allocations WHERE item_id = p_item_id;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    INSERT INTO lot_allocations (item_id, lot_id, allocated_qty)
    VALUES (p_item_id, (v_alloc->>'lot_id')::uuid, (v_alloc->>'qty')::numeric);
  END LOOP;

  RETURN jsonb_build_object('item_id', p_item_id, 'total_allocated', v_total);
END $$;

GRANT EXECUTE ON FUNCTION set_item_lot_allocations(uuid, jsonb) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. clear_item_lot_allocations(item_id)
--    Wipes the plan without requiring totals to match — used when a line item
--    is removed from the form, or its SKU is changed before saving.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION clear_item_lot_allocations(p_item_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM lot_allocations WHERE item_id = p_item_id;
$$;

GRANT EXECUTE ON FUNCTION clear_item_lot_allocations(uuid) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. v_poi_lot_allocations — FIXED view
--    The broken version selected s.brand_name directly on skus. brand_name
--    only exists on brands (b.name), joined here the same way v_sku_status
--    and v_movements already do it elsewhere in this codebase.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_poi_lot_allocations
WITH (security_invoker = on) AS
SELECT
  poi.id           AS item_id,
  poi.order_id,
  poi.sku_id,
  poi.quantity,
  poi.unit_code,
  poi.is_fulfilled,
  poi.notes,
  s.sku_code,
  s.exact_size,
  b.name           AS brand_name,
  s.roll_length_mm,
  COALESCE(
    json_agg(
      json_build_object(
        'allocation_id',  la.id,
        'lot_id',         la.lot_id,
        'allocated_qty',  la.allocated_qty,
        'lot_no',         sl.lot_no,
        'status',         sl.status,
        'roll_length_mm', sl.roll_length_mm,
        'current_qty',    sl.current_qty
      ) ORDER BY sl.created_at
    ) FILTER (WHERE la.id IS NOT NULL),
    '[]'::json
  )                AS allocations,
  COALESCE(SUM(la.allocated_qty), 0) AS total_allocated
FROM production_order_items poi
JOIN skus   s ON s.id = poi.sku_id
JOIN brands b ON b.id = s.brand_id
LEFT JOIN lot_allocations la ON la.item_id = poi.id
LEFT JOIN sku_lots        sl ON sl.id = la.lot_id
GROUP BY
  poi.id, poi.order_id, poi.sku_id, poi.quantity, poi.unit_code,
  poi.is_fulfilled, poi.notes, s.sku_code, s.exact_size, b.name, s.roll_length_mm;

GRANT SELECT ON v_poi_lot_allocations TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. record_production_outward_with_lots(poi_id, notes, channel)
--    Wraps the existing record_production_outward (010) — untouched — then
--    drains every lot in this item's allocation plan. One Postgres function
--    call is one transaction: if a lot can't be drained (e.g. another order
--    already used it up since this item was planned), the whole call rolls
--    back, including the movement and fulfilled flag record_production_outward
--    just set. Nothing is left half-done.
--
--    Items with no lot_allocations rows (V-belts, or legacy items created
--    before lot tracking) drain nothing — this is a safe superset of the
--    original function, so the UI can always call this one instead.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION record_production_outward_with_lots(
  p_poi_id  uuid,
  p_notes   text    DEFAULT NULL,
  p_channel text    DEFAULT 'WEB'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result  jsonb;
  v_row     record;
  v_new_qty numeric;
  v_drained jsonb := '[]'::jsonb;
BEGIN
  -- 1) Normal ledger entry + fulfilled flag — existing function, untouched
  v_result := record_production_outward(p_poi_id, p_notes, p_channel);

  -- 2) Drain each lot in this item's allocation plan, if any
  FOR v_row IN
    SELECT la.lot_id, la.allocated_qty, sl.lot_no
      FROM lot_allocations la
      JOIN sku_lots        sl ON sl.id = la.lot_id
     WHERE la.item_id = p_poi_id
  LOOP
    v_new_qty := drain_lot(v_row.lot_id, v_row.allocated_qty);
    v_drained := v_drained || jsonb_build_object(
      'lot_id',        v_row.lot_id,
      'lot_no',        v_row.lot_no,
      'drained_qty',   v_row.allocated_qty,
      'remaining_qty', v_new_qty
    );
  END LOOP;

  RETURN v_result || jsonb_build_object('lots_drained', v_drained);
END $$;

GRANT EXECUTE ON FUNCTION record_production_outward_with_lots(uuid, text, text) TO authenticated;
