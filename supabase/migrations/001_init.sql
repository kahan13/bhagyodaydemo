-- =====================================================================================
-- Bhagyoday Belts - Inventory Management System  |  v2 schema
-- Single migration: drops v1 objects, rebuilds schema, engine, RBAC, RLS and seed.
-- Run in Supabase > SQL Editor. Safe to re-run.
-- =====================================================================================
-- No product data lives here. Brands, families, SKUs, stock and history all arrive
-- through scripts/import-master-excel.mjs.
-- =====================================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ------------------------------------------------------------------- clean slate
drop view if exists v_movements cascade;
drop view if exists v_sku_status cascade;
drop table if exists audit_logs, backup_records, import_batches, inventory_movements,
                     skus, product_families, brands, suppliers, units,
                     role_permissions, permissions, app_users, roles, app_settings cascade;
drop sequence if exists movement_no_seq;

-- Functions are not covered by the table drops above. Ones that return a table
-- type (current_app_user) went down with their table, but ones returning
-- scalars or a TABLE(...) row survive, and CREATE OR REPLACE cannot change a
-- return type in place. Drop them by resolved signature so re-running is safe
-- no matter what shape an earlier version had.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'reconcile_stock', 'rebuild_stock_cache', 'record_movement', 'reverse_movement',
         'current_app_user', 'has_permission', 'log_audit', 'dashboard_summary',
         'my_session', 'purge_transactional_data', 'sync_movement_seq',
         'guard_movement_write', 'purge_movements', 'stock_reconciliation'
       )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- =====================================================================================
-- REFERENCE
-- =====================================================================================

create table roles (
  code        text primary key,
  name        text not null,
  description text,
  rank        int  not null default 100
);

create table permissions (
  code        text primary key,
  module      text not null,
  action      text not null,
  description text
);

