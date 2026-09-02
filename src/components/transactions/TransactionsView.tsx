'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Undo2, X, SlidersHorizontal, Download } from 'lucide-react';
import { fmtDate, fmtTime, fmtQty, CHANNEL_LABEL } from '@/lib/format';
import type { Movement } from '@/lib/types';

const RANGES: [string, string][] = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'],
  ['month', 'This month'], ['year', 'This year'], ['custom', 'Custom'], ['all', 'All time'],
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
  filters: Record<string, string>;
  facets: { brands: string[]; families: string[]; users: string[] };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [showFilters, setShowFilters] = useState(false);
  const [reversing, setReversing] = useState<Movement | null>(null);

  function setParam(patch: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('page' in patch)) next.delete('page');
    startTransition(() => router.push(`/transactions?${next}`, { scroll: false }));
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const activeCount = Object.entries(filters)
    .filter(([k, v]) => v && !['range', 'from', 'to'].includes(k)).length;

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* ------------------------------------------------------------ head */}
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[17px] font-semibold">Transactions</h1>
          <span className="text-[12px] text-ink-3 num">{total.toLocaleString('en-IN')}</span>
          {pending && <span className="text-[11px] text-ink-3">Updating…</span>}

          <div className="ml-auto flex items-center gap-2">
            <select
              className="field w-[128px]"
              value={filters.range}
              onChange={(e) => setParam({ range: e.target.value, from: '', to: '' })}
            >
              {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>

            <button
              className={`btn btn-sm ${showFilters || activeCount ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setShowFilters((v) => !v)}
            >
              <SlidersHorizontal size={13} />
              Filters{activeCount ? ` (${activeCount})` : ''}
            </button>

            <a
              className="btn btn-secondary btn-sm"
              href={`/api/export?kind=transactions&${params.toString()}`}
            >
              <Download size={13} /> Export
            </a>
          </div>
        </div>

        {filters.range === 'custom' && (
          <div className="flex flex-wrap gap-2">
            <div>
              <label className="label" htmlFor="from">From</label>
              <input id="from" type="date" className="field w-[150px]" value={filters.from}
                onChange={(e) => setParam({ from: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="to">To</label>
              <input id="to" type="date" className="field w-[150px]" value={filters.to}
                onChange={(e) => setParam({ to: e.target.value })} />
            </div>
          </div>
        )}

        {showFilters && (
          <div className="flex flex-wrap items-end gap-2 fade-in">
            <Select label="Type" value={filters.type} onChange={(v) => setParam({ type: v })}
              options={[['INWARD', 'Inward'], ['OUTWARD', 'Outward'], ['ADJUSTMENT', 'Adjustment']]} />
            <Select label="Entry" value={filters.mode} onChange={(v) => setParam({ mode: v })}
              options={[['NORMAL', 'Normal'], ['REVERSAL', 'Reversal']]} />
            <Select label="Product" value={filters.product} onChange={(v) => setParam({ product: v })}
              options={[['TIMING_BELT', 'Timing belts'], ['V_BELT', 'V-belts']]} width="w-[132px]" />
            <Select label="Brand" value={filters.brand} onChange={(v) => setParam({ brand: v })}
              options={facets.brands.map((b) => [b, b])} width="w-[150px]" />
            <Select label="Family" value={filters.family} onChange={(v) => setParam({ family: v })}
              options={facets.families.map((f) => [f, f])} width="w-[112px]" />
            <Select label="User" value={filters.user} onChange={(v) => setParam({ user: v })}
              options={facets.users.map((u) => [u, u])} width="w-[150px]" />
            <Select label="Device" value={filters.channel} onChange={(v) => setParam({ channel: v })}
              options={[['WEB', 'Desktop'], ['MOBILE_PWA', 'Phone'], ['MOBILE_VOICE', 'Voice'], ['IMPORT', 'Import']]}
              width="w-[118px]" />
            <div>
              <label className="label" htmlFor="search">Product search</label>
              <input id="search" className="field w-[170px]" defaultValue={filters.search}
                placeholder="Size or brand"
                onKeyDown={(e) => { if (e.key === 'Enter') setParam({ search: (e.target as HTMLInputElement).value }); }} />
            </div>
            {activeCount > 0 && (
              <button className="btn btn-ghost btn-sm"
                onClick={() => setParam({ type: '', mode: '', product: '', brand: '', family: '', user: '', channel: '', search: '' })}>
                <X size={13} /> Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------- table */}
      <div className="flex-1 min-h-0 scroll">
        {error && <p className="m-4 text-[13px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">{error}</p>}

        {!error && rows.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-[14px]">No movements in this period.</p>
            <p className="text-[13px] text-ink-3 mt-1">Widen the period or clear the filters.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Time</th><th>Ref</th><th>Product</th><th>Brand</th><th>Type</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Before</th>
                <th className="text-right">After</th>
                <th>User</th><th>Device</th><th>Reference</th>
                {canReverse && <th></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={m.is_reversed ? 'opacity-55' : undefined}>
                  <td className="num text-ink-2">{fmtDate(m.occurred_at)}</td>
                  <td className="num text-ink-3">{fmtTime(m.occurred_at)}</td>
                  <td className="font-mono text-[11px] text-ink-3">{m.txn_no}</td>
                  <td className="font-medium max-w-[180px] truncate" title={m.sku_code}>{m.exact_size}</td>
                  <td className="text-ink-2">{m.brand_name}</td>
                  <td>
                    <span className={`badge ${
                      m.txn_type === 'INWARD' ? 'badge-ok'
                        : m.txn_type === 'OUTWARD' ? 'badge-brand' : 'badge-warn'
                    }`}>
                      {m.txn_type.toLowerCase()}
                    </span>
                    {m.txn_mode === 'REVERSAL' && <span className="badge badge-neutral ml-1">reversal</span>}
                    {m.is_reversed && <span className="badge badge-neutral ml-1">reversed</span>}
                  </td>
                  <td className="num text-right font-medium">
                    {m.txn_type === 'OUTWARD' ? '−' : m.txn_type === 'INWARD' ? '+' : '±'}
                    {fmtQty(Math.abs(m.quantity), m.unit_code)}
                  </td>
                  <td className="num text-right text-ink-3">{fmtQty(m.previous_stock)}</td>
                  <td className="num text-right">{fmtQty(m.new_stock)}</td>
                  <td className="text-ink-2">{m.user_name}</td>
                  <td className="text-ink-3">{CHANNEL_LABEL[m.channel] ?? m.channel}</td>
                  <td className="text-ink-3 max-w-[150px] truncate" title={m.notes ?? ''}>{m.reference ?? '—'}</td>
                  {canReverse && (
                    <td className="text-right">
                      {m.txn_mode === 'NORMAL' && !m.is_reversed && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setReversing(m)}>
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

      {/* ------------------------------------------------------ pagination */}
      <div className="border-t border-line bg-surface px-4 lg:px-6 h-12 flex items-center justify-between shrink-0">
        <p className="text-[12px] text-ink-3 num">
          {total === 0 ? 'No rows'
            : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total.toLocaleString('en-IN')}`}
        </p>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}>
            Previous
          </button>
          <span className="text-[12px] text-ink-3 num px-1">{page} / {pages}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setParam({ page: String(page + 1) })}>
            Next
          </button>
        </div>
      </div>

      {reversing && (
        <ReverseDialog
          movement={reversing}
          onClose={() => setReversing(null)}
          onDone={() => { setReversing(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

function Select({
  label, value, onChange, options, width = 'w-[124px]',
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: [string, string][]; width?: string;
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
  movement: Movement; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opposite = movement.txn_type === 'INWARD' ? 'outward'
    : movement.txn_type === 'OUTWARD' ? 'inward' : 'adjustment';

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
    <div className="fixed inset-0 z-[70] grid place-items-center bg-ink/30 backdrop-blur-[2px] p-4">
      <form onSubmit={submit} className="w-full max-w-[430px] card shadow-lg slide-up">
        <div className="card-head border-b">
          <h2 className="card-title">Reverse {movement.txn_no}</h2>
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-3.5">
          <p className="text-[13px] text-ink-2 leading-relaxed">
            The original stays in the history untouched. A linked {opposite} of{' '}
            {fmtQty(Math.abs(movement.quantity), movement.unit_code)} is created to cancel it out.
          </p>

          <div className="bg-subtle rounded-lg px-3.5 py-3 text-[12px]">
            <p className="font-medium text-[13px]">{movement.exact_size} · {movement.brand_name}</p>
            <p className="text-ink-3 num mt-1">
              {movement.txn_type.toLowerCase()} {fmtQty(Math.abs(movement.quantity), movement.unit_code)} ·{' '}
              {fmtDate(movement.occurred_at)} {fmtTime(movement.occurred_at)} · {movement.user_name}
            </p>
          </div>

          <div>
            <label className="label" htmlFor="reason">Reason (required)</label>
            <textarea id="reason" rows={2} className="field" value={reason} required
              onChange={(e) => setReason(e.target.value)} placeholder="Wrong quantity entered" />
          </div>

          {error && <p className="text-[12px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-line bg-subtle rounded-b-xl">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !reason.trim()}>
            {busy ? 'Reversing…' : 'Create reversal'}
          </button>
        </div>
      </form>
    </div>
  );
}
