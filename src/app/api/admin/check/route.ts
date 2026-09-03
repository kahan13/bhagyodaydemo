import { NextResponse } from 'next/server';
import { supabaseServer, supabaseService } from '@/lib/supabase-server';
import { getSession, isAdminEmail } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/* =============================================================================
   Admin setup diagnostics — visit /api/admin/check while signed in.
   Reports which link in the chain is broken. Returns only booleans and a
   masked email, so it discloses nothing useful to anyone who is not already
   signed in.
   ========================================================================== */

function mask(email: string | null | undefined): string | null {
  if (!email) return null;
  const [name, domain] = email.split('@');
  if (!domain) return '***';
  return `${name.slice(0, 2)}***@${domain}`;
}

export async function GET() {
  const session = await getSession();
  const db = await supabaseServer();
  const { data: auth } = await db.auth.getUser();

  if (!auth?.user) {
    return NextResponse.json({ signed_in: false, hint: 'Sign in first, then reload this page.' });
  }

  const configured = process.env.ADMIN_EMAIL?.trim().toLowerCase() || null;
  const signedInAs = auth.user.email?.trim().toLowerCase() ?? null;

  // Does the migration that defines promote_admin actually exist here?
  let promoteFnPresent = false;
  let promoteError: string | null = null;
  let serviceKeyWorks = false;
  try {
    const admin = await supabaseService();
    serviceKeyWorks = true;
    const { error } = await admin.rpc('promote_admin', { p_email: '' });
    promoteFnPresent = !error;
    if (error) promoteError = error.message;
  } catch (e) {
    promoteError = (e as Error).message;
  }

  const checks = {
    admin_email_set: !!configured,
    admin_email_matches_signed_in_user: !!configured && configured === signedInAs,
    service_role_key_present: serviceKeyWorks,
    promote_admin_function_exists: promoteFnPresent,
    profile_exists: !!session,
    current_role: session?.user.role_code ?? null,
    is_super_admin: session?.user.role_code === 'SUPER_ADMIN',
  };

  const problems: string[] = [];
  if (!checks.admin_email_set) {
    problems.push('ADMIN_EMAIL is not set in this environment. Restart the dev server after editing .env.local, or redeploy on Vercel.');
  } else if (!checks.admin_email_matches_signed_in_user) {
    problems.push(`ADMIN_EMAIL does not match the account you signed in as (${mask(signedInAs)}). They must be identical.`);
  }
  if (!checks.service_role_key_present) {
    problems.push('SUPABASE_SERVICE_ROLE_KEY is missing or invalid for this environment.');
  }
  if (!checks.promote_admin_function_exists) {
    problems.push(`promote_admin() is not callable — run 003_team_management.sql and 004_function_grants.sql. (${promoteError ?? 'unknown'})`);
  }

  return NextResponse.json({
    signed_in: true,
    signed_in_as: mask(signedInAs),
    admin_email_configured: mask(configured),
    checks,
    problems,
    verdict: problems.length === 0
      ? checks.is_super_admin
        ? 'All good — you are Super Admin.'
        : 'Configuration looks correct. Sign out and back in to apply it.'
      : 'Setup incomplete — see problems.',
  });
}
