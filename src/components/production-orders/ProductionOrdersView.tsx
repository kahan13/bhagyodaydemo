'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import {
  Plus, Send, CheckCircle, Clock, Loader, Pencil, X,
  Search, Trash2, AlertTriangle, AlertCircle, Ban,
  ArrowDownCircle, CheckSquare,
} from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type {
  ProductionOrder,
  ProductionOrderItem,
  ProductionOrderStatus,
  Session,
  Sku,
  SkuMismatch,
  MismatchOrderItem,
  TimeTag,
  DeliveryMode,
} from '@/lib/types';
import LotAllocationPicker, { type LotAllocation } from './LotAllocationPicker';

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ProductionOrderStatus, string> = {
  CREATED:     'Created',
  SENT:        'Sent',
  IN_PROGRESS: 'In Progress',
  COMPLETED:   'Completed',
  CANCELLED:   'Cancelled',
};

const STATUS_BADGE: Record<ProductionOrderStatus, string> = {
  CREATED:     'badge-warn',
  SENT:        'badge-brand',
  IN_PROGRESS: 'badge-ok',
  COMPLETED:   'bg-subtle text-ink-3 px-2 py-0.5 rounded-full text-[11px] font-medium',
  CANCELLED:   'bg-danger-soft text-danger px-2 py-0.5 rounded-full text-[11px] font-medium',
};

const STATUS_NEXT: Partial<Record<ProductionOrderStatus, ProductionOrderStatus>> = {
  CREATED:     'SENT',
  SENT:        'IN_PROGRESS',
  IN_PROGRESS: 'COMPLETED',
};

const STATUS_NEXT_LABEL: Partial<Record<ProductionOrderStatus, string>> = {
  CREATED:     'Mark Sent',
  SENT:        'Mark In Progress',
  IN_PROGRESS: 'Mark Completed',
};

const TIME_TAGS: TimeTag[] = ['15-20 min', '30-40 min', '1 hour', '2 hours'];
const DELIVERY_MODES: DeliveryMode[] = ['Hand', 'Porter', 'Courier', 'Transportation'];

// ─── WhatsApp message builder ─────────────────────────────────────────────────

