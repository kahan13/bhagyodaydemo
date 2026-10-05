'use client';

import { useEffect, useState } from 'react';
import { PackageX, RefreshCw, AlertTriangle, X, ChevronDown, ChevronUp } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty } from '@/lib/format';
import type { Permission } from '@/lib/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SkuLot {
  id: string;
  lot_no: string;
  roll_length_mm: number;
  inward_qty: number;
  current_qty: number;
  status: 'FULL_SLEEVE' | 'CUT_PCS' | 'EXHAUSTED' | 'WASTED';
  unit_code: string;
  pct_remaining: number | null;
  created_at: string;
  wasted_at: string | null;
  waste_reason: string | null;
  wasted_by_name: string | null;
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  FULL_SLEEVE: 'bg-ok-soft text-ok border-ok-line',
  CUT_PCS:     'bg-warn-soft text-warn border-warn-line',
  EXHAUSTED:   'bg-subtle text-ink-2 border-line',
  WASTED:      'bg-danger-soft text-danger border-danger-line',
};

const STATUS_LABEL: Record<string, string> = {
  FULL_SLEEVE: 'Full Sleeve',
  CUT_PCS:     'Cut Pcs',
  EXHAUSTED:   'Exhausted',
  WASTED:      'Wasted',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center border rounded px-1.5 py-0.5 text-[13px] font-semibold whitespace-nowrap ${STATUS_STYLE[status] ?? 'bg-subtle text-ink-3'}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ── Waste confirm modal ───────────────────────────────────────────────────────

function WasteModal({
  lot,
  onConfirm,
  onClose,
}: {
  lot: SkuLot;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!reason.trim()) { setErr('Please enter a reason.'); return; }
    setBusy(true); setErr('');
    try {
      await onConfirm(reason.trim());
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-md m-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-danger" />
            <h3 className="font-semibold text-[16px]">Mark Lot as Waste</h3>
          </div>
          <button onClick={onClose} className="icon-btn"><X size={15} /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="bg-danger-soft border border-danger-line rounded-lg px-3 py-2.5 text-[14px]">
            <p className="font-medium text-danger">{lot.lot_no} — <StatusBadge status={lot.status} /></p>
            <p className="text-danger mt-1">
              {fmtQty(lot.current_qty, lot.unit_code)} remaining of {fmtQty(lot.roll_length_mm, lot.unit_code)} roll will be written off.
              This action is <strong>permanent</strong> and cannot be undone.
            </p>
          </div>

          <div>
            <label className="label">Reason <span className="text-danger">*</span></label>
            <textarea
              className="input w-full resize-none h-20 text-[15px]"
              placeholder="e.g. Belt damaged beyond use, only 7mm left…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>

          {err && <p className="text-[14px] text-danger">{err}</p>}
        </div>

        <div className="px-5 py-4 border-t border-line flex justify-end gap-3">
          <button onClick={onClose} className="btn" disabled={busy}>Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !reason.trim()}
            className="btn bg-danger text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Processing…' : 'Mark as Waste'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SkuLotsPanel({
  skuId,
  skuCode,
  unitCode,
  can,
  onStockChange,
}: {
  skuId: string;
  skuCode: string;
  unitCode: string;
  can: (p: Permission) => boolean;
  onStockChange?: () => void;    // called after waste so parent can refresh stock
}) {
  const [lots, setLots] = useState<SkuLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [showExhausted, setShowExhausted] = useState(false);
  const [showWasted, setShowWasted] = useState(false);
  const [wasteTarget, setWasteTarget] = useState<SkuLot | null>(null);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true); setErr('');
    const { data, error } = await supabaseBrowser()
      .from('v_sku_lots')
      .select('id,lot_no,roll_length_mm,inward_qty,current_qty,status,unit_code,pct_remaining,created_at,wasted_at,waste_reason,wasted_by_name')
      .eq('sku_id', skuId)
      .order('created_at', { ascending: true });

    if (error) { setErr(error.message); setLoading(false); return; }
    setLots((data ?? []) as SkuLot[]);
    setLoading(false);
  };

  useEffect(() => { load(); }, [skuId]);

  const handleWaste = async (reason: string) => {
    const { error } = await supabaseBrowser().rpc('mark_lot_wasted', {
      p_lot_id: wasteTarget!.id,
      p_reason: reason,
    });
    if (error) throw new Error(error.message);
    setWasteTarget(null);
    await load();
    onStockChange?.();
  };

  // ── Bucket lots by status ──────────────────────────────────────────────────
  const active      = lots.filter((l) => l.status === 'FULL_SLEEVE' || l.status === 'CUT_PCS');
  const exhausted   = lots.filter((l) => l.status === 'EXHAUSTED');
  const wasted      = lots.filter((l) => l.status === 'WASTED');

  // Summary numbers
  const totalActive = active.reduce((s, l) => s + l.current_qty, 0);
  const fullCount   = active.filter((l) => l.status === 'FULL_SLEEVE').length;
  const cutCount    = active.filter((l) => l.status === 'CUT_PCS').length;

  if (loading) {
    return (
      <div className="space-y-1.5 px-1">
        {[0, 1, 2].map((i) => <div key={i} className="h-10 skeleton rounded-md" />)}
      </div>
    );
  }

  if (err) {
    return <p className="text-[14px] text-danger px-1">{err}</p>;
  }

  if (lots.length === 0) {
    return (
      <p className="text-[14px] text-ink-3 px-1">
        No lots yet. Lots are created when stock is received via Purchase Orders.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* ── Summary row ── */}
      <div className="flex items-center gap-3 text-[14px] text-ink-2 flex-wrap">
        <span className="font-medium text-ink">{fmtQty(totalActive, unitCode)} active</span>
        {fullCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-ok inline-block" />
            {fullCount} full sleeve{fullCount > 1 ? 's' : ''}
          </span>
        )}
        {cutCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-warn inline-block" />
            {cutCount} cut pcs
          </span>
        )}
        <button onClick={load} className="ml-auto text-ink-3 hover:text-ink" title="Refresh lots">
          <RefreshCw size={12} />
        </button>
      </div>

      {/* ── Active lots ── */}
      {active.length === 0 && (
        <p className="text-[14px] text-ink-3">No active stock in lots.</p>
      )}

      {active.map((lot) => (
        <LotRow
          key={lot.id}
          lot={lot}
          unitCode={unitCode}
          canWaste={can('inventory.adjust') && lot.current_qty > 0}
          onWaste={() => setWasteTarget(lot)}
        />
      ))}

      {/* ── Exhausted lots (collapsible) ── */}
      {exhausted.length > 0 && (
        <div className="border-t border-line pt-2 mt-1">
          <button
            className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 w-full"
            onClick={() => setShowExhausted((v) => !v)}
          >
            {showExhausted ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {exhausted.length} exhausted lot{exhausted.length > 1 ? 's' : ''}
          </button>
          {showExhausted && (
            <div className="mt-1.5 space-y-1.5">
              {exhausted.map((lot) => (
                <LotRow key={lot.id} lot={lot} unitCode={unitCode} canWaste={false} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Wasted lots (collapsible) ── */}
      {wasted.length > 0 && (
        <div className="border-t border-line pt-2 mt-1">
          <button
            className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 w-full"
            onClick={() => setShowWasted((v) => !v)}
          >
            {showWasted ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {wasted.length} wasted lot{wasted.length > 1 ? 's' : ''}
          </button>
          {showWasted && (
            <div className="mt-1.5 space-y-1.5">
              {wasted.map((lot) => (
                <LotRow key={lot.id} lot={lot} unitCode={unitCode} canWaste={false} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Waste confirm modal ── */}
      {wasteTarget && (
        <WasteModal
          lot={wasteTarget}
          onConfirm={handleWaste}
          onClose={() => setWasteTarget(null)}
        />
      )}
    </div>
  );
}

// ── Individual lot row ────────────────────────────────────────────────────────

function LotRow({
  lot,
  unitCode,
  canWaste,
  onWaste,
}: {
  lot: SkuLot;
  unitCode: string;
  canWaste: boolean;
  onWaste?: () => void;
}) {
  const isInactive = lot.status === 'EXHAUSTED' || lot.status === 'WASTED';

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-[15px] ${
      isInactive ? 'border-line bg-subtle opacity-70' : 'border-line bg-surface'
    }`}>
      {/* line 1: lot number + status */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-mono text-[14px] font-semibold text-ink-2 break-all">{lot.lot_no}</span>
        <StatusBadge status={lot.status} />
      </div>

      {/* line 2: quantity + mark-waste plate */}
      <div className="flex items-center justify-between gap-2 mt-1.5 flex-wrap">
        <div>
          <span className="num text-[17px]">{fmtQty(lot.current_qty, unitCode)}</span>
          <span className="text-ink-2 ml-1.5">
            {lot.current_qty !== lot.inward_qty ? 'of' : 'full'} {fmtQty(lot.roll_length_mm, unitCode)} roll
          </span>
        </div>

        {canWaste && onWaste && (
          <button
            onClick={onWaste}
            className="btn btn-danger btn-sm"
            title="Write this lot off as waste"
          >
            <PackageX size={14} /> Mark waste
          </button>
        )}
      </div>

      {/* Progress bar for cut pieces */}
      {lot.status === 'CUT_PCS' && lot.pct_remaining !== null && (
        <div className="mt-1.5">
          <div className="h-2 bg-warn-soft rounded-full overflow-hidden">
            <div
              className="h-full bg-warn rounded-full"
              style={{ width: `${Math.max(2, lot.pct_remaining)}%` }}
            />
          </div>
          <p className="lot-cut font-medium mt-0.5">{lot.pct_remaining}% of roll remaining</p>
        </div>
      )}

      {/* Waste info */}
      {lot.status === 'WASTED' && lot.waste_reason && (
        <p className="text-danger mt-1 truncate" title={lot.waste_reason}>
          Reason: {lot.waste_reason}
        </p>
      )}
    </div>
  );
}
