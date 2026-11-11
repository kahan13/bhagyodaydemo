'use client';

import { useState } from 'react';
import { Scissors, Loader, CheckCircle2, X } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtDateTime } from '@/lib/format';
import { cutSentence } from '@/lib/rubberCuts';
import type { RubberCut } from '@/lib/types';

/**
 * Open Roll – cut pieces waiting to be reconciled.
 * A cut piece separates a piece from a roll physically; the book still shows the full roll until
 * Reconcile is pressed. Reconcile updates the book, writes one entry in Transactions, and unlocks
 * production orders for the product. Cancel throws the plan away (nothing was ever moved).
 */
export default function RubberCutsPane({
  cuts, loading, canAct = true, onChanged, compact = false,
}: {
  cuts: RubberCut[];
  loading: boolean;
  canAct?: boolean;
  onChanged: () => void;
  compact?: boolean;
}) {
  const db = supabaseBrowser();
  const [busy, setBusy] = useState<string | null>(null);

  async function reconcile(c: RubberCut) {
    setBusy(c.id);
    const { error } = await db.rpc('reconcile_rubber_cut', { p_cut_id: c.id });
    setBusy(null);
    if (error) { window.alert(error.message); return; }
    onChanged();
  }
  async function cancel(c: RubberCut) {
    if (!window.confirm(`Cancel cut piece ${c.cut_no}?\n\n${cutSentence(c)}\n\nNothing has moved in stock, so the roll simply stays as it is.`)) return;
    setBusy(c.id + 'x');
    const { error } = await db.rpc('cancel_rubber_cut', { p_cut_id: c.id, p_reason: null });
    setBusy(null);
    if (error) { window.alert(error.message); return; }
    onChanged();
  }

  if (loading) {
    return <div className="p-4 flex items-center gap-2 text-[15px] text-ink-3"><Loader size={14} className="animate-spin" /> Checking cut pieces…</div>;
  }
  if (cuts.length === 0) {
    return <p className="p-4 text-[15px] text-ink-3">No cut piece is waiting — book and physical agree for Open Roll.</p>;
  }
  return (
    <div className={compact ? 'space-y-2' : 'divide-y divide-line'}>
      {cuts.map((c) => (
        <div key={c.id} className={`flex items-center justify-between gap-3 ${compact ? 'rounded-lg bg-surface border border-line px-3 py-2' : 'px-4 py-3'}`}>
          <div className="min-w-0 text-[14px]">
            <p>
              <span className="font-mono text-brand font-medium">{c.sku_code}</span>
              <span className="text-ink ml-1.5">{c.display_name}</span>
            </p>
            <p className="num font-semibold mt-0.5 flex items-center gap-1.5 flex-wrap">
              <Scissors size={13} className="text-brand shrink-0" /> {cutSentence(c)}
            </p>
            <p className="text-[13px] text-ink-3 mt-0.5">
              Physical stock has the cut piece; the book still shows the full roll · {c.cut_no} · {c.created_by_name ?? 'someone'} · {fmtDateTime(c.created_at)}
            </p>
          </div>
          {canAct && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => reconcile(c)}
                title="Apply this cut to book stock and unlock production orders">
                {busy === c.id ? <Loader size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Reconcile cut piece
              </button>
              <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => cancel(c)} title="Cancel this cut">
                {busy === c.id + 'x' ? <Loader size={12} className="animate-spin" /> : <X size={12} />} Cancel
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
