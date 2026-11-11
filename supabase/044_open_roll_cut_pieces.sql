-- =====================================================================================
-- 044  Open Roll / Rubber — cut pieces, reconcile, simple width x length arithmetic
--
--   Everything is WIDTH (mm) x LENGTH (m) — never square metres on screen.
--
--   CUT PIECE (a separate manual job, not an inventory movement):
--     pick a roll (say 100 mm x 50 m) and type the cut: width mm x length m x pieces
--       the pieces:        pcs x (cut width x cut length)
--       the partial roll:  (roll width - cut width) x (roll length - pcs x cut length)
--         (cut as wide as the roll -> only the length shrinks; cut as long as the roll -> only the width shrinks)
--     The cut is first PENDING: physical stock has changed, the book has not.
--     Mismatch -> "Open Roll - cut pieces" (and the production tab) show it until someone presses RECONCILE.
--     RECONCILE updates the book, writes one entry in Transactions (reversible), and unlocks production orders.
--     Until then no production order can be made for that product.
--
--   PRODUCTION ORDER / OUTWARD from a roll or cut piece: the piece width must equal the roll's width;
--     the outward only shortens that roll's length (50 x 50 m minus 50 x 10 m leaves 50 x 40 m).
--     So an Open Roll outward can be reversed again like any other.
--
-- Safe to run more than once. Run after 043.
-- =====================================================================================

-- 1. what a lot is --------------------------------------------------------------------------
ALTER TABLE sku_lots ADD COLUMN IF NOT EXISTS piece_kind text NOT NULL DEFAULT 'ROLL';
ALTER TABLE sku_lots ADD COLUMN IF NOT EXISTS cut_id     uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sku_lots_piece_kind_check') THEN
    ALTER TABLE sku_lots ADD CONSTRAINT sku_lots_piece_kind_check CHECK (piece_kind IN ('ROLL','CUT_PIECE','PARTIAL_ROLL'));
  END IF;
END $$;

-- 2. the cuts ------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS rubber_cut_seq;

CREATE TABLE IF NOT EXISTS rubber_cuts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cut_no           text NOT NULL UNIQUE,
  sku_id           uuid NOT NULL REFERENCES skus(id),
  source_lot_id    uuid NOT NULL REFERENCES sku_lots(id),
  src_width_mm     numeric NOT NULL,
  src_len_mm       numeric NOT NULL,
  cut_width_mm     numeric NOT NULL,
  cut_len_mm       numeric NOT NULL,
  pcs              int     NOT NULL CHECK (pcs > 0),
  partial_width_mm numeric,
  partial_len_mm   numeric,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RECONCILED','CANCELLED','REVERSED')),
  notes            text,
  created_by       uuid REFERENCES app_users(id),
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  reconciled_by    uuid REFERENCES app_users(id),
  reconciled_by_name text,
  reconciled_at    timestamptz,
  movement_id      uuid REFERENCES inventory_movements(id),
  piece_lot_ids    uuid[],
  partial_lot_id   uuid,
  cancelled_at     timestamptz,
  cancel_reason    text,
  reversed_at      timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rubber_cut_pending_per_lot ON rubber_cuts(source_lot_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_rubber_cuts_sku ON rubber_cuts(sku_id, status);
CREATE INDEX IF NOT EXISTS idx_rubber_cuts_movement ON rubber_cuts(movement_id);

ALTER TABLE rubber_cuts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_read ON rubber_cuts;
CREATE POLICY p_read ON rubber_cuts FOR SELECT TO authenticated USING (true);
GRANT SELECT ON rubber_cuts TO authenticated;

CREATE OR REPLACE VIEW v_rubber_cuts
WITH (security_invoker = on) AS
SELECT c.*,
       s.sku_code, s.display_name, s.product_type, s.hier_l1, s.hier_l2, s.hier_l3,
       sl.lot_no AS source_lot_no,
       m.txn_no  AS reconcile_txn_no
  FROM rubber_cuts c
  JOIN skus s          ON s.id  = c.sku_id
  JOIN sku_lots sl     ON sl.id = c.source_lot_id
  LEFT JOIN inventory_movements m ON m.id = c.movement_id;
GRANT SELECT ON v_rubber_cuts TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'rubber_cuts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE rubber_cuts;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rubber_has_pending(p_sku_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM rubber_cuts WHERE sku_id = p_sku_id AND status = 'PENDING')
$$;
GRANT EXECUTE ON FUNCTION rubber_has_pending(uuid) TO authenticated;

-- 3. views carry what kind of piece a lot is ------------------------------------------------
-- (new columns are always added at the END of a view)
CREATE OR REPLACE VIEW v_lot_free
WITH (security_invoker = on) AS
SELECT
  l.id, l.lot_no, l.sku_id, l.status, l.roll_length_mm, l.inward_qty, l.current_qty, l.created_at,
  l.current_qty - COALESCE(sum(
      CASE WHEN l.width_mm IS NOT NULL AND la.seg_mm IS NOT NULL AND la.seg_pcs IS NOT NULL
           THEN la.seg_mm * la.seg_pcs * l.width_mm
           ELSE la.allocated_qty END
    ) FILTER (WHERE i.is_fulfilled = false AND po.status <> 'CANCELLED'), 0) AS free_qty,
  l.width_mm,
  l.piece_kind
FROM sku_lots l
LEFT JOIN lot_allocations        la ON la.lot_id = l.id
LEFT JOIN production_order_items i  ON i.id = la.item_id
LEFT JOIN production_orders      po ON po.id = i.order_id
WHERE l.status IN ('FULL_SLEEVE','CUT_PCS') AND l.current_qty > 0
GROUP BY l.id;
GRANT SELECT ON v_lot_free TO authenticated;

CREATE OR REPLACE VIEW v_sku_lot_groups
WITH (security_invoker = on) AS
SELECT
  l.sku_id,
  l.status,
  l.current_qty            AS piece_qty,
  count(*)::int            AS pieces,
  sum(l.current_qty)       AS total_qty,
  l.width_mm,
  l.piece_kind
FROM sku_lots l
WHERE l.status IN ('FULL_SLEEVE','CUT_PCS') AND l.current_qty > 0
GROUP BY l.sku_id, l.status, l.current_qty, l.width_mm, l.piece_kind;
GRANT SELECT ON v_sku_lot_groups TO authenticated;

CREATE OR REPLACE VIEW v_sku_lot_groups_free
WITH (security_invoker = on) AS
SELECT sku_id, status, current_qty AS piece_qty,
       count(*)::int AS pieces, sum(free_qty) AS total_qty, width_mm, piece_kind
  FROM v_lot_free
 WHERE free_qty > 0
 GROUP BY sku_id, status, current_qty, width_mm, piece_kind;
GRANT SELECT ON v_sku_lot_groups_free TO authenticated;

CREATE OR REPLACE VIEW v_sku_lots
WITH (security_invoker = on) AS
SELECT
  sl.id, sl.lot_no, sl.sku_id, sl.roll_length_mm, sl.inward_qty, sl.current_qty, sl.status,
  sl.inward_movement_id, sl.wasted_at, sl.waste_reason, sl.notes, sl.created_at,
  s.sku_code, s.display_name, s.product_type, s.exact_size, s.unit_code,
  s.hier_l1, s.hier_l2, s.hier_l3,
  b.name  AS brand_name,
  f.code  AS family_code,
  u.full_name AS wasted_by_name,
  ROUND((sl.current_qty / NULLIF(CASE WHEN sl.width_mm IS NULL THEN sl.roll_length_mm ELSE sl.inward_qty END, 0)) * 100, 1) AS pct_remaining,
  sl.width_mm,
  sl.piece_kind
FROM sku_lots sl
JOIN skus            s ON s.id  = sl.sku_id
JOIN brands          b ON b.id  = s.brand_id
JOIN product_families f ON f.id  = s.family_id
LEFT JOIN app_users  u ON u.id  = sl.wasted_by;
GRANT SELECT ON v_sku_lots TO authenticated;

-- 4. a roll that has a pending cut may not be used, wasted or outwarded until it is reconciled ------
CREATE OR REPLACE FUNCTION trg_lot_pending_cut_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(current_setting('app.rubber_cut_op', true), '') = '1' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM rubber_cuts WHERE source_lot_id = OLD.id AND status = 'PENDING') THEN
    RAISE EXCEPTION 'Roll % has a cut piece waiting to be reconciled. Reconcile or cancel that cut first (Mismatch > Open Roll).', OLD.lot_no;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lot_pending_cut_lock ON sku_lots;