function buildMessage(fields: {
  customer_name: string;
  items: Array<{ display_name: string; quantity: string; unit_code: string }>;
  time_tag: string;
  delivery_mode: string;
  delivery_note: string;
  assigned_to: string;
  notes: string;
}) {
  const itemLines = fields.items
    .filter((i) => i.display_name)
    .map((i, idx) =>
      `  ${idx + 1}. ${i.display_name}${i.quantity ? ` × ${i.quantity} ${i.unit_code}`.trimEnd() : ''}`
    );

  const lines = [
    `*Production Order*`,
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

// ─── ATP / Physical Stock types ───────────────────────────────────────────────

interface SkuAtp {
  sku_id: string;
  current_stock: number;
  physical_prod_stock: number;
  reserved_qty: number;
  atp_stock: number;
}

type SkuWithAtp = Sku & {
  atp_stock: number;        // = physical_prod_stock (already decremented by open orders)
  reserved_qty: number;
};

// ─── Shared SKU + ATP cache ───────────────────────────────────────────────────

let _skuCache: SkuWithAtp[] | null = null;
let _skuInflight: Promise<SkuWithAtp[]> | null = null;
let _skuVersion = 0;

function fetchSkus(): Promise<SkuWithAtp[]> {
  if (_skuInflight) return _skuInflight;

  const p: Promise<SkuWithAtp[]> = Promise.all([
    supabaseBrowser()
      .from('v_sku_status')
      .select(
        'id,sku_code,display_name,exact_size,brand_name,family_name,unit_code,product_type,' +
        'hier_l1,hier_l2,hier_l3,search_text,brand_code,family_code,profile_group,belt_form,' +
        'construction,standard,pitch_mm,pitch_length_mm,width_mm,teeth,nominal_length,' +
        'length_designation,rack_location,opening_stock,current_stock,min_stock_level,' +
        'supplier_moq,reorder_quantity,supplier_name,is_active,stock_status,shortfall,suggested_purchase_qty'
      )
      .eq('is_active', true)
      .order('product_type')
      .order('hier_l1')
      .order('hier_l2'),
    supabaseBrowser()
      .from('v_sku_atp')
      .select('sku_id,current_stock,physical_prod_stock,reserved_qty,atp_stock'),
  ]).then(([skuRes, atpRes]) => {
    if (atpRes.error) {
      console.error('[ATP] v_sku_atp fetch failed:', atpRes.error.message);
    }
    const skuData = (skuRes.data ?? []) as unknown as Sku[];
    const atpData = (atpRes.data ?? []) as SkuAtp[];

    const atpMap: Record<string, SkuAtp> = {};
    for (const row of atpData) atpMap[row.sku_id] = row;

    _skuCache = skuData.map((s) => ({
      ...s,
      physical_prod_stock: atpMap[s.id]?.physical_prod_stock ?? s.current_stock,
      atp_stock:           atpMap[s.id]?.atp_stock ?? s.current_stock,
      reserved_qty:        atpMap[s.id]?.reserved_qty ?? 0,
    }));
    _skuInflight = null;
    return _skuCache;
  });

  _skuInflight = p;
  return p;
}

function loadSkus(): Promise<SkuWithAtp[]> {
  if (_skuCache) return Promise.resolve(_skuCache);
  return fetchSkus();
}

function invalidateSkuCache() {
  _skuCache = null;
  _skuInflight = null;
  _skuVersion += 1;
}
function getSkuVersion() { return _skuVersion; }

// ─── ATP badge helper ─────────────────────────────────────────────────────────

function AtpBadge({ sku, qty, otherQty = 0 }: { sku: SkuWithAtp; qty: string; otherQty?: number }) {
  const effectiveAtp = sku.atp_stock - otherQty;
  const entered = parseFloat(qty) || 0;
  const afterAlloc = effectiveAtp - entered;

  let colour: string;
  if (effectiveAtp <= 0) colour = 'text-danger font-semibold';
  else if (effectiveAtp < (sku.min_stock_level ?? 0)) colour = 'text-warn font-semibold';
  else colour = 'text-ok';

  return (
    <p className="text-[10px] text-center mt-0.5 leading-tight">
      <span className="text-ink-3">{sku.unit_code}</span>
      {' · '}
      <span
        className={colour}
        title={`Book stock: ${sku.current_stock} | Physical stock: ${sku.atp_stock} | Reserved: ${sku.reserved_qty}`}
      >
        {effectiveAtp} avail
      </span>
      {entered > 0 && (
        <span className={afterAlloc < 0 ? ' text-danger font-semibold' : ' text-ink-3'}>
          {' → '}{afterAlloc < 0 ? '⚠ ' : ''}{afterAlloc}
        </span>
      )}
    </p>
  );
}

// ─── SKU Search Combobox ──────────────────────────────────────────────────────

function SkuCombobox({
  value,
  onChange,
  cacheVersion,
  placeholder = 'Search SKU code, name, size…',
}: {
  value: { sku: SkuWithAtp | null; query: string };
  onChange: (val: { sku: SkuWithAtp | null; query: string }) => void;
  cacheVersion: number;
  placeholder?: string;
}) {
  const [skus, setSkus] = useState<SkuWithAtp[]>(_skuCache ?? []);
  const [loadingSkus, setLoadingSkus] = useState(!_skuCache);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoadingSkus(true);
    loadSkus().then((s) => { setSkus(s); setLoadingSkus(false); });
  }, [cacheVersion]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const q = value.query.toLowerCase();
  const filtered = q.length < 1
    ? skus.slice(0, 40)
    : skus.filter((s) =>
        s.sku_code.toLowerCase().includes(q) ||
        s.display_name.toLowerCase().includes(q) ||
        s.exact_size.toLowerCase().includes(q) ||
        s.brand_name.toLowerCase().includes(q) ||
        (s.search_text ?? '').toLowerCase().includes(q)
      ).slice(0, 40);

  function selectSku(sku: SkuWithAtp) {
    onChange({ sku, query: `${sku.sku_code} – ${sku.display_name}` });
    setOpen(false);
  }

  return (
    <div className="relative">
      <div className="relative flex items-center">
        <Search size={13} className="absolute left-2.5 text-ink-3 pointer-events-none" />
        <input
          ref={inputRef}
          className="field pl-7 pr-7"
          placeholder={loadingSkus ? 'Loading SKUs…' : placeholder}
          value={value.query}
          onChange={(e) => { onChange({ sku: null, query: e.target.value }); setOpen(true); }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
        />
        {value.query && (
          <button
            className="absolute right-2 text-ink-3 hover:text-ink"
            onClick={() => { onChange({ sku: null, query: '' }); inputRef.current?.focus(); setOpen(true); }}
            tabIndex={-1}
            type="button"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {open && filtered.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg max-h-56 overflow-y-auto"
        >
          {filtered.map((sku) => {
            const atpColour =
              sku.atp_stock <= 0
                ? 'text-danger'
                : sku.atp_stock < (sku.min_stock_level ?? 0)
                ? 'text-warn'
                : 'text-ok';
            return (
              <button
                key={sku.id}
                className="w-full text-left px-3 py-2 hover:bg-subtle transition-colors flex items-center justify-between gap-2"
                onClick={() => selectSku(sku)}
                type="button"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">
                    <span className="font-mono text-brand">{sku.sku_code}</span>{' – '}{sku.display_name}
                  </div>
                  <div className="text-[11px] text-ink-3 truncate">{sku.brand_name} · {sku.exact_size}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[11px] text-ink-3">{sku.unit_code}</div>
                  <div className={`text-[11px] font-medium ${atpColour}`}>
                    {sku.atp_stock} avail
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {open && !loadingSkus && filtered.length === 0 && value.query.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg px-3 py-4 text-center text-[12px] text-ink-3"
        >
          No SKUs match &quot;{value.query}&quot;
        </div>
      )}
    </div>
  );
}

// ─── Delete Confirm Modal ─────────────────────────────────────────────────────

function DeleteConfirmModal({
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
            <h3 className="text-[15px] font-semibold">Delete Order {orderNo}?</h3>
            <p className="text-[13px] text-ink-3 mt-1">
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

// ─── Record Outward Confirm Modal ─────────────────────────────────────────────

function RecordOutwardModal({
  item,
  onConfirm,
  onCancel,
  recording,
}: {
  item: MismatchOrderItem;
  onConfirm: (notes: string) => void;
  onCancel: () => void;
  recording: boolean;
}) {
  const [notes, setNotes] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-surface rounded-xl border border-line shadow-xl p-6 max-w-sm w-full space-y-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 rounded-full bg-brand/10 p-2">
            <ArrowDownCircle size={18} className="text-brand" />
          </div>
          <div>
            <h3 className="text-[15px] font-semibold">Record Outward</h3>
            <p className="text-[13px] text-ink-3 mt-1">
              Record an OUTWARD inventory entry for{' '}
              <span className="font-medium text-ink">
                {item.quantity} {item.unit_code}
              </span>{' '}
              from order <span className="font-mono text-brand">{item.order_no}</span>
              {item.customer_name ? ` (${item.customer_name})` : ''}.
              This will update both book stock and physical stock.
            </p>
          </div>
        </div>
        <div>
          <label className="eyebrow mb-1 block">Notes (optional)</label>
          <input
            className="field"
            placeholder="e.g. Dispatched via courier"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={onCancel} disabled={recording}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => onConfirm(notes)}
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

// ─── Mismatch Pane ────────────────────────────────────────────────────────────

function MismatchPane({
  mismatches,
  onRecordOutward,
  loadingMismatches,
}: {
  mismatches: SkuMismatch[];
  onRecordOutward: (item: MismatchOrderItem) => void;
  loadingMismatches: boolean;
}) {
  if (loadingMismatches) {
    return (
      <div className="rounded-xl border border-warn/40 bg-warn/5 p-4 flex items-center gap-2 text-[13px] text-ink-3">
        <Loader size={14} className="animate-spin" /> Checking stock status…
      </div>
    );
  }

  if (mismatches.length === 0) return null;

  return (
    <div className="rounded-xl border border-warn/60 bg-warn/5 space-y-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-warn/10 border-b border-warn/30">
        <AlertCircle size={16} className="text-warn shrink-0" />
        <div>
          <p className="text-[13px] font-semibold text-ink">
            Stock Mismatch Detected — {mismatches.length} SKU{mismatches.length > 1 ? 's' : ''}
          </p>
          <p className="text-[11px] text-ink-3 mt-0.5">
            Physical production stock is lower than book stock. Record an outward entry to reconcile.
          </p>
        </div>
      </div>

      {/* Per-SKU rows */}
      <div className="divide-y divide-warn/20">
        {mismatches.map((m) => (
          <div key={m.sku_id} className="p-4 space-y-3">
            {/* SKU header */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="text-[13px] font-semibold">
                  <span className="font-mono text-brand">{m.sku_code}</span>
                  {' – '}{m.display_name}
                </p>
                <div className="flex items-center gap-3 mt-1 text-[12px]">
                  <span className="text-ink-3">
                    Book stock: <span className="font-medium text-ink">{m.current_stock} {m.unit_code}</span>
                  </span>
                  <span className="text-ink-3">
                    Physical: <span className="font-medium text-danger">{m.physical_prod_stock} {m.unit_code}</span>
                  </span>
                  <span className="rounded-full bg-warn/20 text-warn px-2 py-0.5 font-semibold">
                    −{m.stock_gap} {m.unit_code} unposted
                  </span>
                </div>
              </div>
            </div>

            {/* Underlying production order items */}
            {m.open_order_items.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-ink-3 font-medium uppercase tracking-wide">
                  Open production orders consuming this stock:
                </p>
                {m.open_order_items.map((oi) => (
                  <div
                    key={oi.poi_id}
                    className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-line px-3 py-2"
                  >
                    <div className="text-[12px] min-w-0">
                      <span className="font-mono text-brand font-medium">{oi.order_no}</span>
                      {oi.customer_name && (
                        <span className="text-ink-3 ml-1.5">· {oi.customer_name}</span>
                      )}
                      <span className="text-ink ml-2 font-medium">
                        {oi.quantity} {oi.unit_code}
                      </span>
                      <span className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-full ${
                        oi.order_status === 'IN_PROGRESS' ? 'bg-ok/10 text-ok' :
                        oi.order_status === 'SENT' ? 'bg-brand/10 text-brand' :
                        'bg-warn/10 text-warn'
                      }`}>
                        {STATUS_LABEL[oi.order_status]}
                      </span>
                    </div>
                    <button
                      className="btn btn-primary btn-sm shrink-0"
                      onClick={() => onRecordOutward(oi)}
                      title="Record OUTWARD inventory entry for this production order item"
                    >
                      <ArrowDownCircle size={12} />
                      Record Outward
                    </button>
                  </div>
                ))}
              </div>
            )}

            {m.open_order_items.length === 0 && (
              <p className="text-[12px] text-ink-3 italic">
                No open order items found — the mismatch may be from a deleted order.
                Record a manual OUTWARD from the Inventory page to reconcile.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Line item row type ───────────────────────────────────────────────────────

interface LineItem {
  id: string;
  skuSearch: { sku: SkuWithAtp | null; query: string };
  quantity: string;
  /** Which physical lots (rolls) this line should draw from. Only meaningful
   *  for SKUs with roll_length_mm set; empty for everything else — those post
   *  straight to the book ledger exactly as they always have. */
  allocations: LotAllocation[];
}

function makeLineItem(): LineItem {
  return {
    id: Math.random().toString(36).slice(2),
    skuSearch: { sku: null, query: '' },
    quantity: '',
    allocations: [],
  };
}

function makeEmptyForm() {
  return {
    customer_name: '',
    items: [makeLineItem()],
    time_tag: '' as TimeTag | '',
    delivery_mode: '' as DeliveryMode | '',
    delivery_note: '',
    assigned_to: '',
    notes: '',
  };
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${date}, ${time}`;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ProductionOrdersView({
  session,
  initialOrders,
  defaultWhatsapp,
}: {
  session: Session;
  initialOrders: ProductionOrder[];
  defaultWhatsapp: string;
}) {
  const [orders, setOrders] = useState<ProductionOrder[]>(initialOrders);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(makeEmptyForm);
  const [whatsapp, setWhatsapp] = useState(defaultWhatsapp);
  const [editingWhatsapp, setEditingWhatsapp] = useState(false);
  const [whatsappDraft, setWhatsappDraft] = useState(defaultWhatsapp);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProductionOrder | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [skuVersion, setSkuVersion] = useState(0);
  const [, startTransition] = useTransition();

  // Mismatch pane state
  const [mismatches, setMismatches] = useState<SkuMismatch[]>([]);
  const [loadingMismatches, setLoadingMismatches] = useState(true);
  const [outwardTarget, setOutwardTarget] = useState<MismatchOrderItem | null>(null);
  const [recordingOutward, setRecordingOutward] = useState(false);

  const db = supabaseBrowser();
  const canCreate = session.permissions.includes('transactions.create');

  // ── Mismatch fetch ─────────────────────────────────────────────────────────

  async function fetchMismatches() {
    setLoadingMismatches(true);
    const { data, error: err } = await db
      .from('v_production_stock_status')
      .select('*')
      .eq('is_mismatched', true)
      .order('stock_gap', { ascending: false });

    if (!err && data) {
      setMismatches(data as unknown as SkuMismatch[]);
    }
    setLoadingMismatches(false);
  }

  // Fetch mismatches on mount and after any action
  useEffect(() => { fetchMismatches(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function refreshAll() {
    invalidateSkuCache();
    setSkuVersion(getSkuVersion());
    fetchMismatches();
  }

  const needsDeliveryNote = form.delivery_mode === 'Courier' || form.delivery_mode === 'Transportation';

  const previewMessage = buildMessage({
    customer_name: form.customer_name,
    items: form.items.map((li) => ({
      display_name: li.skuSearch.sku?.display_name ?? '',
      quantity: li.quantity,
      unit_code: li.skuSearch.sku?.unit_code ?? '',
    })),
    time_tag: form.time_tag,
    delivery_mode: form.delivery_mode,
    delivery_note: form.delivery_note,
    assigned_to: form.assigned_to,
    notes: form.notes,
  });

  // ── Line item helpers ──────────────────────────────────────────────────────

  function updateItem(id: string, patch: Partial<LineItem>) {
    setForm((f) => ({ ...f, items: f.items.map((li) => li.id === id ? { ...li, ...patch } : li) }));
  }
  function addItem() {
    setForm((f) => ({ ...f, items: [...f.items, makeLineItem()] }));
  }
  function removeItem(id: string) {
    setForm((f) => ({
      ...f,
      items: f.items.length > 1 ? f.items.filter((li) => li.id !== id) : f.items,
    }));
  }

  // ── WhatsApp settings ──────────────────────────────────────────────────────

  async function saveWhatsapp() {
    await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'default_whatsapp_number', value: whatsappDraft }),
    });
    setWhatsapp(whatsappDraft);
    setEditingWhatsapp(false);
  }

  // ── Create order ───────────────────────────────────────────────────────────

  async function handleCreate() {
    const validItems = form.items.filter((li) => li.skuSearch.sku);
    if (validItems.length === 0) { setError('Please add at least one SKU item.'); return; }

    // Check against physical_prod_stock (atp_stock IS physical in this new system)
    const qtyBySku: Record<string, { sku: SkuWithAtp; total: number }> = {};
    for (const li of validItems) {
      const sku = li.skuSearch.sku!;
      const qty = parseFloat(li.quantity) || 0;
      if (!qtyBySku[sku.id]) qtyBySku[sku.id] = { sku, total: 0 };
      qtyBySku[sku.id].total += qty;
    }
    const overCommitted = Object.values(qtyBySku).filter(({ sku, total }) => total > sku.atp_stock);
    if (overCommitted.length > 0) {
      const names = overCommitted
        .map(({ sku, total }) => `${sku.sku_code} (need ${total}, physical stock ${sku.atp_stock})`)
        .join('\n');
      const confirmed = window.confirm(
        `⚠ Quantity exceeds physical production stock:\n\n${names}\n\nProceed anyway?`
      );
      if (!confirmed) return;
    }

    setSaving(true);
    setError(null);

    const { data: noData, error: noErr } = await db.rpc('next_production_order_no');
    if (noErr) { setError(noErr.message); setSaving(false); return; }
    const order_no = noData as string;

    const product_description = validItems
      .map((li) => li.skuSearch.sku!.display_name)
      .join(', ');

    const { data: created, error: err } = await db
      .from('production_orders')
      .insert({
        order_no,
        customer_name:  form.customer_name || null,
        product_description,
        time_tag:       form.time_tag || null,
        delivery_mode:  form.delivery_mode || null,
        delivery_note:  needsDeliveryNote ? (form.delivery_note || null) : null,
        assigned_to:    form.assigned_to || null,
        notes:          form.notes || null,
        whatsapp_number: whatsapp || null,
        whatsapp_message: previewMessage || null,
        status: 'CREATED',
      })
      .select('*')
      .single();

    if (err) { setError(err.message); setSaving(false); return; }
    if (!created) { setError('Failed to create order.'); setSaving(false); return; }

    const orderId = (created as ProductionOrder).id;

    const itemRows = validItems.map((li) => ({
      order_id:     orderId,
      sku_id:       li.skuSearch.sku!.id,
      sku_code:     li.skuSearch.sku!.sku_code,
      display_name: li.skuSearch.sku!.display_name,
      unit_code:    li.skuSearch.sku!.unit_code,
      quantity:     li.quantity ? Number(li.quantity) : 1,
    }));

    const { data: insertedItems, error: itemErr } = await db
      .from('production_order_items')
      .insert(itemRows)
      .select('*');

    if (itemErr) { setSaving(false); setError(itemErr.message); return; }

    // ── Persist lot allocation plans, one call per line item that has one ──
    // Relies on Postgres returning multi-row INSERT...RETURNING in the same
    // order as the VALUES list, same assumption this file already makes when
    // it zips insertedItems straight into newOrder.items below. Only items
    // whose picked lots fully cover the quantity are saved — an incomplete
    // pick is left alone and that item simply posts to the book ledger with
    // no lot split later, exactly like a non-lot-tracked SKU would.
    const rows = (insertedItems ?? []) as ProductionOrderItem[];
    const lotErrors: string[] = [];
    for (let i = 0; i < validItems.length; i++) {
      const li = validItems[i];
      const row = rows[i];
      if (!row || li.allocations.length === 0) continue;

      const totalAllocated = li.allocations.reduce((s, a) => s + a.qty, 0);
      const qtyNeeded = li.quantity ? Number(li.quantity) : 0;
      if (totalAllocated !== qtyNeeded) continue; // picker already flags this to the user

      const { error: allocErr } = await db.rpc('set_item_lot_allocations', {
        p_item_id: row.id,
        p_allocations: li.allocations.map((a) => ({ lot_id: a.lot_id, qty: a.qty })),
      });
      if (allocErr) {
        lotErrors.push(`${li.skuSearch.sku?.sku_code ?? 'item'}: ${allocErr.message}`);
      }
    }

    setSaving(false);

    if (lotErrors.length > 0) {
      setError(
        `Order ${order_no} was created, but lot allocation failed for: ${lotErrors.join('; ')}. ` +
        `Those items will post to stock normally but without a lot split — you can leave them as is.`
      );
    }

    const newOrder: ProductionOrder = {
      ...(created as ProductionOrder),
      items: rows,
    };

    setOrders((prev) => [newOrder, ...prev]);
    setForm(makeEmptyForm());
    setShowForm(false);
    refreshAll();
  }

  // ── Delete order ───────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await db
      .from('production_orders')
      .delete()
      .eq('id', deleteTarget.id);
    setDeleting(false);
    if (err) { setError(err.message); setDeleteTarget(null); return; }
    setOrders((prev) => prev.filter((o) => o.id !== deleteTarget.id));
    setDeleteTarget(null);
    refreshAll();
  }

  // ── Cancel order ───────────────────────────────────────────────────────────

  async function handleCancel(order: ProductionOrder) {
    const confirmed = window.confirm(
      `Cancel order ${order.order_no}? Physical stock for all items will be restored.`
    );
    if (!confirmed) return;

    const { data } = await db
      .from('production_orders')
      .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
      .eq('id', order.id)
      .select('*')
      .single();

    if (data) {
      setOrders((prev) => prev.map((o) =>
        o.id === order.id ? { ...(data as ProductionOrder), items: o.items } : o
      ));
      refreshAll();
    }
  }

  // ── Status advance ─────────────────────────────────────────────────────────

  async function advanceStatus(order: ProductionOrder) {
    const next = STATUS_NEXT[order.status];
    if (!next) return;
    const { data } = await db
      .from('production_orders')
      .update({ status: next, updated_at: new Date().toISOString() })
      .eq('id', order.id)
      .select('*')
      .single();
    if (data) {
      setOrders((prev) => prev.map((o) =>
        o.id === order.id ? { ...(data as ProductionOrder), items: o.items } : o
      ));
      if (next === 'COMPLETED') refreshAll();
    }
  }

  // ── Record Outward (from mismatch pane) ────────────────────────────────────

  async function handleRecordOutward(notes: string) {
    if (!outwardTarget) return;
    setRecordingOutward(true);

    // record_production_outward_with_lots (013) wraps the original
    // record_production_outward (010) — same ledger behaviour, plus it drains
    // whatever lots were allocated to this item (no-op if none were).
    const { error: err } = await db.rpc('record_production_outward_with_lots', {
      p_poi_id:  outwardTarget.poi_id,
      p_notes:   notes || null,
      p_channel: 'WEB',
    });

    setRecordingOutward(false);
    if (err) {
      alert('Error recording outward: ' + err.message);
      return;
    }

    setOutwardTarget(null);
    refreshAll();

    // Reload orders to reflect fulfilled status on items
    const { data: fresh } = await db
      .from('production_orders')
      .select('*, production_order_items(*)')
      .order('created_at', { ascending: false });

    if (fresh) {
      setOrders(fresh.map((o: any) => ({ ...o, items: o.production_order_items ?? [] })));
    }
  }

  // ── WhatsApp open ──────────────────────────────────────────────────────────

  function openWhatsApp(order: ProductionOrder) {
    const num = (order.whatsapp_number ?? whatsapp).replace(/\D/g, '');
    const text = order.whatsapp_message ?? buildMessage({
      customer_name: order.customer_name ?? '',
      items: (order.items ?? []).map((i) => ({
        display_name: i.display_name,
        quantity: String(i.quantity),
        unit_code: i.unit_code,
      })),
      time_tag: order.time_tag ?? '',
      delivery_mode: order.delivery_mode ?? '',
      delivery_note: order.delivery_note ?? '',
      assigned_to: order.assigned_to ?? '',
      notes: order.notes ?? '',
    });
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank');
  }

  // ── Active (non-cancelled, non-completed) orders ───────────────────────────

  const activeOrders = orders.filter(
    (o) => o.status !== 'CANCELLED' && o.status !== 'COMPLETED'
  );
  const closedOrders = orders.filter(
    (o) => o.status === 'CANCELLED' || o.status === 'COMPLETED'
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto space-y-4">

      {/* Modals */}
      {deleteTarget && (
        <DeleteConfirmModal
          orderNo={deleteTarget.order_no}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
          deleting={deleting}
        />
      )}
      {outwardTarget && (
        <RecordOutwardModal
          item={outwardTarget}
          onConfirm={handleRecordOutward}
          onCancel={() => setOutwardTarget(null)}
          recording={recordingOutward}
        />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold">Production Orders</h1>
          <p className="text-[13px] text-ink-3 mt-0.5">
            {activeOrders.length} active · {closedOrders.length} closed
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="text-ink-3 hidden sm:inline">WhatsApp:</span>
            {editingWhatsapp ? (
              <>
                <input
                  className="field w-36"
                  value={whatsappDraft}
                  onChange={(e) => setWhatsappDraft(e.target.value)}
                  placeholder="+91 98765 43210"
                  autoFocus
                />
                <button className="btn btn-primary btn-sm" onClick={saveWhatsapp}>Save</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditingWhatsapp(false)}>Cancel</button>
              </>
            ) : (
              <>
                <span className="font-medium">{whatsapp || <span className="text-ink-3 italic">not set</span>}</span>
                <button className="text-brand text-[12px] hover:underline" onClick={() => { setWhatsappDraft(whatsapp); setEditingWhatsapp(true); }}>
                  <Pencil size={12} className="inline mr-0.5" />Change
                </button>
              </>
            )}
          </div>
          {canCreate && (
            <button className="btn btn-primary" onClick={() => { setShowForm(true); setError(null); setForm(makeEmptyForm()); }}>
              <Plus size={14} /> New Order
            </button>
          )}
        </div>
      </div>

      {/* ── Mismatch Pane ── */}
      <MismatchPane
        mismatches={mismatches}
        onRecordOutward={setOutwardTarget}
        loadingMismatches={loadingMismatches}
      />

      {/* Create form */}
      {showForm && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">New Production Order</h2>
            <button className="btn btn-ghost h-7 w-7 p-0" onClick={() => setShowForm(false)}><X size={15} /></button>
          </div>

          {error && <p className="text-[13px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="eyebrow mb-1 block">Customer Name</label>
              <input
                className="field"
                placeholder="e.g. Ramesh Industries"
                value={form.customer_name}
                onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
              />
            </div>
            <div>
              <label className="eyebrow mb-1 block">Assigned To</label>
              <input
                className="field"
                placeholder="Who will fulfil this order?"
                value={form.assigned_to}
                onChange={(e) => setForm({ ...form, assigned_to: e.target.value })}
              />
            </div>
          </div>

          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="eyebrow">Items <span className="text-danger">*</span></label>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addItem}>
                <Plus size={12} /> Add Item
              </button>
            </div>

            <div className="space-y-2">
              {form.items.map((li, idx) => {
                const otherQty = li.skuSearch.sku
                  ? form.items
                      .filter((other) => other.id !== li.id && other.skuSearch.sku?.id === li.skuSearch.sku!.id)
                      .reduce((sum, other) => sum + (parseFloat(other.quantity) || 0), 0)
                  : 0;
                const effectiveAtp = li.skuSearch.sku ? li.skuSearch.sku.atp_stock - otherQty : Infinity;

                // Lot tracking only applies once the SKU has a roll length defined
                // in Product Master (migration 011). Everything else behaves exactly
                // as before — straight to the book ledger, no lot picker shown.
                const isLotTracked = !!li.skuSearch.sku?.roll_length_mm;
                const qtyNum = parseFloat(li.quantity) || 0;

                return (
                  <div key={li.id} className="rounded-lg border border-line bg-subtle p-3">
                    <div className="flex gap-2 items-start">
                      <span className="text-[11px] text-ink-3 font-mono mt-2.5 w-4 shrink-0 text-center">{idx + 1}</span>
                      <div className="flex-1 min-w-0">
                        <SkuCombobox
                          value={li.skuSearch}
                          onChange={(val) => updateItem(li.id, { skuSearch: val, allocations: [] })}
                          cacheVersion={skuVersion}
                          placeholder="Search SKU…"
                        />
                        {li.skuSearch.sku && (
                          <p className="text-[11px] text-ink-3 mt-0.5 pl-0.5">
                            {li.skuSearch.sku.brand_name} · {li.skuSearch.sku.exact_size}
                            {li.skuSearch.sku.reserved_qty > 0 && (
                              <span className="text-warn ml-1">
                                · {li.skuSearch.sku.reserved_qty} reserved
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="w-24 shrink-0">
                        <input
                          className={`field text-center ${
                            li.skuSearch.sku && parseFloat(li.quantity) > effectiveAtp
                              ? 'border-danger focus:ring-danger/30'
                              : ''
                          }`}
                          type="number"
                          min="0"
                          placeholder="Qty"
                          value={li.quantity}
                          onChange={(e) => updateItem(li.id, { quantity: e.target.value })}
                        />
                        {li.skuSearch.sku && (
                          <AtpBadge sku={li.skuSearch.sku} qty={li.quantity} otherQty={otherQty} />
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost h-8 w-8 p-0 mt-0.5 text-ink-3 hover:text-danger shrink-0"
                        onClick={() => removeItem(li.id)}
                        disabled={form.items.length === 1}
                        title="Remove item"
                      >
                        <X size={14} />
                      </button>
                    </div>

                    {isLotTracked && qtyNum > 0 && (
                      <LotAllocationPicker
                        skuId={li.skuSearch.sku!.id}
                        unitCode={li.skuSearch.sku!.unit_code}
                        qtyNeeded={qtyNum}
                        value={li.allocations}
                        onChange={(next) => updateItem(li.id, { allocations: next })}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              className="mt-2 w-full rounded-lg border border-dashed border-line py-2 text-[12px] text-ink-3 hover:border-brand hover:text-brand transition-colors"
              onClick={addItem}
            >
              <Plus size={12} className="inline mr-1" />Add another item
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="eyebrow mb-1 block">Estimated Time</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {TIME_TAGS.map((tag) => (
                  <button
                    key={tag} type="button"
                    onClick={() => setForm({ ...form, time_tag: form.time_tag === tag ? '' : tag })}
                    className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${
                      form.time_tag === tag
                        ? 'bg-brand text-white border-brand'
                        : 'bg-surface border-line text-ink-2 hover:border-brand hover:text-brand'
                    }`}
                  >{tag}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="eyebrow mb-1 block">Mode of Delivery</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {DELIVERY_MODES.map((mode) => (
                  <button
                    key={mode} type="button"
                    onClick={() => setForm({ ...form, delivery_mode: form.delivery_mode === mode ? '' : mode, delivery_note: '' })}
                    className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${
                      form.delivery_mode === mode
                        ? 'bg-brand text-white border-brand'
                        : 'bg-surface border-line text-ink-2 hover:border-brand hover:text-brand'
                    }`}
                  >{mode}</button>
                ))}
              </div>
              {needsDeliveryNote && (
                <div className="mt-2">
                  <input
                    className="field"
                    placeholder={form.delivery_mode === 'Courier' ? 'Courier company / tracking name' : 'Transport company name'}
                    value={form.delivery_note}
                    onChange={(e) => setForm({ ...form, delivery_note: e.target.value })}
                  />
                </div>
              )}
            </div>

            <div className="sm:col-span-2">
              <label className="eyebrow mb-1 block">Notes</label>
              <textarea
                className="field resize-none"
                rows={2}
                placeholder="Any extra instructions…"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>

          <div className="rounded-lg border border-line bg-subtle p-3">
            <p className="eyebrow mb-1.5">WhatsApp message preview</p>
            <pre className="text-[12px] text-ink-2 whitespace-pre-wrap font-sans leading-relaxed">{previewMessage}</pre>
          </div>

          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? <Loader size={14} className="animate-spin" /> : <Plus size={14} />}
              Create Order
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {orders.length === 0 && !showForm && (
        <div className="card p-10 text-center">
          <p className="text-[13px] text-ink-3">No production orders yet. Create one to get started.</p>
        </div>
      )}

      {/* ── Active Orders ── */}
      {activeOrders.length > 0 && (
        <div className="space-y-3">
          {activeOrders.map((order) => (
            <div key={order.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-mono text-ink-3">{order.order_no}</span>
                    <span className={`badge ${STATUS_BADGE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
                    {order.time_tag && (
                      <span className="text-[11px] bg-subtle border border-line rounded-full px-2 py-0.5 text-ink-2">
                        ⏱ {order.time_tag}
                      </span>
                    )}
                    {order.created_at && (
                      <span className="text-[11px] text-ink-3">🕐 {formatDateTime(order.created_at)}</span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1.5 text-[12px] text-ink-3">
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
                    <ul className="mt-2 space-y-1">
                      {order.items.map((item, idx) => (
                        <li key={item.id} className="flex items-center gap-2 text-[13px]">
                          <span className="text-ink-3 font-mono text-[11px] w-4 shrink-0">{idx + 1}.</span>
                          <span className="font-medium text-ink truncate">{item.display_name}</span>
                          {item.quantity != null && (
                            <span className="text-ink-3 shrink-0">× {item.quantity} {item.unit_code}</span>
                          )}
                          {item.is_fulfilled && (
                            <span className="text-[10px] bg-ok/10 text-ok px-1.5 rounded-full shrink-0">Outward posted</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    order.product_description && (
                      <p className="text-[13px] font-medium mt-1">{order.product_description}
                        {order.quantity != null && (
                          <span className="text-ink-3 font-normal ml-2">× {order.quantity} {order.unit_code ?? ''}</span>
                        )}
                      </p>
                    )
                  )}

                  {order.notes && (
                    <p className="text-[12px] text-ink-3 mt-1 truncate max-w-[500px]">{order.notes}</p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => openWhatsApp(order)}
                    title="Send via WhatsApp"
                  >
                    <Send size={13} /> WhatsApp
                  </button>

                  {STATUS_NEXT[order.status] && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => startTransition(() => { advanceStatus(order); })}
                    >
                      {order.status === 'IN_PROGRESS' ? <CheckCircle size={13} /> : <Clock size={13} />}
                      {STATUS_NEXT_LABEL[order.status]}
                    </button>
                  )}

                  {canCreate && order.status !== 'COMPLETED' && (
                    <button
                      className="btn btn-ghost btn-sm text-ink-3 hover:text-warn hover:bg-warn/10"
                      onClick={() => handleCancel(order)}
                      title="Cancel order (restores physical stock)"
                    >
                      <Ban size={13} />
                    </button>
                  )}

                  {canCreate && (
                    <button
                      className="btn btn-ghost btn-sm text-ink-3 hover:text-danger hover:bg-danger-soft"
                      onClick={() => setDeleteTarget(order)}
                      title="Delete order"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Closed Orders (Completed + Cancelled) ── */}
      {closedOrders.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink select-none py-1">
            Show {closedOrders.length} closed order{closedOrders.length !== 1 ? 's' : ''}
            {' (completed &amp; cancelled)'}
          </summary>
          <div className="mt-2 space-y-2 opacity-70">
            {closedOrders.map((order) => (
              <div key={order.id} className="card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-mono text-ink-3">{order.order_no}</span>
                  <span className={`badge ${STATUS_BADGE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
                  {order.customer_name && (
                    <span className="text-[12px] text-ink-3">{order.customer_name}</span>
                  )}
                  {order.items && order.items.length > 0 && (
                    <span className="text-[12px] text-ink-3">
                      · {order.items.map((i) => `${i.display_name} ×${i.quantity}`).join(', ')}
                    </span>
                  )}
                  {order.created_at && (
                    <span className="text-[11px] text-ink-3 ml-auto">{formatDateTime(order.created_at)}</span>
                  )}
                  {canCreate && order.status !== 'CANCELLED' && (
                    <button
                      className="btn btn-ghost btn-sm text-ink-3 hover:text-danger hover:bg-danger-soft"
                      onClick={() => setDeleteTarget(order)}
                      title="Delete order"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

    </div>
  );
}
