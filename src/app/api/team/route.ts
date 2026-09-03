import { NextResponse } from 'next/server';
import { supabaseServer, supabaseService } from '@/lib/supabase-server';
import { getSession, isAdminEmail } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/* =============================================================================
   Teams & Users
   -----------------------------------------------------------------------------
   Supabase Auth is the register of who exists. This app holds the role and the
   display name. The two are joined here on email, so an account created in
   Supabase shows up immediately — before its owner has ever signed in — and can
   be given a role in advance.

   Listing Auth accounts needs the service role, which is why this runs on the
   server. Writes go through admin_save_user / admin_add_user, which re-check
   the caller's permission in the database.
   ========================================================================== */

interface TeamMember {
  id: string | null;            // app_users id, null until a profile exists
  auth_user_id: string | null;  // Supabase Auth id, null if never created there
  email: string;
  full_name: string;
  role_code: string | null;
  is_active: boolean;
  last_login_at: string | null;
  last_sign_in_at: string | null;
  status: 'active' | 'pending' | 'disabled' | 'orphaned';
  is_configured_admin: boolean;
  is_self: boolean;
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  if (!session.permissions.includes('users.edit')) {
    return NextResponse.json({ error: 'Only a Super Admin can manage users.' }, { status: 403 });
  }

  const db = await supabaseServer();
  const { data: profiles, error } = await db
    .from('app_users')
    .select('id,auth_user_id,email,full_name,role_code,is_active,last_login_at')
    .order('full_name');

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const byEmail = new Map<string, TeamMember>();

  for (const p of profiles ?? []) {
    const email = (p.email ?? '').toLowerCase();
    if (!email) continue;
    byEmail.set(email, {
      id: p.id,
      auth_user_id: p.auth_user_id,
      email,
      full_name: p.full_name,
      role_code: p.role_code,
      is_active: p.is_active,
      last_login_at: p.last_login_at,
      last_sign_in_at: null,
      // A profile with no Auth account cannot sign in — usually a name carried
      // in from the master workbook so its history has an owner.
      status: !p.is_active ? 'disabled' : p.auth_user_id ? 'active' : 'orphaned',
      is_configured_admin: isAdminEmail(email),
      is_self: p.id === session.user.id,
    });
  }

  // Fold in Auth accounts, including any that have no profile yet.
  let authUnavailable = false;
  try {
    const admin = await supabaseService();
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });

    for (const u of list?.users ?? []) {
      const email = (u.email ?? '').toLowerCase();
      if (!email) continue;
      const existing = byEmail.get(email);

      if (existing) {
        existing.auth_user_id = existing.auth_user_id ?? u.id;
        existing.last_sign_in_at = u.last_sign_in_at ?? null;
        if (existing.status === 'orphaned') existing.status = 'active';
      } else {
        byEmail.set(email, {
          id: null,
          auth_user_id: u.id,
          email,
          full_name:
            (u.user_metadata?.full_name as string) ||
            (u.user_metadata?.name as string) ||
            email.split('@')[0],
          role_code: null,
          is_active: true,
          last_login_at: null,
          last_sign_in_at: u.last_sign_in_at ?? null,
          status: 'pending',
          is_configured_admin: isAdminEmail(email),
          is_self: false,
        });
      }
    }
  } catch {
    authUnavailable = true;
  }

  const order = { pending: 0, active: 1, orphaned: 2, disabled: 3 };
  const members = [...byEmail.values()].sort(
    (a, b) => order[a.status] - order[b.status] || a.full_name.localeCompare(b.full_name),
  );

  return NextResponse.json({
    members,
    admin_email_configured: members.some((m) => m.is_configured_admin) || !!process.env.ADMIN_EMAIL,
    auth_unavailable: authUnavailable,
  });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  if (!session.permissions.includes('users.edit')) {
    return NextResponse.json({ error: 'Only a Super Admin can manage users.' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 });
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const role = body.role_code ? String(body.role_code).toUpperCase() : null;
  const fullName = body.full_name ? String(body.full_name).slice(0, 120) : null;
  const isActive = typeof body.is_active === 'boolean' ? body.is_active : null;

  // The configured admin is defined by the environment, so the app must not let
  // the interface contradict it — the next sign-in would just undo the change.
  if (isAdminEmail(email) && (role !== null && role !== 'SUPER_ADMIN')) {
    return NextResponse.json(
      { error: 'This account is set as ADMIN_EMAIL. Change that variable to move the admin.' },
      { status: 400 },
    );
  }
  if (isAdminEmail(email) && isActive === false) {
    return NextResponse.json(
      { error: 'This account is set as ADMIN_EMAIL and cannot be disabled here.' },
      { status: 400 },
    );
  }

  const db = await supabaseServer();

  // Existing profile -> edit it. No profile yet -> create one so the role is
  // already in place the first time they sign in.
  const rpc = body.id
    ? db.rpc('admin_save_user', {
        p_id: String(body.id),
        p_full_name: fullName,
        p_role_code: role,
        p_is_active: isActive,
      })
    : db.rpc('admin_add_user', {
        p_auth_user_id: body.auth_user_id ? String(body.auth_user_id) : null,
        p_email: email,
        p_full_name: fullName,
        p_role_code: role ?? 'VIEWER',
      });

  const { data, error } = await rpc;

  if (error) {
    const denied = /does not allow|not signed in/i.test(error.message);
    return NextResponse.json({ error: error.message }, { status: denied ? 403 : 400 });
  }

  return NextResponse.json({ user: data });
}
