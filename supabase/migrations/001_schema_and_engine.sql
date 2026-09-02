-- =====================================================================================
-- Bhagyoday Belts - Inventory Management System
-- Migration 001 : schema, inventory engine, views, immutability rules
-- Target       : Supabase PostgreSQL 15+
-- Run          : Supabase Dashboard > SQL Editor  (or supabase db push)
-- =====================================================================================
-- NOTHING in this file contains product data. Products, brands, families, sizes, stock
-- and history all arrive through scripts/import-master-excel.mjs from the Excel master.
-- =====================================================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ reference masters

create table if not exists roles (
  code          text primary key,
  name          text not null,
  description   text,
  rank          int  not null default 100,          -- lower = more powerful
  is_system     boolean not null default true
);

create table if not exists permissions (
  code          text primary key,                   -- e.g. 'inventory.adjust'
  module        text not null,                      -- inventory | transactions | reports | users | products | settings
  action        text not null,
  description   text
);

create table if not exists role_permissions (
  role_code       text not null references roles(code) on delete cascade,
  permission_code text not null references permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,                        -- links to auth.users(id)
  user_code     text unique,                        -- USR-001 from the master sheet
  full_name     text not null,
  username      text not null unique,
  email         text unique,
  mobile        text,
  role_code     text not null references roles(code),
  primary_device text not null default 'WEB' check (primary_device in ('WEB','MOBILE_PWA')),
  is_active     boolean not null default true,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists units (
  code          text primary key,                   -- PCS | MTR | ROLL | SET
  name          text not null,
  decimals      int  not null default 0,
  used_for      text,
  is_active     boolean not null default true
);

create table if not exists brands (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  country_origin text,
  has_timing_belts boolean not null default true,
  has_v_belts   boolean not null default true,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- One row per timing-belt family/profile AND per V-belt profile/section.
-- level_1_value is what the browse tree shows at its first product-specific level.
create table if not exists product_families (
  id                uuid primary key default gen_random_uuid(),
  product_type      text not null check (product_type in ('TIMING_BELT','V_BELT')),
  code              text not null,                  -- HTD8M / AT10 / A / SPB ...
  name              text not null,
  standard          text,
  pitch_mm          numeric(8,3),
  belt_form         text,                           -- ENDLESS | OPEN_ENDED
  default_unit      text references units(code),
  size_designation  text,                           -- how the exact size is expressed
  profile_group     text,                           -- CLASSICAL | WEDGE | COGGED ...
  sort_order        int not null default 100,
  is_active         boolean not null default true,
  unique (product_type, code)
);

create table if not exists suppliers (
  id            uuid primary key default gen_random_uuid(),
  supplier_code text not null unique,
  name          text not null,
  city          text,
  state         text,
  gstin         text,
  contact_person text,
  phone         text,
  email         text,
  brands_supplied text,
  lead_time_days int,
  payment_terms text,
  is_active     boolean not null default true
);

-- ------------------------------------------------------------------------------ SKUs

create table if not exists skus (
  id                uuid primary key default gen_random_uuid(),
  sku_code          text not null unique,           -- immutable internal identity
  product_type      text not null check (product_type in ('TIMING_BELT','V_BELT')),
  family_id         uuid not null references product_families(id),
  brand_id          uuid not null references brands(id),
  exact_size        text not null,
  display_name      text not null,

  -- browse hierarchy, resolved at import so the UI stays product-agnostic:
  -- TIMING_BELT : family code -> exact size -> brand
  -- V_BELT      : brand       -> profile    -> exact size
  hier_l1           text not null,
  hier_l2           text not null,
  hier_l3           text not null,

  belt_form         text,
  construction      text,
  standard          text,
  pitch_mm          numeric(8,3),
  pitch_length_mm   numeric(10,2),
  width_mm          numeric(10,2),
  teeth             int,
  nominal_length    numeric(10,2),
  length_designation text,

  unit_code         text not null references units(code),
  opening_stock     numeric(14,2) not null default 0,
  current_stock     numeric(14,2) not null default 0,   -- cache, always rebuilt from movements
  min_stock_level   numeric(14,2) not null default 0,
  supplier_moq      numeric(14,2) not null default 0,
  reorder_quantity  numeric(14,2) not null default 0,
  default_supplier_id uuid references suppliers(id),
  rack_location     text,
  is_active         boolean not null default true,
  source_row        int,
  import_batch_id   uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_skus_type      on skus(product_type) where is_active;
create index if not exists idx_skus_hier      on skus(product_type, hier_l1, hier_l2, hier_l3);
create index if not exists idx_skus_brand     on skus(brand_id);
create index if not exists idx_skus_family    on skus(family_id);
create index if not exists idx_skus_search    on skus using gin (to_tsvector('simple', display_name || ' ' || sku_code));

-- ------------------------------------------------------------------------- movements

create sequence if not exists movement_no_seq start 1;

create table if not exists inventory_movements (
  id              uuid primary key default gen_random_uuid(),
  txn_no          text not null unique,
  sku_id          uuid not null references skus(id),
  txn_type        text not null check (txn_type in ('INWARD','OUTWARD','ADJUSTMENT')),
  txn_mode        text not null default 'NORMAL' check (txn_mode in ('NORMAL','REVERSAL')),
  quantity        numeric(14,2) not null,          -- signed only for ADJUSTMENT
  unit_code       text not null references units(code),
  previous_stock  numeric(14,2) not null,
  new_stock       numeric(14,2) not null,
  occurred_at     timestamptz not null default now(),
  user_id         uuid references app_users(id),
  user_name       text not null,
  channel         text not null default 'WEB'
                  check (channel in ('WEB','MOBILE_PWA','MOBILE_VOICE','IMPORT','SYSTEM')),
  reference       text,
  notes           text,
  reversal_of     uuid references inventory_movements(id),
  reversed_by     uuid references inventory_movements(id),
  is_reversed     boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists idx_mov_sku    on inventory_movements(sku_id, occurred_at desc);
create index if not exists idx_mov_when   on inventory_movements(occurred_at desc);
create index if not exists idx_mov_type   on inventory_movements(txn_type);
create index if not exists idx_mov_user   on inventory_movements(user_id);
create index if not exists idx_mov_chan   on inventory_movements(channel);

-- ------------------------------------------------------------------------ audit trail

create table if not exists audit_logs (
  id            uuid primary key default gen_random_uuid(),
  occurred_at   timestamptz not null default now(),
  user_id       uuid references app_users(id),
  user_name     text,
  role_code     text,
  action        text not null,                     -- CREATE | UPDATE | DISABLE | LOGIN | EXPORT | IMPORT | REVERSE | BACKUP
  entity_type   text not null,                     -- SKU | USER | BRAND | TRANSACTION | SETTING | SESSION
  entity_id     text,
  entity_reference text,
  old_value     text,
  new_value     text,
  channel       text not null default 'WEB',
  ip_address    text,
  description   text
);
create index if not exists idx_audit_when on audit_logs(occurred_at desc);
create index if not exists idx_audit_user on audit_logs(user_id);

-- ------------------------------------------------------------------ settings, batches

create table if not exists app_settings (
  key           text primary key,
  value         jsonb not null,
  description   text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references app_users(id)
);

create table if not exists import_batches (
  id            uuid primary key default gen_random_uuid(),
  file_name     text not null,
  imported_at   timestamptz not null default now(),
  imported_by   text,
  mode          text not null,                     -- MASTER_ONLY | MASTER_WITH_HISTORY | REPLACE
  counts        jsonb not null default '{}'::jsonb,
  warnings      jsonb not null default '[]'::jsonb,
  notes         text
);

create table if not exists backup_records (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  created_by    uuid references app_users(id),
  file_name     text not null,
  size_bytes    bigint,
  row_counts    jsonb
);

-- =====================================================================================
-- IMMUTABILITY : historical movements are never deleted and never silently edited
-- =====================================================================================

create or replace function guard_movement_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('bhagyoday.allow_purge', true), 'off') = 'on' then
      return old;                                   -- only the controlled purge routine
    end if;
    raise exception 'Stock movements cannot be deleted. Create a reversal instead.';
  end if;

  -- UPDATE: only the reversal-link columns may change
  if (new.sku_id, new.txn_type, new.txn_mode, new.quantity, new.unit_code,
      new.previous_stock, new.new_stock, new.occurred_at, new.user_id, new.txn_no)
     is distinct from
     (old.sku_id, old.txn_type, old.txn_mode, old.quantity, old.unit_code,
      old.previous_stock, old.new_stock, old.occurred_at, old.user_id, old.txn_no)
     and coalesce(current_setting('bhagyoday.allow_purge', true), 'off') <> 'on' then
    raise exception 'Stock movements are immutable. Create a reversal instead.';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_movement on inventory_movements;
create trigger trg_guard_movement
  before update or delete on inventory_movements
  for each row execute function guard_movement_write();

-- =====================================================================================
-- IDENTITY + PERMISSIONS
-- =====================================================================================

create or replace function current_app_user()
returns app_users language sql stable security definer set search_path = public as $$
  select u.* from app_users u
  where u.auth_user_id = auth.uid() and u.is_active
  limit 1
$$;

create or replace function has_permission(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from app_users u
    join role_permissions rp on rp.role_code = u.role_code
    where u.auth_user_id = auth.uid()
      and u.is_active
      and rp.permission_code = p_code
  )
$$;

create or replace function my_permissions()
returns table (permission_code text)
language sql stable security definer set search_path = public as $$
  select rp.permission_code
  from app_users u
  join role_permissions rp on rp.role_code = u.role_code
  where u.auth_user_id = auth.uid() and u.is_active
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
  values (u.id, coalesce(u.full_name,'system'), u.role_code, p_action, p_entity_type, p_entity_id,
          p_entity_ref, p_old, p_new, coalesce(p_channel,'WEB'), p_description);
end $$;

-- =====================================================================================
-- INVENTORY ENGINE : stock only ever moves through this function
-- =====================================================================================

create or replace function record_movement(
  p_sku_code    text,
  p_txn_type    text,
  p_quantity    numeric,
  p_unit_code   text,
  p_reference   text default null,
  p_notes       text default null,
  p_channel     text default 'WEB',
  p_occurred_at timestamptz default now()
) returns inventory_movements
language plpgsql security definer set search_path = public as $$
declare
  v_user     app_users;
  v_sku      skus;
  v_prev     numeric(14,2);
  v_new      numeric(14,2);
  v_allow_neg boolean;
  v_row      inventory_movements;
  v_needed   text;
begin
  select * into v_user from current_app_user();
  if v_user.id is null then
    raise exception 'Not signed in, or this account is disabled.';
  end if;

  v_needed := case when p_txn_type = 'ADJUSTMENT' then 'inventory.adjust' else 'transactions.create' end;
  if not has_permission(v_needed) then
    raise exception 'Your role does not allow this action (% required).', v_needed;
  end if;

  -- lock the SKU row so two phones cannot race the same stock figure
  select * into v_sku from skus where sku_code = p_sku_code for update;
  if v_sku.id is null then
    raise exception 'Unknown SKU %.', p_sku_code;
  end if;
  if not v_sku.is_active then
    raise exception '% is inactive and cannot be transacted.', v_sku.display_name;
  end if;

  if p_unit_code is not null and p_unit_code <> v_sku.unit_code then
    raise exception '% is stocked in %, not %.', v_sku.display_name, v_sku.unit_code, p_unit_code;
  end if;

  if p_txn_type in ('INWARD','OUTWARD') and p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero.';
  end if;
  if p_txn_type = 'ADJUSTMENT' and p_quantity = 0 then
    raise exception 'An adjustment of zero changes nothing.';
  end if;
  if p_txn_type = 'ADJUSTMENT' and coalesce(btrim(p_notes),'') = '' then
    raise exception 'A stock adjustment needs a reason.';
  end if;

  v_prev := v_sku.current_stock;
  v_new  := case p_txn_type
              when 'INWARD'  then v_prev + p_quantity
              when 'OUTWARD' then v_prev - p_quantity
              else v_prev + p_quantity
            end;

  select coalesce((value->>'enabled')::boolean, false) into v_allow_neg
  from app_settings where key = 'allow_negative_stock';

  if v_new < 0 and not coalesce(v_allow_neg, false) then
    raise exception 'Only % % of % in stock. Negative stock is switched off in Settings.',
      v_prev, v_sku.unit_code, v_sku.display_name;
  end if;

  insert into inventory_movements(
    txn_no, sku_id, txn_type, txn_mode, quantity, unit_code,
    previous_stock, new_stock, occurred_at, user_id, user_name, channel, reference, notes)
  values (
    'TXN-' || to_char(p_occurred_at, 'YYYYMM') || '-' ||
      lpad(nextval('movement_no_seq')::text, 5, '0'),
    v_sku.id, p_txn_type, 'NORMAL', p_quantity, v_sku.unit_code,
    v_prev, v_new, p_occurred_at, v_user.id, v_user.full_name, p_channel, p_reference, p_notes)
  returning * into v_row;

  update skus set current_stock = v_new, updated_at = now() where id = v_sku.id;

  perform log_audit(
    case p_txn_type when 'ADJUSTMENT' then 'ADJUST' else 'CREATE' end,
    'TRANSACTION', v_row.id::text, v_sku.display_name,
    v_prev::text, v_new::text, p_channel,
    p_txn_type || ' ' || p_quantity || ' ' || v_sku.unit_code || ' - ' || v_row.txn_no);

  return v_row;
end $$;

-- Controlled correction. The original row stays exactly as it was.
create or replace function reverse_movement(p_movement_id uuid, p_reason text, p_channel text default 'WEB')
returns inventory_movements
language plpgsql security definer set search_path = public as $$
declare
  v_user  app_users;
  v_orig  inventory_movements;
  v_sku   skus;
  v_prev  numeric(14,2);
  v_new   numeric(14,2);
  v_type  text;
  v_qty   numeric(14,2);
  v_row   inventory_movements;
begin
  select * into v_user from current_app_user();
  if v_user.id is null then raise exception 'Not signed in, or this account is disabled.'; end if;
  if not has_permission('transactions.reverse') then
    raise exception 'Your role does not allow reversals.';
  end if;
  if coalesce(btrim(p_reason),'') = '' then raise exception 'A reversal needs a reason.'; end if;

  select * into v_orig from inventory_movements where id = p_movement_id for update;
  if v_orig.id is null then raise exception 'That transaction no longer exists.'; end if;
  if v_orig.is_reversed then raise exception '% was already reversed.', v_orig.txn_no; end if;
  if v_orig.txn_mode = 'REVERSAL' then raise exception 'A reversal cannot itself be reversed.'; end if;

  select * into v_sku from skus where id = v_orig.sku_id for update;

  if v_orig.txn_type = 'INWARD' then
    v_type := 'OUTWARD'; v_qty := v_orig.quantity;
  elsif v_orig.txn_type = 'OUTWARD' then
    v_type := 'INWARD';  v_qty := v_orig.quantity;
  else
    v_type := 'ADJUSTMENT'; v_qty := -v_orig.quantity;
  end if;

  v_prev := v_sku.current_stock;
  v_new  := case v_type when 'INWARD' then v_prev + v_qty
                        when 'OUTWARD' then v_prev - v_qty
                        else v_prev + v_qty end;

  if v_new < 0 then
    raise exception 'Reversing % would take % below zero. Adjust stock first.',
      v_orig.txn_no, v_sku.display_name;
  end if;

  insert into inventory_movements(
    txn_no, sku_id, txn_type, txn_mode, quantity, unit_code, previous_stock, new_stock,
    occurred_at, user_id, user_name, channel, reference, notes, reversal_of)
  values (
    'TXN-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('movement_no_seq')::text, 5, '0'),
    v_sku.id, v_type, 'REVERSAL', v_qty, v_sku.unit_code, v_prev, v_new,
    now(), v_user.id, v_user.full_name, p_channel, v_orig.reference,
    'Reversal of ' || v_orig.txn_no || ' - ' || p_reason, v_orig.id)
  returning * into v_row;

  update inventory_movements set is_reversed = true, reversed_by = v_row.id where id = v_orig.id;
  update skus set current_stock = v_new, updated_at = now() where id = v_sku.id;

  perform log_audit('REVERSE','TRANSACTION', v_orig.id::text, v_sku.display_name,
                    v_orig.txn_type || ' ' || v_orig.quantity, v_row.txn_no, p_channel, p_reason);
  return v_row;
end $$;

-- Rebuild every cached stock figure from the movement history (the reconciliation proof).
create or replace function reconcile_stock()
returns table (sku_code text, display_name text, cached numeric, derived numeric, difference numeric)
language plpgsql security definer set search_path = public as $$
begin
  if not has_permission('inventory.adjust') then
    raise exception 'Your role does not allow reconciliation.';
  end if;
  return query
  with derived as (
    select s.id,
           s.opening_stock + coalesce(sum(
             case m.txn_type when 'INWARD' then m.quantity
                             when 'OUTWARD' then -m.quantity
                             else m.quantity end), 0) as val
    from skus s
    left join inventory_movements m on m.sku_id = s.id
    group by s.id, s.opening_stock
  )
  select s.sku_code, s.display_name, s.current_stock, d.val, s.current_stock - d.val
  from skus s join derived d on d.id = s.id
  where s.current_stock <> d.val;
end $$;

create or replace function rebuild_stock_cache()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  with derived as (
    select s.id,
           s.opening_stock + coalesce(sum(
             case m.txn_type when 'INWARD' then m.quantity
                             when 'OUTWARD' then -m.quantity
                             else m.quantity end), 0) as val
    from skus s
    left join inventory_movements m on m.sku_id = s.id
    group by s.id, s.opening_stock
  )
  update skus s set current_stock = d.val, updated_at = now()
  from derived d where d.id = s.id and s.current_stock <> d.val;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Used only by the import script when replacing demo data with real master data.
create or replace function purge_transactional_data()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('bhagyoday.allow_purge', 'on', true);
  update inventory_movements set reversed_by = null, is_reversed = false;
  delete from inventory_movements;
  perform setval('movement_no_seq', 1, false);
  perform set_config('bhagyoday.allow_purge', 'off', true);
end $$;

create or replace function sync_movement_seq()
returns bigint language sql security definer set search_path = public as $$
  select setval('movement_no_seq', greatest((select count(*) from inventory_movements), 1), true)
$$;

-- =====================================================================================
-- VIEWS the application reads (RLS of the base tables still applies)
-- =====================================================================================

create or replace view v_sku_status as
select
  s.id, s.sku_code, s.product_type, s.display_name, s.exact_size,
  s.hier_l1, s.hier_l2, s.hier_l3,
  b.code as brand_code, b.name as brand_name,
  f.code as family_code, f.name as family_name, f.profile_group, f.size_designation,
  s.belt_form, s.construction, s.standard, s.pitch_mm, s.pitch_length_mm, s.width_mm,
  s.teeth, s.nominal_length, s.length_designation, s.rack_location,
  s.unit_code, s.opening_stock, s.current_stock, s.min_stock_level,
  s.supplier_moq, s.reorder_quantity, s.is_active,
  sup.name as supplier_name,
  case
    when s.current_stock <= 0 then 'OUT_OF_STOCK'
    when s.current_stock < s.min_stock_level then 'LOW_STOCK'
    else 'OK'
  end as stock_status,
  greatest(s.min_stock_level - s.current_stock, 0) as shortfall,
  case when s.current_stock < s.min_stock_level
       then greatest(s.supplier_moq, s.min_stock_level - s.current_stock) else 0 end
       as suggested_purchase_qty
from skus s
join brands b on b.id = s.brand_id
join product_families f on f.id = s.family_id
left join suppliers sup on sup.id = s.default_supplier_id;

alter view v_sku_status set (security_invoker = on);

create or replace view v_movements as
select
  m.id, m.txn_no, m.occurred_at, m.txn_type, m.txn_mode, m.quantity, m.unit_code,
  m.previous_stock, m.new_stock, m.reference, m.notes, m.channel,
  m.user_id, m.user_name, m.reversal_of, m.reversed_by, m.is_reversed,
  s.sku_code, s.display_name, s.product_type, s.exact_size,
  b.name as brand_name, f.code as family_code, f.name as family_name,
  u.role_code
from inventory_movements m
join skus s on s.id = m.sku_id
join brands b on b.id = s.brand_id
join product_families f on f.id = s.family_id
left join app_users u on u.id = m.user_id;

alter view v_movements set (security_invoker = on);

-- Dashboard figures in one round trip.
create or replace function dashboard_summary()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'total_skus',       (select count(*) from skus where is_active),
    'timing_skus',      (select count(*) from skus where is_active and product_type = 'TIMING_BELT'),
    'vbelt_skus',       (select count(*) from skus where is_active and product_type = 'V_BELT'),
    'low_stock',        (select count(*) from v_sku_status where is_active and stock_status = 'LOW_STOCK'),
    'out_of_stock',     (select count(*) from v_sku_status where is_active and stock_status = 'OUT_OF_STOCK'),
    'today_inward',     (select count(*) from inventory_movements
                          where txn_type = 'INWARD' and occurred_at >= date_trunc('day', now())),
    'today_outward',    (select count(*) from inventory_movements
                          where txn_type = 'OUTWARD' and occurred_at >= date_trunc('day', now())),
    'today_adjustments',(select count(*) from inventory_movements
                          where txn_type = 'ADJUSTMENT' and occurred_at >= date_trunc('day', now())),
    'month_movements',  (select count(*) from inventory_movements
                          where occurred_at >= date_trunc('month', now()))
  )
$$;
