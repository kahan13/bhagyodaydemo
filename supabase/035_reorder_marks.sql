-- =====================================================================================
-- 035  "Needs reordering" tick-offs
--
--   On Inventory → Needs reordering a person ticks a product once a purchase order has been
--   raised for it; the row is crossed out for everybody. The tick is only a reminder:
--     * it changes no stock and creates nothing else
--     * it disappears by itself as soon as the product is no longer low (stock refilled,
--       or its MSL changed), so the next time it runs low it shows up fresh
--
-- Safe to run more than once. Run after 034.
-- =====================================================================================

CREATE TABLE IF NOT EXISTS reorder_marks (
  sku_id    uuid        PRIMARY KEY REFERENCES skus(id) ON DELETE CASCADE,
  marked_by uuid        REFERENCES app_users(id) ON DELETE SET NULL,
  marked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE reorder_marks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'reorder_marks' AND policyname = 'reorder_marks_select') THEN
    CREATE POLICY reorder_marks_select ON reorder_marks
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
GRANT SELECT ON reorder_marks TO authenticated;

-- Forget the tick of every product that is no longer on the list.
CREATE OR REPLACE FUNCTION prune_reorder_marks()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  DELETE FROM reorder_marks m
   WHERE NOT EXISTS (
     SELECT 1 FROM v_sku_status v
      WHERE v.id = m.sku_id
        AND v.is_active
        AND v.min_stock_level > 0
        AND v.stock_status IN ('LOW_STOCK', 'OUT_OF_STOCK'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION prune_reorder_marks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION prune_reorder_marks() TO authenticated;

-- Tick / untick one product.
CREATE OR REPLACE FUNCTION set_reorder_mark(p_sku_id uuid, p_marked boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user app_users;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN
    RAISE EXCEPTION 'Your role cannot tick off reorders.';
  END IF;
  IF p_marked THEN
    INSERT INTO reorder_marks (sku_id, marked_by) VALUES (p_sku_id, v_user.id)
    ON CONFLICT (sku_id) DO UPDATE SET marked_by = EXCLUDED.marked_by, marked_at = now();
  ELSE
    DELETE FROM reorder_marks WHERE sku_id = p_sku_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION set_reorder_mark(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_reorder_mark(uuid, boolean) TO authenticated;

SELECT 'ok' AS status, (SELECT count(*) FROM reorder_marks) AS ticked;
