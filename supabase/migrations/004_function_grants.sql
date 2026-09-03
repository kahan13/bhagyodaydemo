-- =====================================================================================
-- Bhagyoday Belts — 004: lock down privileged functions
-- Run AFTER 003. Safe to re-run. Does not touch data.
-- =====================================================================================
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
-- adds its own grants to anon and authenticated on top. Revoking from only
-- anon and authenticated, as 001 and 003 did, can leave the PUBLIC grant in
-- place — which would let any signed-in user call these directly.
--
-- promote_admin would hand out Super Admin. purge_transactional_data would
-- erase every stock movement ever recorded. Neither should be reachable with
-- anything but the service role key, which never leaves the server.
-- =====================================================================================

revoke all on function promote_admin(text) from public, anon, authenticated;
grant execute on function promote_admin(text) to service_role;

revoke all on function purge_transactional_data() from public, anon, authenticated;
grant execute on function purge_transactional_data() to service_role;

-- Confirm what is now reachable. Both rows should show only service_role.
select p.proname as function,
       coalesce(array_to_string(array(
         select r.rolname
           from pg_roles r
          where has_function_privilege(r.rolname, p.oid, 'EXECUTE')
            and r.rolname in ('anon', 'authenticated', 'service_role')
          order by r.rolname), ', '), 'none') as can_execute
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('promote_admin', 'purge_transactional_data');
