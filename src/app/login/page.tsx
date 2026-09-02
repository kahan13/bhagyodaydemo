'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const db = supabaseBrowser();
    const { error } = await db.auth.signInWithPassword({ email: email.trim(), password });

    if (error) {
      setBusy(false);
      setError(
        /rate|too many/i.test(error.message)
          ? 'Too many attempts. Wait a minute and try again.'
          : 'That email and password combination did not work.',
      );
      return;
    }

    router.replace(params.get('next') || '/');
    router.refresh();
  }

  return (
    <main className="min-h-screen grid lg:grid-cols-[1.1fr_1fr]">
      {/* left: identity panel. The one place with any weight to it. */}
      <section className="hidden lg:flex flex-col justify-between bg-accent text-white p-10">
        <div>
          <p className="eyebrow text-white/60">Ahmedabad, Gujarat</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Bhagyoday Belts</h1>
          <p className="text-sm text-white/70">Inventory Management System</p>
        </div>

        <div className="space-y-5 max-w-sm">
          <div>
            <p className="eyebrow text-white/50">Timing belts</p>
            <p className="text-sm text-white/85 mt-1">Family &rarr; size &rarr; brand &rarr; stock</p>
          </div>
          <div>
            <p className="eyebrow text-white/50">V-belts</p>
            <p className="text-sm text-white/85 mt-1">Brand &rarr; profile &rarr; size &rarr; stock</p>
          </div>
          <div className="pt-4 border-t border-white/15">
            <p className="text-xs text-white/60">
              Every movement is stamped with the time, the user and the device it came from.
            </p>
          </div>
        </div>

        <p className="text-2xs text-white/45">
          Demo data loaded from the master workbook. Replace it from Admin &rarr; Import.
        </p>
      </section>

      {/* right: the form */}
      <section className="flex items-center justify-center p-6 bg-canvas">
        <div className="w-full max-w-[340px]">
          <div className="lg:hidden mb-6">
            <h1 className="text-lg font-semibold tracking-tight">Bhagyoday Belts</h1>
            <p className="text-xs text-ink-3">Inventory Management System</p>
          </div>

          <h2 className="text-base font-semibold mb-1">Sign in</h2>
          <p className="text-xs text-ink-3 mb-5">Use the account your administrator set up for you.</p>

          <form onSubmit={signIn} className="space-y-3.5">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                className="field"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@bhagyodaybelts.local"
              />
            </div>

            <div>
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                className="field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-xs text-danger bg-danger-soft border border-danger/25 rounded px-2.5 py-2">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <p className="mt-6 text-2xs text-ink-3 leading-relaxed">
            On a phone: sign in once, then use Chrome&apos;s menu &rarr; Add to Home screen to keep the
            app one tap away.
          </p>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-screen grid place-items-center text-xs text-ink-3">Loading…</main>}>
      <SignInForm />
    </Suspense>
  );
}