create table role_permissions (
  role_code       text not null references roles(code) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

create table app_users (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid unique,
  user_code      text unique,
  full_name      text not null,
  username       text not null unique,
  email          text unique,
  mobile         text,
  role_code      text not null references roles(code),
  primary_device text not null default 'WEB' check (primary_device in ('WEB','MOBILE_PWA')),
  is_active      boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now()
);
create index idx_users_auth on app_users(auth_user_id);

create table units (
  code      text primary key,
  name      text not null,
  decimals  int  not null default 0,
  used_for  text,
  is_active boolean not null default true
);

create table brands (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  country_origin   text,
  has_timing_belts boolean not null default true,
  has_v_belts      boolean not null default true,
  is_active        boolean not null default true
);

-- One row per timing-belt family and per V-belt profile. Adding a whole new
-- product category later is a spreadsheet row, not a schema change.
create table product_families (
  id               uuid primary key default gen_random_uuid(),
  product_type     text not null check (product_type in ('TIMING_BELT','V_BELT')),
  code             text not null,
  name             text not null,
  standard         text,
  pitch_mm         numeric(8,3),
  belt_form        text,
  default_unit     text references units(code),
  size_designation text,
  profile_group    text,
  sort_order       int not null default 100,
  is_active        boolean not null default true,
  unique (product_type, code)
);

create table suppliers (
  id             uuid primary key default gen_random_uuid(),
  supplier_code  text not null unique,
  name           text not null,
  city           text,
  state          text,
  gstin          text,
  contact_person text,
  phone          text,
  email          text,
  brands_supplied text,
  lead_time_days int,
  payment_terms  text,
  is_active      boolean not null default true
);

-- =====================================================================================
-- SKUs
-- hier_l1/l2/l3 hold the browse path, resolved at import time:
--   TIMING_BELT : family -> exact size -> brand
--   V_BELT      : brand  -> profile    -> exact size
-- The UI reads these columns, so it never needs to know what a belt is.
-- =====================================================================================

create table skus (
  id                 uuid primary key default gen_random_uuid(),
  sku_code           text not null unique,
  product_type       text not null check (product_type in ('TIMING_BELT','V_BELT')),
  family_id          uuid not null references product_families(id),
  brand_id           uuid not null references brands(id),
  exact_size         text not null,
  display_name       text not null,
  hier_l1            text not null,
  hier_l2            text not null,
  hier_l3            text not null,
  search_text        text not null default '',
  belt_form          text,
  construction       text,
  standard           text,
  pitch_mm           numeric(8,3),
  pitch_length_mm    numeric(10,2),
  width_mm           numeric(10,2),
  teeth              int,
  nominal_length     numeric(10,2),
  length_designation text,
  unit_code          text not null references units(code),
  opening_stock      numeric(14,2) not null default 0,
  current_stock      numeric(14,2) not null default 0,
  min_stock_level    numeric(14,2) not null default 0,
  supplier_moq       numeric(14,2) not null default 0,
  reorder_quantity   numeric(14,2) not null default 0,
  default_supplier_id uuid references suppliers(id),
  rack_location      text,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index idx_skus_browse on skus(product_type, hier_l1, hier_l2, hier_l3) where is_active;
create index idx_skus_brand  on skus(brand_id);
create index idx_skus_low    on skus(current_stock, min_stock_level) where is_active;
create index idx_skus_search on skus using gin (search_text gin_trgm_ops);

-- =====================================================================================
-- MOVEMENTS
-- =====================================================================================

create sequence movement_no_seq start 1;

create table inventory_movements (
  id             uuid primary key default gen_random_uuid(),
  txn_no         text not null unique,
  sku_id         uuid not null references skus(id),
  txn_type       text not null check (txn_type in ('INWARD','OUTWARD','ADJUSTMENT')),
  txn_mode       text not null default 'NORMAL' check (txn_mode in ('NORMAL','REVERSAL')),
  quantity       numeric(14,2) not null,
  unit_code      text not null references units(code),
  previous_stock numeric(14,2) not null,
  new_stock      numeric(14,2) not null,
  occurred_at    timestamptz not null default now(),
  user_id        uuid references app_users(id),
  user_name      text not null,
  channel        text not null default 'WEB'
                 check (channel in ('WEB','MOBILE_PWA','MOBILE_VOICE','IMPORT','SYSTEM')),
  reference      text,
  notes          text,
  reversal_of    uuid references inventory_movements(id),
  reversed_by    uuid references inventory_movements(id),
  is_reversed    boolean not null default false,
  created_at     timestamptz not null default now()
);

create index idx_mov_when on inventory_movements(occurred_at desc);
create index idx_mov_sku  on inventory_movements(sku_id, occurred_at desc);
create index idx_mov_type on inventory_movements(txn_type, occurred_at desc);
create index idx_mov_user on inventory_movements(user_id);

-- Historical movements are never deleted and never silently edited.
create or replace function guard_movement_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('bhagyoday.allow_purge', true), 'off') = 'on' then
      return old;
    end if;
    raise exception 'Stock movements cannot be deleted. Create a reversal instead.';
  end if;

  if (new.sku_id, new.txn_type, new.quantity, new.previous_stock, new.new_stock,
      new.occurred_at, new.user_id, new.txn_no)
     is distinct from
     (old.sku_id, old.txn_type, old.quantity, old.previous_stock, old.new_stock,
      old.occurred_at, old.user_id, old.txn_no)
     and coalesce(current_setting('bhagyoday.allow_purge', true), 'off') <> 'on' then
    raise exception 'Stock movements are immutable. Create a reversal instead.';
  end if;
  return new;
end $$;

create trigger trg_guard_movement
  before update or delete on inventory_movements
  for each row execute function guard_movement_write();

-- =====================================================================================
-- AUDIT, SETTINGS, BATCHES
-- =====================================================================================

create table audit_logs (
  id               uuid primary key default gen_random_uuid(),
  occurred_at      timestamptz not null default now(),
  user_id          uuid references app_users(id),
  user_name        text,
  role_code        text,
  action           text not null,
  entity_type      text not null,
  entity_id        text,
  entity_reference text,
  old_value        text,
  new_value        text,
  channel          text not null default 'WEB',
  ip_address       text,
  description      text
);
create index idx_audit_when on audit_logs(occurred_at desc);

create table app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);

