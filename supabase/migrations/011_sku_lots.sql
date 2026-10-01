-- =====================================================================================
-- 011 – SKU Lots (Roll / Sleeve Tracking)
--
-- WHAT THIS DOES:
--   Introduces per-roll lot tracking underneath the existing flat SKU stock system.
--   Every physical roll of belt becomes a `sku_lot` record with its own qty and status.
--
-- INVARIANT (enforced by all movement helpers):
--   SUM(sku_lots.current_qty WHERE sku_id = X AND status != 'WASTED')
--     = skus.current_stock for SKU X
--
-- STATUSES:
--   FULL_SLEEVE  → current_qty = inward_qty (untouched roll)
--   CUT_PCS      → current_qty < inward_qty (partially used)
--   EXHAUSTED    → current_qty = 0 (fully consumed, closed automatically)
--   WASTED       → manually marked, permanently closed, remaining qty written off
--
-- BACKWARD COMPATIBILITY:
--   All new columns on existing tables are nullable / have safe defaults.
--   Old movements (lot_id IS NULL) continue to work exactly as before.
--   lot_allocations on production_order_items defaults to '[]'.
--
-- Safe to re-run: IF NOT EXISTS / OR REPLACE guards throughout.
-- =====================================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add roll_length_mm to skus
--    Defines what "1 full roll" means for this SKU in its native unit (mm).
--    NULL = not yet defined. UI will warn on inward if not set.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE skus
  ADD COLUMN IF NOT EXISTS roll_length_mm numeric(14,2);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. sku_lots table
