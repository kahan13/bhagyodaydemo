import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase';
import type { AppUser, Permission, Session } from '@/lib/types';

// Server side only - it reads cookies. Client components should import the
// formatting helpers from '@/lib/format' directly.
export * from '@/lib/format';

/**
 * Reads the signed-in user and the permissions their role grants.
 * The list is only used to decide what to show. Every write is checked again
 * inside the database functions, so hiding a button is never the security
 * boundary.
 */
export async function getSession(): Promise<Session | null> {
  const db = supabaseServer();
  const { data: auth } = await db.auth.getUser();
  if (!auth?.user) return null;

  const { data: user } = await db
    .from('app_users')
    .select('id, auth_user_id, user_code, full_name, username, email, mobile, role_code, primary_device, is_active')
    .eq('auth_user_id', auth.user.id)
    .maybeSingle();

  if (!user || !user.is_active) return null;

  const { data: perms } = await db.rpc('my_permissions');
  const permissions = (perms ?? []).map((p: { permission_code: Permission }) => p.permission_code);

  return { user: user as AppUser, permissions };
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  if (!session.permissions.includes(permission)) redirect('/?denied=' + permission);
  return session;
}

export function can(session: Session | null, permission: Permission): boolean {
  return !!session?.permissions.includes(permission);
}
