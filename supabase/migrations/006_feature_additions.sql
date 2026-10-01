-- =====================================================================================
-- 006 – Feature additions
-- Run in Supabase SQL Editor (safe to re-run if IF NOT EXISTS guards are in place)
-- =====================================================================================

-- -----------------------------------------------------------------------
-- 1. New columns on inventory_movements
-- -----------------------------------------------------------------------
ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS invoice_no           text,
  ADD COLUMN IF NOT EXISTS operated_by_user_id  uuid REFERENCES app_users(id);

-- -----------------------------------------------------------------------
-- 2. Sequences for auto-numbered orders
-- -----------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS purchase_order_no_seq   START 1;
CREATE SEQUENCE IF NOT EXISTS production_order_no_seq START 1;

-- -----------------------------------------------------------------------
-- 3. Purchase orders (inward order placement)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no      text        NOT NULL UNIQUE,
  supplier_name text,
  notes         text,
  status        text        NOT NULL DEFAULT 'PLACED'
                            CHECK (status IN ('PLACED','PARTIAL','FULFILLED')),
  created_by    uuid        REFERENCES app_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------
-- 4. Purchase order line items
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid        NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sku_id       uuid        NOT NULL REFERENCES skus(id),
  ordered_qty  numeric(14,2) NOT NULL CHECK (ordered_qty > 0),
  received_qty numeric(14,2) NOT NULL DEFAULT 0,
  status       text        NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING','PARTIAL','FULFILLED')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------
-- 5. Partial receipts against purchase order items
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_receipts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid        NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
  qty_received  numeric(14,2) NOT NULL CHECK (qty_received > 0),
  movement_id   uuid        REFERENCES inventory_movements(id),
  received_at   timestamptz NOT NULL DEFAULT now(),
  received_by   uuid        REFERENCES app_users(id),
  notes         text
);

-- -----------------------------------------------------------------------
-- 6. Production / work orders (sent to team via WhatsApp)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_orders (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no            text        NOT NULL UNIQUE,
  customer_name       text,
  product_description text        NOT NULL,
  quantity            numeric(14,2),
  unit_code           text,
  due_date            date,
  notes               text,
  whatsapp_number     text,
  whatsapp_message    text,
  status              text        NOT NULL DEFAULT 'CREATED'
                                  CHECK (status IN ('CREATED','SENT','IN_PROGRESS','COMPLETED')),
  created_by          uuid        REFERENCES app_users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------
-- 7. RLS
-- -----------------------------------------------------------------------
ALTER TABLE purchase_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_orders     ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='purchase_orders' AND policyname='po_select') THEN
    CREATE POLICY po_select ON purchase_orders FOR SELECT TO authenticated USING (has_permission('transactions.view'));
    CREATE POLICY po_insert ON purchase_orders FOR INSERT TO authenticated WITH CHECK (has_permission('transactions.create'));
    CREATE POLICY po_update ON purchase_orders FOR UPDATE TO authenticated USING (has_permission('transactions.create'));

    CREATE POLICY poi_select ON purchase_order_items FOR SELECT TO authenticated USING (has_permission('transactions.view'));
    CREATE POLICY poi_insert ON purchase_order_items FOR INSERT TO authenticated WITH CHECK (has_permission('transactions.create'));
    CREATE POLICY poi_update ON purchase_order_items FOR UPDATE TO authenticated USING (has_permission('transactions.create'));

    CREATE POLICY por_select ON purchase_order_receipts FOR SELECT TO authenticated USING (has_permission('transactions.view'));
    CREATE POLICY por_insert ON purchase_order_receipts FOR INSERT TO authenticated WITH CHECK (has_permission('transactions.create'));

    CREATE POLICY prod_select ON production_orders FOR SELECT TO authenticated USING (true);
    CREATE POLICY prod_insert ON production_orders FOR INSERT TO authenticated WITH CHECK (has_permission('transactions.create'));
    CREATE POLICY prod_update ON production_orders FOR UPDATE TO authenticated USING (has_permission('transactions.create'));
  END IF;
END $$;

-- -----------------------------------------------------------------------
-- 8. Rebuild v_movements with new columns
-- -----------------------------------------------------------------------
DROP VIEW IF EXISTS v_movements;

CREATE VIEW v_movements
WITH (security_invoker = on) AS
SELECT
  m.id, m.txn_no, m.occurred_at, m.txn_type, m.txn_mode, m.quantity, m.unit_code,
  m.previous_stock, m.new_stock, m.reference, m.invoice_no, m.notes, m.channel,
  m.user_id, m.user_name, m.reversal_of, m.reversed_by, m.is_reversed,
  m.operated_by_user_id,
  op.full_name AS operated_by_name,
  s.sku_code, s.display_name, s.product_type, s.exact_size,
  b.name AS brand_name, f.code AS family_code
