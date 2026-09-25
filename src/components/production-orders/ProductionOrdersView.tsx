'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import { Plus, Send, CheckCircle, Clock, Loader, Pencil, X, Search, Trash2, AlertTriangle } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type {
  ProductionOrder,
  ProductionOrderItem,
  ProductionOrderStatus,
  Session,
  Sku,
  TimeTag,
  DeliveryMode,
} from '@/lib/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ProductionOrderStatus, string> = {
  CREATED: 'Created',
  SENT: 'Sent',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
};

const STATUS_BADGE: Record<ProductionOrderStatus, string> = {
  CREATED: 'badge-warn',
  SENT: 'badge-brand',
  IN_PROGRESS: 'badge-ok',
  COMPLETED: 'bg-subtle text-ink-3 px-2 py-0.5 rounded-full text-[11px] font-medium',
};

const STATUS_NEXT: Partial<Record<ProductionOrderStatus, ProductionOrderStatus>> = {
  CREATED: 'SENT',
  SENT: 'IN_PROGRESS',
  IN_PROGRESS: 'COMPLETED',
};

const STATUS_NEXT_LABEL: Partial<Record<ProductionOrderStatus, string>> = {
  CREATED: 'Mark Sent',
  SENT: 'Mark In Progress',
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

// ─── Shared SKU cache (load once for the whole session) ──────────────────────

let _skuCache: Sku[] | null = null;
let _skuInflight: Promise<Sku[]> | null = null;

function loadSkus(): Promise<Sku[]> {
  if (_skuCache) return Promise.resolve(_skuCache);
  if (_skuInflight) return _skuInflight;

  const p: Promise<Sku[]> = supabaseBrowser()
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
    .order('hier_l2')
    .then(({ data }: { data: unknown[] | null }): Sku[] => {
      _skuCache = (data ?? []) as unknown as Sku[];
      _skuInflight = null;
      return _skuCache;
    });

  _skuInflight = p;
  return p;
}

// ─── SKU Search Combobox ──────────────────────────────────────────────────────

function SkuCombobox({
  value,
  onChange,
  placeholder = 'Search SKU code, name, size…',
}: {
  value: { sku: Sku | null; query: string };
  onChange: (val: { sku: Sku | null; query: string }) => void;
  placeholder?: string;
}) {
  const [skus, setSkus] = useState<Sku[]>(_skuCache ?? []);
  const [loadingSkus, setLoadingSkus] = useState(!_skuCache);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (_skuCache) { setSkus(_skuCache); setLoadingSkus(false); return; }
    setLoadingSkus(true);
    loadSkus().then((s) => { setSkus(s); setLoadingSkus(false); });
  }, []);

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

  function selectSku(sku: Sku) {
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
          {filtered.map((sku) => (
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
              <span className="text-[11px] text-ink-3 shrink-0">{sku.unit_code}</span>
            </button>
          ))}
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
  orderNo,
  onConfirm,
  onCancel,
  deleting,
}: {
  orderNo: string;
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
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
              This will permanently delete the order and all its items. This cannot be undone.
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

// ─── Line item row type ───────────────────────────────────────────────────────

interface LineItem {
  id: string; // local key only
  skuSearch: { sku: Sku | null; query: string };
  quantity: string;
}

function makeLineItem(): LineItem {
  return { id: Math.random().toString(36).slice(2), skuSearch: { sku: null, query: '' }, quantity: '' };
}

// ─── Empty form ───────────────────────────────────────────────────────────────

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
  const [, startTransition] = useTransition();

  const db = supabaseBrowser();
  const canCreate = session.permissions.includes('transactions.create');

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

    setSaving(true);
    setError(null);

    // 1. Get daily-reset order number
    const { data: noData, error: noErr } = await db.rpc('next_production_order_no');
    if (noErr) { setError(noErr.message); setSaving(false); return; }
    const order_no = noData as string;

    // Build summary description from items for legacy field
    const product_description = validItems
      .map((li) => li.skuSearch.sku!.display_name)
      .join(', ');

    // 2. Insert the order header
    const { data: created, error: err } = await db
      .from('production_orders')
      .insert({
        order_no,
        customer_name: form.customer_name || null,
        product_description,
        time_tag: form.time_tag || null,
        delivery_mode: form.delivery_mode || null,
        delivery_note: needsDeliveryNote ? (form.delivery_note || null) : null,
        assigned_to: form.assigned_to || null,
        notes: form.notes || null,
        whatsapp_number: whatsapp || null,
        whatsapp_message: previewMessage || null,
        status: 'CREATED',
      })
      .select('*')
      .single();

    if (err) { setError(err.message); setSaving(false); return; }
    if (!created) { setError('Failed to create order.'); setSaving(false); return; }

    const orderId = (created as ProductionOrder).id;

    // 3. Insert line items
    const itemRows = validItems.map((li) => ({
      order_id: orderId,
      sku_id: li.skuSearch.sku!.id,
      sku_code: li.skuSearch.sku!.sku_code,
      display_name: li.skuSearch.sku!.display_name,
      unit_code: li.skuSearch.sku!.unit_code,
      quantity: li.quantity ? Number(li.quantity) : 1,
    }));

    const { data: insertedItems, error: itemErr } = await db
      .from('production_order_items')
      .insert(itemRows)
      .select('*');

    setSaving(false);

    if (itemErr) { setError(itemErr.message); return; }

    const newOrder: ProductionOrder = {
      ...(created as ProductionOrder),
      items: (insertedItems ?? []) as ProductionOrderItem[],
    };

    setOrders((prev) => [newOrder, ...prev]);
    setForm(makeEmptyForm());
    setShowForm(false);
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

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto space-y-4">

      {/* Delete confirm modal */}
      {deleteTarget && (
        <DeleteConfirmModal
          orderNo={deleteTarget.order_no}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
          deleting={deleting}
        />
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold">Production Orders</h1>
          <p className="text-[13px] text-ink-3 mt-0.5">{orders.length} order{orders.length !== 1 ? 's' : ''}</p>
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

      {/* Create form */}
      {showForm && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">New Production Order</h2>
            <button className="btn btn-ghost h-7 w-7 p-0" onClick={() => setShowForm(false)}><X size={15} /></button>
          </div>

          {error && <p className="text-[13px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}

          <div className="grid gap-3 sm:grid-cols-2">

            {/* Customer Name */}
            <div>
              <label className="eyebrow mb-1 block">Customer Name</label>
              <input
                className="field"
                placeholder="e.g. Ramesh Industries"
                value={form.customer_name}
                onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
              />
            </div>

            {/* Assigned To */}
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

          {/* ── Line Items ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="eyebrow">Items <span className="text-danger">*</span></label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={addItem}
              >
                <Plus size={12} /> Add Item
              </button>
            </div>

            <div className="space-y-2">
              {form.items.map((li, idx) => (
                <div key={li.id} className="flex gap-2 items-start rounded-lg border border-line bg-subtle p-3">
                  {/* Row number */}
                  <span className="text-[11px] text-ink-3 font-mono mt-2.5 w-4 shrink-0 text-center">{idx + 1}</span>

                  {/* SKU search */}
                  <div className="flex-1 min-w-0">
                    <SkuCombobox
                      value={li.skuSearch}
                      onChange={(val) => updateItem(li.id, { skuSearch: val })}
                      placeholder="Search SKU…"
                    />
                    {li.skuSearch.sku && (
                      <p className="text-[11px] text-ink-3 mt-0.5 pl-0.5">
                        {li.skuSearch.sku.brand_name} · {li.skuSearch.sku.exact_size} · {li.skuSearch.sku.unit_code}
                      </p>
                    )}
                  </div>

                  {/* Quantity */}
                  <div className="w-24 shrink-0">
                    <input
                      className="field text-center"
                      type="number"
                      min="0"
                      placeholder="Qty"
                      value={li.quantity}
                      onChange={(e) => updateItem(li.id, { quantity: e.target.value })}
                    />
                    {li.skuSearch.sku && (
                      <p className="text-[10px] text-ink-3 text-center mt-0.5">{li.skuSearch.sku.unit_code}</p>
                    )}
                  </div>

                  {/* Remove */}
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
              ))}
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

            {/* Time Tag */}
            <div>
              <label className="eyebrow mb-1 block">Estimated Time</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {TIME_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setForm({ ...form, time_tag: form.time_tag === tag ? '' : tag })}
                    className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${
                      form.time_tag === tag
                        ? 'bg-brand text-white border-brand'
                        : 'bg-surface border-line text-ink-2 hover:border-brand hover:text-brand'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            {/* Delivery Mode */}
            <div>
              <label className="eyebrow mb-1 block">Mode of Delivery</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {DELIVERY_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setForm({ ...form, delivery_mode: form.delivery_mode === mode ? '' : mode, delivery_note: '' })}
                    className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${
                      form.delivery_mode === mode
                        ? 'bg-brand text-white border-brand'
                        : 'bg-surface border-line text-ink-2 hover:border-brand hover:text-brand'
                    }`}
                  >
                    {mode}
                  </button>
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

            {/* Notes */}
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

          {/* WhatsApp preview */}
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

      {/* Orders list */}
      <div className="space-y-3">
        {orders.map((order) => (
          <div key={order.id} className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">

              {/* Left: order info */}
              <div className="min-w-0 flex-1">
                {/* Top row: order no, status, time tag */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-mono text-ink-3">{order.order_no}</span>
                  <span className={`badge ${STATUS_BADGE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
                  {order.time_tag && (
                    <span className="text-[11px] bg-subtle border border-line rounded-full px-2 py-0.5 text-ink-2">
                      ⏱ {order.time_tag}
                    </span>
                  )}
                </div>

                {/* Meta row */}
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

                {/* Items list */}
                {order.items && order.items.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {order.items.map((item, idx) => (
                      <li key={item.id} className="flex items-center gap-2 text-[13px]">
                        <span className="text-ink-3 font-mono text-[11px] w-4 shrink-0">{idx + 1}.</span>
                        <span className="font-medium text-ink truncate">{item.display_name}</span>
                        {item.quantity != null && (
                          <span className="text-ink-3 shrink-0">× {item.quantity} {item.unit_code}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  /* Legacy single-item orders */
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

              {/* Right: action buttons */}
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
    </div>
  );
}
