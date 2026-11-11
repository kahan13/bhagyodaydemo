'use client';

import { useState } from 'react';
import { usePendingCuts } from '@/lib/rubberCuts';
import RubberCutsPane from './RubberCutsPane';

/**
 * The Mismatch area has two small switchable tabs:
 *   Stock mismatch            — book against physical (orders waiting for outward, waste, adjustments)
 *   Open Roll – cut pieces    — cut pieces created physically, waiting to be reconciled with the book
 * `children` is the ordinary mismatch list.
 */
export default function MismatchTabs({ children, skuId, initialTab = 'stock' }: { children: React.ReactNode; skuId?: string; initialTab?: 'stock' | 'cuts' }) {
  const [tab, setTab] = useState<'stock' | 'cuts'>(initialTab);
  const { cuts, loading, reload } = usePendingCuts(skuId);
  const pill = (on: boolean) =>
    `px-3 py-1 rounded-full text-[13.5px] font-medium border transition-colors ${
      on ? 'bg-brand text-white border-brand' : 'bg-surface border-line text-ink-2 hover:border-brand hover:text-brand'}`;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-line" role="tablist" aria-label="Mismatch type">
        <button type="button" role="tab" aria-selected={tab === 'stock'} className={pill(tab === 'stock')} onClick={() => setTab('stock')}>
          Stock mismatch
        </button>
        <button type="button" role="tab" aria-selected={tab === 'cuts'} className={pill(tab === 'cuts')} onClick={() => setTab('cuts')}>
          Open Roll – cut pieces
          {cuts.length > 0 && (
            <span className={`ml-1.5 rounded-full px-1.5 text-[12px] font-semibold ${tab === 'cuts' ? 'bg-white/25' : 'bg-warn/20 text-warn'}`}>{cuts.length}</span>
          )}
        </button>
      </div>
      {tab === 'stock' ? children : (
        <>
          <p className="px-4 py-2.5 text-[14px] text-ink-3 border-b border-line">
            Cut pieces already separated from a roll on the shelf, but not yet applied to book stock. Reconcile writes one
            entry in Transactions and unlocks production orders for that product.
          </p>
          <RubberCutsPane cuts={cuts} loading={loading} onChanged={reload} />
        </>
      )}
    </div>
  );
}
