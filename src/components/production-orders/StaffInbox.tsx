'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle, Clock, MailOpen, Printer, Search, X } from 'lucide-react';
import type { ProductionOrder } from '@/lib/types';
import { fmtLineQty, fmtQty, fmtRelative } from '@/lib/format';
import { makeMatcher } from '@/lib/search';
import { STATUS_BADGE, STATUS_LABEL, STATUS_NEXT, STATUS_NEXT_LABEL, formatDateTime } from './poShared';
import type { AllocBadge } from './OrderCard';

/**
 * The workshop's view of production orders: an inbox.
 * New orders arrive in bold with a dot and stay that way — for that person only — until opened.
 * Opening an order shows everything the workshop needs and two buttons: In Progress, Completed.
 */
export default function StaffInbox({
  orders, unread, allocs, canAdvance, onOpen, onMarkUnread, onAdvance, onPrint,
}: {
  orders: ProductionOrder[];
  /** ids of orders this person has not opened yet */
  unread: Set<string>;
  allocs: Record<string, AllocBadge[]>;
  /** false = view only: the In Progress / Completed buttons are hidden */
  canAdvance: boolean;
  onOpen: (o: ProductionOrder) => void;
  onMarkUnread: (o: ProductionOrder) => void;
  onAdvance: (o: ProductionOrder) => void;
  onPrint: (o: ProductionOrder) => void;
}) {
  const [folder, setFolder] = useState<'inbox' | 'done'>('inbox');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Direct (drop-ship) orders are for the office, not the workshop.
  const mine = useMemo(() => orders.filter((o) => !o.is_direct), [orders]);
  const inbox = useMemo(() => mine.filter((o) => o.status === 'CREATED' || o.status === 'IN_PROGRESS'), [mine]);
  const done = useMemo(() => mine.filter((o) => o.status === 'COMPLETED').slice(0, 50), [mine]);
  const unreadCount = inbox.filter((o) => unread.has(o.id)).length;

  const match = makeMatcher(query);
  const list = (folder === 'inbox' ? inbox : done).filter((o) =>
    match([o.order_no, o.customer_name, o.assigned_to, o.notes, o.time_tag, o.delivery_mode,
      ...(o.items ?? []).map((i) => i.display_name)]));

  const selected = mine.find((o) => o.id === selectedId) ?? null;

  function open(o: ProductionOrder) {
    setSelectedId(o.id);
    if (unread.has(o.id)) onOpen(o);
  }

  return (
    <div className="card overflow-hidden">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line">
        <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
          {([['inbox', `Inbox${unreadCount ? ` · ${unreadCount} new` : ''}`], ['done', 'Completed']] as const).map(([k, label]) => (
            <button
              key={k} type="button" onClick={() => setFolder(k)}
              className={`px-3 py-1 rounded-md text-[14px] font-medium transition-colors ${
                folder === k ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
              }`}
            >{label}</button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            className="field pl-8 pr-7 text-[15px]" placeholder="Search customer, order no or product"
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink">
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(320px,430px)_1fr]">
        {/* list */}
        <ul className={`divide-y divide-line max-h-[70vh] overflow-y-auto lg:border-r border-line ${selected ? 'hidden lg:block' : ''}`}>
          {list.length === 0 && (
            <li className="px-5 py-10 text-center text-[15px] text-ink-3">
              {query ? 'Nothing matches your search.' : folder === 'inbox' ? 'No active orders. New orders appear here.' : 'No completed orders yet.'}
            </li>
          )}
          {list.map((o) => {
            const isUnread = unread.has(o.id);
            const summary = (o.items ?? []).map((i) => `${i.display_name} — ${fmtLineQty(i)}`).join(' · ');
            return (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => open(o)}
                  className={`w-full text-left px-4 py-3 flex gap-3 transition-colors ${
                    o.id === selectedId ? 'bg-brand-soft' : 'hover:bg-subtle'
                  }`}
                >
                  <span className="pt-1.5 w-2.5 shrink-0">
                    {isUnread && <span className="block w-2.5 h-2.5 rounded-full bg-brand" aria-label="Unread" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`truncate text-[15px] ${isUnread ? 'font-bold text-ink' : 'font-medium text-ink-2'}`}>
                        {o.customer_name || 'No customer'}
                      </span>
                      <span className={`shrink-0 text-[12px] ${isUnread ? 'font-semibold text-brand' : 'text-ink-3'}`}>
                        {fmtRelative(o.created_at)}
                      </span>
                    </span>
                    <span className={`block truncate text-[14px] ${isUnread ? 'font-semibold text-ink' : 'text-ink-3'}`}>
                      <span className="font-mono text-[13px] mr-1.5">{o.order_no}</span>{summary}
                    </span>
                    <span className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className={`badge ${STATUS_BADGE[o.status]}`}>{STATUS_LABEL[o.status]}</span>
                      {o.time_tag && <span className="text-[12px] text-ink-3">⏱ {o.time_tag}</span>}
                      {o.delivery_mode && <span className="text-[12px] text-ink-3">· {o.delivery_mode}</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* reading pane */}
        <div className={`p-5 min-h-[260px] ${selected ? '' : 'hidden lg:block'}`}>
          {!selected ? (
            <p className="text-[15px] text-ink-3 text-center pt-12">Select an order to read it.</p>
          ) : (
            <div className="space-y-4">
              <button type="button" className="lg:hidden btn btn-ghost btn-sm -ml-2" onClick={() => setSelectedId(null)}>
                <ArrowLeft size={14} /> Back to inbox
              </button>

              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[14px] text-ink-3">{selected.order_no}</span>
                  <span className={`badge ${STATUS_BADGE[selected.status]}`}>{STATUS_LABEL[selected.status]}</span>
                  <span className="text-[13px] text-ink-3">🕐 {formatDateTime(selected.created_at)}</span>
                </div>
                <h2 className="text-[20px] font-semibold mt-1">{selected.customer_name || 'No customer name'}</h2>
              </div>

              <ul className="rounded-lg border border-line divide-y divide-line">
                {(selected.items ?? []).map((item, idx) => (
                  <li key={item.id} className="px-3 py-2.5 flex items-start gap-3">
                    <span className="font-mono text-[13px] text-ink-3 w-4 pt-0.5">{idx + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[16px] font-semibold">{item.display_name}</p>
                      <p className="text-[15px] text-ink-2 num">{fmtLineQty(item)}</p>
                      {(allocs[item.id] ?? []).length > 0 && (
                        <span className="flex gap-1 flex-wrap mt-1">
                          {allocs[item.id].map((p, k) => (
                            <span key={k} className={`badge ${p.label === 'Full Sleeve' ? 'badge-ok' : 'badge-warn'}`}>
                              {p.label} {fmtQty(p.qty, item.unit_code === 'RIB' ? 'RIB' : 'MM')}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>

              <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-[15px]">
                {selected.time_tag && <div><dt className="eyebrow">Time needed</dt><dd>{selected.time_tag}</dd></div>}
                {selected.delivery_mode && (
                  <div><dt className="eyebrow">Delivery</dt>
                    <dd>{selected.delivery_mode}{selected.delivery_note ? ` (${selected.delivery_note})` : ''}</dd></div>
                )}
                {selected.assigned_to && <div><dt className="eyebrow">Assigned to</dt><dd>{selected.assigned_to}</dd></div>}
                {selected.notes && <div className="sm:col-span-2"><dt className="eyebrow">Notes</dt><dd className="whitespace-pre-wrap">{selected.notes}</dd></div>}
              </dl>

              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line">
                {canAdvance && STATUS_NEXT[selected.status] && (
                  <button className="btn btn-primary" onClick={() => onAdvance(selected)}>
                    {selected.status === 'IN_PROGRESS' ? <CheckCircle size={14} /> : <Clock size={14} />}
                    {STATUS_NEXT_LABEL[selected.status]}
                  </button>
                )}
                <button className="btn btn-secondary" onClick={() => onPrint(selected)}>
                  <Printer size={14} /> Print
                </button>
                <button className="btn btn-ghost" onClick={() => { onMarkUnread(selected); setSelectedId(null); }}>
                  <MailOpen size={14} /> Mark as unread
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
