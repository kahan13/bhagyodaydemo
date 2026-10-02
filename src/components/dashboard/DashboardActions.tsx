'use client';

import { useEffect, useState } from 'react';
import { Plus, ShoppingCart } from 'lucide-react';
import { takeAction } from '@/lib/keytips';
import DashboardEntryDialog from '@/components/dashboard/DashboardEntryDialog';
import Link from 'next/link';

interface User { id: string; full_name: string; }

export default function DashboardActions({
  canWrite, users, lastRef, lastInvoice,
}: {
  canWrite: boolean;
  users: User[];
  lastRef: string | null;
  lastInvoice: string | null;
}) {
  const [open, setOpen] = useState<'inward' | 'outward' | null>(null);

  // opened here from another page by Alt+M → IN / O
  useEffect(() => {
    if (!canWrite) return;
    const a = takeAction(['inward', 'outward']);
    if (a === 'inward' || a === 'outward') setOpen(a);
  }, [canWrite]);

  // keyboard: i = inward, o = outward
  useEffect(() => {
    if (!canWrite) return;
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d === 'inward' || d === 'outward') setOpen(d);
    };
    window.addEventListener('bb:action', h);
    return () => window.removeEventListener('bb:action', h);
  }, [canWrite]);

  // the shell notices the save and refreshes the page data by itself — no reload needed
  const done = () => setOpen(null);

  return (
    <div className="flex flex-wrap gap-2">
      {canWrite && (
        <>
          <button onClick={() => setOpen('inward')} className="btn btn-secondary" data-kt="IN" data-kt-label="Record Inward">
            <Plus size={14} /> Inward
          </button>
          <button onClick={() => setOpen('outward')} className="btn btn-primary" data-kt="O" data-kt-label="Record Outward">
            <Plus size={14} /> Outward
          </button>
        </>
      )}
      <Link href="/purchase-orders" className="btn btn-secondary" data-kt="OR" data-kt-label="Order">
        <ShoppingCart size={14} /> Order
      </Link>

      {open && (
        <DashboardEntryDialog
          action={open}
          users={users}
          lastRef={lastRef}
          lastInvoice={lastInvoice}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
    </div>
  );
}
