-- =====================================================================================
-- Bhagyoday Belts — 005: Supabase Auth is the only register of people
-- Run AFTER 004. Safe to re-run. Keeps all stock history intact.
-- =====================================================================================
-- The master workbook created an app_users row per name in its Users sheet, so
-- imported movements had an owner. Those rows have no Supabase account and no
-- password — they can never sign in — but they still looked like users.
--
-- Every movement already stores user_name as plain text, so the history reads
-- exactly the same once the profiles are gone. From here, a person exists only
-- if they exist in Supabase → Authentication → Users.
-- =====================================================================================

do $$
declare v_detached int; v_removed int;
begin
  -- inventory_movements is immutable by trigger, including user_id. This is the
  -- one sanctioned path for changing it, and it touches no quantity or stock.
  perform set_config('bhagyoday.allow_purge', 'on', true);

  update inventory_movements m
     set user_id = null
    from app_users a
   where a.id = m.user_id
     and a.auth_user_id is null;
  get diagnostics v_detached = row_count;

  update audit_logs l
     set user_id = null
    from app_users a
   where a.id = l.user_id
     and a.auth_user_id is null;

  update backup_records b
     set created_by = null
    from app_users a
   where a.id = b.created_by
     and a.auth_user_id is null;

  delete from app_users where auth_user_id is null;
  get diagnostics v_removed = row_count;

  perform set_config('bhagyoday.allow_purge', 'off', true);

  raise notice 'Detached % movement(s); removed % profile(s) with no Supabase account.',
    v_detached, v_removed;
end $$;

-- What remains: only people who exist in Supabase Auth.
select a.full_name, a.email, a.role_code, a.is_active,
       (a.auth_user_id is not null) as has_supabase_account
  from app_users a
 order by a.role_code, a.full_name;
