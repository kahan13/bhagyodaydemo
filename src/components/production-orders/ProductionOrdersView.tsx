'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import { Plus, Send, CheckCircle, Clock, Loader, Pencil, X, Search, ChevronDown } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { ProductionOrder, ProductionOrderStatus, Session, Sku, TimeTag, DeliveryMode } from '@/lib/types';

// ─── Constants ───────────────────────────────────────────────────────────────

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
  product_description: string;
  quantity: string;
  unit_code: string;
  time_tag: string;
  delivery_mode: string;
  delivery_note: string;
  assigned_to: string;
  notes: string;
}) {
  const lines = [
    `*Production Order*`,
    fields.customer_name ? `Customer: ${fields.customer_name}` : null,
    `Product: ${fields.product_description}`,
    fields.quantity ? `Quantity: ${fields.quantity} ${fields.unit_code}`.trim() : null,
    fields.time_tag ? `Time: ${fields.time_tag}` : null,
    fields.delivery_mode ? `Delivery: ${fields.delivery_mode}${fields.delivery_note ? ` (${fields.delivery_note})` : ''}` : null,
    fields.assigned_to ? `Assigned to: ${fields.assigned_to}` : null,
    fields.notes ? `Notes: ${fields.notes}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

// ─── SKU Search Combobox ──────────────────────────────────────────────────────

function SkuCombobox({
  value,
  onChange,
}: {
  value: { sku: Sku | null; query: string };
  onChange: (val: { sku: Sku | null; query: string }) => void;
}) {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [loadingSkus, setLoadingSkus] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load SKUs once on mount
  useEffect(() => {
    setLoadingSkus(true);
    supabaseBrowser()
      .from('v_sku_status')
      .select('id,sku_code,display_name,exact_size,brand_name,family_name,unit_code,product_type,hier_l1,hier_l2,hier_l3,search_text,brand_code,family_code,profile_group,belt_form,construction,standard,pitch_mm,pitch_length_mm,width_mm,teeth,nominal_length,length_designation,rack_location,opening_stock,current_stock,min_stock_level,supplier_moq,reorder_quantity,supplier_name,is_active,stock_status,shortfall,suggested_purchase_qty')
      .eq('is_active', true)
      .order('product_type')
      .order('hier_l1')
      .order('hier_l2')
      .then(({ data }: { data: unknown[] | null }) => {
        setSkus((data ?? []) as unknown as Sku[]);
        setLoadingSkus(false);
      });
  }, []);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const q = value.query.toLowerCase();
  const filtered = q.length < 1
    ? skus.slice(0, 40)
    : skus
        .filter((s) =>
          s.sku_code.toLowerCase().includes(q) ||
          s.display_name.toLowerCase().includes(q) ||
          s.exact_size.toLowerCase().includes(q) ||
          s.brand_name.toLowerCase().includes(q) ||
          (s.search_text ?? '').toLowerCase().includes(q)
        )
        .slice(0, 40);

  function selectSku(sku: Sku) {
    onChange({ sku, query: `${sku.sku_code} – ${sku.display_name}` });
    setOpen(false);
  }

  function clearSku() {
    onChange({ sku: null, query: '' });
    inputRef.current?.focus();
    setOpen(true);
  }

  return (
    <div className="relative">
      <div className="relative flex items-center">
        <Search size={13} className="absolute left-2.5 text-ink-3 pointer-events-none" />
        <input
          ref={inputRef}
          className="field pl-7 pr-7"
          placeholder={loadingSkus ? 'Loading SKUs…' : 'Search SKU code, name, size…'}
          value={value.query}
          onChange={(e) => {
            onChange({ sku: null, query: e.target.value });
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
        />
        {value.query && (
          <button
            className="absolute right-2 text-ink-3 hover:text-ink"
            onClick={clearSku}
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
          className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg max-h-64 overflow-y-auto"
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
                  <span className="font-mono text-brand">{sku.sku_code}</span>
                  {' – '}
                  {sku.display_name}
                </div>
                <div className="text-[11px] text-ink-3 truncate">
                  {sku.brand_name} · {sku.exact_size}
                </div>
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
          No SKUs match "{value.query}"
        </div>
      )}
    </div>
  );
}

// ─── Empty form ───────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  customer_name: '',
  skuSearch: { sku: null as Sku | null, query: '' },
  quantity: '',
  unit_code: 'PCS',
  time_tag: '' as TimeTag | '',
  delivery_mode: '' as DeliveryMode | '',
  delivery_note: '',
  assigned_to: '',
  notes: '',
};

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
  const [form, setForm] = useState(EMPTY_FORM);
  const [whatsapp, setWhatsapp] = useState(defaultWhatsapp);
  const [editingWhatsapp, setEditingWhatsapp] = useState(false);
  const [whatsappDraft, setWhatsappDraft] = useState(defaultWhatsapp);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const db = supabaseBrowser();
  const canCreate = session.permissions.includes('transactions.create');

  const selectedSku = form.skuSearch.sku;
  const productDescription = selectedSku?.display_name ?? '';
  const unitCode = selectedSku?.unit_code ?? form.unit_code;

  const previewMessage = buildMessage({
    customer_name: form.customer_name,
    product_description: productDescription,
    quantity: form.quantity,
    unit_code: unitCode,
    time_tag: form.time_tag,
    delivery_mode: form.delivery_mode,
    delivery_note: form.delivery_note,
    assigned_to: form.assigned_to,
    notes: form.notes,
  });

  const needsDeliveryNote =
    form.delivery_mode === 'Courier' || form.delivery_mode === 'Transportation';

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
    if (!selectedSku) { setError('Please select a SKU from the list.'); return; }
    setSaving(true);
    setError(null);

    // Get daily-reset order number from DB function
    const { data: noData, error: noErr } = await db.rpc('next_production_order_no');
    if (noErr) { setError(noErr.message); setSaving(false); return; }
    const order_no = noData as string;

    const { data: created, error: err } = await db
      .from('production_orders')
      .insert({
        order_no,
        customer_name: form.customer_name || null,
        sku_id: selectedSku.id,
        product_description: selectedSku.display_name,
        quantity: form.quantity ? Number(form.quantity) : null,
        unit_code: unitCode || null,
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

    setSaving(false);

    if (err) { setError(err.message); return; }

    if (created) setOrders((prev) => [created as ProductionOrder, ...prev]);
    setForm(EMPTY_FORM);
    setShowForm(false);
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
      setOrders((prev) => prev.map((o) => (o.id === order.id ? (data as ProductionOrder) : o)));
    }
  }

  // ── WhatsApp open ──────────────────────────────────────────────────────────

  function openWhatsApp(order: ProductionOrder) {
    const num = (order.whatsapp_number ?? whatsapp).replace(/\D/g, '');
    const text = order.whatsapp_message ?? buildMessage({
      customer_name: order.customer_name ?? '',
      product_description: order.product_description,
      quantity: String(order.quantity ?? ''),
      unit_code: order.unit_code ?? '',
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

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold">Production Orders</h1>
          <p className="text-[13px] text-ink-3 mt-0.5">{orders.length} order{orders.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* WhatsApp number */}
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
            <button className="btn btn-primary" onClick={() => { setShowForm(true); setError(null); }}>
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

            {/* SKU Search */}
            <div>
              <label className="eyebrow mb-1 block">SKU / Product <span className="text-danger">*</span></label>
              <SkuCombobox
                value={form.skuSearch}
                onChange={(val) => setForm({ ...form, skuSearch: val, unit_code: val.sku?.unit_code ?? form.unit_code })}
              />
              {selectedSku && (
                <p className="text-[11px] text-ink-3 mt-1">
                  {selectedSku.brand_name} · {selectedSku.exact_size} · Unit: {selectedSku.unit_code}
                </p>
              )}
            </div>

            {/* Quantity */}
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="eyebrow mb-1 block">Quantity</label>
                <input
                  className="field"
                  type="number"
                  min="0"
                  placeholder="100"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
              </div>
              <div className="w-24">
                <label className="eyebrow mb-1 block">Unit</label>
                <input
                  className="field"
                  placeholder="PCS"
                  value={selectedSku ? selectedSku.unit_code : form.unit_code}
                  readOnly={!!selectedSku}
                  onChange={(e) => setForm({ ...form, unit_code: e.target.value })}
                />
              </div>
            </div>

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
              {/* Courier / Transportation side note */}
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

          {/* WhatsApp message preview */}
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
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-mono text-ink-3">{order.order_no}</span>
                  <span className={`badge ${STATUS_BADGE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
                  {order.time_tag && (
                    <span className="text-[11px] bg-subtle border border-line rounded-full px-2 py-0.5 text-ink-2">
                      ⏱ {order.time_tag}
                    </span>
                  )}
                </div>

                <p className="text-[14px] font-semibold mt-1">{order.product_description}</p>

                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-[12px] text-ink-3">
                  {order.customer_name && (
                    <span>Customer: <span className="text-ink">{order.customer_name}</span></span>
                  )}
                  {order.quantity != null && (
                    <span>Qty: <span className="text-ink font-medium">{order.quantity} {order.unit_code ?? ''}</span></span>
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
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
