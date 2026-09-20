'use client';

import { useState } from 'react';
import { Plus, ShoppingCart } from 'lucide-react';
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

  const done = () => {
    setOpen(null);
    window.location.reload();
  };

  return (
    <div className="flex flex-wrap gap-2">
      {canWrite && (
        <>
          <button onClick={() => setOpen('inward')} className="btn btn-secondary">
            <Plus size={14} /> Inward
          </button>
          <button onClick={() => setOpen('outward')} className="btn btn-primary">
            <Plus size={14} /> Outward
          </button>
        </>
      )}
      <Link href="/purchase-orders" className="btn btn-secondary">
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
