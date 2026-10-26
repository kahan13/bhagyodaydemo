-- =====================================================================================
-- 036  Three roles — Admin, Accounts, Workshop — and page access for Workshop
--
--   Role            Database code    Sees
--   -------------   --------------   ----------------------------------------------------
--   Admin           SUPER_ADMIN      everything, including the Administration group
--   Accounts        MANAGER          every daily page; NOT the Administration group
--                                    (Product Master, Teams & Users, Import Data, Admin, Activity)
--   Workshop        VIEWER           only the pages an Admin switches on for that person,
--                                    each one either "view only" or "can edit"
--
--   (The database codes stay as they are so nothing already saved breaks; only the names
--    people see changed. The old Inventory Operator role is folded into Accounts.)
--
--   How page access works
--     app_pages          the pages that can be switched on for a Workshop person
--     page_permissions   what each page lets a person read (view) and write (edit)
--     user_page_access   which pages each person has, and whether they can edit
--   has_permission() and my_session() read these, so the database, the menu and every page
--   agree. Admin and Accounts are not affected: they keep using role_permissions.
--
--   New permissions
--     production.view     open "Production Order in Progress"
--     production.update   mark an order In Progress / Completed (Workshop's job)
--
-- Safe to run more than once. Run after 035.
-- =====================================================================================

-- ── 1. Roles ──────────────────────────────────────────────────────────────────────
UPDATE roles SET name = 'Admin',    rank = 10,
       description = 'Everything, including Teams & Users, Product Master, imports and the activity trail'
 WHERE code = 'SUPER_ADMIN';
UPDATE roles SET name = 'Accounts', rank = 20,
       description = 'All daily work — production orders, inventory, purchase orders, transactions, reports. Not the Administration group'
 WHERE code = 'MANAGER';
UPDATE roles SET name = 'Workshop', rank = 30,
       description = 'Sees only the pages an Admin switches on, each view-only or editable'
 WHERE code = 'VIEWER';

-- Inventory Operators become Accounts, then the role goes away.
UPDATE app_users SET role_code = 'MANAGER' WHERE role_code = 'INVENTORY_OPERATOR';
DELETE FROM roles WHERE code = 'INVENTORY_OPERATOR';

-- ── 2. New permissions ────────────────────────────────────────────────────────────
INSERT INTO permissions (code, module, action, description) VALUES
  ('production.view',   'production', 'view',   'Open Production Order in Progress'),
  ('production.update', 'production', 'update', 'Mark production orders In Progress / Completed')
ON CONFLICT (code) DO NOTHING;

-- Admin and Accounts can do both.
INSERT INTO role_permissions (role_code, permission_code)
SELECT r, p FROM (VALUES ('SUPER_ADMIN'), ('MANAGER')) a(r),
                 (VALUES ('production.view'), ('production.update')) b(p)
ON CONFLICT DO NOTHING;

-- Accounts do not touch the Administration group. Product Master (add / edit products) is part
-- of it, so Accounts lose the product rights; everything else they had stays.
DELETE FROM role_permissions
 WHERE role_code = 'MANAGER'
   AND permission_code IN ('products.view', 'products.create', 'products.edit',
                           'users.view', 'users.create', 'users.edit', 'users.disable',
                           'settings.view', 'settings.edit', 'settings.import', 'settings.backup',
                           'audit.view');

-- Workshop gets nothing by role: their access comes from the pages switched on for them.
DELETE FROM role_permissions WHERE role_code = 'VIEWER';

-- ── 3. Pages and what they allow ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_pages (
  page_key text PRIMARY KEY,
  label    text NOT NULL,
  sort     int  NOT NULL
);
INSERT INTO app_pages (page_key, label, sort) VALUES
  ('dashboard',             'Dashboard',                      1),
  ('production_orders',     'Production Order',               2),
  ('production_in_progress','Production Order in Progress',   3),
  ('inventory',             'Inventory',                      4),
  ('purchase_orders',       'Purchase Orders',                5),
  ('transactions',          'Transactions',                   6),
  ('reports',               'Reports',                        7)
ON CONFLICT (page_key) DO UPDATE SET label = EXCLUDED.label, sort = EXCLUDED.sort;

CREATE TABLE IF NOT EXISTS page_permissions (
  page_key        text NOT NULL REFERENCES app_pages(page_key) ON DELETE CASCADE,
  level           text NOT NULL CHECK (level IN ('view', 'edit')),
  permission_code text NOT NULL REFERENCES permissions(code)   ON DELETE CASCADE,
  PRIMARY KEY (page_key, level, permission_code)
);

DELETE FROM page_permissions;
INSERT INTO page_permissions (page_key, level, permission_code) VALUES
  -- Dashboard: stock, orders and recent activity; edit = quick Record Inward / Outward
  ('dashboard',              'view', 'inventory.view'),
  ('dashboard',              'view', 'transactions.view'),
  ('dashboard',              'edit', 'transactions.create'),
  -- Production Order (creating orders)
  ('production_orders',      'view', 'inventory.view'),
  ('production_orders',      'view', 'transactions.view'),
  ('production_orders',      'edit', 'transactions.create'),
  -- Production Order in Progress: the workshop inbox; edit = In Progress / Completed buttons
  ('production_in_progress', 'view', 'production.view'),
  ('production_in_progress', 'view', 'transactions.view'),
  ('production_in_progress', 'edit', 'production.update'),
  -- Inventory; edit = record inward / outward / adjustments
  ('inventory',              'view', 'inventory.view'),
  ('inventory',              'view', 'transactions.view'),
  ('inventory',              'edit', 'transactions.create'),
  ('inventory',              'edit', 'inventory.adjust'),
  -- Purchase Orders; edit = create, receive, record inward
  ('purchase_orders',        'view', 'inventory.view'),
  ('purchase_orders',        'view', 'transactions.view'),
  ('purchase_orders',        'edit', 'transactions.create'),
  -- Transactions; edit = reverse a transaction
  ('transactions',           'view', 'inventory.view'),
  ('transactions',           'view', 'transactions.view'),
  ('transactions',           'edit', 'transactions.reverse'),
  -- Reports; edit = download / export
  ('reports',                'view', 'reports.view'),
  ('reports',                'view', 'inventory.view'),
  ('reports',                'view', 'transactions.view'),
  ('reports',                'edit', 'reports.export');

CREATE TABLE IF NOT EXISTS user_page_access (
  user_id  uuid    NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  page_key text    NOT NULL REFERENCES app_pages(page_key) ON DELETE CASCADE,
  can_edit boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, page_key)
);
ALTER TABLE user_page_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_pages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_permissions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_pages' AND policyname = 'app_pages_read') THEN
    CREATE POLICY app_pages_read ON app_pages FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'page_permissions' AND policyname = 'page_permissions_read') THEN
    CREATE POLICY page_permissions_read ON page_permissions FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'user_page_access' AND policyname = 'upa_read') THEN
    CREATE POLICY upa_read ON user_page_access FOR SELECT TO authenticated
      USING (user_id = (SELECT u.id FROM current_app_user() u) OR has_permission('users.edit'));
  END IF;
