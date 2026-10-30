-- =====================================================================================
-- 041  Mark as waste for products that are not kept in rolls (V-belts, conveyor belts)
--
--   Timing and poly V belts already have "Mark waste" on each roll (mark_lot_wasted).
--   Everything else is a plain quantity, so waste is a quantity:
--
--       mark_stock_wasted(sku, qty, reason)
--
--   It follows exactly the same mechanism as a wasted roll:
--     • BOOK stock drops at once, as a stock adjustment whose note reads
--         "Marked as waste · 3 pcs wasted: <reason>"
--     • PHYSICAL (production) stock is unchanged until someone presses
--       "Mark here as waste" on the Mismatch list — then physical drops by the same amount.
--     • It shows in Transactions, in the "Marked as waste" report and in the Mismatch list.
--
--   The Mismatch list now also recognises these (no roll number) as waste, not as a plain adjustment.
--
-- Safe to run more than once.  Run after 040.
-- =====================================================================================

CREATE OR REPLACE FUNCTION mark_stock_wasted(p_sku_id uuid, p_qty numeric, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sku skus;
  v_res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('inventory.adjust') THEN
    RAISE EXCEPTION 'Your role cannot mark stock as waste.';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'Give a reason for the waste.'; END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'Enter how much was wasted.'; END IF;

  SELECT * INTO v_sku FROM skus WHERE id = p_sku_id FOR UPDATE;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'Unknown product.'; END IF;
  IF is_lot_type(v_sku.product_type) THEN
    RAISE EXCEPTION '% is kept in rolls — mark the roll as waste instead.', v_sku.sku_code;
  END IF;
  IF p_qty > v_sku.current_stock THEN
    RAISE EXCEPTION 'Only % % in stock.', v_sku.current_stock, v_sku.unit_code;
  END IF;
  IF p_qty > v_sku.physical_prod_stock THEN
    RAISE EXCEPTION 'Only % % is free on the shelf — the rest is already promised to production orders.',
      v_sku.physical_prod_stock, v_sku.unit_code;
  END IF;

  v_res := record_movement(
    v_sku.sku_code, 'ADJUSTMENT', -p_qty, v_sku.unit_code, NULL,
    'Marked as waste · ' || p_qty || ' ' || lower(v_sku.unit_code) || ' wasted: ' || btrim(p_reason),
    'WEB', NULL, NULL);
  RETURN v_res;
END $$;
REVOKE ALL ON FUNCTION mark_stock_wasted(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_stock_wasted(uuid, numeric, text) TO authenticated;

-- A waste with no roll number is still a waste on the Mismatch list.
CREATE OR REPLACE FUNCTION trg_movement_pending_adjustment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_delta numeric := NEW.new_stock - NEW.previous_stock;
  v_lot   text    := substring(COALESCE(NEW.notes,'') from 'Lot (\S+) wasted');
BEGIN
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
END $$;

SELECT 'ok' AS status;