create table import_batches (
  id          uuid primary key default gen_random_uuid(),
  file_name   text not null,
  imported_at timestamptz not null default now(),
  imported_by text,
  mode        text not null,
  counts      jsonb not null default '{}'::jsonb,
  warnings    jsonb not null default '[]'::jsonb,
  notes       text
);

create table backup_records (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references app_users(id),
  file_name  text not null,
  size_bytes bigint,
  row_counts jsonb
);

-- =====================================================================================
-- IDENTITY + PERMISSIONS
-- =====================================================================================

create or replace function current_app_user()
returns app_users language sql stable security definer set search_path = public as $$
  select u.* from app_users u where u.auth_user_id = auth.uid() and u.is_active limit 1
$$;

create or replace function has_permission(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_users u
    join role_permissions rp on rp.role_code = u.role_code
    where u.auth_user_id = auth.uid() and u.is_active and rp.permission_code = p_code
  )
$$;

-- One round trip for the whole session: profile + permissions together.
create or replace function my_session()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when u.id is null then null else jsonb_build_object(
    'id', u.id, 'user_code', u.user_code, 'full_name', u.full_name,
    'username', u.username, 'email', u.email, 'role_code', u.role_code,
    'primary_device', u.primary_device, 'is_active', u.is_active,
    'permissions', coalesce((
      select jsonb_agg(rp.permission_code order by rp.permission_code)
      from role_permissions rp where rp.role_code = u.role_code), '[]'::jsonb)
  ) end
  from (select * from app_users where auth_user_id = auth.uid() and is_active limit 1) u
$$;

create or replace function log_audit(
  p_action text, p_entity_type text, p_entity_id text, p_entity_ref text,
  p_old text, p_new text, p_channel text, p_description text
) returns void language plpgsql security definer set search_path = public as $$
declare u app_users;
begin
  select * into u from current_app_user();
  insert into audit_logs(user_id, user_name, role_code, action, entity_type, entity_id,
                         entity_reference, old_value, new_value, channel, description)
  values (u.id, coalesce(u.full_name,'system'), u.role_code, p_action, p_entity_type,
          p_entity_id, p_entity_ref, p_old, p_new, coalesce(p_channel,'WEB'), p_description);
end $$;

-- =====================================================================================
-- INVENTORY ENGINE - the only way stock ever changes
-- =====================================================================================

