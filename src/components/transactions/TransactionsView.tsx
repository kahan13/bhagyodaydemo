'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Undo2, X } from 'lucide-react';
import { fmtDate, fmtTime, fmtQty, CHANNEL_LABEL } from '@/lib/format';
import type { Movement } from '@/lib/types';

type Filters = Record<string, string>;

const RANGES: [string, string][] = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['custom', 'Custom'],
  ['all', 'All time'],
];

export default function TransactionsView({
  rows, total, page, pageSize, error, canReverse, filters, facets,
}: {
  rows: Movement[];
  total: number;
  page: number;
  pageSize: number;
  error: string | null;
  canReverse: boolean;
  filters: Filters;
  facets: { brands: string[]; families: string[]; users: string[] };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [reversing, setReversing] = useState<Movement | null>(null);

  function setParam(patch: Filters) {
    const next = new URLSearchParams(params.toString());
    Object.entries(patch).forEach(([k, v]) => {
      if (v) next.set(k, v);
      else next.delete(k);
    });
    if (!('page' in patch)) next.delete('page');
    startTransition(() => router.push(`/transactions?${next.toString()}`));
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const activeFilters = Object.entries(filters).filter(
    ([k, v]) => v && !['range', 'from', 'to'].includes(k),
  );

  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* ------------------------------------------------------------- filters */}
      <div className="border-b border-line bg-surface px-4 lg:px-6 py-3 space-y-2.5">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-base font-semibold tracking-tight">Transactions</h1>
          <span className="text-2xs text-ink-3 num">{total.toLocaleString('en-IN')} movements</span>
          {pending && <span className="text-2xs text-ink-3">Updating...</span>}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="range">Period</label>
            <select
              id="range"
              className="field w-[130px]"
              value={filters.range}
              onChange={(e) => setParam({ range: e.target.value, from: '', to: '' })}
            >
              {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>

          {filters.range === 'custom' && (
            <>
              <div>
                <label className="label" htmlFor="from">From</label>
                <input id="from" type="date" className="field w-[145px]" value={filters.from}
                  onChange={(e) => setParam({ from: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="to">To</label>
                <input id="to" type="date" className="field w-[145px]" value={filters.to}
                  onChange={(e) => setParam({ to: e.target.value })} />
              </div>
            </>
          )}

          <Select label="Type" value={filters.type} onChange={(v) => setParam({ type: v })}
            options={[['INWARD', 'Inward'], ['OUTWARD', 'Outward'], ['ADJUSTMENT', 'Adjustment']]} />

          <Select label="Entry" value={filters.mode} onChange={(v) => setParam({ mode: v })}
            options={[['NORMAL', 'Normal'], ['REVERSAL', 'Reversal']]} />

          <Select label="Product" value={filters.product} onChange={(v) => setParam({ product: v })}
            options={[['TIMING_BELT', 'Timing belts'], ['V_BELT', 'V-belts']]} />

          <Select label="Brand" value={filters.brand} onChange={(v) => setParam({ brand: v })}
            options={facets.brands.map((b) => [b, b])} width="w-[150px]" />

          <Select label="Family / profile" value={filters.family} onChange={(v) => setParam({ family: v })}
            options={facets.families.map((f) => [f, f])} width="w-[130px]" />

          <Select label="User" value={filters.user} onChange={(v) => setParam({ user: v })}
            options={facets.users.map((u) => [u, u])} width="w-[150px]" />

          <Select label="Device" value={filters.channel} onChange={(v) => setParam({ channel: v })}
            options={[['WEB', 'Desktop'], ['MOBILE_PWA', 'Phone'], ['MOBILE_VOICE', 'Voice'], ['IMPORT', 'Import']]}
            width="w-[120px]" />

          <div>
            <label className="label" htmlFor="sku">Product search</label>
            <input id="sku" className="field w-[180px]" defaultValue={filters.sku} placeholder="Size or brand"
              onKeyDown={(e) => { if (e.key === 'Enter') setParam({ sku: (e.target as HTMLInputElement).value }); }} />
          </div>

          {activeFilters.length > 0 && (
            <button
              className="btn-ghost btn-sm"
              onClick={() => setParam({ type: '', mode: '', product: '', brand: '', family: '', user: '', channel: '', sku: '' })}
            >
              Clear {activeFilters.length}
            </button>
          )}
        </div>
      </div>

      {/* --------------------------------------------------------------- table */}
      <div className="flex-1 min-h-0 scroll-y">
        {error && <p className="m-4 text-xs text-danger bg-danger-soft border border-danger/25 rounded px-3 py-2">{error}</p>}

        {rows.length === 0 && !error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-ink-2">No movements in this period.</p>
            <p className="text-xs text-ink-3 mt-1">Widen the period or clear the filters.</p>
          </div>
        ) : (
          <table className="erp-table">
            <thead>
              <tr>
                <th>Date</th><th>Time</th><th>Transaction</th><th>Product</th><th>Brand</th>
                <th>Type</th><th className="num">Qty</th><th className="num">Before</th><th className="num">After</th>
                <th>User</th><th>Device</th><th>Reference</th>
                {canReverse && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={m.is_reversed ? 'opacity-60' : undefined}>
                  <td className="num text-ink-2">{fmtDate(m.occurred_at)}</td>
                  <td className="num text-ink-3">{fmtTime(m.occurred_at)}</td>
                  <td className="font-mono text-2xs text-ink-3">{m.txn_no}</td>
                  <td className="font-medium max-w-[190px] truncate" title={`${m.display_name} (${m.sku_code})`}>
                    {m.exact_size}
                  </td>
                  <td className="text-ink-2">{m.brand_name}</td>
                  <td>
                    <span className={
                      m.txn_type === 'INWARD' ? 'tag-in' : m.txn_type === 'OUTWARD' ? 'tag-out-mv' : 'tag-adj'
                    }>
                      {m.txn_type.toLowerCase()}
                    </span>
                    {m.txn_mode === 'REVERSAL' && <span className="tag-rev ml-1">reversal</span>}
                    {m.is_reversed && <span className="tag-rev ml-1">reversed</span>}
                  </td>
                  <td className="num font-medium">
                    {m.txn_type === 'OUTWARD' ? '-' : m.txn_type === 'INWARD' ? '+' : m.quantity < 0 ? '-' : '+'}
                    {fmtQty(Math.abs(m.quantity), m.unit_code)}
                  </td>
                  <td className="num text-ink-3">{fmtQty(m.previous_stock)}</td>
                  <td className="num">{fmtQty(m.new_stock)}</td>
                  <td className="text-ink-2">{m.user_name}</td>
                  <td className="text-ink-3">{CHANNEL_LABEL[m.channel] ?? m.channel}</td>
                  <td className="text-ink-3 max-w-[160px] truncate" title={m.notes ?? ''}>{m.reference ?? '-'}</td>
                  {canReverse && (
                    <td className="text-right">
                      {m.txn_mode === 'NORMAL' && !m.is_reversed && (
                        <button className="btn-ghost btn-sm" onClick={() => setReversing(m)} title="Create a reversing entry">
                          <Undo2 size={13} /> Reverse
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ---------------------------------------------------------- pagination */}
      <div className="border-t border-line bg-surface px-4 lg:px-6 h-11 flex items-center justify-between">
        <p className="text-2xs text-ink-3 num">
          {total === 0 ? 'No rows' : `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total.toLocaleString('en-IN')}`}
        </p>
        <div className="flex items-center gap-1.5">
          <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}>
            Previous
          </button>
          <span className="text-2xs text-ink-3 num px-1">{page} / {pages}</span>
          <button className="btn-secondary btn-sm" disabled={page >= pages} onClick={() => setParam({ page: String(page + 1) })}>
            Next
          </button>
        </div>
      </div>

      {reversing && (
        <ReverseDialog movement={reversing} onClose={() => setReversing(null)} onDone={() => { setReversing(null); router.refresh(); }} />
      )}
    </div>
  );
}

function Select({
  label, value, onChange, options, width = 'w-[125px]',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  width?: string;
}) {
  const id = `f-${label.replace(/\W/g, '')}`;
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} className={`field ${width}`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

function ReverseDialog({
  movement, onClose, onDone,
}: {
  movement: Movement;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opposite = movement.txn_type === 'INWARD' ? 'OUTWARD' : movement.txn_type === 'OUTWARD' ? 'INWARD' : 'ADJUSTMENT';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch('/api/movements/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ movement_id: movement.id, reason, channel: 'WEB' }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setError(json.error ?? 'The reversal did not go through.'); return; }
    onDone();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4" role="dialog" aria-modal>
      <form onSubmit={submit} className="w-full max-w-[430px] bg-surface border border-line rounded shadow-modal">
        <div className="panel-head border-b">
          <h2 className="panel-title">Reverse {movement.txn_no}</h2>
          <button type="button" className="btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-xs text-ink-2 leading-relaxed">
            The original entry stays in the history exactly as it is. A linked{' '}
            <span className="font-medium">{opposite.toLowerCase()}</span> of{' '}
            {fmtQty(Math.abs(movement.quantity), movement.unit_code)} is created to cancel it out.
          </p>

          <div className="bg-raised border border-line rounded px-3 py-2 text-xs">
            <p className="font-medium">{movement.display_name}</p>
            <p className="text-ink-3 num mt-1">
              {movement.txn_type.toLowerCase()} {fmtQty(Math.abs(movement.quantity), movement.unit_code)} &middot;{' '}
              {fmtDate(movement.occurred_at)} {fmtTime(movement.occurred_at)} &middot; {movement.user_name}
            </p>
          </div>

          <div>
            <label className="label" htmlFor="reason">Reason (required)</label>
            <textarea id="reason" rows={2} className="field" value={reason} required
              onChange={(e) => setReason(e.target.value)} placeholder="Wrong quantity entered" />
          </div>

          {error && <p className="text-xs text-danger bg-danger-soft border border-danger/25 rounded px-2.5 py-2">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-line bg-raised">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !reason.trim()}>
            {busy ? 'Reversing...' : 'Create reversal'}
          </button>
        </div>
      </form>
    </div>
  );
}
