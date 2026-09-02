import { redirect } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { getAuthState } from '@/lib/auth';
import SignOutButton from '@/components/shell/SignOutButton';

export const dynamic = 'force-dynamic';

/**
 * Signed in, but the account has no app_users row (or it is disabled), so there
 * is no role and nothing to show. This page ends the request instead of
 * redirecting — that is what stops the browser ping-ponging with /login.
 */
export default async function NoAccessPage() {
  const state = await getAuthState();
  if (state.status === 'signed-out') redirect('/login');
  if (state.status === 'ok') redirect('/');

  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div className="card w-full max-w-[420px] p-6 slide-up">
        <span className="grid place-items-center h-9 w-9 rounded-lg bg-warn-soft text-warn mb-4">
          <ShieldAlert size={18} />
        </span>

        <h1 className="text-[15px] font-semibold">This account has no access yet</h1>

        <p className="text-[13px] text-ink-2 leading-relaxed mt-2">
          You are signed in as <span className="text-ink font-medium">{state.email ?? 'an unknown account'}</span>.
          A profile is normally created automatically on first sign-in, so seeing this
          means one of the following:
        </p>

        <ul className="text-[13px] text-ink-2 leading-relaxed mt-3 space-y-1.5 list-disc pl-4">
          <li>The profile exists but has been marked inactive.</li>
          <li>Automatic provisioning is switched off in <span className="font-mono text-[12px]">app_settings</span>.</li>
          <li>Migration <span className="font-mono text-[12px]">002_auth_provisioning.sql</span> has not been run yet.</li>
        </ul>

        <p className="text-[13px] text-ink-2 leading-relaxed mt-3">
          A Super Admin can fix this in Supabase by setting{' '}
          <span className="font-mono text-[12px]">is_active</span> on the{' '}
          <span className="font-mono text-[12px]">app_users</span> row for this email.
        </p>

        <div className="mt-5 pt-5 border-t border-line">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
