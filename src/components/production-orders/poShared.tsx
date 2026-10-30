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
import Modal from '@/components/ui/Modal';
import { loadItemParts, partLine, partMain, partTotal, fromTag, totalLine, type AllocPart } from '@/lib/orderParts';

export { loadItemParts, partLine, partMain, partTotal, fromTag, totalLine };
export type { AllocPart };

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

/** "from Cut Pcs of 230 mm" as a coloured chip — green for a full sleeve, amber for cut pieces. Never confused with a total. */
export function FromChip({ p, unit }: { p: AllocPart; unit?: string | null }) {
  return (
    <span className={`badge ${p.status === 'FULL_SLEEVE' ? 'badge-ok' : 'badge-warn'} !h-[22px] !text-[12.5px] mt-0.5`}>
      {fromTag(p, unit)}
    </span>
  );
}

// ─── WhatsApp message builder ─────────────────────────────────────────────────

export function buildMessage(fields: {
  order_no?: string;
  direct?: boolean;
  customer_name: string;
  items: Array<{
    display_name: string; quantity: string; unit_code: string; pieces?: string; mm?: string;
    /** roll-tracked lines: the whole line ("250 mm") — only given when it has more than one entry */
    total?: string;
    /** roll-tracked lines: each entry and where it is cut from: { text: "25 mm × 9 pcs (225 mm total)", from: "from Cut Pcs of 230 mm" } */
    parts?: { text: string; from: string }[];
  }>;
  time_tag: string;
  delivery_mode: string;
  delivery_note: string;
  assigned_to: string;
  notes: string;
}) {
  // Entry first, its total small beside it, and under it where it is cut from:
  //   1. H-480 PIX — 250 mm total            (only when the line has several entries)
  //      25 mm × 9 pcs (225 mm total)
  //        from Cut Pcs of 230 mm
  //      25 mm × 1 pcs (25 mm total)
  //        from Full Sleeve of 450 mm
  const itemLines = fields.items
    .filter((i) => i.display_name)
    .flatMap((i, idx) => {
      if (i.parts && i.parts.length > 0) {
        return [
          `  ${idx + 1}. ${i.display_name}${i.total ? ` — ${i.total} total` : ''}`,
          ...i.parts.flatMap((p) => [`     ${p.text}`, `       ➜ *${p.from}*`]),
        ];
      }
      const isMmPcs = i.pieces && i.mm && Number(i.pieces) * Number(i.mm) === Number(i.quantity);
      const qty = isMmPcs
        ? `${fmtMmPcs(i.mm, i.pieces, i.unit_code.toUpperCase() === 'RIB' ? 'ribs' : 'mm')} (${fmtQty(i.quantity, i.unit_code)} total)`
        : i.quantity ? fmtQty(i.quantity, i.unit_code) : '';
      return [`  ${idx + 1}. ${i.display_name}${qty ? ` — ${qty}` : ''}`];
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

/**
 * A production-order line, the same slim way everywhere:
 *   H-480 PIX                         250 mm total   ← only when it has several entries
 *   25 mm × 9 pcs   225 mm total                     ← the entry first; its total small beside it
 *     from Cut Pcs of 230 mm                         ← and where it is cut from
 */
export function ItemBlock({
  name, badge, item, parts, big = false,
}: {
  name: string;
  badge?: React.ReactNode;
  item: { quantity: number | string; unit_code?: string | null; pieces?: number | null; length_mm?: number | null };
  parts?: AllocPart[];
  big?: boolean;
}) {
  const list = parts ?? [];
  const sz = big ? 'text-[15px]' : 'text-[14px]';
  const legacy = Number(item.pieces) > 0 && Number(item.length_mm) > 0 && Number(item.pieces) * Number(item.length_mm) === Number(item.quantity);
  return (
    <div>
      <p className={`${big ? 'text-[16px]' : 'text-[15px]'} font-medium text-ink flex items-baseline gap-x-2 flex-wrap`}>
        <span>{name}</span>
        {list.length > 1 && <span className="text-[12px] font-normal text-ink-3">{totalLine(item)} total</span>}
        {badge}
      </p>
      {list.length > 0 ? (
        <div className="mt-0.5 space-y-1">
          {list.map((p, k) => (
            <div key={k}>
              <p className={`${sz} num text-ink`}>
                {partMain(p, item.unit_code)}
                {partTotal(p, item.unit_code) && <span className="text-[12px] text-ink-3 ml-2">{partTotal(p, item.unit_code)}</span>}
              </p>
              <div><FromChip p={p} unit={item.unit_code} /></div>
            </div>
          ))}
        </div>
      ) : (
        <p className={`${sz} num text-ink mt-0.5`}>
          {legacy ? fmtMmPcs(item.length_mm, item.pieces, (item.unit_code ?? '').toUpperCase() === 'RIB' ? 'ribs' : 'mm') : fmtQty(Number(item.quantity), item.unit_code)}
          {legacy && <span className="text-[12px] text-ink-3 ml-2">{fmtQty(Number(item.quantity), item.unit_code)} total</span>}
        </p>
      )}
    </div>
  );
}

// ─── Modals ───────────────────────────────────────────────────────────────────

export function DeleteConfirmModal({
  orderNo, onConfirm, onCancel, deleting,
}: {
  orderNo: string; onConfirm: () => void; onCancel: () => void; deleting: boolean;
}) {
  return (
    <Modal
      title={`Delete Order ${orderNo}?`}
      icon={<span className="shrink-0 rounded-full bg-danger-soft p-1.5"><AlertTriangle size={16} className="text-danger" /></span>}
      onClose={onCancel}
      z={50}
      width="max-w-sm"
      bodyClassName="p-5"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel} disabled={deleting}>Cancel</button>
          <button
            className="btn bg-danger text-white hover:bg-danger/90 border-danger"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? <Loader size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete
          </button>
        </>
      }
    >
      <p className="text-[15px] text-ink-3">
        This will permanently delete the order and all its items. Physical stock will be restored.
      </p>
    </Modal>
  );
}

export function RecordOutwardModal({
  item,
  onConfirm,
  onCancel,
  recording,
  z = 50,
}: {
  item: MismatchOrderItem;
  onConfirm: (notes: string, invoiceNo: string, operatedBy: string) => void;
  onCancel: () => void;
  recording: boolean;
  /** raise it when it opens on top of another dialog */
  z?: 50 | 60 | 70 | 80 | 90;
}) {
  const [notes, setNotes] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [operatedBy, setOperatedBy] = useState('');
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([]);
  const [parts, setParts] = useState<AllocPart[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabaseBrowser().from('app_users').select('id,full_name').eq('is_active', true).order('full_name');
      if (alive) setUsers((data ?? []) as { id: string; full_name: string }[]);
      const p = await loadItemParts(supabaseBrowser(), [item.poi_id]);
      if (alive) setParts(p[item.poi_id] ?? []);
    })();
    return () => { alive = false; };
  }, [item.poi_id]);
  return (
    <Modal
      title="Record Outward"
      icon={<span className="shrink-0 rounded-full bg-brand/10 p-1.5"><ArrowDownCircle size={16} className="text-brand" /></span>}
      onClose={onCancel}
      z={z}
      width="max-w-sm"
      bodyClassName="p-5 space-y-4"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onCancel} disabled={recording}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => onConfirm(notes, invoiceNo, operatedBy)}
            disabled={recording}
          >
            {recording ? <Loader size={14} className="animate-spin" /> : <CheckSquare size={14} />}
            Confirm Outward
          </button>
        </>
      }
    >
      <p className="text-[15px] text-ink-3">
        Record an OUTWARD inventory entry for{' '}
        <span className="font-medium text-ink">{fmtLineQty(item)}</span>{' '}
        from order <span className="font-mono text-brand">{item.order_no}</span>
        {item.customer_name ? ` (${item.customer_name})` : ''}.
        This will update both book stock and physical stock.
      </p>
      {parts.length > 0 && (
        <div className="rounded-lg border border-line bg-subtle px-3 py-2.5 space-y-1">
          <p className="eyebrow">Will be taken from</p>
          {parts.map((p, k) => (
            <div key={k} className="num">
              <p className="text-[14px]">
                <span className="font-semibold">{partMain(p, item.unit_code)}</span>
                {partTotal(p, item.unit_code) && <span className="text-[12px] text-ink-3 ml-2">{partTotal(p, item.unit_code)}</span>}
              </p>
              <div><FromChip p={p} unit={item.unit_code} /></div>
            </div>
          ))}
        </div>
      )}
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
    </Modal>
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
  // where each waiting item's quantity comes from (rolls), shown under it
  const [parts, setParts] = useState<Record<string, AllocPart[]>>({});
  const itemKey = mismatches.flatMap((m) => m.open_order_items.map((i) => i.poi_id)).join(',');
  useEffect(() => {
    const ids = itemKey ? itemKey.split(',') : [];
    if (ids.length === 0) { setParts({}); return; }
    let alive = true;
    loadItemParts(supabaseBrowser(), ids).then((p) => { if (alive) setParts(p); });
    return () => { alive = false; };
  }, [itemKey]);

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
                    {' · '}{p.source === 'WASTE'
                      ? (p.lot_no ? 'Roll marked as waste' : 'Marked as waste')
                      : 'Stock adjustment'}
                    {p.reason && (p.source !== 'WASTE' || !p.lot_no) ? ` — ${p.reason.replace(/^Marked as waste\s*·\s*/i, '')}` : ''}
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
                        <span className="text-ink ml-2 font-medium">{(parts[oi.poi_id] ?? []).length > 1 ? `${totalLine(oi)} total` : (parts[oi.poi_id]?.length ? '' : fmtLineQty(oi))}</span>
                        <span className={`ml-2 text-[13px] px-1.5 py-0.5 rounded-full ${
                          oi.order_status === 'IN_PROGRESS' ? 'bg-ok/10 text-ok' :
                          oi.order_status === 'COMPLETED'   ? 'bg-brand/10 text-brand' :
                          'bg-warn/10 text-warn'
                        }`}>{oi.order_status === 'COMPLETED' ? 'Completed · outward not posted' : STATUS_LABEL[oi.order_status]}</span>
                        {(parts[oi.poi_id] ?? []).map((p, k) => (
                          <div key={k} className="num mt-1">
                            <p className="text-[14px] text-ink">
                              {partMain(p, oi.unit_code)}
                              {partTotal(p, oi.unit_code) && <span className="text-[12px] text-ink-3 ml-2">{partTotal(p, oi.unit_code)}</span>}
                            </p>
                            <div><FromChip p={p} unit={oi.unit_code} /></div>
                          </div>
                        ))}
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
