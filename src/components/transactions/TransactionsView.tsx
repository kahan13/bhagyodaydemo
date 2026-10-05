'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Undo2, X, SlidersHorizontal, Download } from 'lucide-react';
import { fmtDate, fmtTime, fmtQty } from '@/lib/format';
import type { Movement } from '@/lib/types';
import { qtySplit, lotChip, snapTotal, LOT_NAME, type SnapGroup } from '@/lib/lotView';

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
  facets: { brands: string[]; families: string[]; users: string[]; operators: string[] };
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
    <div className="flex flex-col h-[calc(100vh/var(--z,1)-56px)]">
      {/* head */}
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[19px] font-semibold">Transactions</h1>
          <span className="text-[14px] text-ink-3 num">{total}</span>
          {pending && <span className="text-[13px] text-ink-3">Updating…</span>}

          <div className="ml-auto flex items-center gap-2">
            <select className="field w-[128px]" value={filters.range}
              onChange={(e) => setParam({ range: e.target.value, from: '', to: '' })}>
              {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button
              className={`btn btn-sm ${showFilters || activeCount ? 'btn-primary' : 'btn-secondary'}`}
              data-kt="F" data-kt-label="Filters"
              onClick={() => setShowFilters((v) => !v)}>
              <SlidersHorizontal size={13} />
              Filters{activeCount ? ` (${activeCount})` : ''}
            </button>
            <a className="btn btn-secondary btn-sm" data-kt="X" data-kt-label="Export"
              href={`/api/export?kind=transactions&${params.toString()}`}>
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
            <Select label="Product Type" value={filters.product} onChange={(v) => setParam({ product: v })}
              options={[['TIMING_BELT', 'Timing Belt'], ['V_BELT', 'V-Belt'], ['CONVEYOR_BELT', 'Conveyor Belt']]} width="w-[140px]" />
            <Select label="Brand" value={filters.brand} onChange={(v) => setParam({ brand: v })}
              options={facets.brands.map((b) => [b, b])} width="w-[150px]" />
            <Select label="Family" value={filters.family} onChange={(v) => setParam({ family: v })}
              options={facets.families.map((f) => [f, f])} width="w-[112px]" />
            <Select label="Entered By" value={filters.user} onChange={(v) => setParam({ user: v })}
              options={facets.users.map((u) => [u, u])} width="w-[150px]" />
            <Select label="Operated By" value={filters.operated_by} onChange={(v) => setParam({ operated_by: v })}
              options={facets.operators.map((u) => [u, u])} width="w-[150px]" />
            <div>
              <label className="label" htmlFor="search">Product search</label>
              <input id="search" data-kt="S" data-kt-label="Search product" data-global-search className="field w-[170px]" defaultValue={filters.search}
                placeholder="Size or brand"
                onKeyDown={(e) => { if (e.key === 'Enter') setParam({ search: (e.target as HTMLInputElement).value }); }} />
            </div>
            {activeCount > 0 && (
              <button className="btn btn-ghost btn-sm"
                onClick={() => setParam({ type: '', mode: '', product: '', brand: '', family: '', user: '', operated_by: '', search: '' })}>
                <X size={13} /> Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* table */}
      <div className="flex-1 min-h-0 scroll">
        {error && <p className="m-4 text-[15px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">{error}</p>}

        {!error && rows.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-[16px]">No movements in this period.</p>
            <p className="text-[15px] text-ink-3 mt-1">Widen the period or clear the filters.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Product</th>
                <th>Type</th>
                <th>Qty</th>
                <th>Stock before / after</th>
                <th>By</th>
                <th>Ref</th>
                {canReverse && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const operator = (m as Movement & { operated_by_name?: string }).operated_by_name;
                return (
                <tr key={m.id} className={m.is_reversed ? 'opacity-60' : undefined}>
                  <td className="whitespace-nowrap" suppressHydrationWarning>
                    <p className="num text-ink">{fmtDate(m.occurred_at)}</p>
                    <p className="text-[13px] text-ink-3 mt-0.5">{fmtTime(m.occurred_at)}</p>
                  </td>
                  <td className="min-w-[170px]">
                    <p className="font-semibold text-ink" title={m.sku_code}>{m.exact_size}</p>
                    <p className="text-[13px] text-ink-3 mt-0.5">
                      {m.brand_name}
                      {' · '}
                      {({ TIMING_BELT: 'Timing Belt', V_BELT: 'V-Belt', CONVEYOR_BELT: 'Conveyor Belt' } as Record<string, string>)[m.product_type] ?? '—'}
                    </p>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <span className={`badge ${isWaste(m) ? 'badge-danger' : 'badge-neutral'}`}>
                        {typeLabel(m)}
                      </span>
                      {m.txn_mode === 'REVERSAL' && <span className="badge badge-neutral">reversal</span>}
                      {m.is_reversed && <span className="badge badge-neutral">reversed</span>}
                    </div>
                  </td>
                  <td className="min-w-[200px]"><QtyCell m={m} /></td>
                  <td className="min-w-[270px]"><StateCell m={m} /></td>
                  <td className="whitespace-nowrap">
                    <p className="text-ink">{m.user_name}</p>
                    {operator && <p className="text-[13px] text-ink-3 mt-0.5">op. {operator}</p>}
                  </td>
                  <td className="whitespace-nowrap">
                    <p className="font-mono text-[13px] text-ink-2">{m.txn_no}</p>
                    {m.invoice_no && <p className="text-[13px] text-ink-3 mt-0.5">inv. {m.invoice_no}</p>}
                  </td>
                  {canReverse && (
                    <td className="text-right">
                      {m.txn_mode === 'NORMAL' && !m.is_reversed && (
                        <button className="btn btn-ghost btn-sm text-danger" onClick={() => setReversing(m)}>
                          <Undo2 size={13} /> Reverse
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* pagination */}
      <div className="border-t border-line bg-surface px-4 lg:px-6 h-12 flex items-center justify-between shrink-0">
        <p className="text-[14px] text-ink-3 num">
          {total === 0 ? 'No rows'
            : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
        </p>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}>Previous</button>
          <span className="text-[14px] text-ink-3 num px-1">{page} / {pages}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setParam({ page: String(page + 1) })}>Next</button>
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

function Select({ label, value, onChange, options, width = 'w-[124px]' }: {
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

/** One line per lot for the reverse dialog, e.g. "30 mm from Cut Pcs · LOT-…-0003". */
function lotLines(m: Movement): string[] {
  const b = m.lot_breakdown;
  if (!b || b.length === 0) return [];
  return b.map((e) => {
    if (e.status === 'WASTED') return `${fmtQty(e.qty, m.unit_code)} of ${LOT_NAME[e.was ?? ''] ?? 'lot'} goes back into · ${e.lot_no}`;
    if (m.txn_type === 'INWARD' && m.txn_mode !== 'REVERSAL') return `${fmtQty(e.qty, m.unit_code)} new ${e.status === 'CUT_PCS' ? 'Cut Pcs' : 'Full Sleeve'} piece · ${e.lot_no}`;
    return `${fmtQty(e.qty, m.unit_code)} ${m.txn_type === 'OUTWARD' ? 'from' : 'in'} ${LOT_NAME[e.status] ?? e.status} · ${e.lot_no}`;
  });
}

const isWaste = (m: Movement) =>
  m.txn_type === 'ADJUSTMENT' &&
  (m.lot_breakdown?.some((e) => e.status === 'WASTED' || e.restored) || /wasted:/i.test(m.notes ?? ''));

function typeLabel(m: Movement): string {
  if (m.txn_mode === 'REVERSAL' && m.txn_type === 'ADJUSTMENT' && isWaste(m)) return 'waste put back';
  if (isWaste(m)) return 'marked as waste';
  return m.txn_type.toLowerCase();
}

const SHORT: Record<string, string> = { FULL_SLEEVE: 'Full', CUT_PCS: 'Cut' };

/** Qty: lot chips (teal = Full Sleeve, amber = Cut Pcs) and the signed total. */
function QtyCell({ m }: { m: Movement }) {
  const sign = m.txn_type === 'OUTWARD' ? '−' : m.txn_type === 'INWARD' ? '+'
    : m.quantity < 0 ? '−' : '+';
  const total = `${sign}${fmtQty(Math.abs(m.quantity), m.unit_code)}`;
  const newRolls = m.txn_type === 'INWARD' && m.txn_mode !== 'REVERSAL';
  const parts = m.lot_tracked ? qtySplit(m.lot_breakdown, m.unit_code, newRolls) : [];
  const note = m.txn_mode === 'REVERSAL' && m.txn_type === 'INWARD' ? 'put back'
    : m.txn_mode === 'REVERSAL' && m.txn_type === 'OUTWARD' ? 'closed' : '';
  return (
    <div className="space-y-1.5">
      <p className="num text-[16px] text-ink">{total}</p>
      {parts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {parts.map((p) => (
            <span key={p.key} className={`chip ${lotChip(p.status)}`}>{note ? `${note} · ` : ''}{p.text}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One side of "before → after": lot chips and the total. */
function StateBlock({ m, which }: { m: Movement; which: 'before' | 'after' }) {
  const g: SnapGroup[] | undefined = m.lot_state?.[which];
  const stock = which === 'before' ? m.previous_stock : m.new_stock;
  const label = which === 'before' ? 'Before' : 'After';
  if (!m.lot_tracked || !g) {
    return (
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] uppercase tracking-wide text-ink-3 w-[46px] shrink-0">{label}</span>
        <span className="num text-[15px]">{fmtQty(stock, m.unit_code)}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <span className="text-[12px] uppercase tracking-wide text-ink-3 w-[46px] shrink-0 pt-0.5">{label}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap gap-1">
          {g.length === 0 && <span className="text-[14px] text-ink-3">no stock in lots</span>}
          {g.map((x) => (
            <span key={x.status + x.each} className={`chip ${lotChip(x.status)}`} title={LOT_NAME[x.status]}>
              {x.count} × {fmtQty(x.each, m.unit_code)} {SHORT[x.status]}
            </span>
          ))}
        </div>
        <p className="num text-[14px] text-ink-2 mt-0.5">Total {fmtQty(snapTotal(g), m.unit_code)}</p>
      </div>
    </div>
  );
}

function StateCell({ m }: { m: Movement }) {
  return (
    <div className="space-y-2">
      <StateBlock m={m} which="before" />
      <StateBlock m={m} which="after" />
    </div>
  );
}

function ReverseDialog({ movement, onClose, onDone }: {
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
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="p-5 space-y-3.5">
          <p className="text-[15px] text-ink-2 leading-relaxed">
            The original stays in the history untouched. A linked {opposite} of{' '}
            {fmtQty(Math.abs(movement.quantity), movement.unit_code)} is created to cancel it out.
          </p>
          <div className="bg-subtle rounded-lg px-3.5 py-3 text-[14px]">
            <p className="font-medium text-[15px]">{movement.exact_size} · {movement.brand_name}</p>
            <p className="text-ink-3 num mt-1">
              {movement.txn_type.toLowerCase()} {fmtQty(Math.abs(movement.quantity), movement.unit_code)} ·{' '}
              {fmtDate(movement.occurred_at)} {fmtTime(movement.occurred_at)} · {movement.user_name}
            </p>
          </div>
          {(movement.lot_tracked || movement.txn_type === 'ADJUSTMENT') && lotLines(movement).length > 0 && (
            <div className="bg-brand-soft/40 rounded-lg px-3.5 py-2.5">
              <p className="text-[13px] font-semibold text-ink-2 mb-1">
                {movement.txn_type === 'INWARD' ? 'These lots will be closed' : 'Will be put back into these lots'}
              </p>
              {lotLines(movement).map((l, i) => <p key={i} className="text-[14px] text-ink-2 num">{l}</p>)}
              {movement.txn_type === 'INWARD' && (
                <p className="text-[13px] text-ink-3 mt-1">Blocked if any of these rolls has already been used.</p>
              )}
            </div>
          )}
          <div>
            <label className="label" htmlFor="reason">Reason (required)</label>
            <textarea id="reason" rows={2} className="field" value={reason} required
              onChange={(e) => setReason(e.target.value)} placeholder="Wrong quantity entered" />
          </div>
          {error && <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
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
