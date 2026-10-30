'use client';

import { Send, CheckCircle, Clock, Ban, Trash2, Printer, FileDown, ArrowDownCircle } from 'lucide-react';
import type { ProductionOrder } from '@/lib/types';
import { fmtQty } from '@/lib/format';
import type { AllocPart } from '@/lib/orderParts';
import { STATUS_BADGE, STATUS_LABEL, STATUS_NEXT, STATUS_NEXT_LABEL, formatDateTime, ItemBlock } from './poShared';


/**
 * One production order as a card: what was asked, who has it, and the buttons that move it on.
 * Used by the Active and Direct tabs of "Production Order in Progress".
 */
export default function OrderCard({
  order, allocs, canManage,
  onAdvance, onCancel, onDelete, onWhatsApp, onPrint, onPdf, onMarkDirect, onOpenMismatch,
}: {
  order: ProductionOrder;
  /** the rolls each item is taken FROM, per item id */
  allocs: Record<string, AllocPart[]>;
  /** may cancel / delete */
  canManage: boolean;
  onAdvance: (o: ProductionOrder) => void;
  onCancel: (o: ProductionOrder) => void;
  onDelete: (o: ProductionOrder) => void;
  onWhatsApp: (o: ProductionOrder) => void;
  onPrint: (o: ProductionOrder) => void;
  onPdf: (o: ProductionOrder) => void;
  onMarkDirect: (o: ProductionOrder, step: 'INWARD' | 'OUTWARD', done: boolean) => void;
  /** jump to the Mismatch tab (completed orders whose outward is still to be recorded) */
  onOpenMismatch?: () => void;
}) {
  const waiting = !order.is_direct && order.status === 'COMPLETED'
    ? (order.items ?? []).filter((i) => !i.is_fulfilled).length
    : 0;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-mono text-ink-3">{order.order_no}</span>
            <span className={`badge ${STATUS_BADGE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
            {order.is_direct && <span className="badge badge-brand">Direct</span>}
            {order.time_tag && (
              <span className="text-[13px] bg-subtle border border-line rounded-full px-2 py-0.5 text-ink-2">
                ⏱ {order.time_tag}
              </span>
            )}
            {order.created_at && (
              <span className="text-[13px] text-ink-3">🕐 {formatDateTime(order.created_at)}</span>
            )}
            {waiting > 0 && (
              <button
                type="button"
                onClick={onOpenMismatch}
                className="text-[12px] font-semibold px-2 py-0.5 rounded-full bg-warn/15 text-warn hover:bg-warn/25"
                title="Open Mismatch to record the outward"
              >
                Outward not posted · {waiting} item{waiting !== 1 ? 's' : ''}
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 text-[14px] text-ink-3">
            {order.customer_name && (
              <span>Customer: <span className="text-ink">{order.customer_name}</span></span>
            )}
            {order.delivery_mode && (
              <span>
                Delivery: <span className="text-ink">{order.delivery_mode}</span>
                {order.delivery_note ? <span className="text-ink-3"> ({order.delivery_note})</span> : null}
              </span>
            )}
            {order.assigned_to && (
              <span>Assigned: <span className="text-ink font-medium">{order.assigned_to}</span></span>
            )}
          </div>

          {order.items && order.items.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {order.items.map((item, idx) => (
                <li key={item.id} className="flex items-start gap-2">
                  <span className="text-ink-3 font-mono text-[13px] w-4 shrink-0 pt-0.5">{idx + 1}.</span>
                  <ItemBlock
                    name={item.display_name}
                    item={item}
                    parts={allocs[item.id]}
                    badge={item.is_fulfilled ? <span className="text-[12px] bg-ok/10 text-ok px-1.5 rounded-full">Outward posted</span> : undefined}
                  />
                </li>
              ))}
            </ul>
          ) : (
            order.product_description && (
              <p className="text-[15px] font-medium mt-1">{order.product_description}
                {order.quantity != null && (
                  <span className="text-ink-3 font-normal ml-2">— {fmtQty(order.quantity, order.unit_code)}</span>
                )}
              </p>
            )
          )}

          {order.notes && (
            <p className="text-[14px] text-ink-3 mt-1 truncate max-w-[500px]">{order.notes}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button className="btn btn-secondary btn-sm" onClick={() => onWhatsApp(order)} title="Send via WhatsApp">
            <Send size={13} /> WhatsApp
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => onPrint(order)} title="Preview and print on thermal paper">
            <Printer size={13} /> Print
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => onPdf(order)} title="Download as PDF">
            <FileDown size={13} /> PDF
          </button>

          {STATUS_NEXT[order.status] && (
            <button className="btn btn-primary btn-sm" onClick={() => onAdvance(order)}>
              {order.status === 'IN_PROGRESS' ? <CheckCircle size={13} /> : <Clock size={13} />}
              {STATUS_NEXT_LABEL[order.status]}
            </button>
          )}

          {canManage && order.status !== 'COMPLETED' && order.status !== 'CANCELLED' && (
            <button
              className="btn btn-ghost btn-sm text-ink-3 hover:text-warn hover:bg-warn/10"
              onClick={() => onCancel(order)}
              title="Cancel order (restores physical stock)"
            >
              <Ban size={13} />
            </button>
          )}

          {canManage && (
            <button
              className="btn btn-ghost btn-sm text-ink-3 hover:text-danger hover:bg-danger-soft"
              onClick={() => onDelete(order)}
              title="Delete order"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {order.is_direct && (
        <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink-3 mr-1">Post in Inventory:</span>
          {(['INWARD', 'OUTWARD'] as const).map((step) => {
            const at = step === 'INWARD' ? order.direct_inward_at : order.direct_outward_at;
            const by = step === 'INWARD' ? order.direct_inward_by : order.direct_outward_by;
            return (
              <button
                key={step}
                className={`btn btn-sm ${at ? 'btn-secondary' : 'btn-primary'}`}
                onClick={() => onMarkDirect(order, step, !at)}
              >
                {at ? <CheckCircle size={12} /> : <ArrowDownCircle size={12} />}
                {step === 'INWARD' ? 'Inward' : 'Outward'}
                {at ? ` done · ${by ?? ''} · ${formatDateTime(at)}` : ' — mark done'}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
