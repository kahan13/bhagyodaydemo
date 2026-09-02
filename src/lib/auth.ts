import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase-server';
import type { Permission, Session } from '@/lib/types';

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
  // profile with the same email is adopted, otherwise a new one is created.
  if (!data) {
    const provisioned = await db.rpc('ensure_app_user');
    data = provisioned.data;
  }

  if (!data) return { status: 'no-profile', email: auth.user.email ?? null };

  const row = data as Session['user'] & { permissions: Permission[] };
  const { permissions, ...user } = row;
  return { status: 'ok', session: { user, permissions: permissions ?? [] } };
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

export function can(session: Session | null, permission: Permission): boolean {
  return !!session?.permissions.includes(permission);
}
