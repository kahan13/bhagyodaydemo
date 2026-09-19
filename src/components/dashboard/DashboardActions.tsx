'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import DashboardEntryDialog from '@/components/dashboard/DashboardEntryDialog';

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
    // Soft-refresh: reload the page's streaming sections without full navigation
    window.location.reload();
  };

  if (!canWrite) return null;

  return (
    <>
      <button onClick={() => setOpen('inward')} className="btn btn-secondary">
        <Plus size={14} /> Inward
      </button>
      <button onClick={() => setOpen('outward')} className="btn btn-primary">
        <Plus size={14} /> Outward
      </button>

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
    </>
  );
}