CREATE TRIGGER lot_pending_cut_lock BEFORE UPDATE OF current_qty, status ON sku_lots
  FOR EACH ROW WHEN (OLD.width_mm IS NOT NULL) EXECUTE FUNCTION trg_lot_pending_cut_lock();

-- 5. a cut-piece reconcile is not a "pending adjustment" for production to acknowledge ----------------
CREATE OR REPLACE FUNCTION public.trg_movement_pending_adjustment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_delta numeric := NEW.new_stock - NEW.previous_stock;
  v_lot   text    := substring(COALESCE(NEW.notes,'') from 'Lot (\S+) wasted');
BEGIN
  IF COALESCE(NEW.reference,'') ~ '^CUT-' THEN RETURN NEW; END IF;      -- cut piece reconcile / its reversal
  IF NEW.txn_type = 'ADJUSTMENT' AND v_delta <> 0 THEN
    INSERT INTO prod_pending_adjustments (movement_id, sku_id, delta, source, lot_no, reason, created_by, created_at)
    VALUES (NEW.id, NEW.sku_id, v_delta,
            CASE WHEN v_lot IS NOT NULL
                   OR (NEW.txn_mode = 'NORMAL' AND COALESCE(NEW.notes,'') ILIKE 'Marked as waste%')
                 THEN 'WASTE' ELSE 'ADJUSTMENT' END,
            v_lot, NEW.notes, NEW.user_name, NEW.occurred_at)
    ON CONFLICT (movement_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $function$;

-- 6. create a cut (PENDING: physical only) --------------------------------------------------
CREATE OR REPLACE FUNCTION create_rubber_cut(
  p_lot_id uuid, p_width_mm numeric, p_len_mm numeric, p_pcs int, p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  app_users;
  v_lot   sku_lots;
  v_sku   skus;
  v_free  numeric;
  v_len   numeric;
  v_block numeric;
  v_pw    numeric;
  v_pl    numeric;
  v_no    text;
  v_cut   rubber_cuts;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN RAISE EXCEPTION 'Your role cannot create cut pieces.'; END IF;

  SELECT * INTO v_lot FROM sku_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'That roll no longer exists. Reload and pick again.'; END IF;
  SELECT * INTO v_sku FROM skus WHERE id = v_lot.sku_id;
  IF NOT is_rubber(v_sku.product_type) THEN RAISE EXCEPTION 'Cut pieces are for Open Roll products only.'; END IF;
  IF v_lot.status NOT IN ('FULL_SLEEVE','CUT_PCS') OR v_lot.current_qty <= 0 THEN
    RAISE EXCEPTION 'That roll is no longer in stock. Pick another roll.';
  END IF;
  IF v_lot.width_mm IS NULL OR v_lot.width_mm <= 0 THEN RAISE EXCEPTION 'This roll has no width recorded.'; END IF;
  IF p_width_mm IS NULL OR p_width_mm <= 0 OR p_len_mm IS NULL OR p_len_mm <= 0 OR p_pcs IS NULL OR p_pcs < 1 THEN
    RAISE EXCEPTION 'Enter the cut piece width, length and number of pieces.';
  END IF;
  IF EXISTS (SELECT 1 FROM rubber_cuts WHERE source_lot_id = v_lot.id AND status = 'PENDING') THEN
    RAISE EXCEPTION 'This roll already has a cut piece waiting to be reconciled.';
  END IF;

  SELECT free_qty INTO v_free FROM v_lot_free WHERE id = v_lot.id;
  IF COALESCE(v_free, 0) < v_lot.current_qty THEN
    RAISE EXCEPTION 'Roll % is already planned in a production order. Cut a roll that is not planned.', v_lot.lot_no;
  END IF;

  v_len   := v_lot.current_qty / v_lot.width_mm;
  v_block := p_len_mm * p_pcs;
  IF p_width_mm > v_lot.width_mm THEN
    RAISE EXCEPTION 'A % mm wide piece cannot be cut from a roll that is only % mm wide.', p_width_mm, v_lot.width_mm;
  END IF;
  IF v_block > v_len THEN
    RAISE EXCEPTION 'This roll is only % mm long, but % pcs x % mm needs % mm.', v_len, p_pcs, p_len_mm, v_block;
  END IF;

  -- the partial roll: whatever width / length is left
  v_pw := CASE WHEN p_width_mm = v_lot.width_mm THEN v_lot.width_mm ELSE v_lot.width_mm - p_width_mm END;
  v_pl := CASE WHEN v_block = v_len THEN v_len ELSE v_len - v_block END;
  IF p_width_mm = v_lot.width_mm AND v_block = v_len THEN v_pw := NULL; v_pl := NULL; END IF;

  v_no := 'CUT-' || to_char(now(),'YYYYMM') || '-' || lpad(nextval('rubber_cut_seq')::text, 5, '0');
  INSERT INTO rubber_cuts (cut_no, sku_id, source_lot_id, src_width_mm, src_len_mm, cut_width_mm, cut_len_mm, pcs,
                           partial_width_mm, partial_len_mm, notes, created_by, created_by_name)
  VALUES (v_no, v_sku.id, v_lot.id, v_lot.width_mm, v_len, p_width_mm, p_len_mm, p_pcs,
          v_pw, v_pl, NULLIF(btrim(p_notes), ''), v_user.id, v_user.full_name)
  RETURNING * INTO v_cut;

  PERFORM log_audit('CREATE', 'CUT_PIECE', v_cut.id::text, v_no, NULL, 'PENDING', 'WEB',
                    'Cut piece ' || v_no || ' planned from ' || v_lot.lot_no);
  RETURN jsonb_build_object('cut_id', v_cut.id, 'cut_no', v_no);
END $$;
REVOKE ALL ON FUNCTION create_rubber_cut(uuid, numeric, numeric, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_rubber_cut(uuid, numeric, numeric, int, text) TO authenticated;

-- 7. cancel a pending cut -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cancel_rubber_cut(p_cut_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user app_users; v_cut rubber_cuts;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN RAISE EXCEPTION 'Your role cannot cancel cut pieces.'; END IF;
  SELECT * INTO v_cut FROM rubber_cuts WHERE id = p_cut_id FOR UPDATE;
  IF v_cut.id IS NULL THEN RAISE EXCEPTION 'That cut does not exist.'; END IF;
  IF v_cut.status <> 'PENDING' THEN RAISE EXCEPTION '% is already %.', v_cut.cut_no, lower(v_cut.status); END IF;
  UPDATE rubber_cuts SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = NULLIF(btrim(p_reason), '') WHERE id = v_cut.id;
  PERFORM log_audit('CANCEL', 'CUT_PIECE', v_cut.id::text, v_cut.cut_no, 'PENDING', 'CANCELLED', 'WEB', COALESCE(p_reason, 'Cut cancelled'));
  RETURN jsonb_build_object('cut_no', v_cut.cut_no);
END $$;
REVOKE ALL ON FUNCTION cancel_rubber_cut(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_rubber_cut(uuid, text) TO authenticated;

-- 8. reconcile: book stock follows the physical cut; one reversible Transactions entry --------------
CREATE OR REPLACE FUNCTION reconcile_rubber_cut(p_cut_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user   app_users;
  v_cut    rubber_cuts;
  v_lot    sku_lots;
  v_sku    skus;
  v_free   numeric;
  v_src    numeric;
  v_new_a  numeric;
  v_delta  numeric;
  v_prev   numeric;
  v_next   numeric;
  v_no     text;
  v_mov    uuid;
  v_id     uuid;
  v_ids    uuid[] := '{}';
  v_pid    uuid;
  v_lno    text;
  v_break  jsonb;
  i        int;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN RAISE EXCEPTION 'Your role cannot reconcile cut pieces.'; END IF;

  SELECT * INTO v_cut FROM rubber_cuts WHERE id = p_cut_id FOR UPDATE;
  IF v_cut.id IS NULL THEN RAISE EXCEPTION 'That cut does not exist.'; END IF;
  IF v_cut.status <> 'PENDING' THEN RAISE EXCEPTION '% is already %.', v_cut.cut_no, lower(v_cut.status); END IF;

  SELECT * INTO v_lot FROM sku_lots WHERE id = v_cut.source_lot_id FOR UPDATE;
  SELECT * INTO v_sku FROM skus WHERE id = v_cut.sku_id FOR UPDATE;
  v_src := v_cut.src_width_mm * v_cut.src_len_mm;
  IF v_lot.status NOT IN ('FULL_SLEEVE','CUT_PCS') OR v_lot.current_qty <> v_src THEN
    RAISE EXCEPTION 'Roll % changed after this cut was planned. Cancel this cut and plan it again.', v_lot.lot_no;
  END IF;
  SELECT free_qty INTO v_free FROM v_lot_free WHERE id = v_lot.id;
  IF COALESCE(v_free, 0) < v_lot.current_qty THEN
    RAISE EXCEPTION 'Roll % is now planned in a production order. Cancel this cut.', v_lot.lot_no;
  END IF;

  v_new_a := v_cut.pcs * v_cut.cut_width_mm * v_cut.cut_len_mm
             + COALESCE(v_cut.partial_width_mm * v_cut.partial_len_mm, 0);
  v_delta := v_new_a - v_src;                       -- 0 when the arithmetic leaves nothing out
  v_prev  := v_sku.current_stock;
  v_next  := v_prev + v_delta;
  IF v_next < 0 THEN RAISE EXCEPTION 'This would take stock below zero.'; END IF;

  PERFORM set_config('app.lot_managed',   '1', true);
  PERFORM set_config('app.rubber_cut_op', '1', true);

  -- the movement first, so "before" is the state before the cut
  v_no := 'TXN-' || to_char(now(),'YYYYMM') || '-' || lpad(nextval('movement_no_seq')::text, 5, '0');
  INSERT INTO inventory_movements (txn_no, sku_id, txn_type, txn_mode, quantity, unit_code, previous_stock, new_stock,
                                   occurred_at, user_id, user_name, channel, reference, notes)
  VALUES (v_no, v_sku.id, 'ADJUSTMENT', 'NORMAL', v_delta, v_sku.unit_code, v_prev, v_next,
          now(), v_user.id, v_user.full_name, 'WEB', v_cut.cut_no, 'Cut piece reconciled · ' || v_cut.cut_no)
  RETURNING id INTO v_mov;

  UPDATE sku_lots SET current_qty = 0, status = 'EXHAUSTED',
         notes = trim(both ' ' from COALESCE(notes || ' · ', '') || 'Cut into pieces (' || v_cut.cut_no || ')')
   WHERE id = v_lot.id;

  v_break := jsonb_build_array(jsonb_build_object(
      'cut', true, 'cut_no', v_cut.cut_no, 'lot_no', v_lot.lot_no, 'status', 'EXHAUSTED', 'qty', v_src,
      'src_width_mm', v_cut.src_width_mm, 'src_len_mm', v_cut.src_len_mm,
      'cut_width_mm', v_cut.cut_width_mm, 'cut_len_mm', v_cut.cut_len_mm, 'pcs', v_cut.pcs,
      'partial_width_mm', v_cut.partial_width_mm, 'partial_len_mm', v_cut.partial_len_mm));

  FOR i IN 1..v_cut.pcs LOOP
    v_lno := generate_lot_no();
    INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, width_mm, inward_qty, current_qty, status, is_cut, inward_movement_id, notes, piece_kind, cut_id)
    VALUES (v_lno, v_sku.id, v_cut.cut_len_mm, v_cut.cut_width_mm, v_cut.cut_width_mm * v_cut.cut_len_mm,
            v_cut.cut_width_mm * v_cut.cut_len_mm, 'FULL_SLEEVE', true, NULL,
            'Cut piece from ' || v_lot.lot_no || ' (' || v_cut.cut_no || ')', 'CUT_PIECE', v_cut.id)
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
    v_break := v_break || jsonb_build_object('lot_no', v_lno, 'status', 'FULL_SLEEVE', 'qty', v_cut.cut_width_mm * v_cut.cut_len_mm,
                 'width_mm', v_cut.cut_width_mm, 'len_mm', v_cut.cut_len_mm, 'new_lot', true, 'piece', 'CUT_PIECE');
  END LOOP;

  IF v_cut.partial_width_mm IS NOT NULL AND v_cut.partial_len_mm IS NOT NULL THEN
    v_lno := generate_lot_no();
    INSERT INTO sku_lots (lot_no, sku_id, roll_length_mm, width_mm, inward_qty, current_qty, status, is_cut, inward_movement_id, notes, piece_kind, cut_id)
    VALUES (v_lno, v_sku.id, v_cut.partial_len_mm, v_cut.partial_width_mm, v_cut.partial_width_mm * v_cut.partial_len_mm,
            v_cut.partial_width_mm * v_cut.partial_len_mm, 'FULL_SLEEVE', true, NULL,
            'Partial roll left from ' || v_lot.lot_no || ' (' || v_cut.cut_no || ')', 'PARTIAL_ROLL', v_cut.id)
    RETURNING id INTO v_pid;
    v_break := v_break || jsonb_build_object('lot_no', v_lno, 'status', 'FULL_SLEEVE', 'qty', v_cut.partial_width_mm * v_cut.partial_len_mm,
                 'width_mm', v_cut.partial_width_mm, 'len_mm', v_cut.partial_len_mm, 'new_lot', true, 'piece', 'PARTIAL_ROLL');
  END IF;

  UPDATE skus SET current_stock = v_next, physical_prod_stock = physical_prod_stock + v_delta, updated_at = now() WHERE id = v_sku.id;
  UPDATE inventory_movements SET lot_breakdown = v_break WHERE id = v_mov;
  UPDATE rubber_cuts SET status = 'RECONCILED', reconciled_by = v_user.id, reconciled_by_name = v_user.full_name,
         reconciled_at = now(), movement_id = v_mov, piece_lot_ids = v_ids, partial_lot_id = v_pid WHERE id = v_cut.id;

  PERFORM set_config('app.lot_managed',   '', true);
  PERFORM set_config('app.rubber_cut_op', '', true);

  PERFORM log_audit('RECONCILE', 'CUT_PIECE', v_cut.id::text, v_cut.cut_no, 'PENDING', 'RECONCILED', 'WEB',
                    'Cut piece ' || v_cut.cut_no || ' reconciled (' || v_no || ')');
  RETURN jsonb_build_object('cut_no', v_cut.cut_no, 'txn_no', v_no);
END $$;
REVOKE ALL ON FUNCTION reconcile_rubber_cut(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reconcile_rubber_cut(uuid) TO authenticated;

-- 9. reversing the reconcile entry in Transactions puts the roll back --------------------------------
CREATE OR REPLACE FUNCTION trg_reverse_rubber_cut()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cut   rubber_cuts;
  v_lot   sku_lots;
  v_src   sku_lots;
  v_ids   uuid[];
  v_orders text;
  v_txn   text;
  v_break jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_cut FROM rubber_cuts WHERE movement_id = NEW.reversal_of;
  IF v_cut.id IS NULL THEN RETURN NEW; END IF;
  IF v_cut.status <> 'RECONCILED' THEN RAISE EXCEPTION '% is already %.', v_cut.cut_no, lower(v_cut.status); END IF;

  v_ids := COALESCE(v_cut.piece_lot_ids, '{}') || CASE WHEN v_cut.partial_lot_id IS NOT NULL THEN ARRAY[v_cut.partial_lot_id] ELSE '{}' END;

  FOR v_lot IN SELECT * FROM sku_lots WHERE id = ANY(v_ids) FOR UPDATE LOOP
    IF v_lot.status = 'WASTED' THEN
      RAISE EXCEPTION 'Cannot reverse % — piece % was marked as waste. Reverse that waste first.', v_cut.cut_no, v_lot.lot_no;
    END IF;
    IF v_lot.current_qty <> v_lot.inward_qty THEN
      SELECT m.txn_no INTO v_txn FROM inventory_movements m
       WHERE m.sku_id = v_lot.sku_id AND m.is_reversed = false AND m.txn_mode = 'NORMAL'
         AND m.lot_breakdown @> jsonb_build_array(jsonb_build_object('lot_no', v_lot.lot_no))
         AND m.id <> NEW.reversal_of
       ORDER BY m.occurred_at DESC LIMIT 1;
      RAISE EXCEPTION 'Cannot reverse % — piece % was already used%. Reverse that outward first.',
        v_cut.cut_no, v_lot.lot_no, COALESCE(' in ' || v_txn, '');
    END IF;
    SELECT string_agg(DISTINCT po.order_no, ', ') INTO v_orders
      FROM lot_allocations la
      JOIN production_order_items i ON i.id = la.item_id
      JOIN production_orders po     ON po.id = i.order_id
     WHERE la.lot_id = v_lot.id AND po.status <> 'CANCELLED';
    IF v_orders IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot reverse % — piece % is used by order %. Cancel or finish that order first.', v_cut.cut_no, v_lot.lot_no, v_orders;
    END IF;
  END LOOP;

  PERFORM set_config('app.lot_managed',   '1', true);
  PERFORM set_config('app.rubber_cut_op', '1', true);

  SELECT * INTO v_src FROM sku_lots WHERE id = v_cut.source_lot_id FOR UPDATE;
  UPDATE sku_lots SET current_qty = v_cut.src_width_mm * v_cut.src_len_mm,
         status = derive_lot_status(v_cut.src_width_mm * v_cut.src_len_mm, inward_qty),
         notes  = trim(both ' ' from COALESCE(notes || ' · ', '') || 'Cut reversed (' || v_cut.cut_no || ')')
   WHERE id = v_src.id;
  UPDATE sku_lots SET current_qty = 0, status = 'EXHAUSTED',
         notes = trim(both ' ' from COALESCE(notes || ' · ', '') || 'Cut reversed')
   WHERE id = ANY(v_ids);

  v_break := jsonb_build_array(jsonb_build_object(
      'cut', true, 'reversed', true, 'restored', true, 'cut_no', v_cut.cut_no, 'lot_no', v_src.lot_no, 'status', 'FULL_SLEEVE',
      'qty', v_cut.src_width_mm * v_cut.src_len_mm, 'src_width_mm', v_cut.src_width_mm, 'src_len_mm', v_cut.src_len_mm,
      'cut_width_mm', v_cut.cut_width_mm, 'cut_len_mm', v_cut.cut_len_mm, 'pcs', v_cut.pcs,
      'partial_width_mm', v_cut.partial_width_mm, 'partial_len_mm', v_cut.partial_len_mm));

  UPDATE skus SET physical_prod_stock = physical_prod_stock + NEW.quantity, updated_at = now() WHERE id = NEW.sku_id;
  UPDATE rubber_cuts SET status = 'REVERSED', reversed_at = now() WHERE id = v_cut.id;
  UPDATE inventory_movements SET lot_breakdown = v_break WHERE id = NEW.id;

  PERFORM set_config('app.rubber_cut_op', '', true);   -- app.lot_managed stays on: movement_sync_lots runs after this trigger
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS movement_reverse_rubber_cut ON inventory_movements;
CREATE TRIGGER movement_reverse_rubber_cut AFTER INSERT ON inventory_movements
  FOR EACH ROW WHEN (NEW.txn_mode = 'REVERSAL' AND NEW.reversal_of IS NOT NULL)
  EXECUTE FUNCTION trg_reverse_rubber_cut();

-- 10. an Open Roll outward CAN be reversed now (it only shortened a roll) — but not once its roll was cut up
CREATE OR REPLACE FUNCTION trg_block_rubber_outward_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_type text; v_orig inventory_movements; v_e jsonb; v_cut text;
BEGIN
  IF NEW.txn_mode = 'REVERSAL' AND NEW.txn_type = 'INWARD' THEN      -- a reversal of an outward
    SELECT product_type INTO v_type FROM skus WHERE id = NEW.sku_id;
    IF is_rubber(v_type) THEN
      SELECT * INTO v_orig FROM inventory_movements WHERE id = NEW.reversal_of;
      FOR v_e IN SELECT * FROM jsonb_array_elements(COALESCE(v_orig.lot_breakdown, '[]'::jsonb)) LOOP
        SELECT c.cut_no INTO v_cut FROM rubber_cuts c
          JOIN sku_lots l ON l.id = c.source_lot_id
         WHERE l.lot_no = v_e->>'lot_no' AND l.sku_id = NEW.sku_id AND c.status = 'RECONCILED';
        IF v_cut IS NOT NULL THEN
          RAISE EXCEPTION 'Cannot reverse this outward — its roll was cut up afterwards (%). Reverse that cut piece first.', v_cut;
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 11. an outward only shortens the roll: the piece width must equal the roll's width ------------------
CREATE OR REPLACE FUNCTION rubber_cut(p_lot_id uuid, p_len_mm numeric, p_width_mm numeric, p_pcs int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lot   sku_lots;
  v_block numeric := p_len_mm * p_pcs;
  v_len   numeric;
  v_new   numeric;
BEGIN
  SELECT * INTO v_lot FROM sku_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'Roll not found.'; END IF;
  IF v_lot.status IN ('WASTED','EXHAUSTED') OR v_lot.current_qty <= 0 THEN
    RAISE EXCEPTION 'This roll is already %.', lower(v_lot.status);
  END IF;
  IF v_lot.width_mm IS NULL OR v_lot.width_mm <= 0 THEN RAISE EXCEPTION 'This roll has no width recorded.'; END IF;
  IF p_len_mm IS NULL OR p_len_mm <= 0 OR p_width_mm IS NULL OR p_width_mm <= 0 OR p_pcs IS NULL OR p_pcs < 1 THEN
    RAISE EXCEPTION 'Enter width, length and pieces.';
  END IF;
  IF p_width_mm <> v_lot.width_mm THEN
    RAISE EXCEPTION 'This roll is % mm wide but the piece is % mm wide. Create a cut piece of % mm first.',
      v_lot.width_mm, p_width_mm, p_width_mm;
  END IF;
  v_len := v_lot.current_qty / v_lot.width_mm;
  IF v_block > v_len THEN
    RAISE EXCEPTION 'Only % mm of this roll is left, but % mm is needed (% pcs x % mm).', v_len, v_block, p_pcs, p_len_mm;
  END IF;

  v_new := v_lot.current_qty - v_block * v_lot.width_mm;
  UPDATE sku_lots SET current_qty = v_new, status = derive_lot_status(v_new, v_lot.inward_qty) WHERE id = v_lot.id;

  RETURN jsonb_build_object(
    'lot_id', v_lot.id, 'lot_no', v_lot.lot_no, 'status', v_lot.status,
    'qty', p_len_mm * p_width_mm * p_pcs,
    'width_mm', p_width_mm, 'len_mm', p_len_mm, 'pcs', p_pcs,
    'from_width_mm', v_lot.width_mm, 'from_len_mm', v_len,
    'left_len_mm', v_new / v_lot.width_mm);
END $$;
REVOKE ALL ON FUNCTION rubber_cut(uuid, numeric, numeric, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rubber_cut(uuid, numeric, numeric, int) TO authenticated;

-- 12. outward / production order: width must equal the piece width; blocked while a cut is pending ----------
CREATE OR REPLACE FUNCTION public.record_outward_with_lots(p_sku_code text, p_rows jsonb, p_reference text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_channel text DEFAULT 'WEB'::text, p_invoice_no text DEFAULT NULL::text, p_operated_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sku      skus;
  v_rubber   boolean;
  v_grp      jsonb;
  v_pcs      int;
  v_mm       numeric;
  v_wid      numeric;
  v_src      text;
  v_total    numeric := 0;
  v_i        int;
  v_lot      record;
  v_cut      jsonb;
  v_movement jsonb;
  v_mov_id   uuid;
  v_break    jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.lot_managed','1',true);

  SELECT * INTO v_sku FROM skus WHERE sku_code = p_sku_code;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'Unknown product.'; END IF;
  IF NOT is_lot_type(v_sku.product_type) THEN
    RAISE EXCEPTION 'MM × PCS / RIBS × PCS outward is for timing belts, poly V belts and Open Roll only.';
  END IF;
  v_rubber := is_rubber(v_sku.product_type);
  IF v_rubber AND rubber_has_pending(v_sku.id) THEN
    RAISE EXCEPTION 'A cut piece for this product is waiting to be reconciled. Reconcile it first (Mismatch > Open Roll).';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Enter at least one % × PCS row.', lot_unit_word(v_sku.id);
  END IF;

  FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_pcs := COALESCE((v_grp->>'rolls')::int, 0);
    v_mm  := COALESCE((v_grp->>'roll_length')::numeric, 0);
    v_wid := NULLIF(v_grp->>'width', '')::numeric;
    IF v_pcs < 1 OR v_mm <= 0 THEN
      RAISE EXCEPTION 'Each row needs a PCS of 1 or more and % above zero.', lot_unit_word(v_sku.id);
    END IF;
    IF v_rubber AND (v_wid IS NULL OR v_wid <= 0) THEN
      RAISE EXCEPTION 'Each row needs a width.';
    END IF;
    v_total := v_total + v_pcs * v_mm * CASE WHEN v_rubber THEN v_wid ELSE 1 END;
  END LOOP;

  v_movement := record_movement(
    v_sku.sku_code, 'OUTWARD', v_total, v_sku.unit_code,
    p_reference, p_notes, COALESCE(p_channel, 'WEB'), p_invoice_no, p_operated_by
  );
  SELECT id INTO v_mov_id FROM inventory_movements WHERE txn_no = (v_movement->>'txn_no');

  FOR v_grp IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_pcs := (v_grp->>'rolls')::int;
    v_mm  := (v_grp->>'roll_length')::numeric;

    IF v_rubber THEN
      v_wid := (v_grp->>'width')::numeric;
      -- the roll / cut piece of exactly this width, long enough, not promised elsewhere, then the closest fit
      SELECT f.id INTO v_lot
        FROM v_lot_free f
       WHERE f.sku_id = v_sku.id
         AND f.width_mm = v_wid
         AND f.current_qty / f.width_mm >= v_mm * v_pcs
       ORDER BY (f.free_qty >= v_mm * v_pcs * f.width_mm) DESC,
                f.current_qty / f.width_mm,         -- the shortest that is long enough
                f.created_at, f.lot_no
       LIMIT 1;
      IF v_lot.id IS NULL THEN
        RAISE EXCEPTION 'No % mm wide roll or cut piece with % m of length is left (% pcs x % m). Create a cut piece of that width first, or try fewer pieces.',
          v_wid, round(v_mm * v_pcs / 1000, 3), v_pcs, round(v_mm / 1000, 3);
      END IF;
      v_cut := rubber_cut(v_lot.id, v_mm, v_wid, v_pcs);
      v_break := v_break || v_cut;
    ELSE
      v_src := CASE WHEN COALESCE((v_grp->>'cut')::boolean, false) THEN 'CUT_PCS' ELSE 'FULL_SLEEVE' END;
      FOR v_i IN 1..v_pcs LOOP
        SELECT f.id, f.lot_no, f.status, f.current_qty
          INTO v_lot
          FROM v_lot_free f
         WHERE f.sku_id = v_sku.id
           AND f.status = v_src
           AND f.current_qty >= v_mm
         ORDER BY (f.free_qty >= v_mm) DESC,
                  (f.current_qty = v_mm) DESC,
                  f.current_qty,
                  f.created_at, f.lot_no
         LIMIT 1;

        IF v_lot.id IS NULL THEN
          RAISE EXCEPTION 'No % of % % or more is left in stock (% more piece(s) needed). Try % instead, or fewer pieces.',
            CASE v_src WHEN 'CUT_PCS' THEN 'Cut Pcs piece' ELSE 'Full Sleeve' END,
            v_mm, lower(lot_unit_word(v_sku.id)), v_pcs - v_i + 1,
            CASE v_src WHEN 'CUT_PCS' THEN 'Full Sleeve' ELSE 'Cut Pcs' END;
        END IF;

        PERFORM drain_lot(v_lot.id, v_mm);
        v_break := v_break || jsonb_build_object('lot_no', v_lot.lot_no, 'status', v_lot.status, 'qty', v_mm);
      END LOOP;
    END IF;
  END LOOP;

  UPDATE inventory_movements SET lot_breakdown = v_break WHERE id = v_mov_id;

  RETURN v_movement || jsonb_build_object('lot_breakdown', v_break, 'rows', p_rows);
END $function$;

CREATE OR REPLACE FUNCTION create_production_order_full(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user    app_users;
  v_direct  boolean := COALESCE((p_order->>'is_direct')::boolean, false);
  v_items   jsonb   := p_order->'items';
  v_item    jsonb;
  v_seg     jsonb;
  v_sku     skus;
  v_lot     sku_lots;
  v_order   production_orders;
  v_poi     production_order_items;
  v_no      text;
  v_msg     text;
  v_qty     numeric;
  v_pcs     int;
  v_mm      numeric;
  v_wid     numeric;
  v_rubber  boolean;
  v_segs    jsonb;
  v_seg_no  int;
  v_desc    text[] := '{}';
  v_free    numeric;
  r         record;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role cannot create production orders.';
  END IF;
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one product.';
  END IF;

  -- ── Pass 1: every roll asked for must still have that much free, summed over the whole order ──
  -- (Open Roll: a cut takes a slab = length x pcs x the roll's full width out of the roll)
  FOR r IN
    SELECT (sg->>'lot_id')::uuid AS lot_id,
           sum((sg->>'mm')::numeric * (sg->>'pcs')::int) AS need_len
      FROM jsonb_array_elements(v_items) it
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(it->'segments', '[]'::jsonb)) sg
     GROUP BY 1
  LOOP
    SELECT * INTO v_lot FROM sku_lots WHERE id = r.lot_id FOR UPDATE;
    IF v_lot.id IS NULL THEN RAISE EXCEPTION 'A roll you picked no longer exists. Reload and pick again.'; END IF;
    IF v_lot.status NOT IN ('FULL_SLEEVE','CUT_PCS') OR v_lot.current_qty <= 0 THEN
      RAISE EXCEPTION 'That roll is no longer in stock. Pick another roll.';
    END IF;
    SELECT free_qty INTO v_free FROM v_lot_free WHERE id = r.lot_id;
    IF v_lot.width_mm IS NOT NULL THEN
      IF COALESCE(v_free, 0) < r.need_len * v_lot.width_mm THEN
        RAISE EXCEPTION 'The % mm wide roll you picked has only % mm of length free, but % mm was asked from it. Pick another roll or reduce the quantity.',
          v_lot.width_mm, floor(COALESCE(v_free, 0) / v_lot.width_mm), r.need_len;
      END IF;
    ELSIF COALESCE(v_free, 0) < r.need_len THEN
      RAISE EXCEPTION 'Roll % has only % free, but % was asked from it. Pick another roll or reduce the quantity.',
        v_lot.lot_no, COALESCE(v_free, 0), r.need_len;
    END IF;
  END LOOP;

  -- ── the order ──
  v_no := next_production_order_no();
  v_msg := replace(COALESCE(p_order->>'whatsapp_message', ''), '{{ORDER_NO}}', v_no);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_desc := v_desc || COALESCE(NULLIF(btrim(v_item->>'display_name'), ''), 'Item');
  END LOOP;

  INSERT INTO production_orders (
    order_no, customer_name, product_description, time_tag, delivery_mode, delivery_note,
    assigned_to, notes, whatsapp_number, whatsapp_message, is_direct, status, created_by
  ) VALUES (
    v_no,
    NULLIF(btrim(p_order->>'customer_name'), ''),
    array_to_string(v_desc, ', '),
    NULLIF(p_order->>'time_tag', ''),
    NULLIF(p_order->>'delivery_mode', ''),
    NULLIF(p_order->>'delivery_note', ''),
    NULLIF(btrim(p_order->>'assigned_to'), ''),
    NULLIF(p_order->>'notes', ''),
    NULLIF(p_order->>'whatsapp_number', ''),
    NULLIF(v_msg, ''),
    v_direct,
    'CREATED',
    v_user.id
  ) RETURNING * INTO v_order;

  -- ── the lines ──
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_segs := COALESCE(v_item->'segments', '[]'::jsonb);

    IF v_direct THEN
      v_qty := (v_item->>'quantity')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter a quantity for every product.'; END IF;
      INSERT INTO production_order_items (order_id, sku_id, sku_code, display_name, unit_code, quantity, pieces, length_mm, width_mm)
      VALUES (v_order.id, NULL, 'DIRECT', btrim(v_item->>'display_name'),
              COALESCE(NULLIF(v_item->>'unit_code', ''), 'PCS'), v_qty,
              NULLIF(v_item->>'pieces', '')::int, NULLIF(v_item->>'length_mm', '')::numeric,
              NULLIF(v_item->>'width_mm', '')::numeric);
      CONTINUE;
    END IF;

    SELECT * INTO v_sku FROM skus WHERE id = (v_item->>'sku_id')::uuid;
    IF v_sku.id IS NULL THEN RAISE EXCEPTION 'A product on this order no longer exists.'; END IF;
    v_rubber := is_rubber(v_sku.product_type);
    IF v_rubber AND rubber_has_pending(v_sku.id) THEN
      RAISE EXCEPTION '% has a cut piece waiting to be reconciled. Reconcile it first, then create the order.', v_sku.sku_code;
    END IF;

    IF is_lot_type(v_sku.product_type) THEN
      IF jsonb_typeof(v_segs) <> 'array' OR jsonb_array_length(v_segs) = 0 THEN
        RAISE EXCEPTION '% needs at least one % × PCS entry with a roll picked.', v_sku.sku_code, lot_unit_word(v_sku.id);
      END IF;
      v_qty := 0;
      FOR v_seg IN SELECT * FROM jsonb_array_elements(v_segs) LOOP
        v_mm  := (v_seg->>'mm')::numeric;
        v_pcs := (v_seg->>'pcs')::int;
        v_wid := NULLIF(v_seg->>'width', '')::numeric;
        IF v_mm IS NULL OR v_mm <= 0 OR v_pcs IS NULL OR v_pcs < 1 THEN
          RAISE EXCEPTION 'Each entry on % needs a length above zero and 1 or more pieces.', v_sku.sku_code;
        END IF;
        IF v_rubber AND (v_wid IS NULL OR v_wid <= 0) THEN
          RAISE EXCEPTION 'Each entry on % needs a width.', v_sku.sku_code;
        END IF;
        v_qty := v_qty + v_mm * v_pcs * CASE WHEN v_rubber THEN v_wid ELSE 1 END;
      END LOOP;
    ELSE
      IF jsonb_array_length(v_segs) > 0 THEN
        RAISE EXCEPTION '% is not kept in rolls — it has no roll to pick.', v_sku.sku_code;
      END IF;
      v_qty := (v_item->>'quantity')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Enter a quantity for % .', v_sku.sku_code; END IF;
    END IF;

    INSERT INTO production_order_items (order_id, sku_id, sku_code, display_name, unit_code, quantity, pieces, length_mm, width_mm)
    VALUES (
      v_order.id, v_sku.id, v_sku.sku_code, v_sku.display_name, v_sku.unit_code, v_qty,
      CASE WHEN jsonb_array_length(v_segs) = 1 THEN (v_segs->0->>'pcs')::int END,
      CASE WHEN jsonb_array_length(v_segs) = 1 THEN (v_segs->0->>'mm')::numeric END,
      CASE WHEN jsonb_array_length(v_segs) = 1 AND v_rubber THEN (v_segs->0->>'width')::numeric END
    ) RETURNING * INTO v_poi;

    v_seg_no := 0;
    FOR v_seg IN SELECT * FROM jsonb_array_elements(v_segs) LOOP
      v_seg_no := v_seg_no + 1;
      SELECT * INTO v_lot FROM sku_lots WHERE id = (v_seg->>'lot_id')::uuid;
      IF v_lot.id IS NULL OR v_lot.sku_id <> v_sku.id THEN
        RAISE EXCEPTION 'The roll picked for % does not belong to that product.', v_sku.sku_code;
      END IF;
      IF v_rubber THEN
        v_wid := (v_seg->>'width')::numeric;
        IF v_wid <> v_lot.width_mm THEN
          RAISE EXCEPTION 'The roll picked for % is % mm wide but the order is for % mm. Create a % mm cut piece first.', v_sku.sku_code, v_lot.width_mm, v_wid, v_wid;
        END IF;
        IF (v_seg->>'mm')::numeric * (v_seg->>'pcs')::int > v_lot.current_qty / v_lot.width_mm THEN
          RAISE EXCEPTION 'The roll picked for % has only % mm of length left — % pcs x % mm needs more.',
            v_sku.sku_code, v_lot.current_qty / v_lot.width_mm, (v_seg->>'pcs')::int, (v_seg->>'mm')::numeric;
        END IF;
        INSERT INTO lot_allocations (item_id, lot_id, allocated_qty, seg_no, seg_mm, seg_pcs, seg_width_mm)
        VALUES (v_poi.id, v_lot.id, (v_seg->>'mm')::numeric * (v_seg->>'pcs')::int * v_wid,
                v_seg_no, (v_seg->>'mm')::numeric, (v_seg->>'pcs')::int, v_wid);
      ELSE
        IF (v_seg->>'mm')::numeric > v_lot.current_qty THEN
          RAISE EXCEPTION 'Roll % is only % long — a % piece cannot be cut from it.',
            v_lot.lot_no, v_lot.current_qty, (v_seg->>'mm')::numeric;
        END IF;
        INSERT INTO lot_allocations (item_id, lot_id, allocated_qty, seg_no, seg_mm, seg_pcs)
        VALUES (v_poi.id, v_lot.id, (v_seg->>'mm')::numeric * (v_seg->>'pcs')::int,
                v_seg_no, (v_seg->>'mm')::numeric, (v_seg->>'pcs')::int);
      END IF;
    END LOOP;
  END LOOP;

  PERFORM log_audit('CREATE', 'PRODUCTION_ORDER', v_order.id::text, v_order.order_no,
                    NULL, v_order.status, 'WEB', 'Production order ' || v_order.order_no || ' created');

  RETURN jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no);
END $$;
REVOKE ALL ON FUNCTION create_production_order_full(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_production_order_full(jsonb) TO authenticated;
