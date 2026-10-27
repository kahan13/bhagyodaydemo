'use client';

import { useState, useEffect } from 'react';
import { Loader, Trash2, AlertTriangle, ArrowDownCircle, CheckSquare, Trash } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type {
  ProductionOrder,
  ProductionOrderStatus,
  SkuMismatch,
  MismatchOrderItem,
  PendingAdjustment,
} from '@/lib/types';
import { fmtMmPcs, fmtLineQty, fmtQty } from '@/lib/format';

/**
 * Pieces shared by the two production-order screens:
 *   /production-orders              → create an order
 *   /production-orders/in-progress  → follow, finish and reconcile orders
 */

// ─── Status words ─────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<ProductionOrderStatus, string> = {
  CREATED:     'Created',
  IN_PROGRESS: 'In Progress',
  COMPLETED:   'Completed',
  CANCELLED:   'Cancelled',
};

export const STATUS_BADGE: Record<ProductionOrderStatus, string> = {
  CREATED:     'badge-warn',
  IN_PROGRESS: 'badge-ok',
  COMPLETED:   'bg-subtle text-ink-3 px-2 py-0.5 rounded-full text-[13px] font-medium',
  CANCELLED:   'bg-danger-soft text-danger px-2 py-0.5 rounded-full text-[13px] font-medium',
};

/** The only two moves workshop staff make. Each needs one click. */
export const STATUS_NEXT: Partial<Record<ProductionOrderStatus, 'IN_PROGRESS' | 'COMPLETED'>> = {
  CREATED:     'IN_PROGRESS',
  IN_PROGRESS: 'COMPLETED',
};

export const STATUS_NEXT_LABEL: Partial<Record<ProductionOrderStatus, string>> = {
  CREATED:     'Mark In Progress',
  IN_PROGRESS: 'Mark Completed',
};

// ─── Dates ────────────────────────────────────────────────────────────────────

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${date}, ${time}`;
}

// ─── WhatsApp message builder ─────────────────────────────────────────────────

export function buildMessage(fields: {
  order_no?: string;
  direct?: boolean;
  customer_name: string;
  items: Array<{ display_name: string; quantity: string; unit_code: string; detail?: string; pieces?: string; mm?: string }>;
  time_tag: string;
  delivery_mode: string;
  delivery_note: string;
  assigned_to: string;
  notes: string;
}) {
  // Every line says exactly what is wanted, MM first and PCS second:
  //   1. H-210 — 470 mm × 2 pcs (total 940 mm)
  //   2. A-38  — 5 pcs
  const itemLines = fields.items
    .filter((i) => i.display_name)
    .map((i, idx) => {
      const isMmPcs = i.pieces && i.mm && Number(i.pieces) * Number(i.mm) === Number(i.quantity);
      const qty = isMmPcs
        ? ` — ${fmtMmPcs(i.mm, i.pieces, i.unit_code.toUpperCase() === 'RIB' ? 'ribs' : 'mm')} (total ${fmtQty(i.quantity, i.unit_code)})`
        : i.quantity ? ` — ${fmtQty(i.quantity, i.unit_code)}` : '';
      return `  ${idx + 1}. ${i.display_name}${qty}${i.detail ? ` (${i.detail})` : ''}`;
    });

  const lines = [
    `*Production Order${fields.direct ? ' (DIRECT)' : ''}*`,
    `PO No: ${fields.order_no ?? '(assigned when created)'}`,
    fields.customer_name ? `Customer: ${fields.customer_name}` : null,
    itemLines.length > 0 ? `Items:\n${itemLines.join('\n')}` : null,
    fields.time_tag ? `Time: ${fields.time_tag}` : null,
    fields.delivery_mode
      ? `Delivery: ${fields.delivery_mode}${fields.delivery_note ? ` (${fields.delivery_note})` : ''}`
      : null,
    fields.assigned_to ? `Assigned to: ${fields.assigned_to}` : null,
    fields.notes ? `Notes: ${fields.notes}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

// ─── Modals ───────────────────────────────────────────────────────────────────