create or replace function record_movement(
  p_sku_code    text,
  p_txn_type    text,
  p_quantity    numeric,
  p_unit_code   text default null,
  p_reference   text default null,
  p_notes       text default null,
  p_channel     text default 'WEB'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user app_users; v_sku skus;
  v_prev numeric(14,2); v_new numeric(14,2);
  v_allow_neg boolean; v_txn_no text; v_needed text;
begin
  select * into v_user from current_app_user();
  if v_user.id is null then raise exception 'Not signed in, or this account is disabled.'; end if;

  v_needed := case when p_txn_type = 'ADJUSTMENT' then 'inventory.adjust' else 'transactions.create' end;
  if not has_permission(v_needed) then
    raise exception 'Your role does not allow this action.';
  end if;

  select * into v_sku from skus where sku_code = p_sku_code for update;
  if v_sku.id is null then raise exception 'Unknown product.'; end if;
  if not v_sku.is_active then raise exception '% is inactive.', v_sku.display_name; end if;

  if p_unit_code is not null and upper(p_unit_code) <> v_sku.unit_code then
    raise exception '% is stocked in %, not %.', v_sku.display_name, v_sku.unit_code, p_unit_code;
  end if;

  if p_txn_type in ('INWARD','OUTWARD') and p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero.';
  end if;
  if p_txn_type = 'ADJUSTMENT' then
    if p_quantity = 0 then raise exception 'An adjustment of zero changes nothing.'; end if;
    if coalesce(btrim(p_notes),'') = '' then raise exception 'A stock adjustment needs a reason.'; end if;
  end if;

  v_prev := v_sku.current_stock;
  v_new  := case p_txn_type when 'INWARD' then v_prev + p_quantity
                            when 'OUTWARD' then v_prev - p_quantity
                            else v_prev + p_quantity end;

  select coalesce((value->>'enabled')::boolean, false) into v_allow_neg
    from app_settings where key = 'allow_negative_stock';

  if v_new < 0 and not coalesce(v_allow_neg, false) then
    raise exception 'Only % % in stock.', v_prev, v_sku.unit_code;
  end if;

  v_txn_no := 'TXN-' || to_char(now(),'YYYYMM') || '-' || lpad(nextval('movement_no_seq')::text, 5, '0');

  insert into inventory_movements(txn_no, sku_id, txn_type, txn_mode, quantity, unit_code,
    previous_stock, new_stock, occurred_at, user_id, user_name, channel, reference, notes)
  values (v_txn_no, v_sku.id, p_txn_type, 'NORMAL', p_quantity, v_sku.unit_code,
    v_prev, v_new, now(), v_user.id, v_user.full_name, p_channel, p_reference, p_notes);

  update skus set current_stock = v_new, updated_at = now() where id = v_sku.id;

  perform log_audit(case p_txn_type when 'ADJUSTMENT' then 'ADJUST' else 'CREATE' end,
                    'TRANSACTION', v_txn_no, v_sku.display_name, v_prev::text, v_new::text,
                    p_channel, p_txn_type || ' ' || p_quantity || ' ' || v_sku.unit_code);

  return jsonb_build_object('txn_no', v_txn_no, 'sku_code', v_sku.sku_code,
    'display_name', v_sku.display_name, 'previous_stock', v_prev, 'new_stock', v_new,
    'unit_code', v_sku.unit_code, 'txn_type', p_txn_type);
end $$;

create or replace function reverse_movement(p_movement_id uuid, p_reason text, p_channel text default 'WEB')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user app_users; v_orig inventory_movements; v_sku skus;
  v_prev numeric(14,2); v_new numeric(14,2);
  v_type text; v_qty numeric(14,2); v_id uuid; v_txn_no text;
begin
  select * into v_user from current_app_user();
  if v_user.id is null then raise exception 'Not signed in.'; end if;
  if not has_permission('transactions.reverse') then
    raise exception 'Your role does not allow reversals.';
  end if;
  if coalesce(btrim(p_reason),'') = '' then raise exception 'A reversal needs a reason.'; end if;

  select * into v_orig from inventory_movements where id = p_movement_id for update;
  if v_orig.id is null then raise exception 'That transaction does not exist.'; end if;
  if v_orig.is_reversed then raise exception '% was already reversed.', v_orig.txn_no; end if;
  if v_orig.txn_mode = 'REVERSAL' then raise exception 'A reversal cannot be reversed.'; end if;

  select * into v_sku from skus where id = v_orig.sku_id for update;

  if v_orig.txn_type = 'INWARD' then v_type := 'OUTWARD'; v_qty := v_orig.quantity;
  elsif v_orig.txn_type = 'OUTWARD' then v_type := 'INWARD'; v_qty := v_orig.quantity;
  else v_type := 'ADJUSTMENT'; v_qty := -v_orig.quantity; end if;

  v_prev := v_sku.current_stock;
  v_new  := case v_type when 'INWARD' then v_prev + v_qty
                        when 'OUTWARD' then v_prev - v_qty else v_prev + v_qty end;

  if v_new < 0 then
    raise exception 'Reversing % would take stock below zero.', v_orig.txn_no;
  end if;

  v_txn_no := 'TXN-' || to_char(now(),'YYYYMM') || '-' || lpad(nextval('movement_no_seq')::text, 5, '0');

  insert into inventory_movements(txn_no, sku_id, txn_type, txn_mode, quantity, unit_code,
    previous_stock, new_stock, occurred_at, user_id, user_name, channel, reference, notes, reversal_of)
  values (v_txn_no, v_sku.id, v_type, 'REVERSAL', v_qty, v_sku.unit_code, v_prev, v_new,
    now(), v_user.id, v_user.full_name, p_channel, v_orig.reference,
    'Reversal of ' || v_orig.txn_no || ' - ' || p_reason, v_orig.id)
  returning id into v_id;

  update inventory_movements set is_reversed = true, reversed_by = v_id where id = v_orig.id;
  update skus set current_stock = v_new, updated_at = now() where id = v_sku.id;

  perform log_audit('REVERSE','TRANSACTION', v_txn_no, v_sku.display_name,
                    v_orig.txn_no, v_txn_no, p_channel, p_reason);

  return jsonb_build_object('txn_no', v_txn_no, 'reversed', v_orig.txn_no, 'new_stock', v_new);
end $$;

create or replace function rebuild_stock_cache()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  with derived as (
    select s.id, s.opening_stock + coalesce(sum(
      case m.txn_type when 'INWARD' then m.quantity
                      when 'OUTWARD' then -m.quantity else m.quantity end), 0) as val
    from skus s left join inventory_movements m on m.sku_id = s.id
    group by s.id, s.opening_stock
  )
  update skus s set current_stock = d.val, updated_at = now()
  from derived d where d.id = s.id and s.current_stock <> d.val;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function reconcile_stock()
returns table (sku_code text, display_name text, cached numeric, derived numeric)
language sql security definer set search_path = public as $$
  with d as (
    select s.id, s.opening_stock + coalesce(sum(
      case m.txn_type when 'INWARD' then m.quantity
                      when 'OUTWARD' then -m.quantity else m.quantity end), 0) as val
    from skus s left join inventory_movements m on m.sku_id = s.id
    group by s.id, s.opening_stock
  )
  select s.sku_code, s.display_name, s.current_stock, d.val
  from skus s join d on d.id = s.id where s.current_stock <> d.val
$$;

create or replace function purge_transactional_data()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('bhagyoday.allow_purge','on', true);
  update inventory_movements set reversed_by = null, is_reversed = false;
  delete from inventory_movements;
  perform setval('movement_no_seq', 1, false);
  perform set_config('bhagyoday.allow_purge','off', true);
end $$;

create or replace function sync_movement_seq()
returns bigint language sql security definer set search_path = public as $$
  select setval('movement_no_seq', greatest((select count(*) from inventory_movements), 1), true)
$$;

-- =====================================================================================
-- VIEWS
-- =====================================================================================

create view v_sku_status
with (security_invoker = on) as
select
  s.id, s.sku_code, s.product_type, s.display_name, s.exact_size,
  s.hier_l1, s.hier_l2, s.hier_l3, s.search_text,
  b.code as brand_code, b.name as brand_name,
  f.code as family_code, f.name as family_name, f.profile_group,
  s.belt_form, s.construction, s.standard, s.pitch_mm, s.pitch_length_mm,
  s.width_mm, s.teeth, s.nominal_length, s.length_designation, s.rack_location,
  s.unit_code, s.opening_stock, s.current_stock, s.min_stock_level,
  s.supplier_moq, s.reorder_quantity, s.is_active,
  sup.name as supplier_name,
  case when s.current_stock <= 0 then 'OUT_OF_STOCK'
       when s.current_stock < s.min_stock_level then 'LOW_STOCK'
       else 'OK' end as stock_status,
  greatest(s.min_stock_level - s.current_stock, 0) as shortfall,
  case when s.current_stock < s.min_stock_level
       then greatest(s.supplier_moq, s.min_stock_level - s.current_stock) else 0 end
       as suggested_purchase_qty
from skus s
join brands b on b.id = s.brand_id
join product_families f on f.id = s.family_id
left join suppliers sup on sup.id = s.default_supplier_id;

create view v_movements
with (security_invoker = on) as
select
  m.id, m.txn_no, m.occurred_at, m.txn_type, m.txn_mode, m.quantity, m.unit_code,
  m.previous_stock, m.new_stock, m.reference, m.notes, m.channel,
  m.user_id, m.user_name, m.reversal_of, m.reversed_by, m.is_reversed,
  s.sku_code, s.display_name, s.product_type, s.exact_size,
  b.name as brand_name, f.code as family_code
from inventory_movements m
join skus s on s.id = m.sku_id
join brands b on b.id = s.brand_id
join product_families f on f.id = s.family_id;

create or replace function dashboard_summary()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'total_skus',   (select count(*) from skus where is_active),
    'timing_skus',  (select count(*) from skus where is_active and product_type='TIMING_BELT'),
    'vbelt_skus',   (select count(*) from skus where is_active and product_type='V_BELT'),
    'low_stock',    (select count(*) from skus where is_active and current_stock>0 and current_stock<min_stock_level),
    'out_of_stock', (select count(*) from skus where is_active and current_stock<=0),
    'today_inward', (select count(*) from inventory_movements where txn_type='INWARD' and occurred_at>=date_trunc('day', now() at time zone 'Asia/Kolkata')),
    'today_outward',(select count(*) from inventory_movements where txn_type='OUTWARD' and occurred_at>=date_trunc('day', now() at time zone 'Asia/Kolkata')),
    'today_adjust', (select count(*) from inventory_movements where txn_type='ADJUSTMENT' and occurred_at>=date_trunc('day', now() at time zone 'Asia/Kolkata')),
    'month_moves',  (select count(*) from inventory_movements where occurred_at>=date_trunc('month', now() at time zone 'Asia/Kolkata')),
    'total_moves',  (select count(*) from inventory_movements)
  )
