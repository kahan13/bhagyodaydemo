'use client';

/**
 * LotAllocationPicker
 * ─────────────────────────────────────────────────────────────────────────────
 * Lets the admin pick WHICH physical lots (rolls) a production order line item
 * should pull from, when the quantity can't all come from one roll.
 *
 * Rebuilt clean for Step 6 — the previous attempt assumed a `DRAFT` order
 * status that never exists in this schema (see 013_lot_allocations.sql) and
 * wasn't wired into the real ProductionOrdersView.tsx line-item form at all.
 * This version is a self-contained, controlled component: it fetches a SKU's
 * lots itself and reports the chosen split back to the parent as plain data —
 * no assumptions about where it's rendered.
 *
 * Business rule it encodes (as explained to the user):
 *   - Cut Pcs lots are offered before Full Sleeve lots — use up an already
 *     opened roll before opening a fresh one.
 *   - If one lot doesn't cover the full quantity, the remainder is pulled
 *     from the next lot in line (auto-split), and that lot becomes Cut Pcs
 *     the moment anything is taken from it.
 *   - The book ledger is never touched here. This only records the PLAN;
 *     lots are actually drained later, when the order item's outward is
 *     posted (record_production_outward_with_lots in 013).
 *
 * Usage:
 *   <LotAllocationPicker
 *     skuId={sku.id}
 *     unitCode={sku.unit_code}
 *     qtyNeeded={50}
 *     value={allocations}
 *     onChange={(next, isComplete) => ...}
 *   />
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Wand2 } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty } from '@/lib/format';

export interface LotAllocation {
  lot_id: string;
  lot_no: string;
  qty: number;
  status: 'FULL_SLEEVE' | 'CUT_PCS';
  roll_length_mm: number;
}

interface AvailableLot {
  id: string;
  lot_no: string;
  status: 'FULL_SLEEVE' | 'CUT_PCS' | 'EXHAUSTED' | 'WASTED';
  current_qty: number;
  roll_length_mm: number;
  created_at: string;
}

export default function LotAllocationPicker({
  skuId,
  unitCode,
  qtyNeeded,
  value,
  onChange,
  disabled = false,
}: {
  skuId: string;
  unitCode: string;
  qtyNeeded: number;
  value: LotAllocation[];
  onChange: (next: LotAllocation[], isComplete: boolean) => void;
  disabled?: boolean;
}) {
  const [lots, setLots] = useState<AvailableLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = async () => {
    if (!skuId) { setLots([]); setLoading(false); return; }
    setLoading(true); setErr('');
    const { data, error } = await supabaseBrowser()
      .from('v_sku_lots')
      .select('id,lot_no,status,current_qty,roll_length_mm,created_at')
      .eq('sku_id', skuId)
      .in('status', ['FULL_SLEEVE', 'CUT_PCS'])
      .gt('current_qty', 0)
      // Cut pieces first (use up opened rolls before opening a new one),
      // then oldest first within each group (FIFO).
      .order('status', { ascending: false }) // 'FULL_SLEEVE' > 'CUT_PCS' alphabetically desc puts CUT_PCS first
      .order('created_at', { ascending: true });

    if (error) { setErr(error.message); setLoading(false); return; }
    setLots((data ?? []) as AvailableLot[]);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [skuId]);

  const totalAllocated = useMemo(
    () => value.reduce((s, a) => s + a.qty, 0),
    [value],
  );
  const totalAvailable = useMemo(
    () => lots.reduce((s, l) => s + l.current_qty, 0),
    [lots],
  );
  const isComplete = qtyNeeded > 0 && totalAllocated === qtyNeeded;
  const remaining = qtyNeeded - totalAllocated;

  // ── Auto-fill: greedy, cut-pcs-first, oldest-first (lots already sorted that way) ──
  const autoFill = () => {
    let need = qtyNeeded;
    const next: LotAllocation[] = [];
    for (const lot of lots) {
      if (need <= 0) break;
      const take = Math.min(need, lot.current_qty);
      if (take > 0) {
        next.push({
          lot_id: lot.id,
          lot_no: lot.lot_no,
          qty: take,
          status: lot.status as 'FULL_SLEEVE' | 'CUT_PCS',
          roll_length_mm: lot.roll_length_mm,
        });
        need -= take;
      }
    }
    onChange(next, need <= 0);
  };

  const setLotQty = (lot: AvailableLot, qty: number) => {
    const clamped = Math.max(0, Math.min(qty, lot.current_qty));
    const existing = value.filter((a) => a.lot_id !== lot.id);
    const next = clamped > 0
      ? [...existing, {
          lot_id: lot.id, lot_no: lot.lot_no, qty: clamped,
          status: lot.status as 'FULL_SLEEVE' | 'CUT_PCS', roll_length_mm: lot.roll_length_mm,
        }]
      : existing;
    const total = next.reduce((s, a) => s + a.qty, 0);
    onChange(next, total === qtyNeeded);
  };

  const valueFor = (lotId: string) => value.find((a) => a.lot_id === lotId)?.qty ?? 0;

  if (!skuId || qtyNeeded <= 0) return null;

  if (loading) {
    return <div className="h-16 skeleton rounded-md mt-2" />;
  }

  if (err) {
    return <p className="text-[11px] text-danger mt-2">Could not load lots: {err}</p>;
  }

  if (lots.length === 0) {
    return (
      <div className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-3 bg-subtle border border-line rounded-md px-2.5 py-2">
        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
        <span>
          No tracked lots for this SKU yet. Outward will still post to the book ledger normally —
          it just won't be split by roll.
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-line bg-subtle p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink-3">
          Allocate from lots — {fmtQty(totalAvailable, unitCode)} available across {lots.length} lot{lots.length > 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={load}
            className="text-ink-3 hover:text-ink p-1"
            title="Refresh lots"
          >
            <RefreshCw size={11} />
          </button>
          {!disabled && (
            <button
              type="button"
              onClick={autoFill}
              className="btn btn-secondary btn-sm !h-6 !py-0 !px-2 text-[11px] flex items-center gap-1"
            >
              <Wand2 size={11} /> Auto-fill
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        {lots.map((lot) => {
          const qty = valueFor(lot.id);
          return (
            <div key={lot.id} className="flex items-center gap-2 text-[12px]">
              <span className="font-mono text-[11px] text-ink-3 w-28 shrink-0 truncate">{lot.lot_no}</span>
              <span className={`badge shrink-0 ${lot.status === 'FULL_SLEEVE' ? 'badge-ok' : 'badge-warn'}`}>
                {lot.status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs'}
              </span>
              <span className="text-ink-3 text-[11px] shrink-0 w-24">
                {fmtQty(lot.current_qty, unitCode)} left
              </span>
              <input
                type="number"
                min={0}
                max={lot.current_qty}
                className="field h-7 text-[12px] text-right w-24 ml-auto"
                value={qty || ''}
                placeholder="0"
                disabled={disabled}
                onChange={(e) => setLotQty(lot, Number(e.target.value) || 0)}
              />
            </div>
          );
        })}
      </div>

      <div className={`flex items-center gap-1.5 text-[11px] pt-1 border-t border-line ${
        isComplete ? 'text-ok' : remaining > 0 ? 'text-warn' : 'text-danger'
      }`}>
        {isComplete ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
        {isComplete && <span>Fully allocated — {fmtQty(totalAllocated, unitCode)} across {value.length} lot{value.length > 1 ? 's' : ''}</span>}
        {!isComplete && remaining > 0 && (
          <span>{fmtQty(remaining, unitCode)} still unallocated of {fmtQty(qtyNeeded, unitCode)} needed</span>
        )}
        {!isComplete && remaining < 0 && (
          <span>Over-allocated by {fmtQty(-remaining, unitCode)} — reduce a lot's quantity</span>
        )}
      </div>
    </div>
  );
}