--    One row per physical roll ever received or seeded as opening balance.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sku_lots (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_no              text          NOT NULL UNIQUE,       -- e.g. LOT-20261001-0001
  sku_id              uuid          NOT NULL REFERENCES skus(id),

  -- Roll snapshot at time of creation
  roll_length_mm      numeric(14,2) NOT NULL,              -- what 1 full sleeve = for this SKU
  inward_qty          numeric(14,2) NOT NULL CHECK (inward_qty > 0),   -- qty when lot was created
  current_qty         numeric(14,2) NOT NULL CHECK (current_qty >= 0), -- remaining right now

  -- Status stored for query performance (auto-derived by helpers, never set manually)
  status              text          NOT NULL DEFAULT 'FULL_SLEEVE'
                      CHECK (status IN ('FULL_SLEEVE','CUT_PCS','EXHAUSTED','WASTED')),

  -- Links
  inward_movement_id  uuid          REFERENCES inventory_movements(id), -- NULL for opening-balance lots
  wasted_at           timestamptz,
  wasted_by           uuid          REFERENCES app_users(id),
  waste_reason        text,
  notes               text,

  created_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lots_sku_status ON sku_lots(sku_id, status);
CREATE INDEX IF NOT EXISTS idx_lots_lot_no     ON sku_lots(lot_no);
CREATE INDEX IF NOT EXISTS idx_lots_inward_mv  ON sku_lots(inward_movement_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Add lot_id to inventory_movements
--    Links a movement to the primary lot it affected.
--    NULL for legacy movements and multi-lot splits (those store detail in poi).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES sku_lots(id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Add lot_allocations to production_order_items
--    Stores how a single order item's qty was split across lots.
--    Format: [{"lot_id":"uuid","lot_no":"LOT-X","qty":25}, ...]
--    Empty array = no lot tracking yet (legacy rows).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE production_order_items
  ADD COLUMN IF NOT EXISTS lot_allocations jsonb NOT NULL DEFAULT '[]';


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Lot sequence for generating lot_no
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS lot_no_seq START 1;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Helper: generate_lot_no()
--    Returns a unique, date-prefixed lot number.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION generate_lot_no()
RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'LOT-' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYYMMDD') || '-' ||
         lpad(nextval('lot_no_seq')::text, 4, '0');
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Helper: derive_lot_status(current_qty, inward_qty)
--    Pure function, called after any qty change on a lot.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION derive_lot_status(
  p_current_qty numeric,
  p_inward_qty  numeric
)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_current_qty <= 0              THEN 'EXHAUSTED'
    WHEN p_current_qty < p_inward_qty   THEN 'CUT_PCS'
    ELSE                                      'FULL_SLEEVE'
  END;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Helper: create_opening_lot(sku_id, qty, status, roll_length_mm, notes)
--    Used during sheet import to seed existing inventory as opening lots.
--    Caller is responsible for having already set skus.current_stock correctly.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_opening_lot(
  p_sku_id        uuid,
  p_qty           numeric,
  p_status        text    DEFAULT 'FULL_SLEEVE',  -- as declared in the sheet
  p_roll_length   numeric DEFAULT NULL,           -- falls back to skus.roll_length_mm
  p_notes         text    DEFAULT 'Opening balance'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_roll_len  numeric;
  v_lot_id    uuid;
BEGIN
  -- Resolve roll length: explicit arg → SKU master → qty itself (best-effort)
  SELECT COALESCE(p_roll_length, s.roll_length_mm, p_qty)
    INTO v_roll_len
    FROM skus s WHERE s.id = p_sku_id;

  -- For a CUT_PCS opening lot the inward_qty can't be known exactly;
  -- we set inward_qty = roll_length so status derives correctly.
  INSERT INTO sku_lots (
    lot_no, sku_id, roll_length_mm,
    inward_qty, current_qty, status,
    inward_movement_id, notes
  ) VALUES (
    generate_lot_no(),
    p_sku_id,
    v_roll_len,
    CASE p_status WHEN 'CUT_PCS' THEN v_roll_len ELSE p_qty END,
    p_qty,
    p_status,
    NULL,  -- no inward movement for opening balance
    p_notes
  )
  RETURNING id INTO v_lot_id;

  RETURN v_lot_id;
END $$;

GRANT EXECUTE ON FUNCTION create_opening_lot(uuid, numeric, text, numeric, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Helper: create_inward_lot(inward_movement_id, sku_id, qty)
--    Called by receive_purchase_order_item after record_movement().
--    Creates one FULL_SLEEVE lot per roll received.
--    p_num_rolls: how many rolls are being received (default 1).
--    Total qty = p_qty_per_roll × p_num_rolls (must match the movement qty).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_inward_lot(
  p_movement_id   uuid,
  p_sku_id        uuid,
  p_qty_per_roll  numeric,
  p_num_rolls     int     DEFAULT 1,
  p_notes         text    DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_roll_len  numeric;
  v_lot_id    uuid;
  v_lot_ids   uuid[] := '{}';
  i           int;
BEGIN
  SELECT COALESCE(roll_length_mm, p_qty_per_roll)
    INTO v_roll_len
    FROM skus WHERE id = p_sku_id;

  FOR i IN 1..p_num_rolls LOOP
    INSERT INTO sku_lots (
      lot_no, sku_id, roll_length_mm,
      inward_qty, current_qty, status,
      inward_movement_id, notes
    ) VALUES (
      generate_lot_no(),
      p_sku_id,
      v_roll_len,
      p_qty_per_roll,
      p_qty_per_roll,
      'FULL_SLEEVE',
      p_movement_id,
      p_notes
    )
    RETURNING id INTO v_lot_id;

    v_lot_ids := v_lot_ids || v_lot_id;
  END LOOP;

  RETURN v_lot_ids;
END $$;

GRANT EXECUTE ON FUNCTION create_inward_lot(uuid, uuid, numeric, int, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Helper: drain_lot(lot_id, qty)
--     Deducts qty from a lot and updates its status.
--     Raises if lot is WASTED or EXHAUSTED, or qty exceeds current_qty.
--     Returns remaining qty.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION drain_lot(
  p_lot_id  uuid,
  p_qty     numeric
)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lot     sku_lots;
  v_new_qty numeric;
BEGIN
  SELECT * INTO v_lot FROM sku_lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lot % not found.', p_lot_id;
  END IF;
  IF v_lot.status IN ('WASTED','EXHAUSTED') THEN
    RAISE EXCEPTION 'Lot % is % and cannot be allocated from.', v_lot.lot_no, v_lot.status;
  END IF;
  IF p_qty > v_lot.current_qty THEN
    RAISE EXCEPTION 'Lot % only has % remaining, cannot drain %.', v_lot.lot_no, v_lot.current_qty, p_qty;
  END IF;

  v_new_qty := v_lot.current_qty - p_qty;

  UPDATE sku_lots
  SET current_qty = v_new_qty,
      status      = derive_lot_status(v_new_qty, v_lot.inward_qty)
  WHERE id = p_lot_id;

  RETURN v_new_qty;
END $$;

GRANT EXECUTE ON FUNCTION drain_lot(uuid, numeric) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Helper: restore_lot(lot_id, qty)
--     Adds qty back to a lot (used on production order cancel / movement reversal).
--     Will re-open an EXHAUSTED lot. Will NOT restore a WASTED lot.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION restore_lot(
  p_lot_id  uuid,
  p_qty     numeric
)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lot     sku_lots;
  v_new_qty numeric;
BEGIN
  SELECT * INTO v_lot FROM sku_lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lot % not found.', p_lot_id;
  END IF;
  IF v_lot.status = 'WASTED' THEN
    RAISE EXCEPTION 'Lot % is WASTED and cannot be restored.', v_lot.lot_no;
  END IF;

  v_new_qty := v_lot.current_qty + p_qty;

  -- Guard: never exceed original inward_qty
  IF v_new_qty > v_lot.inward_qty THEN
    RAISE EXCEPTION 'Restoring % to lot % would exceed its original inward qty of %.', p_qty, v_lot.lot_no, v_lot.inward_qty;
  END IF;

  UPDATE sku_lots
  SET current_qty = v_new_qty,
      status      = derive_lot_status(v_new_qty, v_lot.inward_qty)
  WHERE id = p_lot_id;

  RETURN v_new_qty;
END $$;

GRANT EXECUTE ON FUNCTION restore_lot(uuid, numeric) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Helper: mark_lot_wasted(lot_id, reason)
--     Permanently closes a lot. Posts a negative ADJUSTMENT to the book ledger
--     so current_stock stays in sync with lot totals.
--     Returns the qty that was written off.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mark_lot_wasted(
  p_lot_id  uuid,
  p_reason  text DEFAULT 'Marked as waste'
)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lot       sku_lots;
  v_sku       skus;
  v_user      app_users;
  v_writeoff  numeric;
BEGIN
  SELECT * INTO v_lot FROM sku_lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lot % not found.', p_lot_id;
  END IF;
  IF v_lot.status IN ('WASTED','EXHAUSTED') THEN
    RAISE EXCEPTION 'Lot % is already % — cannot waste.', v_lot.lot_no, v_lot.status;
  END IF;

  v_writeoff := v_lot.current_qty;

  SELECT * INTO v_sku  FROM skus      WHERE id = v_lot.sku_id;
  SELECT * INTO v_user FROM app_users WHERE id = auth.uid() LIMIT 1;

  -- Mark the lot
  UPDATE sku_lots
  SET status      = 'WASTED',
      current_qty = 0,
      wasted_at   = now(),
      wasted_by   = v_user.id,
      waste_reason= p_reason
  WHERE id = p_lot_id;

  -- Post ADJUSTMENT to keep book ledger in sync
  IF v_writeoff > 0 THEN
    PERFORM record_movement(
      v_sku.sku_code,
      'ADJUSTMENT',
      -v_writeoff,
      v_sku.unit_code,
      NULL,
      'Lot ' || v_lot.lot_no || ' wasted: ' || p_reason,
      'WEB',
      NULL,
      NULL
    );
  END IF;

  RETURN v_writeoff;
END $$;

GRANT EXECUTE ON FUNCTION mark_lot_wasted(uuid, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 13. View: v_sku_lots
--     Used by inventory view and SKU picker to show lot breakdown per SKU.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_sku_lots
WITH (security_invoker = on) AS
SELECT
  sl.id,
  sl.lot_no,
  sl.sku_id,
  sl.roll_length_mm,
  sl.inward_qty,
  sl.current_qty,
  sl.status,
  sl.inward_movement_id,
  sl.wasted_at,
  sl.waste_reason,
  sl.notes,
  sl.created_at,
  -- SKU fields for display
  s.sku_code,
  s.display_name,
  s.product_type,
  s.exact_size,
  s.unit_code,
  s.hier_l1,
  s.hier_l2,
  s.hier_l3,
  b.name  AS brand_name,
  f.code  AS family_code,
  -- Wasted-by user name
  u.full_name AS wasted_by_name,
  -- Roll context: how many mm out of original roll remain
  ROUND((sl.current_qty / NULLIF(sl.roll_length_mm, 0)) * 100, 1) AS pct_remaining
FROM sku_lots sl
JOIN skus            s ON s.id  = sl.sku_id
JOIN brands          b ON b.id  = s.brand_id
JOIN product_families f ON f.id  = s.family_id
LEFT JOIN app_users  u ON u.id  = sl.wasted_by;

GRANT SELECT ON v_sku_lots TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 14. RLS on sku_lots
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sku_lots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sku_lots' AND policyname = 'sl_select'
  ) THEN
    CREATE POLICY sl_select ON sku_lots FOR SELECT TO authenticated
      USING (has_permission('transactions.view'));
    CREATE POLICY sl_insert ON sku_lots FOR INSERT TO authenticated
      WITH CHECK (has_permission('transactions.create'));
    CREATE POLICY sl_update ON sku_lots FOR UPDATE TO authenticated
      USING (has_permission('transactions.create'));
  END IF;
END $$;
