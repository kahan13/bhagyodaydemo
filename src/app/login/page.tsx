'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Boxes } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';


function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await supabaseBrowser().auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error) {
      setBusy(false);
      setError(
        /rate|too many/i.test(error.message)
          ? 'Too many attempts. Wait a minute, then try again.'
          : 'That email and password did not match an account.',
      );
      return;
    }

    router.replace(params.get('next') || '/');
    router.refresh();
  }

  return (
    <main className="min-h-screen grid lg:grid-cols-2">
      {/* identity side */}
      <section className="relative hidden lg:flex flex-col justify-between p-12 bg-[#0e0e12] text-white overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            background:
              'radial-gradient(680px circle at 22% 18%, rgba(91,91,214,0.5), transparent 60%), radial-gradient(520px circle at 82% 88%, rgba(18,128,74,0.22), transparent 55%)',
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-2.5">
            <span className="grid place-items-center h-8 w-8 rounded-lg bg-white/10 backdrop-blur">
              <Boxes size={17} />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold">Bhagyoday Belt Company</p>
              <p className="text-[11px] text-white/50">Ahmedabad, Gujarat</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-sm">
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">
            Every metre and every piece, accounted for.
          </h1>
          <p className="mt-3 text-sm text-white/60 leading-relaxed">
            Stock is calculated from movements, never typed over. Each entry carries the time,
            the person and the device it came from.
          </p>

          <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5">
            {[
              ['Timing belts', 'Family → Size → Brand'],
              ['V-belts', 'Brand → Profile → Size'],
              ['On the floor', 'Voice entry, one tap to confirm'],
              ['Corrections', 'Reversed, never deleted'],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] text-white/40">{k}</dt>
                <dd className="text-[13px] text-white/80 mt-0.5">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="relative text-[11px] text-white/35">
          Demo data — replaceable with the company master workbook from Admin.
        </p>
      </section>

      {/* form side */}
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-[360px] slide-up">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <span className="grid place-items-center h-8 w-8 rounded-lg bg-brand text-white">
              <Boxes size={17} />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold">Bhagyoday Belts</p>
              <p className="text-[11px] text-ink-3">Inventory</p>
            </div>
          </div>

          <h2 className="text-lg font-semibold">Sign in</h2>
          <p className="text-[13px] text-ink-3 mt-1 mb-6">Use the account your admin set up.</p>

          <form onSubmit={submit} className="space-y-3.5">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input
                id="email" type="email" required autoComplete="username" className="field"
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>

            <div>
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password" type="password" required autoComplete="current-password" className="field"
                value={password} onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-[12px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>
            )}

            <button type="submit" className="btn btn-primary w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              {!busy && <ArrowRight size={15} />}
            </button>
          </form>

          <p className="mt-6 text-[12px] text-ink-3 leading-relaxed">
            Accounts are managed in Supabase. A new account picks up its role the first
            time it signs in.
          </p>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-screen grid place-items-center text-[13px] text-ink-3">Loading…</main>}>
      <SignIn />
    </Suspense>
  );
}
