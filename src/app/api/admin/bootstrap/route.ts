import { NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

/* =============================================================================
   First-run admin bootstrap
   -----------------------------------------------------------------------------
   Creates the Supabase Auth account named by ADMIN_EMAIL, using ADMIN_PASSWORD,
   the first time it is needed. Without this a fresh deployment has no way in.

   Create-only by design: if the account already exists this does nothing and
   never touches the password. Rotating a password from an environment variable
   on every deploy is a good way to lock yourself out, and Supabase is the right
   place to change it.

   Safe to call unauthenticated. It reports only whether setup is still needed,
   which tells an attacker nothing they could not learn from the sign-in form.
   ========================================================================== */

export async function POST() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    return NextResponse.json({ status: 'not-configured' });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { status: 'error', error: 'ADMIN_PASSWORD must be at least 8 characters.' },
      { status: 400 },
    );
  }

  try {
    const admin = await supabaseService();

    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const exists = (list?.users ?? []).some((u) => u.email?.toLowerCase() === email);
    if (exists) return NextResponse.json({ status: 'already-set-up' });

    const { error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: 'SUPER_ADMIN' },
    });
    if (error) {
      return NextResponse.json({ status: 'error', error: error.message }, { status: 400 });
    }

    // The profile and its Super Admin role are applied on first sign-in, by the
    // server, from ADMIN_EMAIL.
    return NextResponse.json({ status: 'created', email });
  } catch {
    return NextResponse.json(
      { status: 'error', error: 'Could not reach Supabase with the service role key.' },
      { status: 500 },
    );
  }
}
