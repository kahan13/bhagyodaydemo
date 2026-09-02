-- =====================================================================================
-- Bhagyoday Belts — 002: user provisioning from Supabase Auth
-- Run AFTER 001_init.sql. Safe to re-run. Does not touch stock or history.
-- =====================================================================================
-- Supabase Auth owns identity and passwords. This app additionally needs a role
-- and a name to stamp on every movement, which Auth has no concept of.
--
-- Rather than making you maintain that second record by hand, the app creates
-- it on first sign-in. Create the account in Supabase → Authentication → Users
-- and nothing else is required.
-- =====================================================================================

alter table app_users alter column username drop not null;

insert into app_settings (key, value, description)
values (
  'auto_provision',
  jsonb_build_object('enabled', true, 'default_role', 'VIEWER'),
  'Create an app profile automatically the first time a Supabase Auth user signs in'
)
on conflict (key) do nothing;

-- -------------------------------------------------------------------------------------
-- Resolves the signed-in Auth user to an app profile, creating or linking one
-- if needed. Called by the app when my_session() comes back empty.
--
-- Order of preference:
--   1. already linked            -> use it
--   2. unlinked row, same email  -> adopt it, keeping its role and history
--   3. nothing                   -> create one
--
-- The very first person to sign in becomes Super Admin, so a fresh project can
-- never lock you out. Everyone after that gets default_role above, unless the
-- Auth user carries a "role" in its metadata.
-- -------------------------------------------------------------------------------------
create or replace function ensure_app_user()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth     record;
  v_row      app_users;
  v_settings jsonb;
  v_role     text;
  v_name     text;
  v_username text;
  v_linked   int;
  v_suffix   int := 0;
begin
  select id, email, raw_user_meta_data
    into v_auth
    from auth.users
   where id = auth.uid();

  if v_auth.id is null then
    return null;                                   -- not signed in
  end if;

  -- 1. already linked
  select * into v_row from app_users where auth_user_id = v_auth.id;
  if v_row.id is not null then
    if not v_row.is_active then return null; end if;
    update app_users set last_login_at = now() where id = v_row.id;
    return my_session();
  end if;

  select value into v_settings from app_settings where key = 'auto_provision';
  if not coalesce((v_settings->>'enabled')::boolean, true) then
    return null;
  end if;

  -- 2. adopt an unlinked profile with the same email (e.g. one that arrived
  --    through the master workbook), so its role and history carry over
  update app_users
     set auth_user_id = v_auth.id,
         last_login_at = now()
   where auth_user_id is null
     and lower(email) = lower(v_auth.email)
     and is_active
  returning * into v_row;

  if v_row.id is not null then
    return my_session();
  end if;

  -- 3. create a fresh profile
  select count(*) into v_linked from app_users where auth_user_id is not null;

  v_role := upper(coalesce(
    nullif(v_auth.raw_user_meta_data->>'role', ''),
    case when v_linked = 0 then 'SUPER_ADMIN'
         else coalesce(v_settings->>'default_role', 'VIEWER') end
  ));
  if not exists (select 1 from roles where code = v_role) then
    v_role := 'VIEWER';
  end if;

  v_name := coalesce(
    nullif(v_auth.raw_user_meta_data->>'full_name', ''),
    nullif(v_auth.raw_user_meta_data->>'name', ''),
    initcap(replace(split_part(v_auth.email, '@', 1), '.', ' '))
  );

  v_username := lower(regexp_replace(split_part(v_auth.email, '@', 1), '[^a-z0-9._-]', '', 'gi'));
  if v_username = '' then v_username := 'user'; end if;
  while exists (select 1 from app_users where username = v_username) loop
    v_suffix := v_suffix + 1;
    v_username := v_username || v_suffix::text;
  end loop;

  insert into app_users (
    auth_user_id, user_code, full_name, username, email,
    role_code, primary_device, is_active, last_login_at
  )
  values (
    v_auth.id,
    'U-' || upper(substr(replace(v_auth.id::text, '-', ''), 1, 8)),
    v_name, v_username, lower(v_auth.email),
    v_role, 'WEB', true, now()
  )
  returning * into v_row;

  perform log_audit(
    'CREATE', 'USER', v_row.id::text, v_row.full_name, null, v_role, 'SYSTEM',
    'Profile created automatically on first sign-in'
  );

  return my_session();
end $$;

grant execute on function ensure_app_user() to authenticated;

-- -------------------------------------------------------------------------------------
-- Backfill: link any profile whose email already matches an Auth account.
-- Harmless to run repeatedly.
-- -------------------------------------------------------------------------------------
update app_users a
   set auth_user_id = u.id
  from auth.users u
 where lower(u.email) = lower(a.email)
   and a.auth_user_id is null;
