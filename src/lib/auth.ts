import { redirect } from 'next/navigation';
import { supabaseServer, supabaseService } from '@/lib/supabase-server';
import type { PageAccess, PageKey, Permission, Session } from '@/lib/types';
import { PAGES, firstPageHref, pageLevel } from '@/lib/pages';

/**
 * The one account guaranteed Super Admin, read from the environment so it is
 * configured per deployment rather than written into the code or decided by a
 * rule like "whoever signs in first". Server-only: the browser never sees it,
 * and the comparison is against the email Supabase already verified.
 */
function adminEmail(): string | null {
  return process.env.ADMIN_EMAIL?.trim().toLowerCase() || null;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  const configured = adminEmail();
  return !!configured && !!email && email.trim().toLowerCase() === configured;
}

// Server only — reads cookies. Client components import '@/lib/format'.
export * from '@/lib/format';

/**
 * Three outcomes, kept distinct on purpose. Folding "signed in but no profile"
 * into "signed out" is what produces a sign-in loop: middleware sees a valid
 * session and pushes to the dashboard, the dashboard finds no profile and
 * pushes back, forever.
 */
type AuthState =
  | { status: 'signed-out' }
  | { status: 'no-profile'; email: string | null }
  | { status: 'ok'; session: Session };

export async function getAuthState(): Promise<AuthState> {
  const db = await supabaseServer();
  const { data: auth } = await db.auth.getUser();
  if (!auth?.user) return { status: 'signed-out' };

  // Profile and permissions in one round trip.
  let { data } = await db.rpc('my_session');

  // No profile yet. Supabase Auth owns identity but has no concept of a role,
  // so the app keeps its own record. Rather than making an admin create that by
  // hand for every account, provision it here on first sign-in: an existing
  // profile with the same email is adopted, otherwise a new one is created with
  // the lowest privilege available.
  if (!data) {
    const provisioned = await db.rpc('ensure_app_user');
    data = provisioned.data;
  }

  // Reconcile the configured admin on every sign-in, not just the first, so a
  // deleted or demoted admin account recovers by signing in again. Runs through
  // the service role, so a browser cannot invoke it.
  const row = data as (Session['user'] & { permissions: Permission[] }) | null;
  if (isAdminEmail(auth.user.email) && row?.role_code !== 'SUPER_ADMIN') {
    try {
      const admin = await supabaseService();
      const { error } = await admin.rpc('promote_admin', { p_email: auth.user.email });
      if (error) throw new Error(error.message);
      const refreshed = await db.rpc('my_session');
      data = refreshed.data ?? data;
    } catch (e) {
      // Never fail the request over this, but say so loudly in the server log —
      // silently leaving the admin on Viewer is impossible to diagnose from the
      // interface, which is exactly the trap this used to create.
      console.error(
        '[auth] ADMIN_EMAIL matched but the account was not promoted:',
        (e as Error).message,
        '\n  Check: 003_team_management.sql has been run, and',
        'SUPABASE_SERVICE_ROLE_KEY is set for this environment.',
      );
    }
  }

  if (!data) return { status: 'no-profile', email: auth.user.email ?? null };

  const resolved = data as Session['user'] & { permissions: Permission[]; pages?: PageAccess[] };
  const { permissions, pages, ...user } = resolved;
  return { status: 'ok', session: { user, permissions: permissions ?? [], pages: pages ?? legacyPages(user.role_code) } };
}

/**
 * Until migration 036 has been run the database does not send a page list.
 * Everyone but a Viewer then gets every page, as before; a Viewer gets none until it is run.
 */
function legacyPages(role: string): PageAccess[] {
  return role === 'VIEWER' ? [] : PAGES.map((p) => ({ page: p.key, can_edit: true }));
}

export async function getSession(): Promise<Session | null> {
  const state = await getAuthState();
  return state.status === 'ok' ? state.session : null;
}

export async function requireSession(): Promise<Session> {
  const state = await getAuthState();
  if (state.status === 'ok') return state.session;
  redirect(state.status === 'no-profile' ? '/no-access' : '/login');
}

export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  if (!session.permissions.includes(permission)) redirect(`/?denied=${permission}`);
  return session;
}

/**
 * Guards a page of the daily menu. Someone without it is sent to the first page they do have,
 * or to a short "no pages yet" notice — never back to a page they cannot open (which would loop).
 */
export async function requirePage(key: PageKey): Promise<Session> {
  const session = await requireSession();
  if (!pageLevel(session.pages, key)) redirect(firstPageHref(session));
  return session;
}

export function can(session: Session | null, permission: Permission): boolean {
  return !!session?.permissions.includes(permission);
}
