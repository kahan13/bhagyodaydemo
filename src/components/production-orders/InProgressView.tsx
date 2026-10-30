'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileDown, Loader, Printer, Search, X } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { onDataChanged } from '@/lib/dataSync';
import { makeMatcher } from '@/lib/search';
import type {
  MismatchOrderItem, PendingAdjustment, ProductionOrder, Session, SkuMismatch,
} from '@/lib/types';
import { loadReceiptModel, printReceipt, downloadReceiptPdf, receiptHtml, type ReceiptModel } from '@/lib/order-receipt';
import { invalidateSkuCache } from './skuCache';
import {
  DeleteConfirmModal, RecordOutwardModal, MismatchPane, MovementsPane, STATUS_LABEL,
  openWhatsApp, type MovementRow,
} from './poShared';
import OrderCard from './OrderCard';
import { loadItemParts, type AllocPart } from '@/lib/orderParts';
import StaffInbox from './StaffInbox';

type Tab = 'active' | 'direct' | 'movements' | 'mismatch';
const TABS: Tab[] = ['active', 'direct', 'movements', 'mismatch'];

const ORDER_SELECT = '*, production_order_items(*)';
const toOrders = (rows: unknown[]): ProductionOrder[] =>
  (rows as (ProductionOrder & { production_order_items?: ProductionOrder['items'] })[])
    .map((o) => ({ ...o, items: o.production_order_items ?? [] }));

/**
 * Production Order in Progress — everything that happens AFTER an order is created.
 *
 *   Office (can create orders): four tabs — Active orders · Direct orders · Movements · Mismatch,
 *                               each with its own search bar.
 *   Workshop:                   an inbox of active orders, bold with a dot until opened.
 */
