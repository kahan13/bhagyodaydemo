-- =====================================================================================
-- Bhagyoday Belts — 003: team management
-- Run AFTER 002. Safe to re-run. Does not touch stock or history.
-- =====================================================================================
-- Removes the "first account to sign in becomes Super Admin" rule. Who is admin
-- is now decided by ADMIN_EMAIL in the environment and applied server-side,
-- where the value cannot be forged. Every other role is assigned by a human in
-- the Teams & Users screen.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- Deleting a Supabase Auth user leaves app_users.auth_user_id pointing at an ID
-- that no longer exists — there is no foreign key across the auth schema. Those
-- orphans made the old "first user" count non-zero and quietly demoted the next
-- person to sign in. Clear them, and keep clearing them on every run.
-- -------------------------------------------------------------------------------------
update app_users a
   set auth_user_id = null
 where a.auth_user_id is not null
   and not exists (select 1 from auth.users u where u.id = a.auth_user_id);

-- -------------------------------------------------------------------------------------
-- Provisioning: create a profile, never decide privilege.
-- New accounts land on default_role and stay there until an admin changes it.
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
  v_suffix   int := 0;
begin
  select id, email, raw_user_meta_data
    into v_auth
    from auth.users
   where id = auth.uid();

  if v_auth.id is null then
    return null;
  end if;

  -- 1. already linked
  select * into v_row from app_users where auth_user_id = v_auth.id;
  if v_row.id is not null then
    if not v_row.is_active then return null; end if;
    update app_users set last_login_at = now() where id = v_row.id;
    return my_session();
  end if;

  -- 2. adopt a profile an admin prepared for this email, keeping its role
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

  select value into v_settings from app_settings where key = 'auto_provision';
  if not coalesce((v_settings->>'enabled')::boolean, true) then
    return null;
  end if;

  -- 3. create a profile with the lowest privilege available
  v_role := upper(coalesce(nullif(v_settings->>'default_role', ''), 'VIEWER'));
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

  perform log_audit('CREATE', 'USER', v_row.id::text, v_row.full_name,
                    null, v_role, 'SYSTEM', 'Profile created on first sign-in');

  return my_session();
end $$;

