-- =====================================================================================
-- Bhagyoday Belts - Inventory Management System
-- Migration 002 : roles, granular permissions, row level security, default settings
-- Run after 001_schema_and_engine.sql
-- =====================================================================================

-- ---------------------------------------------------------------------------- roles
insert into roles (code, name, description, rank) values
  ('SUPER_ADMIN',        'Super Admin',        'Full access including users, settings, reversals and the activity trail', 10),
  ('MANAGER',            'Manager',            'Inventory, transactions, reversals, reports and exports', 20),
  ('INVENTORY_OPERATOR', 'Inventory Operator', 'Records inward and outward stock on desktop and phone', 30),
  ('VIEWER',             'Viewer',             'Read only', 40)
on conflict (code) do update set name = excluded.name, description = excluded.description;

-- ---------------------------------------------------------------------- permissions
insert into permissions (code, module, action, description) values
  ('inventory.view',      'inventory',    'view',    'See stock and SKU details'),
  ('inventory.create',    'inventory',    'create',  'Add a new SKU'),
  ('inventory.edit',      'inventory',    'edit',    'Edit SKU settings such as minimum stock'),
  ('inventory.adjust',    'inventory',    'adjust',  'Post an authorised stock adjustment'),
  ('transactions.view',   'transactions', 'view',    'See movement history'),
  ('transactions.create', 'transactions', 'create',  'Record inward and outward movements'),
  ('transactions.reverse','transactions', 'reverse', 'Reverse a wrong movement'),
  ('reports.view',        'reports',      'view',    'Open reports'),
  ('reports.export',      'reports',      'export',  'Export reports to PDF and Excel'),
  ('products.view',       'products',     'view',    'See the product master'),
  ('products.create',     'products',     'create',  'Add brands, families and products'),
  ('products.edit',       'products',     'edit',    'Edit the product master'),
  ('products.disable',    'products',     'disable', 'Deactivate a product'),
  ('users.view',          'users',        'view',    'See user accounts'),
  ('users.create',        'users',        'create',  'Create user accounts'),
  ('users.edit',          'users',        'edit',    'Edit user accounts and roles'),
  ('users.disable',       'users',        'disable', 'Disable a user account'),
  ('settings.view',       'settings',     'view',    'Open Admin and Settings'),
  ('settings.edit',       'settings',     'edit',    'Change company settings'),
  ('settings.import',     'settings',     'import',  'Import master data from Excel'),
  ('settings.backup',     'settings',     'backup',  'Download and restore backups'),
  ('audit.view',          'audit',        'view',    'See the full activity trail across web and mobile')
on conflict (code) do update set description = excluded.description;

-- ----------------------------------------------------------------- role permissions
delete from role_permissions;

insert into role_permissions (role_code, permission_code)
select 'SUPER_ADMIN', code from permissions;

insert into role_permissions (role_code, permission_code) values
  ('MANAGER','inventory.view'), ('MANAGER','inventory.edit'), ('MANAGER','inventory.adjust'),
  ('MANAGER','transactions.view'), ('MANAGER','transactions.create'), ('MANAGER','transactions.reverse'),
  ('MANAGER','reports.view'), ('MANAGER','reports.export'),
  ('MANAGER','products.view'), ('MANAGER','products.edit'),
  ('MANAGER','users.view');

insert into role_permissions (role_code, permission_code) values
  ('INVENTORY_OPERATOR','inventory.view'),
  ('INVENTORY_OPERATOR','transactions.view'),
  ('INVENTORY_OPERATOR','transactions.create'),
  ('INVENTORY_OPERATOR','products.view'),
  ('INVENTORY_OPERATOR','reports.view');

insert into role_permissions (role_code, permission_code) values
  ('VIEWER','inventory.view'), ('VIEWER','transactions.view'),
  ('VIEWER','products.view'), ('VIEWER','reports.view');

-- ------------------------------------------------------------------ default settings
insert into app_settings (key, value, description) values
  ('company', jsonb_build_object(
      'name','Bhagyoday Belts',
      'address','Ahmedabad, Gujarat, India',
      'gstin','',
      'phone','',
      'email','',
      'report_footer','Bhagyoday Belts - Inventory Management System'),
    'Shown on exported reports'),
  ('allow_negative_stock', jsonb_build_object('enabled', false),
    'When off, an outward movement cannot take stock below zero'),
  ('data_source', jsonb_build_object(
      'status','DEMO',
      'note','DEMO / DUMMY DATA - to be replaced with Bhagyoday Belts master data'),
    'Flips to LIVE when the real master Excel is imported'),
  ('retention', jsonb_build_object('transaction_years', 2),
    'Minimum transaction history the system keeps online')
