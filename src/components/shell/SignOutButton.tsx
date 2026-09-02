'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function SignOutButton({
  label = 'Sign out',
  variant = 'secondary',
}: {
  label?: string;
  variant?: 'secondary' | 'ghost';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await supabaseBrowser().auth.signOut();
    router.replace('/login');
    router.refresh();
  }

  return (
    <button
      className={`btn ${variant === 'ghost' ? 'btn-ghost w-full justify-start' : 'btn-secondary'}`}
      onClick={signOut}
      disabled={busy}
    >
      <LogOut size={14} />
      {busy ? 'Signing out…' : label}
    </button>
  );
}
