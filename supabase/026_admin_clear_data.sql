-- =====================================================================================
-- 026  Admin "Clear data" tools (Super Admin only)
--
--   admin_clear_preview()                 -> counts of what exists right now
--   admin_clear_orders_and_transactions() -> deletes ALL purchase orders, production orders,
--        transactions (movements), import history and activity log. KEEPS SKUs, current stock
--        and roll lots; opening stock is reset to current stock so the books still reconcile.
--   admin_zero_stock(p_sku_ids uuid[])    -> for the chosen SKUs (NULL = every SKU): stock to 0,
--        roll lots removed, their transaction history removed, planned lots released.
--        SKUs themselves are never deleted.
--
-- Safe to re-run. Run after 020-025.
-- =====================================================================================

CREATE OR REPLACE FUNCTION _assert_super_admin() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user app_users;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF v_user.role_code <> 'SUPER_ADMIN' THEN
    RAISE EXCEPTION 'Only a Super Admin can clear data.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION admin_clear_preview() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM _assert_super_admin();
  RETURN jsonb_build_object(
    'skus',               (SELECT count(*) FROM skus),
    'skus_with_stock',    (SELECT count(*) FROM skus WHERE current_stock <> 0),
    'lots',               (SELECT count(*) FROM sku_lots WHERE status IN ('FULL_SLEEVE','CUT_PCS')),
    'movements',          (SELECT count(*) FROM inventory_movements),
    'purchase_orders',    (SELECT count(*) FROM purchase_orders),
    'production_orders',  (SELECT count(*) FROM production_orders),
    'activity_entries',   (SELECT count(*) FROM audit_logs),
    'imports',            (SELECT count(*) FROM import_batches)
  );
END $$;

CREATE OR REPLACE FUNCTION admin_clear_orders_and_transactions() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before jsonb;
BEGIN
  PERFORM _assert_super_admin();
  v_before := admin_clear_preview();

  -- Order matters (foreign keys): receipts and adjustments point at movements, movements point at
  -- order items, so: receipts -> movements -> order items/orders.
  DELETE FROM purchase_order_receipts WHERE true;
  DELETE FROM prod_pending_adjustments WHERE true;

  -- transactions: detach lots, lift the immutability guard for this call only, reset TXN numbers
  -- (every statement has a WHERE: Supabase refuses DELETE/UPDATE without one)
  UPDATE sku_lots SET inward_movement_id = NULL WHERE inward_movement_id IS NOT NULL;
  UPDATE inventory_movements SET lot_id = NULL WHERE lot_id IS NOT NULL;
  UPDATE inventory_movements SET reversed_by = NULL, reversal_of = NULL, is_reversed = false WHERE true;
  PERFORM set_config('bhagyoday.allow_purge', 'on', true);
  DELETE FROM inventory_movements WHERE true;
  PERFORM set_config('bhagyoday.allow_purge', 'off', true);
  PERFORM setval('movement_no_seq', 1, false);

  -- now the orders (their lot plans go with the items)
  DELETE FROM production_order_items WHERE true;
  DELETE FROM production_orders WHERE true;
  DELETE FROM purchase_order_items WHERE true;
  DELETE FROM purchase_orders WHERE true;

  -- what is on the shelf now becomes the opening position
  UPDATE skus SET opening_stock = current_stock, physical_prod_stock = current_stock, updated_at = now() WHERE true;

  DELETE FROM import_batches WHERE true;
  DELETE FROM audit_logs WHERE true;

  PERFORM setval('purchase_order_no_seq', 1, false);
  PERFORM setval('production_order_no_seq', 1, false);

  PERFORM log_audit('CLEAR', 'DATA', 'orders+transactions', 'Cleared orders and transactions',
                    NULL, NULL, 'WEB', 'Stock kept as opening stock');
  RETURN jsonb_build_object('deleted', v_before, 'kept', admin_clear_preview());
END $$;

CREATE OR REPLACE FUNCTION admin_zero_stock(p_sku_ids uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids   uuid[];
  v_n     int;
  v_lots  int;
BEGIN
  PERFORM _assert_super_admin();
  SELECT COALESCE(array_agg(id), '{}') INTO v_ids FROM skus WHERE p_sku_ids IS NULL OR id = ANY(p_sku_ids);
  IF array_length(v_ids, 1) IS NULL THEN RAISE EXCEPTION 'No products selected.'; END IF;

  -- release any lots planned on orders for these SKUs
  DELETE FROM lot_allocations WHERE lot_id IN (SELECT id FROM sku_lots WHERE sku_id = ANY(v_ids));
  DELETE FROM prod_pending_adjustments WHERE sku_id = ANY(v_ids);

  -- detach, then remove the history of these SKUs
  UPDATE purchase_order_receipts
     SET movement_id = NULL, inwarded_movement_id = NULL
   WHERE movement_id IN (SELECT id FROM inventory_movements WHERE sku_id = ANY(v_ids))
      OR inwarded_movement_id IN (SELECT id FROM inventory_movements WHERE sku_id = ANY(v_ids));
  UPDATE inventory_movements SET lot_id = NULL WHERE sku_id = ANY(v_ids) AND lot_id IS NOT NULL;
  UPDATE sku_lots SET inward_movement_id = NULL WHERE sku_id = ANY(v_ids) AND inward_movement_id IS NOT NULL;
  UPDATE inventory_movements SET reversed_by = NULL, reversal_of = NULL, is_reversed = false WHERE sku_id = ANY(v_ids);
  PERFORM set_config('bhagyoday.allow_purge', 'on', true);
  DELETE FROM inventory_movements WHERE sku_id = ANY(v_ids);
  PERFORM set_config('bhagyoday.allow_purge', 'off', true);

  SELECT count(*) INTO v_lots FROM sku_lots WHERE sku_id = ANY(v_ids);
  DELETE FROM sku_lots WHERE sku_id = ANY(v_ids);

  UPDATE skus SET opening_stock = 0, current_stock = 0, physical_prod_stock = 0, updated_at = now()
   WHERE id = ANY(v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM log_audit('CLEAR', 'STOCK', v_n::text || ' SKUs', 'Zeroed stock',
                    NULL, NULL, 'WEB', 'Quantities, lots and history removed; SKUs kept');
  RETURN jsonb_build_object('skus_zeroed', v_n, 'lots_removed', v_lots);
END $$;

REVOKE ALL ON FUNCTION _assert_super_admin()                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_clear_preview()                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_clear_orders_and_transactions()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_zero_stock(uuid[])                   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_clear_preview()                   TO authenticated;
GRANT EXECUTE ON FUNCTION admin_clear_orders_and_transactions()   TO authenticated;
GRANT EXECUTE ON FUNCTION admin_zero_stock(uuid[])                TO authenticated;

SELECT 'ok' AS status;