$$;

-- =====================================================================================
-- SEED: roles, permissions, settings
-- =====================================================================================

insert into roles (code, name, description, rank) values
  ('SUPER_ADMIN','Super Admin','Everything, including users, settings and the activity trail',10),
  ('MANAGER','Manager','Inventory, transactions, reversals, reports and exports',20),
  ('INVENTORY_OPERATOR','Inventory Operator','Records stock in and out on desktop and phone',30),
  ('VIEWER','Viewer','Read only',40);

insert into permissions (code, module, action, description) values
  ('inventory.view','inventory','view','See stock and product details'),
  ('inventory.create','inventory','create','Add a product'),
  ('inventory.edit','inventory','edit','Edit product settings such as minimum stock'),
  ('inventory.adjust','inventory','adjust','Post an authorised stock adjustment'),
  ('transactions.view','transactions','view','See movement history'),
  ('transactions.create','transactions','create','Record stock in and out'),
  ('transactions.reverse','transactions','reverse','Reverse a wrong movement'),
  ('reports.view','reports','view','Open reports'),
  ('reports.export','reports','export','Export to PDF and Excel'),
  ('products.view','products','view','See the product master'),
  ('products.create','products','create','Add brands and products'),
  ('products.edit','products','edit','Edit the product master'),
  ('users.view','users','view','See user accounts'),
  ('users.create','users','create','Create user accounts'),
  ('users.edit','users','edit','Edit accounts and roles'),
  ('users.disable','users','disable','Disable an account'),
  ('settings.view','settings','view','Open Admin'),
  ('settings.edit','settings','edit','Change company settings'),
  ('settings.import','settings','import','Import master data'),
  ('settings.backup','settings','backup','Download backups'),
  ('audit.view','audit','view','See the full activity trail across all devices');

