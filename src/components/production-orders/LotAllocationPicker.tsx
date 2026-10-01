'use client';

/**
 * LotAllocationPicker
 * ─────────────────────────────────────────────────────────────────────────────
 * Used inside the Production Order item form.
 *
 * Props:
 *   skuId       – the SKU to allocate from
 *   unitCode    – mm / pcs / etc.
 *   required    – total qty the order item needs
 *   value       – current saved allocations (array)
 *   onChange    – called whenever allocations change
 *   readOnly    – show-only mode (fulfilled / cancelled orders)
 *
 * Allocation model
 * ────────────────
 *   Each allocation = { lot_id, lot_no, status, available_qty, allocated_qty }
 *   The component lets the worker pick which lots to pull from and how much.
 *   If one lot can't cover the full qty, they split across two lots.
 *   A FULL_SLEEVE lot split is shown with a "will become CUT PCS" notice.
 *
 * The component does NOT write to the DB itself – the parent production-order
 * save handler writes `lot_allocations` rows via the API.
 */

import { useEffect, useState, useMemo } from 'react';
import { Layers, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty } from '@/lib/format';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LotAllocation {
  lot_id: string;
  lot_no: string;
  status: 'FULL_SLEEVE' | 'CUT_PCS';
  roll_length_mm: number;
  available_qty: number;
  allocated_qty: number;
}