END $$;
GRANT SELECT ON app_pages, page_permissions, user_page_access TO authenticated;

-- People who were already Workshop (Viewer) keep what they could see before, view-only, and can
-- mark their production orders; an Admin can then adjust it per person in Teams & Users.
INSERT INTO user_page_access (user_id, page_key, can_edit)
SELECT u.id, p.page_key, (p.page_key = 'production_in_progress')
  FROM app_users u CROSS JOIN app_pages p
 WHERE u.role_code = 'VIEWER'
   AND NOT EXISTS (SELECT 1 FROM user_page_access a WHERE a.user_id = u.id)
ON CONFLICT DO NOTHING;

-- ── 4. has_permission() and my_session() now understand page access ────────────────
CREATE OR REPLACE FUNCTION has_permission(p_code text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_users u
     WHERE u.auth_user_id = auth.uid() AND u.is_active
       AND (
         EXISTS (SELECT 1 FROM role_permissions rp
                  WHERE rp.role_code = u.role_code AND rp.permission_code = p_code)
         OR (u.role_code = 'VIEWER' AND EXISTS (
               SELECT 1 FROM user_page_access a
                 JOIN page_permissions pp ON pp.page_key = a.page_key
                WHERE a.user_id = u.id AND pp.permission_code = p_code
                  AND (pp.level = 'view' OR a.can_edit)))
       )
  )
$$;