FROM inventory_movements m
JOIN skus s  ON s.id = m.sku_id
JOIN brands b ON b.id = s.brand_id
JOIN product_families f ON f.id = s.family_id
LEFT JOIN app_users op ON op.id = m.operated_by_user_id;

-- -----------------------------------------------------------------------
-- 9. Updated record_movement — adds invoice_no and operated_by params
-- -----------------------------------------------------------------------
DO $$ DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_movement'
  LOOP EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION record_movement(
  p_sku_code    text,
  p_txn_type    text,
  p_quantity    numeric,
  p_unit_code   text    DEFAULT NULL,
  p_reference   text    DEFAULT NULL,
  p_notes       text    DEFAULT NULL,
  p_channel     text    DEFAULT 'WEB',
  p_invoice_no  text    DEFAULT NULL,
  p_operated_by uuid    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      app_users;
  v_sku       skus;
  v_prev      numeric(14,2);
  v_new       numeric(14,2);
  v_allow_neg boolean;
  v_txn_no    text;
  v_needed    text;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in, or this account is disabled.'; END IF;

  v_needed := CASE WHEN p_txn_type = 'ADJUSTMENT' THEN 'inventory.adjust' ELSE 'transactions.create' END;
  IF NOT has_permission(v_needed) THEN RAISE EXCEPTION 'Your role does not allow this action.'; END IF;

  SELECT * INTO v_sku FROM skus WHERE sku_code = p_sku_code FOR UPDATE;
  IF v_sku.id IS NULL THEN RAISE EXCEPTION 'Unknown product.'; END IF;
  IF NOT v_sku.is_active THEN RAISE EXCEPTION '% is inactive.', v_sku.display_name; END IF;

  IF p_unit_code IS NOT NULL AND upper(p_unit_code) <> v_sku.unit_code THEN
    RAISE EXCEPTION '% is stocked in %, not %.', v_sku.display_name, v_sku.unit_code, p_unit_code;
  END IF;

  IF p_txn_type IN ('INWARD','OUTWARD') AND p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero.';
  END IF;
  IF p_txn_type = 'ADJUSTMENT' THEN
    IF p_quantity = 0 THEN RAISE EXCEPTION 'An adjustment of zero changes nothing.'; END IF;
    IF coalesce(btrim(p_notes),'') = '' THEN RAISE EXCEPTION 'A stock adjustment needs a reason.'; END IF;
  END IF;

  v_prev := v_sku.current_stock;
  v_new  := CASE p_txn_type
              WHEN 'INWARD'  THEN v_prev + p_quantity
              WHEN 'OUTWARD' THEN v_prev - p_quantity
              ELSE v_prev + p_quantity END;

  SELECT coalesce((value->>'enabled')::boolean, false) INTO v_allow_neg
    FROM app_settings WHERE key = 'allow_negative_stock';

  IF v_new < 0 AND NOT coalesce(v_allow_neg, false) THEN
    RAISE EXCEPTION 'Only % % in stock.', v_prev, v_sku.unit_code;
  END IF;

  v_txn_no := 'TXN-' || to_char(now(),'YYYYMM') || '-' || lpad(nextval('movement_no_seq')::text, 5, '0');

  INSERT INTO inventory_movements(
    txn_no, sku_id, txn_type, txn_mode, quantity, unit_code,
    previous_stock, new_stock, occurred_at, user_id, user_name,
    channel, reference, notes, invoice_no, operated_by_user_id
  ) VALUES (
    v_txn_no, v_sku.id, p_txn_type, 'NORMAL', p_quantity, v_sku.unit_code,
    v_prev, v_new, now(), v_user.id, v_user.full_name,
    p_channel, p_reference, p_notes, p_invoice_no, p_operated_by
  );

  UPDATE skus SET current_stock = v_new, updated_at = now() WHERE id = v_sku.id;

  PERFORM log_audit(
    CASE p_txn_type WHEN 'ADJUSTMENT' THEN 'ADJUST' ELSE 'CREATE' END,
    'TRANSACTION', v_txn_no, v_sku.display_name,
    v_prev::text, v_new::text, p_channel,
    p_txn_type || ' ' || p_quantity || ' ' || v_sku.unit_code
  );

  RETURN jsonb_build_object(
    'txn_no', v_txn_no, 'sku_code', v_sku.sku_code,
    'display_name', v_sku.display_name, 'previous_stock', v_prev,
    'new_stock', v_new, 'unit_code', v_sku.unit_code, 'txn_type', p_txn_type
  );
END $$;

GRANT EXECUTE ON FUNCTION record_movement(text,text,numeric,text,text,text,text,text,uuid) TO authenticated;

-- -----------------------------------------------------------------------
-- 10. create_purchase_order helper
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_purchase_order(
  p_supplier_name text,
  p_notes         text,
  p_items         jsonb   -- [{sku_id, ordered_qty, notes}]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     app_users;
  v_order_id uuid;
  v_order_no text;
  v_item     jsonb;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN RAISE EXCEPTION 'Permission denied.'; END IF;

  v_order_no := 'PO-' || to_char(now(),'YYYYMM') || '-' ||
                lpad(nextval('purchase_order_no_seq')::text, 4, '0');

  INSERT INTO purchase_orders(order_no, supplier_name, notes, created_by)
  VALUES (v_order_no, p_supplier_name, p_notes, v_user.id)
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO purchase_order_items(order_id, sku_id, ordered_qty, notes)
    VALUES (
      v_order_id,
      (v_item->>'sku_id')::uuid,
      (v_item->>'ordered_qty')::numeric,
      v_item->>'notes'
    );
  END LOOP;

  RETURN jsonb_build_object('order_id', v_order_id, 'order_no', v_order_no);
END $$;

GRANT EXECUTE ON FUNCTION create_purchase_order(text,text,jsonb) TO authenticated;

-- -----------------------------------------------------------------------
-- 11. receive_purchase_order_item helper (handles partial receipt)
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION receive_purchase_order_item(
  p_item_id     uuid,
  p_qty_received numeric,
  p_notes       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user        app_users;
  v_item        purchase_order_items;
  v_sku         skus;
  v_movement    jsonb;
  v_mov_id      uuid;
  v_new_received numeric;
  v_new_status  text;
  v_order_status text;
  v_order_no    text;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;

  SELECT * INTO v_item FROM purchase_order_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Item not found.'; END IF;
  IF v_item.status = 'FULFILLED' THEN RAISE EXCEPTION 'This item is already fully received.'; END IF;
  IF p_qty_received <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero.'; END IF;

  SELECT * INTO v_sku FROM skus WHERE id = v_item.sku_id;
  SELECT order_no INTO v_order_no FROM purchase_orders WHERE id = v_item.order_id;

  v_movement := record_movement(
    v_sku.sku_code, 'INWARD', p_qty_received,
    v_sku.unit_code, v_order_no, p_notes, 'WEB'
  );

  SELECT id INTO v_mov_id FROM inventory_movements WHERE txn_no = (v_movement->>'txn_no');

  INSERT INTO purchase_order_receipts(order_item_id, qty_received, movement_id, received_by, notes)
  VALUES (p_item_id, p_qty_received, v_mov_id, v_user.id, p_notes);

  v_new_received := v_item.received_qty + p_qty_received;
  v_new_status   := CASE WHEN v_new_received >= v_item.ordered_qty THEN 'FULFILLED' ELSE 'PARTIAL' END;

  UPDATE purchase_order_items
    SET received_qty = v_new_received, status = v_new_status
    WHERE id = p_item_id;

  SELECT CASE
    WHEN COUNT(*) FILTER (WHERE status = 'PENDING')    = COUNT(*) THEN 'PLACED'
    WHEN COUNT(*) FILTER (WHERE status = 'FULFILLED')  = COUNT(*) THEN 'FULFILLED'
    ELSE 'PARTIAL' END
  INTO v_order_status
  FROM purchase_order_items WHERE order_id = v_item.order_id;

  UPDATE purchase_orders SET status = v_order_status, updated_at = now()
    WHERE id = v_item.order_id;

  RETURN jsonb_build_object(
    'new_received',  v_new_received,
    'item_status',   v_new_status,
    'order_status',  v_order_status,
    'movement',      v_movement
  );
END $$;

GRANT EXECUTE ON FUNCTION receive_purchase_order_item(uuid,numeric,text) TO authenticated;

-- -----------------------------------------------------------------------
-- 12. create_production_order helper
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_production_order(
  p_customer_name       text,
  p_product_description text,
  p_quantity            numeric,
  p_unit_code           text,
  p_due_date            date,
  p_notes               text,
  p_whatsapp_number     text,
  p_whatsapp_message    text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     app_users;
  v_order_id uuid;
  v_order_no text;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('transactions.create') THEN RAISE EXCEPTION 'Permission denied.'; END IF;

  v_order_no := 'WO-' || to_char(now(),'YYYYMM') || '-' ||
                lpad(nextval('production_order_no_seq')::text, 4, '0');

  INSERT INTO production_orders(
    order_no, customer_name, product_description, quantity, unit_code,
    due_date, notes, whatsapp_number, whatsapp_message, created_by
  ) VALUES (
    v_order_no, p_customer_name, p_product_description, p_quantity, p_unit_code,
    p_due_date, p_notes, p_whatsapp_number, p_whatsapp_message, v_user.id
  ) RETURNING id INTO v_order_id;

  RETURN jsonb_build_object('order_id', v_order_id, 'order_no', v_order_no);
END $$;

GRANT EXECUTE ON FUNCTION create_production_order(text,text,numeric,text,date,text,text,text) TO authenticated;