export function DeleteConfirmModal({
  orderNo, onConfirm, onCancel, deleting,
}: {
  orderNo: string; onConfirm: () => void; onCancel: () => void; deleting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-surface rounded-xl border border-line shadow-xl p-6 max-w-sm w-full space-y-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 rounded-full bg-danger-soft p-2">
            <AlertTriangle size={18} className="text-danger" />
          </div>
          <div>
            <h3 className="text-[17px] font-semibold">Delete Order {orderNo}?</h3>
            <p className="text-[15px] text-ink-3 mt-1">
              This will permanently delete the order and all its items. Physical stock will be restored.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={onCancel} disabled={deleting}>Cancel</button>
          <button
            className="btn bg-danger text-white hover:bg-danger/90 border-danger"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? <Loader size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function RecordOutwardModal({
  item,
  onConfirm,
  onCancel,
  recording,
}: {
  item: MismatchOrderItem;
  onConfirm: (notes: string, invoiceNo: string, operatedBy: string) => void;
  onCancel: () => void;
  recording: boolean;
}) {
  const [notes, setNotes] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [operatedBy, setOperatedBy] = useState('');
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabaseBrowser().from('app_users').select('id,full_name').eq('is_active', true).order('full_name');
      if (alive) setUsers((data ?? []) as { id: string; full_name: string }[]);
    })();
    return () => { alive = false; };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-surface rounded-xl border border-line shadow-xl p-6 max-w-sm w-full space-y-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 rounded-full bg-brand/10 p-2">
            <ArrowDownCircle size={18} className="text-brand" />
          </div>
          <div>
            <h3 className="text-[17px] font-semibold">Record Outward</h3>
            <p className="text-[15px] text-ink-3 mt-1">
              Record an OUTWARD inventory entry for{' '}
              <span className="font-medium text-ink">
                {fmtLineQty(item)}
              </span>{' '}
              from order <span className="font-mono text-brand">{item.order_no}</span>
              {item.customer_name ? ` (${item.customer_name})` : ''}.
              This will update both book stock and physical stock.
            </p>
          </div>
        </div>
        <div>
          <label className="eyebrow mb-1 block">Invoice no (optional)</label>
          <input className="field" placeholder="INV-001" value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="eyebrow mb-1 block">Operated by</label>
          <select className="field" value={operatedBy} onChange={(e) => setOperatedBy(e.target.value)}>
            <option value="">— select team member —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
        <div>
          <label className="eyebrow mb-1 block">Notes (optional)</label>
          <input
            className="field"
            placeholder="e.g. Dispatched via courier"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={onCancel} disabled={recording}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => onConfirm(notes, invoiceNo, operatedBy)}
            disabled={recording}
          >
            {recording ? <Loader size={14} className="animate-spin" /> : <CheckSquare size={14} />}
            Confirm Outward
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mismatch Pane (content) ──────────────────────────────────────────────────
// Two traced kinds of difference between book and physical stock:
//   1. Pending outward  — production planned/consumed stock, outward not posted yet
//   2. Book-only moves  — a waste or adjustment changed book stock; apply it to physical

