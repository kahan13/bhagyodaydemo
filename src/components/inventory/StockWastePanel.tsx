'use client';

import { useEffect, useState } from 'react';
import { PackageX, AlertTriangle, Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty } from '@/lib/format';
import type { Permission } from '@/lib/types';

/**
 * "Mark as waste" for products that are not kept in rolls (V-belts, conveyor belts).
 * It works exactly like marking a roll as waste:
 *   • BOOK stock drops at once, as a stock adjustment noted "Marked as waste · 3 pcs wasted: <reason>"
 *   • PHYSICAL (production) stock stays as it is until someone presses "Mark here as waste" on the
 *     Mismatch list — so the difference is visible there, traced to this very transaction
 *   • it shows in Transactions and in the "Marked as waste" report
 */
export default function StockWastePanel({
  skuId, skuCode, unitCode, can, onStockChange,
}: {
  skuId: string;
  skuCode: string;
  unitCode: string;
  can: (p: Permission) => boolean;
  onStockChange?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const allowed = can('inventory.adjust');

  return (
    <div className="space-y-2">
      <p className="text-[14px] text-ink-3 leading-relaxed">
        {skuCode} is not kept in rolls. If some of it is damaged or unusable, write it off here. Book stock drops now;
        the Mismatch list then shows it until it is applied to production stock.
      </p>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        disabled={!allowed}
        onClick={() => setOpen(true)}
        title={allowed ? 'Write some of this product off as waste' : 'Your role cannot mark stock as waste'}
      >
        <PackageX size={14} /> Mark as waste
      </button>
      {open && (
        <WasteQtyModal
          skuId={skuId} skuCode={skuCode} unitCode={unitCode}
          onClose={() => setOpen(false)}
          onDone={() => { setOpen(false); onStockChange?.(); }}
        />
      )}
    </div>
  );
}

function WasteQtyModal({
  skuId, skuCode, unitCode, onClose, onDone,
}: { skuId: string; skuCode: string; unitCode: string; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [book, setBook] = useState<number | null>(null);
  const [shelf, setShelf] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    supabaseBrowser().from('v_sku_atp').select('current_stock,physical_prod_stock').eq('sku_id', skuId).maybeSingle()
      .then(({ data }: { data: { current_stock: number | string; physical_prod_stock: number | string } | null }) => {
        if (!alive || !data) return;
        setBook(Number(data.current_stock)); setShelf(Number(data.physical_prod_stock));
      });
    return () => { alive = false; };
  }, [skuId]);

  const max = book !== null && shelf !== null ? Math.max(0, Math.min(book, shelf)) : null;
  const n = Number(qty) || 0;
  const tooMany = max !== null && n > max;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(n > 0)) { setErr('Enter how much was wasted.'); return; }
    if (tooMany) { setErr(`Only ${fmtQty(max, unitCode)} can be written off — the rest is promised to production orders.`); return; }
    if (!reason.trim()) { setErr('Please enter a reason.'); return; }
    setBusy(true); setErr('');
    const { error } = await supabaseBrowser().rpc('mark_stock_wasted', { p_sku_id: skuId, p_qty: n, p_reason: reason.trim() });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onDone();
  };

  return (
    <Modal
      title="Mark as Waste"
      icon={<AlertTriangle size={16} className="text-danger" />}
      onClose={onClose}
      onSubmit={submit}
      z={60}
      width="max-w-md"
      bodyClassName="px-5 py-4 space-y-3"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn" disabled={busy}>Cancel</button>
          <button type="submit" disabled={busy || !(n > 0) || !reason.trim() || tooMany}
            className="btn bg-danger text-white hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : 'Mark as Waste'}
          </button>
        </>
      }
    >
      <div className="bg-danger-soft border border-danger-line rounded-lg px-3 py-2.5 text-[14px]">
        <p className="font-medium text-danger font-mono">{skuCode}</p>
        <p className="text-danger mt-1">
          This writes the quantity off. It is <strong>permanent</strong> and cannot be undone
          (a wrong entry can be reversed from Transactions).
        </p>
      </div>
      <div className="text-[14px] text-ink-2 flex gap-x-5 gap-y-1 flex-wrap">
        <span>Book stock: <strong className="num">{book === null ? '…' : fmtQty(book, unitCode)}</strong></span>
        <span>Free on the shelf: <strong className="num">{shelf === null ? '…' : fmtQty(shelf, unitCode)}</strong></span>
      </div>
      <div>
        <label className="label">Quantity wasted ({unitCode.toLowerCase() === 'mtr' ? 'm' : unitCode.toLowerCase()}) <span className="text-danger">*</span></label>
        <input
          className={`field num text-[18px] h-11 ${tooMany ? 'border-danger' : ''}`}
          inputMode="decimal" placeholder="0" value={qty} autoFocus
          onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
        />
        {tooMany && <p className="text-[13px] text-danger mt-1">Only {fmtQty(max, unitCode)} can be written off.</p>}
      </div>
      <div>
        <label className="label">Reason <span className="text-danger">*</span></label>
        <textarea
          className="input w-full resize-none h-20 text-[15px]"
          placeholder="e.g. Belts damaged in storage, cut during handling…"
          value={reason} onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {err && <p className="text-[14px] text-danger">{err}</p>}
    </Modal>
  );
}