insert into role_permissions (role_code, permission_code)
  select 'SUPER_ADMIN', code from permissions;

insert into role_permissions (role_code, permission_code) values
  ('MANAGER','inventory.view'),('MANAGER','inventory.edit'),('MANAGER','inventory.adjust'),
  ('MANAGER','transactions.view'),('MANAGER','transactions.create'),('MANAGER','transactions.reverse'),
  ('MANAGER','reports.view'),('MANAGER','reports.export'),
  ('MANAGER','products.view'),('MANAGER','products.edit'),('MANAGER','users.view');

insert into role_permissions (role_code, permission_code) values
  ('INVENTORY_OPERATOR','inventory.view'),('INVENTORY_OPERATOR','transactions.view'),
  ('INVENTORY_OPERATOR','transactions.create'),('INVENTORY_OPERATOR','products.view'),
  ('INVENTORY_OPERATOR','reports.view');

insert into role_permissions (role_code, permission_code) values
  ('VIEWER','inventory.view'),('VIEWER','transactions.view'),
  ('VIEWER','products.view'),('VIEWER','reports.view');

insert into app_settings (key, value, description) values
  ('company', jsonb_build_object(
     'name','Bhagyoday Belt Company',
     'address','A-FF-10, Pushpak Estate, Gujarat Bottling Compound, Nr. Keval Kanta Char Rasta, Rakhial, Ahmedabad 380023',
     'phone','+91 9429439956','email','info@bhagyodaybelt.com','gstin',''),
   'Printed on exported reports'),
  ('allow_negative_stock', jsonb_build_object('enabled', false),
   'When off, stock cannot be issued below zero'),
  ('data_source', jsonb_build_object('status','DEMO',
     'note','Demo data - replace with the Bhagyoday Belts master workbook'),
   'Set to LIVE once real master data is imported');

