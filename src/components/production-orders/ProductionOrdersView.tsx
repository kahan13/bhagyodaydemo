'use client';

import { useState, useTransition } from 'react';
import { Plus, Send, CheckCircle, Clock, Loader, Pencil, X } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { ProductionOrder, ProductionOrderStatus, Session } from '@/lib/types';

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

function buildMessage(fields: {
  customer_name: string;
  product_description: string;
  quantity: string;
  unit_code: string;
  due_date: string;
  notes: string;
}) {
  const lines = [
    `*Production Order*`,
    fields.customer_name ? `Customer: ${fields.customer_name}` : null,
    `Product: ${fields.product_description}`,
    fields.quantity ? `Quantity: ${fields.quantity} ${fields.unit_code}`.trim() : null,
    fields.due_date ? `Due: ${new Date(fields.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : null,
    fields.notes ? `Notes: ${fields.notes}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

const EMPTY_FORM = {
  customer_name: '',
  product_description: '',
  quantity: '',
  unit_code: 'PCS',
  due_date: '',
  notes: '',
};

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

  const previewMessage = buildMessage(form);

  async function saveWhatsapp() {
    await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'default_whatsapp_number', value: whatsappDraft }),
    });
    setWhatsapp(whatsappDraft);
    setEditingWhatsapp(false);
  }

  async function handleCreate() {
    if (!form.product_description.trim()) { setError('Product description is required.'); return; }
    setSaving(true);
    setError(null);

    // Generate order_no client-side: PRD-YYYYMMDD-XXXX
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randPart = Math.floor(1000 + Math.random() * 9000);
    const order_no = `PRD-${datePart}-${randPart}`;

    const { data: created, error: err } = await db
      .from('production_orders')
      .insert({
        order_no,
        customer_name: form.customer_name || null,
        product_description: form.product_description,
        quantity: form.quantity ? Number(form.quantity) : null,
        unit_code: form.unit_code || null,
        due_date: form.due_date || null,
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

  function openWhatsApp(order: ProductionOrder) {
    const num = (order.whatsapp_number ?? whatsapp).replace(/\D/g, '');
    const text = order.whatsapp_message ?? buildMessage({
      customer_name: order.customer_name ?? '',
      product_description: order.product_description,
      quantity: String(order.quantity ?? ''),
      unit_code: order.unit_code ?? '',
      due_date: order.due_date ?? '',
      notes: order.notes ?? '',
    });
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank');
  }

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto space-y-4">
      {/* header */}
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

      {/* create form */}
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
              <input className="field" placeholder="e.g. Ramesh Industries" value={form.customer_name}
                onChange={(e) => setForm({ ...form, customer_name: e.target.value })} />
            </div>
            <div>
              <label className="eyebrow mb-1 block">Product Description <span className="text-danger">*</span></label>
              <input className="field" placeholder="e.g. A-42 V-Belt × 50 pcs" value={form.product_description}
                onChange={(e) => setForm({ ...form, product_description: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="eyebrow mb-1 block">Quantity</label>
                <input className="field" type="number" min="0" placeholder="100" value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
              </div>
              <div className="w-24">
                <label className="eyebrow mb-1 block">Unit</label>
                <input className="field" placeholder="PCS" value={form.unit_code}
                  onChange={(e) => setForm({ ...form, unit_code: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="eyebrow mb-1 block">Due Date</label>
              <input className="field" type="date" value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="eyebrow mb-1 block">Notes</label>
              <textarea className="field resize-none" rows={2} placeholder="Any extra instructions…" value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
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

      {/* orders list */}
      {orders.length === 0 && !showForm && (
        <div className="card p-10 text-center">
          <p className="text-[13px] text-ink-3">No production orders yet. Create one to get started.</p>
        </div>
      )}

      <div className="space-y-3">
        {orders.map((order) => (
          <div key={order.id} className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-mono text-ink-3">{order.order_no}</span>
                  <span className={`badge ${STATUS_BADGE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
                </div>
                <p className="text-[14px] font-semibold mt-1">{order.product_description}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-[12px] text-ink-3">
                  {order.customer_name && <span>Customer: <span className="text-ink">{order.customer_name}</span></span>}
                  {order.quantity != null && <span>Qty: <span className="text-ink font-medium">{order.quantity} {order.unit_code ?? ''}</span></span>}
                  {order.due_date && <span>Due: <span className="text-ink">{new Date(order.due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span></span>}
                </div>
                {order.notes && <p className="text-[12px] text-ink-3 mt-1 truncate max-w-[500px]">{order.notes}</p>}
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
                  <button className="btn btn-primary btn-sm" onClick={() => startTransition(() => { advanceStatus(order); })}>
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
