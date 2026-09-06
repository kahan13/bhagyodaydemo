'use client';

import { Suspense, useEffect, useState } from 'react';
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

  // Creates the ADMIN_EMAIL account on a brand new deployment. Does nothing
  // once that account exists, and nothing at all if the variables are unset.
  useEffect(() => {
    fetch('/api/admin/bootstrap', { method: 'POST' }).catch(() => {});
  }, []);

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
      <section className="relative hidden lg:flex items-center justify-center bg-[#0e0e12] text-white overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.32]"
          style={{
            background:
              'radial-gradient(620px circle at 30% 28%, rgba(91,91,214,0.5), transparent 62%), radial-gradient(480px circle at 74% 82%, rgba(18,128,74,0.2), transparent 58%)',
          }}
        />
        <div className="relative text-center">
          <span className="inline-grid place-items-center h-14 w-14 rounded-2xl bg-white/10 backdrop-blur">
            <Boxes size={28} />
          </span>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em] mt-5">Bhagyoday Belt Company</h1>
          <p className="text-[15px] text-white/55 mt-1.5">Inventory Management System</p>
        </div>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-[350px] slide-up">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <span className="grid place-items-center h-9 w-9 rounded-lg bg-brand text-white">
              <Boxes size={18} />
            </span>
            <div className="leading-tight">
              <p className="text-[14px] font-semibold">Bhagyoday Belt Company</p>
              <p className="text-[11px] text-ink-3">Inventory Management System</p>
            </div>
          </div>

          <h2 className="text-lg font-semibold">Sign in</h2>

          <form onSubmit={submit} className="space-y-3.5 mt-5">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input
                id="email" type="email" required autoComplete="username" className="field h-11"
                value={email} onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password" type="password" required autoComplete="current-password" className="field h-11"
                value={password} onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-[12px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>
            )}

            <button type="submit" className="btn btn-primary w-full h-11" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
              {!busy && <ArrowRight size={15} />}
            </button>
          </form>
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