export function MismatchPane({
  mismatches, pending, onRecordOutward, onResolve, resolvingId, loadingMismatches, searching = false,
}: {
  mismatches: SkuMismatch[];
  pending: PendingAdjustment[];
  onRecordOutward: (item: MismatchOrderItem) => void;
  onResolve: (p: PendingAdjustment) => void;
  resolvingId: string | null;
  loadingMismatches: boolean;
  /** true while a search is filtering the lists, so "empty" can say "no match" */
  searching?: boolean;
}) {
  if (loadingMismatches) {
    return (
      <div className="p-4 flex items-center gap-2 text-[15px] text-ink-3">
        <Loader size={14} className="animate-spin" /> Checking stock status…
      </div>
    );
  }
  if (mismatches.length === 0 && pending.length === 0) {
    return (
      <p className="p-4 text-[15px] text-ink-3">
        {searching ? 'Nothing matches your search.' : 'Book and physical stock agree — nothing to reconcile.'}
      </p>
    );
  }

  return (
    <div className="divide-y divide-line">
      {pending.length > 0 && (
        <div className="p-4 space-y-2">
          <p className="text-[13px] text-ink-3 font-medium uppercase tracking-wide">
            Stock movements not yet applied to production stock
          </p>
          {pending.map((p) => {
            const unit = p.skus?.unit_code ?? '';
            const removed = p.delta < 0;
            return (
              <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-line px-3 py-2">
                <div className="text-[14px] min-w-0">
                  <span className="font-mono text-brand font-medium">{p.skus?.sku_code}</span>
                  <span className="text-ink ml-1.5">{p.skus?.display_name}</span>
                  <div className="text-[13px] text-ink-3 mt-0.5">
                    <span className={`font-semibold ${removed ? 'text-danger' : 'text-ok'}`}>
                      {removed ? '' : '+'}{p.delta} {unit}
                    </span>
                    {' · '}{p.source === 'WASTE' ? `Lot ${p.lot_no ?? ''} marked as waste` : 'Stock adjustment'}
                    {p.reason && p.source !== 'WASTE' ? ` — ${p.reason}` : ''}
                    {' · '}{p.created_by ?? 'system'} · {formatDateTime(p.created_at)}
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm shrink-0"
                  disabled={resolvingId === p.id}
                  onClick={() => onResolve(p)}
                  title="Apply this change to production (physical) stock so both match"
                >
                  {resolvingId === p.id ? <Loader size={12} className="animate-spin" /> : <Trash size={12} />}
                  {p.source === 'WASTE' ? 'Mark here as waste' : 'Apply to production'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {mismatches.length > 0 && (
        <div className="divide-y divide-warn/20">
          <p className="px-4 pt-4 text-[13px] text-ink-3 font-medium uppercase tracking-wide">
            Pending outward
          </p>
          {mismatches.map((m) => (
            <div key={m.sku_id} className="p-4 space-y-3">
              <div>
                <p className="text-[15px] font-semibold">
                  <span className="font-mono text-brand">{m.sku_code}</span>{' – '}{m.display_name}
                </p>
                <div className="flex items-center gap-3 mt-1 text-[14px] flex-wrap">
                  <span className="text-ink-3">
                    Book: <span className="font-medium text-ink">{m.current_stock} {m.unit_code}</span>
                  </span>
                  <span className="text-ink-3">
                    Physical: <span className="font-medium text-danger">{m.physical_prod_stock} {m.unit_code}</span>
                  </span>
                  <span className="rounded-full bg-warn/20 text-warn px-2 py-0.5 font-semibold">
                    {m.stock_gap > 0 ? `−${m.stock_gap} ${m.unit_code} outward not posted` : `+${-m.stock_gap} ${m.unit_code} physical above book`}
                  </span>
                </div>
              </div>

              {m.open_order_items.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[13px] text-ink-3 font-medium uppercase tracking-wide">
                    Orders waiting for their outward to be recorded:
                  </p>
                  {m.open_order_items.map((oi) => (
                    <div key={oi.poi_id} className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-line px-3 py-2">
                      <div className="text-[14px] min-w-0">
                        <span className="font-mono text-brand font-medium">{oi.order_no}</span>
                        {oi.customer_name && <span className="text-ink-3 ml-1.5">· {oi.customer_name}</span>}
                        <span className="text-ink ml-2 font-medium">{fmtLineQty(oi)}</span>
                        <span className={`ml-2 text-[13px] px-1.5 py-0.5 rounded-full ${
                          oi.order_status === 'IN_PROGRESS' ? 'bg-ok/10 text-ok' :
                          oi.order_status === 'COMPLETED'   ? 'bg-brand/10 text-brand' :
                          'bg-warn/10 text-warn'
                        }`}>{oi.order_status === 'COMPLETED' ? 'Completed · outward not posted' : STATUS_LABEL[oi.order_status]}</span>
                      </div>
                      <button
                        className="btn btn-primary btn-sm shrink-0"
                        onClick={() => onRecordOutward(oi)}
                        title="Record OUTWARD inventory entry for this production order item"
                      >
                        <ArrowDownCircle size={12} /> Record Outward
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {m.open_order_items.length === 0 && (
                <p className="text-[14px] text-ink-3 italic">
                  No movement or open order explains this difference. Check the Movements pane for the
                  SKU, or record a manual entry from the Inventory page.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Movements pane (content) ─────────────────────────────────────────────────

export interface MovementRow {
  id: string;
  txn_no: string;
  txn_type: string;
  txn_mode: string;
  quantity: number;
  unit_code: string;
  occurred_at: string;
  user_name: string;
  notes: string | null;
  reference?: string | null;
  lot_breakdown: { lot_no: string; status: string; qty: number }[] | null;
  skus: { sku_code: string; display_name: string } | null;
}

export function MovementsPane({ rows, loading, pendingMovementIds, searching = false }: {
  rows: MovementRow[]; loading: boolean; pendingMovementIds: Set<string>; searching?: boolean;
}) {
  if (loading) return <div className="p-4 flex items-center gap-2 text-[15px] text-ink-3"><Loader size={14} className="animate-spin" /> Loading…</div>;
  if (rows.length === 0) {
    return <p className="p-4 text-[15px] text-ink-3">{searching ? 'No movement matches your search.' : 'No stock movements yet.'}</p>;
  }
  return (
    <div className="divide-y divide-line max-h-[60vh] overflow-y-auto">
      {rows.map((m) => {
        const isAdj = m.txn_type === 'ADJUSTMENT';
        const tag = isAdj ? (m.notes?.includes(' wasted:') ? 'Waste' : 'Adjustment') : m.txn_type === 'INWARD' ? 'Inward' : 'Outward';
        const sync = m.txn_type === 'INWARD'
          ? 'Book + physical'
          : m.txn_type === 'OUTWARD' ? 'Physical already planned'
          : pendingMovementIds.has(m.id) ? 'Awaiting production' : 'Reconciled';
        return (
          <div key={m.id} className="px-4 py-2 flex items-center justify-between gap-3 text-[14px]">
            <div className="min-w-0">
              <span className="font-mono text-brand">{m.skus?.sku_code}</span>
              <span className="text-ink ml-1.5">{m.skus?.display_name}</span>
              <div className="text-[13px] text-ink-3 truncate">
                {m.txn_no} · {m.user_name} · {formatDateTime(m.occurred_at)}{m.notes ? ` · ${m.notes}` : ''}
              </div>
              {m.lot_breakdown && m.lot_breakdown.length > 0 && (
                <div className="flex gap-1 flex-wrap mt-1">
                  {m.lot_breakdown.map((b, k) => (
                    <span key={k} className={`badge ${b.status === 'FULL_SLEEVE' ? 'badge-ok' : 'badge-warn'}`}>
                      {b.status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs'} {b.qty}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className="font-medium">{tag} {m.quantity} {m.unit_code}</div>
              <div className={`text-[13px] ${sync === 'Awaiting production' ? 'text-warn font-semibold' : 'text-ink-3'}`}>{sync}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

/** Opens WhatsApp with the saved order message (or one rebuilt from the order). */
export function openWhatsApp(order: ProductionOrder, fallbackNumber: string) {
  const num = (order.whatsapp_number ?? fallbackNumber).replace(/\D/g, '');
  const text = order.whatsapp_message ?? buildMessage({
    order_no: order.order_no,
    direct: order.is_direct,
    customer_name: order.customer_name ?? '',
    items: (order.items ?? []).map((i) => ({
      display_name: i.display_name,
      quantity: String(i.quantity),
      unit_code: i.unit_code,
      pieces: i.pieces ? String(i.pieces) : undefined,
      mm: i.length_mm ? String(i.length_mm) : undefined,
    })),
    time_tag: order.time_tag ?? '',
    delivery_mode: order.delivery_mode ?? '',
    delivery_note: order.delivery_note ?? '',
    assigned_to: order.assigned_to ?? '',
    notes: order.notes ?? '',
  });
  window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank');
}