CREATE OR REPLACE FUNCTION my_session()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', u.id, 'user_code', u.user_code, 'full_name', u.full_name,
    'username', u.username, 'email', u.email, 'role_code', u.role_code,
    'primary_device', u.primary_device, 'is_active', u.is_active,
    'permissions', COALESCE((
       SELECT jsonb_agg(code ORDER BY code) FROM (
         SELECT rp.permission_code AS code FROM role_permissions rp WHERE rp.role_code = u.role_code
         UNION
         SELECT pp.permission_code FROM user_page_access a
           JOIN page_permissions pp ON pp.page_key = a.page_key
          WHERE u.role_code = 'VIEWER' AND a.user_id = u.id AND (pp.level = 'view' OR a.can_edit)
       ) x), '[]'::jsonb),
    -- pages in the menu: Admin and Accounts get every page, Workshop only the ones switched on
    'pages', COALESCE((
       SELECT jsonb_agg(jsonb_build_object('page', pg.page_key, 'can_edit', true) ORDER BY pg.sort)
         FROM app_pages pg WHERE u.role_code IN ('SUPER_ADMIN', 'MANAGER')
       ), '[]'::jsonb)
       || COALESCE((
       SELECT jsonb_agg(jsonb_build_object('page', a.page_key, 'can_edit', a.can_edit) ORDER BY pg.sort)
         FROM user_page_access a JOIN app_pages pg ON pg.page_key = a.page_key
        WHERE u.role_code = 'VIEWER' AND a.user_id = u.id
       ), '[]'::jsonb)
  ) END
  FROM (SELECT * FROM app_users WHERE auth_user_id = auth.uid() AND is_active LIMIT 1) u
$$;

-- ── 5. Admin sets a person's pages ────────────────────────────────────────────────
-- p_pages = [{"page":"inventory","can_edit":false}, ...]  — replaces the person's whole list
CREATE OR REPLACE FUNCTION set_user_page_access(p_user_id uuid, p_pages jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_target app_users;
  v_item   jsonb;
  v_n      int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT has_permission('users.edit') THEN
    RAISE EXCEPTION 'Only an Admin can change page access.';
  END IF;
  SELECT * INTO v_target FROM app_users WHERE id = p_user_id;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'User not found.'; END IF;
  IF p_pages IS NULL OR jsonb_typeof(p_pages) <> 'array' THEN
    RAISE EXCEPTION 'Send the pages as a list.';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_pages) LOOP
    IF NOT EXISTS (SELECT 1 FROM app_pages WHERE page_key = v_item->>'page') THEN
      RAISE EXCEPTION 'Unknown page "%".', v_item->>'page';
    END IF;
  END LOOP;

  DELETE FROM user_page_access WHERE user_id = p_user_id;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_pages) LOOP
    INSERT INTO user_page_access (user_id, page_key, can_edit)
    VALUES (p_user_id, v_item->>'page', COALESCE((v_item->>'can_edit')::boolean, false))
    ON CONFLICT (user_id, page_key) DO UPDATE SET can_edit = EXCLUDED.can_edit;
    v_n := v_n + 1;
  END LOOP;

  PERFORM log_audit('UPDATE', 'USER', v_target.id::text, v_target.full_name,
                    NULL, v_n || ' page(s)', 'WEB',
                    'Page access changed for ' || v_target.full_name || ': ' || v_n || ' page(s)');
  RETURN jsonb_build_object('user_id', p_user_id, 'pages', v_n);
END $$;
REVOKE ALL ON FUNCTION set_user_page_access(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_user_page_access(uuid, jsonb) TO authenticated;

-- ── 6. Marking a production order In Progress / Completed ──────────────────────────
CREATE OR REPLACE FUNCTION set_production_order_status(p_order_id uuid, p_status text)
RETURNS production_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  app_users;
  v_order production_orders;
BEGIN
  SELECT * INTO v_user FROM current_app_user();
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Not signed in.'; END IF;
  IF NOT (has_permission('production.update') OR has_permission('transactions.create')) THEN
    RAISE EXCEPTION 'Your account can view production orders but not change them.';
  END IF;

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

-- ── 7. Ticking off reorders follows the same rule as other writes ───────────────────
-- (set_reorder_mark already needs transactions.create, which a Workshop person only gets when
--  an editable page grants it.)

SELECT 'ok' AS status,
       (SELECT string_agg(code || '=' || name, ', ' ORDER BY rank) FROM roles) AS roles,
       (SELECT count(*) FROM user_page_access) AS page_rows;