export default function InProgressView({
  session, initialOrders, initialReadIds, defaultWhatsapp, initialTab,
}: {
  session: Session;
  initialOrders: ProductionOrder[];
  /** orders this user has already opened */
  initialReadIds: string[];
  defaultWhatsapp: string;
  initialTab?: string;
}) {
  const db = supabaseBrowser();
  const { refresh: refreshCatalog } = useCatalog();
  // Admin and Accounts work in the office view; a Workshop person always gets the inbox.
  const canManage = session.user.role_code !== 'VIEWER';
  // Marking In Progress / Completed is a separate right (a Workshop person may have it, or only view)
  const canAdvance = session.permissions.includes('production.update') || session.permissions.includes('transactions.create');

  const [orders, setOrders] = useState<ProductionOrder[]>(initialOrders);
  const [readIds, setReadIds] = useState<Set<string>>(new Set(initialReadIds));
  const [tab, setTab] = useState<Tab>(TABS.includes(initialTab as Tab) ? (initialTab as Tab) : 'active');
  const [asWorkshop, setAsWorkshop] = useState(false);
  const [search, setSearch] = useState<Record<Tab, string>>({ active: '', direct: '', movements: '', mismatch: '' });
  const [allocMap, setAllocMap] = useState<Record<string, AllocPart[]>>({});

  const [mismatches, setMismatches] = useState<SkuMismatch[]>([]);
  const [pending, setPending] = useState<PendingAdjustment[]>([]);
  const [loadingMismatches, setLoadingMismatches] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [loadingMovements, setLoadingMovements] = useState(false);

  const [outwardTarget, setOutwardTarget] = useState<MismatchOrderItem | null>(null);
  const [recordingOutward, setRecordingOutward] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProductionOrder | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Active orders tab: which group is on show
  const [orderView, setOrderView] = useState<'pending' | 'completed' | 'cancelled'>('pending');

  // ── Loading ────────────────────────────────────────────────────────────────

  const loadAllocs = useCallback(async (list: ProductionOrder[]) => {
    const ids = list.flatMap((o) => (o.items ?? []).map((i) => i.id));
    if (ids.length === 0) { setAllocMap({}); return; }
    const m = await loadItemParts(db, ids);
    setAllocMap(m);
  }, [db]);

  const fetchMismatches = useCallback(async () => {
    setLoadingMismatches(true);
    // Listed when book and physical differ OR an order is still waiting for its outward —
    // so Record Outward never disappears before it has really been recorded.
    let res = await db.from('v_production_stock_status').select('*')
      .or('is_mismatched.eq.true,open_item_count.gt.0')
      .order('stock_gap', { ascending: false });
    if (res.error) {            // database not yet updated with 032: fall back to the old test
      res = await db.from('v_production_stock_status').select('*').eq('is_mismatched', true)
        .order('stock_gap', { ascending: false });
    }
    if (!res.error && res.data) setMismatches(res.data as unknown as SkuMismatch[]);

    const pend = await db.from('prod_pending_adjustments')
      .select('*, skus(sku_code,display_name,unit_code)')
      .is('resolved_at', null)
      .order('created_at', { ascending: false });
    if (!pend.error && pend.data) setPending(pend.data as unknown as PendingAdjustment[]);
    setLoadingMismatches(false);
  }, [db]);

  const fetchMovements = useCallback(async () => {
    setLoadingMovements(true);
    const { data } = await db.from('inventory_movements')
      .select('id,txn_no,txn_type,txn_mode,quantity,unit_code,occurred_at,user_name,notes,reference,lot_breakdown,skus(sku_code,display_name)')
      .order('occurred_at', { ascending: false })
      .limit(300);
    setMovements((data ?? []) as unknown as MovementRow[]);
    setLoadingMovements(false);
  }, [db]);

  const reloadOrders = useCallback(async () => {
    const [{ data: fresh }, { data: reads }] = await Promise.all([
      db.from('production_orders').select(ORDER_SELECT).order('created_at', { ascending: false }),
      db.from('production_order_reads').select('order_id'),
    ]);
    if (fresh) { const next = toOrders(fresh); setOrders(next); loadAllocs(next); }
    if (reads) setReadIds(new Set((reads as { order_id: string }[]).map((r) => r.order_id)));
  }, [db, loadAllocs]);

  useEffect(() => { loadAllocs(initialOrders); fetchMismatches(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'movements') fetchMovements(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // live refresh when anything is saved here, on another screen or in another tab
  const syncRef = useRef<() => void>(() => {});
  syncRef.current = () => {
    invalidateSkuCache();
    fetchMismatches();
    if (tab === 'movements') fetchMovements();
    reloadOrders();
  };
  useEffect(() => onDataChanged(() => { syncRef.current(); }), []);

  // keep the address bar on the tab being looked at (so a refresh or a shared link lands here)
  useEffect(() => {
    if (canManage) window.history.replaceState(null, '', `?tab=${tab}`);
  }, [tab, canManage]);

  function afterStockChange() {
    refreshCatalog();
    invalidateSkuCache();
    fetchMismatches();
    if (tab === 'movements') fetchMovements();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function advance(order: ProductionOrder) {
    const next = order.status === 'CREATED' ? 'IN_PROGRESS' : order.status === 'IN_PROGRESS' ? 'COMPLETED' : null;
    if (!next) return;
    const { data, error: err } = await db.rpc('set_production_order_status', { p_order_id: order.id, p_status: next });
    if (err) { window.alert(err.message); return; }
    const row = data as unknown as ProductionOrder;
    setOrders((prev) => prev.map((o) => o.id === order.id ? { ...o, ...row, items: o.items } : o));
    if (next === 'COMPLETED') fetchMismatches();   // its items now wait in Mismatch for the outward
  }

  async function setRead(order: ProductionOrder, read: boolean) {
    setReadIds((prev) => { const n = new Set(prev); if (read) n.add(order.id); else n.delete(order.id); return n; });
    const { error: err } = await db.rpc('mark_production_order_read', { p_order_id: order.id, p_read: read });
    if (err) setReadIds((prev) => { const n = new Set(prev); if (read) n.delete(order.id); else n.add(order.id); return n; });
  }

  async function cancel(order: ProductionOrder) {
    if (!window.confirm(`Cancel order ${order.order_no}? Physical stock for all items will be restored.`)) return;
    const { data } = await db.from('production_orders')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', order.id).select('*').single();
    if (data) {
      setOrders((prev) => prev.map((o) => o.id === order.id ? { ...(data as ProductionOrder), items: o.items } : o));
      afterStockChange();
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await db.from('production_orders').delete().eq('id', deleteTarget.id);
    setDeleting(false);
    if (err) {
      setError(err.message.includes('inventory_movements_source_poi_id_fkey')
        ? `${deleteTarget.order_no} has an outward already posted against it, so it cannot be deleted.`
        : err.message);
      setDeleteTarget(null);
      return;
    }
    setOrders((prev) => prev.filter((o) => o.id !== deleteTarget.id));
    setDeleteTarget(null);
    afterStockChange();
  }

  async function handleRecordOutward(notes: string, invoiceNo: string, operatedBy: string) {
    if (!outwardTarget) return;
    setRecordingOutward(true);
    const { error: err } = await db.rpc('record_production_outward_with_lots', {
      p_poi_id: outwardTarget.poi_id,
      p_notes: notes || null,
      p_channel: 'WEB',
      p_invoice_no: invoiceNo.trim() || null,
      p_operated_by: operatedBy || null,
    });
    setRecordingOutward(false);
    if (err) { window.alert('Error recording outward: ' + err.message); return; }
    setOutwardTarget(null);
    afterStockChange();
    reloadOrders();
  }

  async function handleResolve(p: PendingAdjustment) {
    setResolvingId(p.id);
    const { error: err } = await db.rpc('resolve_prod_adjustment', { p_id: p.id });
    setResolvingId(null);
    if (err) { window.alert(err.message); return; }
    afterStockChange();
  }

  async function markDirect(order: ProductionOrder, step: 'INWARD' | 'OUTWARD', done: boolean) {
    if (!done && !window.confirm(`Un-mark ${step.toLowerCase()} as done for ${order.order_no}?`)) return;
    const { error: err } = await db.rpc('set_direct_step', { p_order_id: order.id, p_step: step, p_done: done });
    if (err) { window.alert(err.message); return; }
    const at = done ? new Date().toISOString() : null;
    const by = done ? session.user.full_name : null;
    setOrders((prev) => prev.map((o) => o.id !== order.id ? o : (
      step === 'INWARD' ? { ...o, direct_inward_at: at, direct_inward_by: by } : { ...o, direct_outward_at: at, direct_outward_by: by }
    )));
  }

  const showReceipt = async (o: ProductionOrder) => setReceipt(await loadReceiptModel(db, o));
  const pdfReceipt = async (o: ProductionOrder) => downloadReceiptPdf(await loadReceiptModel(db, o));

  // ── Derived lists ──────────────────────────────────────────────────────────

  const regular = orders.filter((o) => !o.is_direct);
  const direct = orders.filter((o) => o.is_direct);
  const activeAll = regular.filter((o) => o.status === 'CREATED' || o.status === 'IN_PROGRESS');
  const completedAll = regular.filter((o) => o.status === 'COMPLETED');
  const cancelledAll = regular.filter((o) => o.status === 'CANCELLED');
  const pendingDirect = direct.filter((o) => o.status !== 'CANCELLED' && !(o.direct_inward_at && o.direct_outward_at)).length;
  const awaitingOutward = regular
    .filter((o) => o.status === 'COMPLETED')
    .reduce((n, o) => n + (o.items ?? []).filter((i) => !i.is_fulfilled).length, 0);
  const unread = useMemo(() => new Set(orders.filter((o) => !readIds.has(o.id)).map((o) => o.id)), [orders, readIds]);

  const orderMatch = (q: string) => {
    const m = makeMatcher(q);
    return (o: ProductionOrder) => m([
      o.order_no, o.customer_name, o.assigned_to, o.notes, o.time_tag, o.delivery_mode, STATUS_LABEL[o.status],
      ...(o.items ?? []).flatMap((i) => [i.display_name, i.sku_code]),
    ]);
  };
  const active = activeAll.filter(orderMatch(search.active));
  const completed = completedAll.filter(orderMatch(search.active));
  const cancelled = cancelledAll.filter(orderMatch(search.active));
  const shownOrders = orderView === 'pending' ? active : orderView === 'completed' ? completed : cancelled;
  const orderViews = [
    { key: 'pending' as const,   label: 'Pending',   count: activeAll.length },
    { key: 'completed' as const, label: 'Completed', count: completedAll.length },
    { key: 'cancelled' as const, label: 'Cancelled', count: cancelledAll.length },
  ];
  const emptyText = search.active
    ? `No ${orderViews.find((v) => v.key === orderView)!.label.toLowerCase()} order matches your search.`
    : orderView === 'pending'   ? 'No pending production orders. Create one from Production Order.'
    : orderView === 'completed' ? 'No completed production orders yet.'
    :                             'No cancelled production orders.';
  const directShown = direct.filter(orderMatch(search.direct));

  const moveMatch = makeMatcher(search.movements);
  const movementsShown = movements.filter((m) =>
    moveMatch([m.txn_no, m.txn_type, m.skus?.sku_code, m.skus?.display_name, m.user_name, m.notes, m.reference]));

  const misMatch = makeMatcher(search.mismatch);
  const mismatchShown = mismatches.filter((m) =>
    misMatch([m.sku_code, m.display_name, ...(m.open_order_items ?? []).flatMap((i) => [i.order_no, i.customer_name])]));
  const pendingShown = pending.filter((p) =>
    misMatch([p.skus?.sku_code, p.skus?.display_name, p.reason, p.lot_no]));

  // ── Render ─────────────────────────────────────────────────────────────────

  const modals = (
    <>
      {deleteTarget && (
        <DeleteConfirmModal orderNo={deleteTarget.order_no} onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)} deleting={deleting} />
      )}
      {outwardTarget && (
        <RecordOutwardModal item={outwardTarget} onConfirm={handleRecordOutward}
          onCancel={() => setOutwardTarget(null)} recording={recordingOutward} />
      )}
      {receipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setReceipt(null)}>
          <div className="bg-surface rounded-xl border border-line shadow-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-line">
              <p className="text-[16px] font-semibold">Thermal print preview · 80 mm</p>
              <button className="btn btn-ghost h-7 w-7 p-0" onClick={() => setReceipt(null)}><X size={15} /></button>
            </div>
            <div className="overflow-auto bg-subtle p-4">
              <div className="bg-white shadow mx-auto px-3 py-3 w-fit" dangerouslySetInnerHTML={{ __html: receiptHtml(receipt) }} />
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-line">
              <button className="btn btn-secondary" onClick={() => downloadReceiptPdf(receipt)}><FileDown size={14} /> PDF</button>
              <button className="btn btn-primary" onClick={() => printReceipt(receipt)}><Printer size={14} /> Print</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  const workshopView = !canManage || asWorkshop;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-[21px] font-semibold">Production Order in Progress</h1>
        <p className="text-[15px] text-ink-3 mt-0.5">
          {activeAll.length} active
          {canManage && awaitingOutward > 0 && <> · <span className="text-warn font-medium">{awaitingOutward} waiting for outward</span></>}
        </p>
      </div>
      {canManage && (
        <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5" title="See the orders the way the workshop sees them">
          {([[false, 'Office view'], [true, 'Workshop inbox']] as const).map(([v, label]) => (
            <button key={label} type="button" onClick={() => setAsWorkshop(v)}
              className={`px-3 py-1 rounded-md text-[14px] font-medium transition-colors ${
                asWorkshop === v ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
              }`}>{label}</button>
          ))}
        </div>
      )}
    </div>
  );

  if (workshopView) {
    return (
      <div className="p-4 lg:p-6 max-w-[1200px] mx-auto space-y-4">
        {modals}
        {header}
        <StaffInbox
          orders={orders} unread={unread} allocs={allocMap}
          onOpen={(o) => setRead(o, true)} onMarkUnread={(o) => setRead(o, false)}
          onAdvance={advance} onPrint={showReceipt} canAdvance={canAdvance}
        />
      </div>
    );
  }

  const tabLabel: Record<Tab, { label: string; count?: number; warn?: boolean }> = {
    active:    { label: 'Active orders', count: activeAll.length },
    direct:    { label: 'Direct orders', count: pendingDirect, warn: true },
    movements: { label: 'Movements' },
    mismatch:  { label: 'Mismatch', count: mismatches.length + pending.length, warn: true },
  };
  const searchPlaceholder: Record<Tab, string> = {
    active:    'Search customer, order no, product or status',
    direct:    'Search customer, order no or product',
    movements: 'Search size, SKU, transaction no, person or note',
    mismatch:  'Search size, SKU or order no',
  };

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto space-y-4">
      {modals}
      {header}

      {error && (
        <p className="text-[15px] text-danger bg-danger-soft rounded-lg px-3 py-2 flex items-start justify-between gap-3">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={14} /></button>
        </p>
      )}

      {/* tabs */}
      <div role="tablist" className="flex gap-1 border-b border-line overflow-x-auto">
        {TABS.map((t) => {
          const { label, count, warn } = tabLabel[t];
          const on = tab === t;
          return (
            <button key={t} role="tab" aria-selected={on} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-[15px] border-b-2 -mb-px whitespace-nowrap transition-colors flex items-center gap-2 ${
                on ? 'border-primary text-primary font-semibold' : 'border-transparent text-ink-2 hover:text-ink'
              }`}>
              {label}
              {count != null && (
                <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${
                  warn && count > 0 ? 'bg-warn/20 text-warn' : 'bg-subtle text-ink-3 border border-line'
                }`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* search — one per tab */}
      <div className="relative max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
        <input
          className="field pl-9 pr-8" data-global-search
          placeholder={searchPlaceholder[tab]}
          value={search[tab]}
          onChange={(e) => setSearch((s) => ({ ...s, [tab]: e.target.value }))}
        />
        {search[tab] && (
          <button type="button" aria-label="Clear search" onClick={() => setSearch((s) => ({ ...s, [tab]: '' }))}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink">
            <X size={14} />
          </button>
        )}
      </div>

      {/* ── Active orders ── */}
      {tab === 'active' && (
        <div className="space-y-3">
          {/* Pending / Completed / Cancelled */}
          <div role="tablist" aria-label="Order group" className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
            {orderViews.map((v) => {
              const on = orderView === v.key;
              return (
                <button key={v.key} type="button" role="tab" aria-selected={on} onClick={() => setOrderView(v.key)}
                  className={`px-4 py-1.5 rounded-md text-[15px] font-medium transition-colors flex items-center gap-2 ${
                    on ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
                  }`}>
                  {v.label}
                  <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${
                    on ? 'bg-primary/10 text-primary' : 'bg-surface text-ink-3 border border-line'
                  }`}>{v.count}</span>
                </button>
              );
            })}
          </div>

          {shownOrders.length === 0 && (
            <div className="card p-10 text-center text-[15px] text-ink-3">{emptyText}</div>
          )}
          {shownOrders.map((o) => (
            <OrderCard key={o.id} order={o} allocs={allocMap} canManage={canManage}
              onAdvance={advance} onCancel={cancel} onDelete={setDeleteTarget}
              onWhatsApp={(x) => openWhatsApp(x, defaultWhatsapp)} onPrint={showReceipt} onPdf={pdfReceipt}
              onMarkDirect={markDirect} onOpenMismatch={() => setTab('mismatch')} />
          ))}
        </div>
      )}

      {/* ── Direct orders ── */}
      {tab === 'direct' && (
        <div className="space-y-3">
          <p className="text-[14px] text-ink-3">
            Supplier ships straight to the customer — remember to post the inward and the outward in Inventory.
          </p>
          {directShown.length === 0 && (
            <div className="card p-10 text-center text-[15px] text-ink-3">
              {search.direct ? 'No direct order matches your search.' : 'No direct orders yet. Choose “Direct order” when creating one.'}
            </div>
          )}
          {directShown.map((o) => (
            <OrderCard key={o.id} order={o} allocs={allocMap} canManage={canManage}
              onAdvance={advance} onCancel={cancel} onDelete={setDeleteTarget}
              onWhatsApp={(x) => openWhatsApp(x, defaultWhatsapp)} onPrint={showReceipt} onPdf={pdfReceipt}
              onMarkDirect={markDirect} />
          ))}
        </div>
      )}

      {/* ── Movements ── */}
      {tab === 'movements' && (
        <section className="rounded-xl border border-line bg-surface overflow-hidden">
          <p className="px-4 py-2.5 text-[14px] text-ink-3 border-b border-line">
            Latest stock movements and whether production stock has caught up.
          </p>
          <MovementsPane rows={movementsShown} loading={loadingMovements}
            pendingMovementIds={new Set(pending.map((p) => p.movement_id))} searching={!!search.movements} />
        </section>
      )}

      {/* ── Mismatch ── */}
      {tab === 'mismatch' && (
        <section className="rounded-xl border border-line bg-surface overflow-hidden">
          <p className="px-4 py-2.5 text-[14px] text-ink-3 border-b border-line">
            Book stock against physical production stock, traced to its cause. An order stays here — even after
            it is completed — until its outward is recorded.
          </p>
          {loadingMismatches && mismatches.length === 0 ? (
            <div className="p-4 flex items-center gap-2 text-[15px] text-ink-3">
              <Loader size={14} className="animate-spin" /> Checking stock status…
            </div>
          ) : (
            <MismatchPane
              mismatches={mismatchShown} pending={pendingShown}
              onRecordOutward={setOutwardTarget} onResolve={handleResolve}
              resolvingId={resolvingId} loadingMismatches={false} searching={!!search.mismatch}
            />
          )}
        </section>
      )}
    </div>
  );
}