-- -------------------------------------------------------------------------------------
-- Grants Super Admin to the address configured in ADMIN_EMAIL. Called only from
-- the server, which reads that value from the environment and passes the email
-- it has already verified against the session. Never callable by a browser.
-- -------------------------------------------------------------------------------------
create or replace function promote_admin(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row app_users;
begin
  if coalesce(btrim(p_email), '') = '' then return null; end if;

  update app_users
     set role_code = 'SUPER_ADMIN', is_active = true
   where lower(email) = lower(btrim(p_email))
     and (role_code is distinct from 'SUPER_ADMIN' or not is_active)
  returning * into v_row;

  if v_row.id is not null then
    perform log_audit('UPDATE', 'USER', v_row.id::text, v_row.full_name,
                      null, 'SUPER_ADMIN', 'SYSTEM',
                      'Granted Super Admin from ADMIN_EMAIL configuration');
  end if;

  return to_jsonb(v_row);
end $$;

revoke execute on function promote_admin(text) from authenticated, anon;

-- -------------------------------------------------------------------------------------
-- Editing a teammate. Permission is re-checked here, so it holds even if
-- someone calls the API directly.
-- -------------------------------------------------------------------------------------
create or replace function admin_save_user(
  p_id        uuid,
  p_full_name text    default null,
  p_role_code text    default null,
  p_is_active boolean default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     app_users;
  v_target app_users;
  v_before text;
begin
  select * into v_me from current_app_user();
  if v_me.id is null then raise exception 'Not signed in.'; end if;
  if not has_permission('users.edit') then
    raise exception 'Your role does not allow managing users.';
  end if;

  select * into v_target from app_users where id = p_id for update;
  if v_target.id is null then raise exception 'That user no longer exists.'; end if;

  -- Changing your own role or switching yourself off is how an admin locks
  -- everyone out of the system, so it is refused.
  if v_target.id = v_me.id then
    if p_role_code is not null and p_role_code <> v_target.role_code then
      raise exception 'You cannot change your own role. Ask another Super Admin.';
    end if;
    if p_is_active is not null and p_is_active = false then
      raise exception 'You cannot deactivate your own account.';
    end if;
  end if;

  if p_role_code is not null and not exists (select 1 from roles where code = p_role_code) then
    raise exception 'Unknown role "%".', p_role_code;
  end if;

  -- Never leave the system without an active Super Admin.
  if v_target.role_code = 'SUPER_ADMIN'
     and (coalesce(p_role_code, v_target.role_code) <> 'SUPER_ADMIN'
          or coalesce(p_is_active, v_target.is_active) = false)
     and (select count(*) from app_users
           where role_code = 'SUPER_ADMIN' and is_active and id <> v_target.id) = 0 then
    raise exception 'This is the last active Super Admin. Promote someone else first.';
  end if;

  v_before := v_target.role_code || ' / ' || (case when v_target.is_active then 'active' else 'disabled' end);

  update app_users
     set full_name = coalesce(nullif(btrim(p_full_name), ''), full_name),
         role_code = coalesce(p_role_code, role_code),
         is_active = coalesce(p_is_active, is_active)
   where id = p_id
  returning * into v_target;

  perform log_audit('UPDATE', 'USER', v_target.id::text, v_target.full_name, v_before,
                    v_target.role_code || ' / ' ||
                    (case when v_target.is_active then 'active' else 'disabled' end),
                    'WEB', 'Edited in Teams & Users');

  return to_jsonb(v_target);
end $$;

grant execute on function admin_save_user(uuid, text, text, boolean) to authenticated;

-- -------------------------------------------------------------------------------------
-- Gives a role to a Supabase Auth account that has never signed in, so the
-- right permissions are waiting the first time they do.
-- -------------------------------------------------------------------------------------
create or replace function admin_add_user(
  p_auth_user_id uuid,
  p_email        text,
  p_full_name    text,
  p_role_code    text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      app_users;
  v_username text;
  v_suffix   int := 0;
begin
  if not has_permission('users.edit') then
    raise exception 'Your role does not allow managing users.';
  end if;
  if coalesce(btrim(p_email), '') = '' then raise exception 'Email is required.'; end if;
  if not exists (select 1 from roles where code = p_role_code) then
    raise exception 'Unknown role "%".', p_role_code;
  end if;

  select * into v_row from app_users
   where auth_user_id = p_auth_user_id or lower(email) = lower(p_email);

  if v_row.id is not null then
    update app_users
       set auth_user_id = coalesce(p_auth_user_id, auth_user_id),
           full_name    = coalesce(nullif(btrim(p_full_name), ''), full_name),
           role_code    = p_role_code,
           is_active    = true
     where id = v_row.id
    returning * into v_row;
  else
    v_username := lower(regexp_replace(split_part(p_email, '@', 1), '[^a-z0-9._-]', '', 'gi'));
    if v_username = '' then v_username := 'user'; end if;
    while exists (select 1 from app_users where username = v_username) loop
      v_suffix := v_suffix + 1;
      v_username := v_username || v_suffix::text;
    end loop;

    insert into app_users (auth_user_id, user_code, full_name, username, email,
                           role_code, primary_device, is_active)
    values (
      p_auth_user_id,
      'U-' || upper(substr(replace(coalesce(p_auth_user_id, gen_random_uuid())::text, '-', ''), 1, 8)),
      coalesce(nullif(btrim(p_full_name), ''), initcap(replace(split_part(p_email, '@', 1), '.', ' '))),
      v_username, lower(p_email), p_role_code, 'WEB', true
    )
    returning * into v_row;
  end if;

  perform log_audit('CREATE', 'USER', v_row.id::text, v_row.full_name,
                    null, p_role_code, 'WEB', 'Added from Teams & Users');

  return to_jsonb(v_row);
end $$;

grant execute on function admin_add_user(uuid, text, text, text) to authenticated;

-- Managing people is a Super Admin job only.
delete from role_permissions where role_code = 'MANAGER' and permission_code = 'users.view';
