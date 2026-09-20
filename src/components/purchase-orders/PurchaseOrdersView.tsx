'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Plus, X, Search, Check, Package,
  ChevronRight, Loader2, ArrowDownLeft, ClipboardCheck, Trash2,
} from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { fmtQty, fmtDate } from '@/lib/format';
import type { ProductType, Sku } from '@/lib/types';

type ItemStatus  = 'PENDING' | 'PARTIAL' | 'FULFILLED';
type OrderStatus = 'PLACED'  | 'PARTIAL' | 'FULFILLED';

interface OrderItem {
  id: string;
  order_id: string;
  sku_id: string;
  ordered_qty: number;
  received_qty: number;
  status: ItemStatus;
  notes: string | null;
  created_at: string;
  skus: {
    sku_code: string; exact_size: string; brand_name: string;
    unit_code: string; current_stock: number; product_type: string;
  } | null;
}

interface Order {
  id: string;
  order_no: string;
  supplier_name: string | null;
  notes: string | null;
  status: OrderStatus;
  created_at: string;
  items: OrderItem[];
}

const TYPE_LABEL: Record<string, string> = { TIMING_BELT: 'Timing Belt', V_BELT: 'V-Belt' };

function StatusBadge({ status }: { status: OrderStatus | ItemStatus }) {
  const map: Record<string, string> = {
    PLACED:    'bg-brand-soft text-brand',
    PENDING:   'bg-surface-2 text-ink-3 border border-line',
    PARTIAL:   'bg-warn-soft text-warn',
    FULFILLED: 'bg-ok-soft text-ok',
  };
  const label: Record<string, string> = {
    PLACED: 'Placed', PENDING: 'Pending', PARTIAL: 'Partial', FULFILLED: 'Fulfilled',
  };
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${map[status] ?? ''}`}>
      {label[status] ?? status}
    </span>
  );
}

/* ── SKU Picker ───────────────────────────────────────────────────────────── */
function SkuPicker({ onSelect, selected }: { onSelect: (s: Sku) => void; selected: string[] }) {
  const { skus } = useCatalog();
  const [type, setType] = useState<ProductType>('TIMING_BELT');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const pool = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skus
      .filter((s) => s.product_type === type && s.is_active)
      .filter((s) =>
        !q ||
        s.exact_size.toLowerCase().includes(q) ||
        s.brand_name.toLowerCase().includes(q) ||
        s.sku_code.toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [skus, type, search]);

  return (
    <div className="space-y-2">
      <div className="flex gap-1 p-0.5 bg-subtle rounded-md">
        {(['TIMING_BELT', 'V_BELT'] as ProductType[]).map((t) => (
          <button
            key={t} type="button"
            onClick={() => { setType(t); setSearch(''); }}
            className={`flex-1 py-1 text-[12px] rounded font-medium transition-colors ${
              type === t ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
            }`}
          >
            {t === 'TIMING_BELT' ? 'Timing Belt' : 'V-Belt'}
          </button>
        ))}
      </div>
      <div ref={ref} className="relative">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            ref={inputRef}
            className="field pl-8 text-[13px]"
            placeholder="Search size, brand or SKU…"
            value={search}
            autoComplete="off"
            onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
          />
        </div>
        {open && (
          <div className="absolute z-20 mt-1 w-full bg-surface border border-line rounded-lg shadow-lg max-h-64 overflow-y-auto">
            {pool.length === 0 ? (
              <p className="px-3 py-4 text-[12px] text-ink-3 text-center">No matches</p>
            ) : (
              pool.map((s) => {
                const already = selected.includes(s.id);
                return (
                  <button
                    key={s.id} type="button"
                    disabled={already}
                    className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 border-b border-line last:border-0 ${
                      already ? 'opacity-40 cursor-not-allowed bg-subtle' : 'hover:bg-subtle'
                    }`}
                    onMouseDown={() => { if (!already) { onSelect(s); setSearch(''); setOpen(false); } }}
                  >
                    <span>
                      <span className="text-[13px] font-medium">{s.exact_size}</span>
                      <span className="text-[11px] text-ink-3 ml-1.5">{s.brand_name}</span>
                      <span className="text-[10px] text-ink-3 ml-1.5">· {TYPE_LABEL[s.product_type]}</span>
                    </span>
                    <span className={`text-[12px] num shrink-0 ${
                      s.stock_status === 'OUT_OF_STOCK' ? 'text-danger' :
                      s.stock_status === 'LOW_STOCK'    ? 'text-warn'   : 'text-ink-3'
                    }`}>
                      {fmtQty(s.current_stock, s.unit_code)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Receive Dialog ───────────────────────────────────────────────────────── */
function ReceiveDialog({
  item, onClose, onDone,
}: { item: OrderItem; onClose: () => void; onDone: () => void }) {
  const remaining = item.ordered_qty - item.received_qty;
  const [qty, setQty]     = useState(String(remaining));
  const [notes, setNotes] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(qty);
    if (!n || n <= 0)        { setErr('Enter a valid quantity.'); return; }
    if (n > remaining)       { setErr(`Maximum receivable is ${remaining}.`); return; }
    setBusy(true); setErr(null);
    const res  = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'receive', item_id: item.id, qty_received: n, notes: notes || null }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(json.error ?? 'Something went wrong.'); return; }
    onDone();
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/30 backdrop-blur-[2px] p-4">
      <form onSubmit={submit} className="w-full max-w-[420px] bg-surface border border-line rounded-xl shadow-xl">
        <div className="card-head border-b">
          <h2 className="card-title">Receive Stock</h2>
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-subtle rounded-lg px-3.5 py-2.5 space-y-0.5">
            <p className="text-[13px] font-medium">{item.skus?.exact_size}</p>
            <p className="text-[11px] text-ink-3">{item.skus?.brand_name} · {TYPE_LABEL[item.skus?.product_type ?? ''] ?? ''}</p>
            <div className="flex gap-4 mt-1.5">
              <span className="text-[11px] text-ink-3">Ordered: <strong className="text-ink">{fmtQty(item.ordered_qty, item.skus?.unit_code)}</strong></span>
              <span className="text-[11px] text-ink-3">Received: <strong className="text-ok">{fmtQty(item.received_qty, item.skus?.unit_code)}</strong></span>
              <span className="text-[11px] text-ink-3">Left: <strong className="text-warn">{fmtQty(remaining, item.skus?.unit_code)}</strong></span>
            </div>
          </div>
          <div>
            <label className="label">Quantity receiving ({item.skus?.unit_code}) <span className="text-danger">*</span></label>
            <input
              className="field num text-[16px] h-11"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Notes <span className="text-ink-3 font-normal">(optional)</span></label>
            <textarea rows={2} className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. partial shipment, damaged items" />
          </div>
          {err && <p className="text-[12px] text-danger bg-danger-soft rounded-lg px-3 py-2">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-line bg-subtle rounded-b-xl">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <><Check size={14} /> Confirm receipt</>}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ── Create Order Dialog ──────────────────────────────────────────────────── */
function CreateOrderDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [supplier, setSupplier] = useState('');
  const [notes, setNotes]       = useState('');
  const [lines, setLines]       = useState<{ sku: Sku; qty: string }[]>([]);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  const addSku    = (s: Sku) => setLines((prev) => [...prev, { sku: s, qty: '' }]);
  const removeLine = (i: number) => setLines((prev) => prev.filter((_, j) => j !== i));
  const setQty     = (i: number, v: string) =>
    setLines((prev) => prev.map((l, j) => j === i ? { ...l, qty: v.replace(/[^0-9.]/g, '') } : l));

  const invalid = lines.length === 0 || lines.some((l) => !l.qty || Number(l.qty) <= 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    setBusy(true); setErr(null);
    const res = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:   'create',
        supplier: supplier || null,
        notes:    notes    || null,
        items:    lines.map((l) => ({ sku_id: l.sku.id, qty: Number(l.qty) })),
      }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(json.error ?? 'Something went wrong.'); return; }
    onDone();
  };

  const selectedIds = lines.map((l) => l.sku.id);

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-ink/30 backdrop-blur-[2px] p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-[700px] bg-surface border border-line rounded-xl shadow-xl max-h-[92vh] flex flex-col"
      >
        <div className="card-head border-b shrink-0">
          <h2 className="card-title">New Purchase Order</h2>
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" onClick={onClose}><X size={15} /></button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Supplier</label>
              <input className="field" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <label className="label">Notes</label>
              <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
            </div>
          </div>

          <div>
            <label className="label mb-2">Add products</label>
            <SkuPicker onSelect={addSku} selected={selectedIds} />
          </div>

          {lines.length > 0 && (
            <div className="rounded-lg border border-line overflow-hidden">
              <div className="px-3 py-2 bg-subtle border-b border-line">
                <span className="text-[11px] font-semibold text-ink-2 uppercase tracking-wide">
                  Order items — {lines.length} product{lines.length !== 1 ? 's' : ''}
                </span>
              </div>
              {lines.map((l, i) => (
                <div key={l.sku.id} className="flex items-center gap-4 px-4 py-3 border-b border-line last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium truncate">{l.sku.exact_size}</p>
                    <p className="text-[11px] text-ink-3">
                      {l.sku.brand_name}
                      <span className="mx-1.5">·</span>
                      <span className="text-brand">{TYPE_LABEL[l.sku.product_type]}</span>
                      <span className="mx-1.5">·</span>
                      in stock: {fmtQty(l.sku.current_stock, l.sku.unit_code)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      className="field num h-9 w-28 text-[13px]"
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => setQty(i, e.target.value)}
                      placeholder={`qty (${l.sku.unit_code})`}
                    />
                    <button type="button" onClick={() => removeLine(i)} className="text-ink-3 hover:text-danger p-1">
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {err && <p className="text-[12px] text-danger bg-danger-soft rounded-lg px-3 py-2.5">{err}</p>}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-line bg-subtle rounded-b-xl shrink-0">
          <p className="text-[12px] text-ink-3">
            {lines.length === 0 ? 'Search and add products above' : `${lines.length} item${lines.length !== 1 ? 's' : ''} · each treated as a separate line`}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || invalid}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <><Check size={14} /> Place Order</>}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

/* ── Delete confirm dialog ────────────────────────────────────────────────── */
function DeleteDialog({
  order, onClose, onDone,
}: { order: Order; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    const res  = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', order_id: order.id }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(json.error ?? 'Delete failed.'); return; }
    onDone();
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/30 backdrop-blur-[2px] p-4">
      <div className="w-full max-w-[400px] bg-surface border border-line rounded-xl shadow-xl">
        <div className="card-head border-b">
          <h2 className="card-title text-danger">Delete Order</h2>
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="p-5">
          <p className="text-[13px] text-ink-2">
            Delete <strong>{order.order_no}</strong>? This will permanently remove the order and all its line items. This cannot be undone.
          </p>
          {err && <p className="text-[12px] text-danger mt-3 bg-danger-soft rounded px-3 py-2">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-line bg-subtle rounded-b-xl">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn bg-danger text-white hover:bg-danger/90"
            disabled={busy}
            onClick={confirm}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <><Trash2 size={14} /> Delete</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Order Card ───────────────────────────────────────────────────────────── */
function OrderCard({
  order, onReceive, onRecordInward, onDelete,
}: {
  order: Order;
  onReceive: (item: OrderItem) => void;
  onRecordInward: (order: Order) => void;
  onDelete: (order: Order) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const allFulfilled = order.items.length > 0 && order.items.every((i) => i.status === 'FULFILLED');

  return (
    <div className="border border-line rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-surface">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
        >
          <ChevronRight
            size={14}
            className={`text-ink-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold">{order.order_no}</span>
              {order.supplier_name && (
                <span className="text-[12px] text-ink-3">· {order.supplier_name}</span>
              )}
              <StatusBadge status={order.status} />
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-[11px] text-ink-3">{fmtDate(order.created_at)}</span>
              <span className="text-[11px] text-ink-3">
                {order.items.length} item{order.items.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {allFulfilled && (
            <button
              type="button"
              className="btn btn-primary h-7 px-2.5 text-[12px]"
              onClick={() => onRecordInward(order)}
            >
              <ArrowDownLeft size={12} /> Record Inward
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost h-7 w-7 p-0 text-ink-3 hover:text-danger"
            onClick={() => onDelete(order)}
            title="Delete order"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Items */}
      {expanded && (
        <div className="border-t border-line divide-y divide-line">
          {order.items.length === 0 ? (
            <p className="px-4 py-4 text-[12px] text-ink-3 text-center">No items — order may still be loading.</p>
          ) : (
            order.items.map((item) => {
              const itemRemaining = item.ordered_qty - item.received_qty;
              return (
                <div key={item.id} className="flex items-center gap-3 px-4 py-3 bg-surface-2/40">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium">{item.skus?.exact_size ?? '—'}</span>
                      <span className="text-[11px] text-ink-3">{item.skus?.brand_name}</span>
                      {item.skus?.product_type && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-subtle text-ink-3 font-medium">
                          {TYPE_LABEL[item.skus.product_type]}
                        </span>
                      )}
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="flex items-center gap-4 mt-1.5">
                      <span className="text-[11px] text-ink-3 num">
                        Ordered <strong className="text-ink">{fmtQty(item.ordered_qty, item.skus?.unit_code)}</strong>
                      </span>
                      <span className="text-[11px] text-ink-3 num">
                        Received <strong className="text-ok">{fmtQty(item.received_qty, item.skus?.unit_code)}</strong>
                      </span>
                      {itemRemaining > 0 && (
                        <span className="text-[11px] text-warn num font-medium">
                          {fmtQty(itemRemaining, item.skus?.unit_code)} left
                        </span>
                      )}
                    </div>
                  </div>
                  {item.status !== 'FULFILLED' ? (
                    <button
                      type="button"
                      className="btn btn-secondary h-8 px-3 text-[12px] shrink-0"
                      onClick={() => onReceive(item)}
                    >
                      <ArrowDownLeft size={12} /> Receive
                    </button>
                  ) : (
                    <span className="text-[11px] text-ok font-medium shrink-0 flex items-center gap-1">
                      <Check size={12} /> Done
                    </span>
                  )}
                </div>
              );
            })
          )}

          {allFulfilled && (
            <div className="px-4 py-3 bg-ok-soft/20 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-ok">
                <ClipboardCheck size={14} />
                <span className="text-[12px] font-medium">
                  All items received — press &quot;Record Inward&quot; to update stock
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
export default function PurchaseOrdersView() {
  const [orders, setOrders]         = useState<Order[]>([]);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState<'in_progress' | 'fulfilled'>('in_progress');
  const [showCreate, setShowCreate] = useState(false);
  const [receiveItem, setReceiveItem]   = useState<OrderItem | null>(null);
  const [recordTarget, setRecordTarget] = useState<Order | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Order | null>(null);
  const [recording, setRecording]       = useState(false);
  const [toast, setToast]               = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch('/api/purchase-orders');
      const json = await res.json();
      if (!res.ok) { setLoading(false); return; }

      const itemMap = new Map<string, OrderItem[]>();
      for (const item of (json.items ?? []) as OrderItem[]) {
        if (!itemMap.has(item.order_id)) itemMap.set(item.order_id, []);
        itemMap.get(item.order_id)!.push(item);
      }
      const hydrated: Order[] = (json.orders ?? []).map((o: Order) => ({
        ...o,
        items: itemMap.get(o.id) ?? [],
      }));
      setOrders(hydrated);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRecordInward = async (order: Order) => {
    setRecording(true);
    const res  = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'record_inward', order_id: order.id }),
    });
    const json = await res.json();
    setRecording(false);
    setRecordTarget(null);
    if (!res.ok) { showToast(`Error: ${json.error}`); return; }
    showToast(`Recorded ${json.recorded} inward transaction${json.recorded !== 1 ? 's' : ''}.`);
    load();
  };

  const inProgress = orders.filter((o) => o.status !== 'FULFILLED');
  const fulfilled  = orders.filter((o) => o.status === 'FULFILLED');
  const displayed  = tab === 'in_progress' ? inProgress : fulfilled;

  return (
    <div className="p-4 lg:p-6 max-w-[960px] mx-auto space-y-4">
      {toast && (
        <div className="fixed bottom-4 right-4 z-[100] bg-ink text-white text-[13px] px-4 py-2.5 rounded-lg shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold">Purchase Orders</h1>
          <p className="text-[13px] text-ink-3 mt-0.5">Track ordered stock and receive against items</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> New Order
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-subtle rounded-lg w-fit">
        {([
          { key: 'in_progress', label: 'In Progress', count: inProgress.length, warn: true },
          { key: 'fulfilled',   label: 'Fulfilled',   count: fulfilled.length,  warn: false },
        ] as const).map(({ key, label, count, warn }) => (
          <button
            key={key} type="button"
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md font-medium transition-colors ${
              tab === key ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                warn ? 'bg-warn-soft text-warn' : 'bg-subtle text-ink-3'
              }`}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="card h-24 skeleton" />)}
        </div>
      ) : displayed.length === 0 ? (
        <div className="card px-5 py-12 text-center">
          <Package size={32} className="text-ink-3 mx-auto mb-3" />
          <p className="text-[14px] text-ink-2 font-medium">
            {tab === 'in_progress' ? 'No orders in progress' : 'No fulfilled orders yet'}
          </p>
          {tab === 'in_progress' && (
            <p className="text-[13px] text-ink-3 mt-1">Create a purchase order to start tracking received stock.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {displayed.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              onReceive={(item) => setReceiveItem(item)}
              onRecordInward={(order) => setRecordTarget(order)}
              onDelete={(order) => setDeleteTarget(order)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateOrderDialog
          onClose={() => setShowCreate(false)}
          onDone={() => { setShowCreate(false); load(); showToast('Order placed.'); }}
        />
      )}

      {receiveItem && (
        <ReceiveDialog
          item={receiveItem}
          onClose={() => setReceiveItem(null)}
          onDone={() => { setReceiveItem(null); load(); showToast('Stock received.'); }}
        />
      )}

      {deleteTarget && (
        <DeleteDialog
          order={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={() => { setDeleteTarget(null); load(); showToast(`${deleteTarget.order_no} deleted.`); }}
        />
      )}

      {/* Record inward confirm */}
      {recordTarget && (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/30 backdrop-blur-[2px] p-4">
          <div className="w-full max-w-[440px] bg-surface border border-line rounded-xl shadow-xl">
            <div className="card-head border-b">
              <h2 className="card-title">Record as Inward?</h2>
              <button type="button" className="btn btn-ghost h-7 w-7 p-0" onClick={() => setRecordTarget(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[13px] text-ink-2">
                This will create inward stock movements for all <strong>{recordTarget.items.length}</strong> item{recordTarget.items.length !== 1 ? 's' : ''} in <strong>{recordTarget.order_no}</strong>. Stock levels will update immediately and appear in Transactions.
              </p>
              <div className="bg-subtle rounded-lg p-3 space-y-2">
                {recordTarget.items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between text-[12px] gap-2">
                    <div className="min-w-0">
                      <span className="font-medium">{item.skus?.exact_size}</span>
                      <span className="text-ink-3 ml-1.5">{item.skus?.brand_name}</span>
                    </div>
                    <span className="num font-semibold text-ok shrink-0">
                      +{fmtQty(item.received_qty, item.skus?.unit_code)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-line bg-subtle rounded-b-xl">
              <button type="button" className="btn btn-secondary" onClick={() => setRecordTarget(null)}>Cancel</button>
              <button
                type="button" className="btn btn-primary" disabled={recording}
                onClick={() => handleRecordInward(recordTarget)}
              >
                {recording
                  ? <Loader2 size={14} className="animate-spin" />
                  : <><ArrowDownLeft size={14} /> Confirm &amp; Record</>
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