-- =====================================================================================
-- ROW LEVEL SECURITY
-- Writes to stock never go through the API directly - they go through
-- record_movement / reverse_movement, which check permissions themselves.
-- =====================================================================================

alter table roles enable row level security;
alter table permissions enable row level security;
alter table role_permissions enable row level security;
alter table app_users enable row level security;
alter table units enable row level security;
alter table brands enable row level security;
alter table product_families enable row level security;
alter table suppliers enable row level security;
alter table skus enable row level security;
alter table inventory_movements enable row level security;
alter table audit_logs enable row level security;
alter table app_settings enable row level security;
alter table import_batches enable row level security;
alter table backup_records enable row level security;

create policy p_read on roles            for select to authenticated using (true);
create policy p_read on permissions      for select to authenticated using (true);
create policy p_read on role_permissions for select to authenticated using (true);
create policy p_read on units            for select to authenticated using (true);
create policy p_read on app_settings     for select to authenticated using (true);

create policy p_read on app_users for select to authenticated
  using (auth_user_id = auth.uid() or has_permission('users.view'));

create policy p_read on brands           for select to authenticated using (has_permission('products.view'));
create policy p_read on product_families for select to authenticated using (has_permission('products.view'));
create policy p_read on suppliers        for select to authenticated using (has_permission('products.view'));
create policy p_read on skus             for select to authenticated using (has_permission('inventory.view'));
create policy p_read on inventory_movements for select to authenticated using (has_permission('transactions.view'));
create policy p_read on audit_logs       for select to authenticated using (has_permission('audit.view'));
create policy p_read on import_batches   for select to authenticated using (has_permission('settings.view'));
create policy p_read on backup_records   for select to authenticated using (has_permission('settings.view'));

create policy p_edit on skus for update to authenticated
  using (has_permission('inventory.edit')) with check (has_permission('inventory.edit'));
create policy p_edit on app_settings for update to authenticated
  using (has_permission('settings.edit')) with check (has_permission('settings.edit'));
create policy p_edit on app_users for update to authenticated
  using (has_permission('users.edit')) with check (has_permission('users.edit'));

grant execute on function record_movement(text,text,numeric,text,text,text,text) to authenticated;
grant execute on function reverse_movement(uuid,text,text) to authenticated;
grant execute on function dashboard_summary() to authenticated;
grant execute on function my_session() to authenticated;
grant execute on function has_permission(text) to authenticated;
grant execute on function reconcile_stock() to authenticated;
revoke execute on function purge_transactional_data() from authenticated, anon;