interface AvailableLot {
  id: string;
  lot_no: string;
  status: 'FULL_SLEEVE' | 'CUT_PCS';
  roll_length_mm: number;
  current_qty: number;
  unit_code: string;
  pct_remaining: number | null;
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  FULL_SLEEVE: 'bg-green-100 text-green-800 border-green-200',
  CUT_PCS:     'bg-amber-100 text-amber-800 border-amber-200',
};
const STATUS_LABEL: Record<string, string> = {
  FULL_SLEEVE: 'Full Sleeve',
  CUT_PCS:     'Cut Pcs',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center border rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[status] ?? 'bg-slate-100 text-slate-500'}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function LotAllocationPicker({
  skuId,
  unitCode,
  required,
  value,
  onChange,
  readOnly = false,
}: {
  skuId: string;
  unitCode: string;
  required: number;                  // total qty the order item needs (mm)
  value: LotAllocation[];
  onChange: (allocs: LotAllocation[]) => void;
  readOnly?: boolean;
}) {
  const [lots, setLots] = useState<AvailableLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // Load active (non-exhausted, non-wasted) lots for this SKU
  useEffect(() => {
    if (!skuId) return;
    setLoading(true); setErr('');

    void supabaseBrowser()
      .from('v_sku_lots')
      .select('id,lot_no,status,roll_length_mm,current_qty,unit_code,pct_remaining')
      .eq('sku_id', skuId)
      .in('status', ['FULL_SLEEVE', 'CUT_PCS'])
      .order('created_at', { ascending: true })   // oldest (cut pcs) first
      .then(({ data, error }) => {
        if (error) { setErr(error.message); setLoading(false); return; }
        setLots((data ?? []) as AvailableLot[]);
        setLoading(false);
      });
  }, [skuId]);

  // Total allocated so far
  const totalAllocated = useMemo(
    () => value.reduce((s, a) => s + a.allocated_qty, 0),
    [value],
  );

  const remaining = required - totalAllocated;
  const isComplete = remaining <= 0;
  const isOver     = remaining < 0;

  // ── Auto-suggest allocation ─────────────────────────────────────────────────
  // Suggest button: greedily fill from CUT_PCS first, then FULL_SLEEVE
  const suggest = () => {
    if (!lots.length || required <= 0) return;
    let need = required;
    const result: LotAllocation[] = [];

    // Sort: CUT_PCS first (use up partials), then FULL_SLEEVE (oldest first)
    const sorted = [...lots].sort((a, b) => {
      if (a.status === 'CUT_PCS' && b.status !== 'CUT_PCS') return -1;
      if (b.status === 'CUT_PCS' && a.status !== 'CUT_PCS') return 1;
      return 0;
    });

    for (const lot of sorted) {
      if (need <= 0) break;
      const take = Math.min(need, lot.current_qty);
      if (take > 0) {
        result.push({
          lot_id:        lot.id,
          lot_no:        lot.lot_no,
          status:        lot.status,
          roll_length_mm: lot.roll_length_mm,
          available_qty: lot.current_qty,
          allocated_qty: take,
        });
        need -= take;
      }
    }

    onChange(result);
  };

  // ── Per-lot qty change ──────────────────────────────────────────────────────
  const setLotQty = (lotId: string, qty: number, lot: AvailableLot) => {
    const clamped = Math.max(0, Math.min(qty, lot.current_qty));
    if (clamped === 0) {
      // Remove this lot from allocations
      onChange(value.filter((a) => a.lot_id !== lotId));
      return;
    }
    const existing = value.find((a) => a.lot_id === lotId);
    if (existing) {
      onChange(value.map((a) => a.lot_id === lotId ? { ...a, allocated_qty: clamped } : a));
    } else {
      onChange([...value, {
        lot_id:        lot.id,
        lot_no:        lot.lot_no,
        status:        lot.status,
        roll_length_mm: lot.roll_length_mm,
        available_qty: lot.current_qty,
        allocated_qty: clamped,
      }]);
    }
  };

  // ── What will a lot's status become after allocation ─────────────────────────
  const postStatus = (lot: AvailableLot, allocQty: number): 'FULL_SLEEVE' | 'CUT_PCS' | 'EXHAUSTED' => {
    const after = lot.current_qty - allocQty;
    if (after <= 0) return 'EXHAUSTED';
    return 'CUT_PCS';   // any partial = cut pcs regardless of current status
  };

  if (loading) {
    return (
      <div className="space-y-1.5">
        {[0, 1].map((i) => <div key={i} className="h-10 skeleton rounded-md" />)}
      </div>
    );
  }

  if (err) return <p className="text-[12px] text-red-500">{err}</p>;

  if (lots.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px]">
        <AlertTriangle size={14} className="text-amber-500 mt-px shrink-0" />
        <p className="text-amber-800">No active lots available for this SKU. Receive stock via a Purchase Order first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">

      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers size={13} className="text-ink-3" />
          <span className="text-[12px] font-medium text-ink">Lot Allocation</span>
        </div>

        {/* Status pill */}
        {isOver && (
          <span className="inline-flex items-center gap-1 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-0.5">
            <AlertTriangle size={11} /> Over by {fmtQty(Math.abs(remaining), unitCode)}
          </span>
        )}
        {isComplete && !isOver && (
          <span className="inline-flex items-center gap-1 text-[11px] text-green-700 bg-green-50 border border-green-200 rounded px-2 py-0.5">
            <CheckCircle2 size={11} /> Fully allocated
          </span>
        )}
        {!isComplete && (
          <span className="text-[11px] text-ink-3">
            {fmtQty(totalAllocated, unitCode)} / {fmtQty(required, unitCode)}
          </span>
        )}

        {!readOnly && (
          <button
            type="button"
            onClick={suggest}
            className="btn btn-secondary btn-xs ml-auto"
            title="Auto-fill from oldest lots"
          >
            Auto-fill
          </button>
        )}
      </div>

      {/* Lot rows */}
      <div className="space-y-2">
        {lots.map((lot) => {
          const alloc     = value.find((a) => a.lot_id === lot.id);
          const allocQty  = alloc?.allocated_qty ?? 0;
          const rollsStr  = `${lot.roll_length_mm} mm / roll`;
          const after     = lot.current_qty - allocQty;
          const willBe    = allocQty > 0 ? postStatus(lot, allocQty) : null;

          return (
            <div
              key={lot.id}
              className={`rounded-lg border px-3 py-2.5 text-[12px] transition-colors ${
                allocQty > 0 ? 'border-brand/40 bg-brand/5' : 'border-line bg-surface'
              }`}
            >
              <div className="flex items-start gap-3">
                {/* Lot info */}
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-ink-3">{lot.lot_no}</span>
                    <StatusBadge status={lot.status} />
                    <span className="text-[11px] text-ink-3">{rollsStr}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-ink">
                      Available: <span className="font-semibold num">{fmtQty(lot.current_qty, unitCode)}</span>
                    </span>
                    {lot.status === 'CUT_PCS' && lot.pct_remaining !== null && (
                      <span className="text-ink-3">{lot.pct_remaining}% of roll</span>
                    )}
                  </div>

                  {/* Progress bar for CUT_PCS */}
                  {lot.status === 'CUT_PCS' && lot.pct_remaining !== null && (
                    <div className="h-1 bg-amber-100 rounded-full overflow-hidden w-32">
                      <div
                        className="h-full bg-amber-400 rounded-full"
                        style={{ width: `${Math.max(2, lot.pct_remaining)}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Qty input */}
                {!readOnly && (
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="w-6 h-6 rounded border border-line bg-subtle text-ink hover:bg-line flex items-center justify-center text-[13px] font-bold"
                        onClick={() => setLotQty(lot.id, allocQty - 1, lot)}
                        disabled={allocQty <= 0}
                      >−</button>
                      <input
                        type="number"
                        min={0}
                        max={lot.current_qty}
                        className="input w-24 text-center text-[13px] num h-7 px-1"
                        value={allocQty || ''}
                        placeholder="0"
                        onChange={(e) => setLotQty(lot.id, Number(e.target.value), lot)}
                      />
                      <button
                        type="button"
                        className="w-6 h-6 rounded border border-line bg-subtle text-ink hover:bg-line flex items-center justify-center text-[13px] font-bold"
                        onClick={() => setLotQty(lot.id, allocQty + 1, lot)}
                        disabled={allocQty >= lot.current_qty}
                      >+</button>
                    </div>
                    {allocQty > 0 && (
                      <span className="text-[11px] text-ink-3 num">
                        {after > 0 ? `${fmtQty(after, unitCode)} left` : 'will exhaust'}
                      </span>
                    )}
                  </div>
                )}

                {/* Read-only qty */}
                {readOnly && allocQty > 0 && (
                  <span className="shrink-0 num font-semibold text-[13px]">{fmtQty(allocQty, unitCode)}</span>
                )}
              </div>

              {/* Post-allocation notice */}
              {!readOnly && allocQty > 0 && willBe && (
                <div className={`mt-2 pt-2 border-t border-line text-[11px] flex items-center gap-1.5 ${
                  willBe === 'EXHAUSTED' ? 'text-slate-500' : 'text-amber-700'
                }`}>
                  <Info size={11} className="shrink-0" />
                  {willBe === 'EXHAUSTED'
                    ? 'This lot will be fully exhausted after fulfillment.'
                    : lot.status === 'FULL_SLEEVE'
                      ? `This full sleeve will become CUT PCS (${fmtQty(after, unitCode)} remaining).`
                      : `${fmtQty(after, unitCode)} will remain as CUT PCS.`
                  }
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Shortage warning */}
      {!readOnly && !isComplete && lots.reduce((s, l) => s + l.current_qty, 0) < required && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px]">
          <AlertTriangle size={14} className="text-red-500 mt-px shrink-0" />
          <p className="text-red-800">
            Total available stock ({fmtQty(lots.reduce((s, l) => s + l.current_qty, 0), unitCode)}) is less
            than the required quantity ({fmtQty(required, unitCode)}).
            Receive more stock before fulfilling this order.
          </p>
        </div>
      )}
    </div>
  );
}