on conflict (key) do nothing;

-- =====================================================================================
-- ROW LEVEL SECURITY
-- Reads are permission gated. Writes to stock never happen through the API directly -
-- they go through record_movement / reverse_movement, which are SECURITY DEFINER and
-- check permissions themselves. So there are deliberately no INSERT/UPDATE policies
-- on inventory_movements.
-- =====================================================================================

alter table roles              enable row level security;
alter table permissions        enable row level security;
alter table role_permissions   enable row level security;
alter table app_users          enable row level security;
alter table units              enable row level security;
alter table brands             enable row level security;
alter table product_families   enable row level security;
alter table suppliers          enable row level security;
alter table skus               enable row level security;
alter table inventory_movements enable row level security;
alter table audit_logs         enable row level security;
alter table app_settings       enable row level security;
alter table import_batches     enable row level security;
alter table backup_records     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['roles','permissions','role_permissions','app_users','units','brands',
                           'product_families','suppliers','skus','inventory_movements','audit_logs',
                           'app_settings','import_batches','backup_records']
  loop
    execute format('drop policy if exists p_read on %I', t);
    execute format('drop policy if exists p_write on %I', t);
    execute format('drop policy if exists p_update on %I', t);
  end loop;
end $$;

-- everyone signed in can read the reference vocabulary
create policy p_read on roles            for select to authenticated using (true);
create policy p_read on permissions      for select to authenticated using (true);
create policy p_read on role_permissions for select to authenticated using (true);
create policy p_read on units            for select to authenticated using (true);

-- own profile always readable; the full list needs users.view
create policy p_read on app_users for select to authenticated
  using (auth_user_id = auth.uid() or has_permission('users.view'));

create policy p_read on brands           for select to authenticated using (has_permission('products.view'));
create policy p_read on product_families for select to authenticated using (has_permission('products.view'));
create policy p_read on suppliers        for select to authenticated using (has_permission('products.view'));
create policy p_read on skus             for select to authenticated using (has_permission('inventory.view'));
create policy p_read on inventory_movements for select to authenticated using (has_permission('transactions.view'));

-- the activity trail is Super Admin territory
create policy p_read on audit_logs       for select to authenticated using (has_permission('audit.view'));
create policy p_read on import_batches   for select to authenticated using (has_permission('settings.view'));
create policy p_read on backup_records   for select to authenticated using (has_permission('settings.view'));
create policy p_read on app_settings     for select to authenticated using (true);

-- master data edits from the app
create policy p_write  on skus   for insert to authenticated with check (has_permission('products.create'));
create policy p_update on skus   for update to authenticated using (has_permission('inventory.edit'))
                                                          with check (has_permission('inventory.edit'));
create policy p_write  on brands for insert to authenticated with check (has_permission('products.create'));
create policy p_update on brands for update to authenticated using (has_permission('products.edit'))
                                                            with check (has_permission('products.edit'));
create policy p_update on app_settings for update to authenticated using (has_permission('settings.edit'))
                                                                  with check (has_permission('settings.edit'));
create policy p_write  on app_users for insert to authenticated with check (has_permission('users.create'));
create policy p_update on app_users for update to authenticated using (has_permission('users.edit'))
                                                               with check (has_permission('users.edit'));

-- audit rows are written by log_audit() only
create policy p_write on audit_logs for insert to authenticated with check (false);

-- ------------------------------------------------------------------- function grants
grant execute on function record_movement(text,text,numeric,text,text,text,text,timestamptz) to authenticated;
grant execute on function reverse_movement(uuid,text,text) to authenticated;
grant execute on function reconcile_stock() to authenticated;
grant execute on function dashboard_summary() to authenticated;
grant execute on function my_permissions() to authenticated;
grant execute on function current_app_user() to authenticated;
grant execute on function has_permission(text) to authenticated;

revoke execute on function purge_transactional_data() from authenticated, anon;
revoke execute on function rebuild_stock_cache() from anon;
