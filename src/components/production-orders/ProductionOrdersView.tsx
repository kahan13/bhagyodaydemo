'use client';

import { useState, useTransition, useEffect, useRef } from 'react';
import {
  Plus, Send, CheckCircle, Clock, Loader, Pencil, X,
  Search, Trash2, AlertTriangle, AlertCircle, Ban,
  ArrowDownCircle, CheckSquare, ChevronDown, ChevronRight, Trash, Printer, FileDown,
} from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useCatalog } from '@/components/catalog/CatalogProvider';
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
import type { LotGroup, PendingAdjustment } from '@/lib/types';
import { loadReceiptModel, printReceipt, downloadReceiptPdf, receiptHtml, type ReceiptModel } from '@/lib/order-receipt';
import { groupText, groupLabel } from '@/components/inventory/LotBreakdown';

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
  order_no?: string;
  direct?: boolean;
  customer_name: string;
  items: Array<{ display_name: string; quantity: string; unit_code: string; detail?: string }>;
  time_tag: string;
  delivery_mode: string;
  delivery_note: string;
  assigned_to: string;
  notes: string;
}) {
  const itemLines = fields.items
    .filter((i) => i.display_name)
    .map((i, idx) =>
      `  ${idx + 1}. ${i.display_name}${i.quantity ? ` × ${i.quantity} ${i.unit_code}`.trimEnd() : ''}${i.detail ? ` (${i.detail})` : ''}`
    );

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

// ─── ATP / Physical Stock types ───────────────────────────────────────────────

interface SkuAtp {
  sku_id: string;
  current_stock: number;
  physical_prod_stock: number;
  reserved_qty: number;
  atp_stock: number;
}

type SkuPick = { sku: SkuWithAtp | null; query: string; group?: LotGroup | null };

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
        'supplier_moq,reorder_quantity,supplier_name,is_active,stock_status,shortfall,suggested_purchase_qty,roll_length_mm'
      )
      .eq('is_active', true)
      .order('product_type')
      .order('hier_l1')
      .order('hier_l2'),
    supabaseBrowser()
      .from('v_sku_atp')
      .select('sku_id,current_stock,physical_prod_stock,reserved_qty,atp_stock'),
    supabaseBrowser()
      .from('v_sku_lot_groups_free')
      .select('sku_id,status,piece_qty,pieces,total_qty'),
  ]).then(([skuRes, atpRes, grpRes]) => {
    const groups: Record<string, LotGroup[]> = {};
    for (const r of ((grpRes.data ?? []) as unknown as (LotGroup & { sku_id: string })[])) {
      (groups[r.sku_id] ??= []).push({
        status: r.status, piece_qty: Number(r.piece_qty), pieces: Number(r.pieces), total_qty: Number(r.total_qty),
      });
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => (a.status === b.status ? b.piece_qty - a.piece_qty : a.status === 'FULL_SLEEVE' ? -1 : 1));
    }
    if (atpRes.error) {
      console.error('[ATP] v_sku_atp fetch failed:', atpRes.error.message);
    }
    const skuData = (skuRes.data ?? []) as unknown as Sku[];
    const atpData = (atpRes.data ?? []) as SkuAtp[];

    const atpMap: Record<string, SkuAtp> = {};
    for (const row of atpData) atpMap[row.sku_id] = row;

    // Timing belts without a roll length can't be lot-tracked yet, so they stay out of the picker.
    _skuCache = skuData.filter((s) => s.product_type !== 'TIMING_BELT' || Number(s.roll_length_mm) > 0).map((s) => ({
      ...s,
      physical_prod_stock: atpMap[s.id]?.physical_prod_stock ?? s.current_stock,
      atp_stock:           atpMap[s.id]?.atp_stock ?? s.current_stock,
      reserved_qty:        atpMap[s.id]?.reserved_qty ?? 0,
      lot_groups:          groups[s.id],
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
  usedElsewhere,
  placeholder = 'Search SKU code, name, size…',
}: {
  value: SkuPick;
  onChange: (val: SkuPick) => void;
  cacheVersion: number;
  /** Quantity other order lines already use of this SKU / classification (screen-only deduction) */
  usedElsewhere?: (sku: SkuWithAtp, group: LotGroup | null) => number;
  placeholder?: string;
}) {
  const [skus, setSkus] = useState<SkuWithAtp[]>(_skuCache ?? []);
  const [loadingSkus, setLoadingSkus] = useState(!_skuCache);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'CUT_PCS' | 'FULL_SLEEVE' | 'ALL'>('CUT_PCS');
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

  // One option per classification: a timing belt with 4×50 Full Sleeve and 1×50 Cut Pcs
  // appears as two separate, tagged entries. Other SKUs stay a single entry.
  const allOptions: { sku: SkuWithAtp; group: LotGroup | null }[] = filtered.flatMap((sku): { sku: SkuWithAtp; group: LotGroup | null }[] =>
    sku.lot_groups && sku.lot_groups.length > 0
      ? sku.lot_groups.map((g) => ({ sku, group: g }))
      : [{ sku, group: null }],
  );
  // Tabs only apply to lot-tracked entries; V-belts / conveyor / no-lot SKUs always show.
  const cutCount = allOptions.filter((o) => o.group?.status === 'CUT_PCS').length;
  const fullCount = allOptions.filter((o) => o.group?.status === 'FULL_SLEEVE').length;
  const options = allOptions
    .filter((o) => !o.group || tab === 'ALL' || o.group.status === tab)
    // Cut pieces always first
    .sort((a, b) => (a.group?.status === 'CUT_PCS' ? 0 : 1) - (b.group?.status === 'CUT_PCS' ? 0 : 1));

  function selectOption(sku: SkuWithAtp, group: LotGroup | null) {
    onChange({
      sku,
      group,
      query: sku.display_name,
    });
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

      {open && (allOptions.length > 0) && (
        <div
          ref={dropdownRef}
          className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg max-h-72 overflow-y-auto"
        >
          <div className="sticky top-0 z-10 flex gap-1 bg-surface border-b border-line px-2 py-1.5">
            {([['CUT_PCS', `Cut Pcs (${cutCount})`], ['FULL_SLEEVE', `Full Sleeve (${fullCount})`], ['ALL', 'Show all']] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTab(k)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                  tab === k ? 'bg-brand text-white border-brand' : 'bg-surface border-line text-ink-2 hover:border-brand'
                }`}
              >{label}</button>
            ))}
          </div>
          {options.length === 0 && (
            <p className="px-3 py-4 text-center text-[12px] text-ink-3">
              Nothing in this tab — try {tab === 'CUT_PCS' ? 'Full Sleeve' : 'Show all'}.
            </p>
          )}
          {options.map(({ sku, group }) => {
            const used = usedElsewhere ? usedElsewhere(sku, group) : 0;
            const avail = Math.max(0, (group ? group.total_qty : sku.atp_stock) - used);
            const atpColour =
              avail <= 0
                ? 'text-danger'
                : !group && avail < (sku.min_stock_level ?? 0)
                ? 'text-warn'
                : 'text-ok';
            return (
              <button
                key={`${sku.id}-${group?.status ?? 'x'}-${group?.piece_qty ?? 0}`}
                className={`w-full text-left px-3 py-2 transition-colors flex items-center justify-between gap-2 ${
                  group && avail <= 0 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-subtle'
                }`}
                disabled={!!group && avail <= 0}
                onClick={() => selectOption(sku, group)}
                type="button"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">
                    <span className="font-mono text-brand">{sku.sku_code}</span>{' – '}{sku.display_name}
                    {group && (
                      <span className={`badge ml-2 ${group.status === 'FULL_SLEEVE' ? 'badge-ok' : 'badge-warn'}`}>
                        {groupLabel(group)}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-ink-3 truncate">{sku.brand_name} · {sku.exact_size}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[11px] text-ink-3">{group ? groupText(group) : sku.unit_code}</div>
                  <div className={`text-[11px] font-medium ${atpColour}`}>
                    {avail} {group ? 'mm ' : ''}avail
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {open && !loadingSkus && allOptions.length === 0 && value.query.length > 0 && (
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

// ─── Collapsible pane ─────────────────────────────────────────────────────────

function Pane({
  title, subtitle, count, tone = 'neutral', open, onToggle, children,
}: {
  title: string;
  subtitle?: string;
  count?: number;
  tone?: 'neutral' | 'warn';
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border bg-surface overflow-hidden ${tone === 'warn' && (count ?? 0) > 0 ? 'border-warn/60' : 'border-line'}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-subtle transition-colors"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={15} className="text-ink-3" /> : <ChevronRight size={15} className="text-ink-3" />}
        <span className="text-[14px] font-semibold">{title}</span>
        {count != null && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            tone === 'warn' && count > 0 ? 'bg-warn/20 text-warn' : 'bg-subtle text-ink-3 border border-line'
          }`}>{count}</span>
        )}
        {subtitle && <span className="text-[12px] text-ink-3 truncate">{subtitle}</span>}
      </button>
      {open && <div className="border-t border-line">{children}</div>}
    </section>
  );
}

// ─── Mismatch Pane (content) ──────────────────────────────────────────────────
// Two traced kinds of difference between book and physical stock:
//   1. Pending outward  — production planned/consumed stock, outward not posted yet
//   2. Book-only moves  — a waste or adjustment changed book stock; apply it to physical

function MismatchPane({
  mismatches, pending, onRecordOutward, onResolve, resolvingId, loadingMismatches,
}: {
  mismatches: SkuMismatch[];
  pending: PendingAdjustment[];
  onRecordOutward: (item: MismatchOrderItem) => void;
  onResolve: (p: PendingAdjustment) => void;
  resolvingId: string | null;
  loadingMismatches: boolean;
}) {
  if (loadingMismatches) {
    return (
      <div className="p-4 flex items-center gap-2 text-[13px] text-ink-3">
        <Loader size={14} className="animate-spin" /> Checking stock status…
      </div>
    );
  }
  if (mismatches.length === 0 && pending.length === 0) {
    return <p className="p-4 text-[13px] text-ink-3">Book and physical stock agree — nothing to reconcile.</p>;
  }

  return (
    <div className="divide-y divide-line">
      {pending.length > 0 && (
        <div className="p-4 space-y-2">
          <p className="text-[11px] text-ink-3 font-medium uppercase tracking-wide">
            Stock movements not yet applied to production stock
          </p>
          {pending.map((p) => {
            const unit = p.skus?.unit_code ?? '';
            const removed = p.delta < 0;
            return (
              <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-line px-3 py-2">
                <div className="text-[12px] min-w-0">
                  <span className="font-mono text-brand font-medium">{p.skus?.sku_code}</span>
                  <span className="text-ink ml-1.5">{p.skus?.display_name}</span>
                  <div className="text-[11px] text-ink-3 mt-0.5">
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
          <p className="px-4 pt-4 text-[11px] text-ink-3 font-medium uppercase tracking-wide">
            Pending outward
          </p>
          {mismatches.map((m) => (
            <div key={m.sku_id} className="p-4 space-y-3">
              <div>
                <p className="text-[13px] font-semibold">
                  <span className="font-mono text-brand">{m.sku_code}</span>{' – '}{m.display_name}
                </p>
                <div className="flex items-center gap-3 mt-1 text-[12px] flex-wrap">
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

              {m.open_order_items.length > 0 && m.stock_gap > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] text-ink-3 font-medium uppercase tracking-wide">
                    Open production orders consuming this stock:
                  </p>
                  {m.open_order_items.map((oi) => (
                    <div key={oi.poi_id} className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-line px-3 py-2">
                      <div className="text-[12px] min-w-0">
                        <span className="font-mono text-brand font-medium">{oi.order_no}</span>
                        {oi.customer_name && <span className="text-ink-3 ml-1.5">· {oi.customer_name}</span>}
                        <span className="text-ink ml-2 font-medium">{oi.quantity} {oi.unit_code}</span>
                        <span className={`ml-2 text-[11px] px-1.5 py-0.5 rounded-full ${
                          oi.order_status === 'IN_PROGRESS' ? 'bg-ok/10 text-ok' :
                          oi.order_status === 'SENT' ? 'bg-brand/10 text-brand' :
                          'bg-warn/10 text-warn'
                        }`}>{STATUS_LABEL[oi.order_status]}</span>
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

              {(m.open_order_items.length === 0 || m.stock_gap < 0) && (
                <p className="text-[12px] text-ink-3 italic">
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

interface MovementRow {
  id: string;
  txn_no: string;
  txn_type: string;
  txn_mode: string;
  quantity: number;
  unit_code: string;
  occurred_at: string;
  user_name: string;
  notes: string | null;
  lot_breakdown: { lot_no: string; status: string; qty: number }[] | null;
  skus: { sku_code: string; display_name: string } | null;
}

function MovementsPane({ rows, loading, pendingMovementIds }: { rows: MovementRow[]; loading: boolean; pendingMovementIds: Set<string> }) {
  if (loading) return <div className="p-4 flex items-center gap-2 text-[13px] text-ink-3"><Loader size={14} className="animate-spin" /> Loading…</div>;
  if (rows.length === 0) return <p className="p-4 text-[13px] text-ink-3">No stock movements yet.</p>;
  return (
    <div className="divide-y divide-line max-h-96 overflow-y-auto">
      {rows.map((m) => {
        const isAdj = m.txn_type === 'ADJUSTMENT';
        const tag = isAdj ? (m.notes?.includes(' wasted:') ? 'Waste' : 'Adjustment') : m.txn_type === 'INWARD' ? 'Inward' : 'Outward';
        const sync = m.txn_type === 'INWARD'
          ? 'Book + physical'
          : m.txn_type === 'OUTWARD' ? 'Physical already planned'
          : pendingMovementIds.has(m.id) ? 'Awaiting production' : 'Reconciled';
        return (
          <div key={m.id} className="px-4 py-2 flex items-center justify-between gap-3 text-[12px]">
            <div className="min-w-0">
              <span className="font-mono text-brand">{m.skus?.sku_code}</span>
              <span className="text-ink ml-1.5">{m.skus?.display_name}</span>
              <div className="text-[11px] text-ink-3 truncate">
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
              <div className={`text-[11px] ${sync === 'Awaiting production' ? 'text-warn font-semibold' : 'text-ink-3'}`}>{sync}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Line item row type ───────────────────────────────────────────────────────

interface LineItem {
  id: string;
  skuSearch: SkuPick;
  quantity: string;
  /** Direct orders: typed product name / unit (no SKU) */
  manualName: string;
  manualUnit: 'MM' | 'PCS';
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
    manualName: '',
    manualUnit: 'MM',
    allocations: [],
  };
}

function makeEmptyForm() {
  return {
    isDirect: false,
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

/** "Cut Pcs 50, Full Sleeve 20" from a line's chosen lots */
function allocDetail(allocs: LotAllocation[]): string {
  const sum: Record<string, number> = {};
  for (const a of allocs) sum[a.status] = (sum[a.status] ?? 0) + a.qty;
  return (['CUT_PCS', 'FULL_SLEEVE'] as const)
    .filter((k) => sum[k])
    .map((k) => `${k === 'CUT_PCS' ? 'Cut Pcs' : 'Full Sleeve'} ${sum[k]}`)
    .join(', ');
}

/** Quantity other lines already use of this SKU (and classification, when given). Screen-only. */
function usedElsewhereIn(items: LineItem[], excludeId: string, sku: { id: string }, group: LotGroup | null): number {
  return items
    .filter((o) =>
      o.id !== excludeId &&
      o.skuSearch.sku?.id === sku.id &&
      (group
        ? o.skuSearch.group?.status === group.status && o.skuSearch.group?.piece_qty === group.piece_qty
        : !o.skuSearch.group))
    .reduce((sum, o) => sum + (parseFloat(o.quantity) || 0), 0);
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
  const [showForm, setShowForm] = useState(true);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [movementsOpen, setMovementsOpen] = useState(false);
  const [mismatchOpen, setMismatchOpen] = useState(false);
  const [directOpen, setDirectOpen] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptModel | null>(null);
  const [allocMap, setAllocMap] = useState<Record<string, { label: string; qty: number; piece: number }[]>>({});

  async function loadAllocs(list: ProductionOrder[]) {
    const ids = list.flatMap((o) => (o.items ?? []).map((i) => i.id));
    if (ids.length === 0) { setAllocMap({}); return; }
    const { data } = await db
      .from('lot_allocations')
      .select('item_id,allocated_qty,lot_status,piece_qty,sku_lots(status,current_qty)')
      .in('item_id', ids);
    const m: Record<string, { label: string; qty: number; piece: number }[]> = {};
    for (const r of (data ?? []) as any[]) {
      const status = r.lot_status ?? r.sku_lots?.status ?? 'CUT_PCS';
      (m[r.item_id] ??= []).push({
        label: status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs',
        qty: Number(r.allocated_qty),
        piece: Number(r.piece_qty ?? r.sku_lots?.current_qty ?? 0),
      });
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => (a.label === b.label ? 0 : a.label === 'Cut Pcs' ? -1 : 1));
    setAllocMap(m);
  }
  useEffect(() => { loadAllocs(orders); }, [orders]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pending, setPending] = useState<PendingAdjustment[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [loadingMovements, setLoadingMovements] = useState(false);
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

  const { refresh: refreshCatalog } = useCatalog();
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

    const pend = await db
      .from('prod_pending_adjustments')
      .select('*, skus(sku_code,display_name,unit_code)')
      .is('resolved_at', null)
      .order('created_at', { ascending: false });
    if (!pend.error && pend.data) setPending(pend.data as unknown as PendingAdjustment[]);
    setLoadingMismatches(false);
  }

  async function fetchMovements() {
    setLoadingMovements(true);
    const { data } = await db
      .from('inventory_movements')
      .select('id,txn_no,txn_type,txn_mode,quantity,unit_code,occurred_at,user_name,notes,lot_breakdown,skus(sku_code,display_name)')
      .order('occurred_at', { ascending: false })
      .limit(40);
    setMovements((data ?? []) as unknown as MovementRow[]);
    setLoadingMovements(false);
  }

  async function handleResolve(p: PendingAdjustment) {
    setResolvingId(p.id);
    const { error: rerr } = await db.rpc('resolve_prod_adjustment', { p_id: p.id });
    setResolvingId(null);
    if (rerr) { window.alert(rerr.message); return; }
    refreshAll();
  }

  // Fetch mismatches on mount and after any action
  useEffect(() => { fetchMismatches(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function refreshAll() {
    refreshCatalog();            // Inventory view must see the new lot state
    loadAllocs(orders);
    if (movementsOpen) fetchMovements();
    invalidateSkuCache();
    setSkuVersion(getSkuVersion());
    fetchMismatches();
  }

  useEffect(() => { if (movementsOpen) fetchMovements(); }, [movementsOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const needsDeliveryNote = form.delivery_mode === 'Courier' || form.delivery_mode === 'Transportation';

  const previewMessage = buildMessage({
    direct: form.isDirect,
    customer_name: form.customer_name,
    items: form.items.map((li) => form.isDirect
      ? { display_name: li.manualName, quantity: li.quantity, unit_code: li.manualUnit }
      : {
          display_name: li.skuSearch.sku?.display_name ?? '',
          quantity: li.quantity,
          unit_code: li.skuSearch.sku?.unit_code ?? '',
          detail: allocDetail(li.allocations),
        }),
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
  function addItem(focusName = false) {
    setForm((f) => ({ ...f, items: [...f.items, makeLineItem()] }));
    if (focusName) {
      setTimeout(() => {
        const els = document.querySelectorAll<HTMLInputElement>('[data-name-for]');
        els[els.length - 1]?.focus();
      }, 30);
    }
  }

  /** Cut Pcs line can't cover the quantity: cap it, then add one Full Sleeve line PER ROLL needed
   *  (a roll is at most roll-size long: 70 short with 50 mm rolls → a 50 line and a 20 line). */
  function addFromNewSleeve(id: string) {
    setForm((f) => {
      const idx = f.items.findIndex((x) => x.id === id);
      const li = f.items[idx];
      const sku = li?.skuSearch.sku;
      const grp = li?.skuSearch.group;
      if (!sku || !grp) return f;
      const avail = Math.max(0, grp.total_qty - usedElsewhereIn(f.items, id, sku, grp));
      let remaining = (parseFloat(li.quantity) || 0) - avail;
      if (remaining <= 0) return f;
      const full = (sku.lot_groups ?? []).find((g) => g.status === 'FULL_SLEEVE');
      if (!full) return f;
      let rollsLeft = Math.max(0, full.pieces - f.items.filter((o) =>
        o.id !== id && o.skuSearch.sku?.id === sku.id && o.skuSearch.group?.status === 'FULL_SLEEVE').length);
      const lines: LineItem[] = [];
      while (remaining > 0 && rollsLeft > 0) {
        const take = Math.min(remaining, full.piece_qty);
        lines.push({
          ...makeLineItem(),
          skuSearch: { sku, query: sku.display_name, group: full },
          quantity: String(take),
        });
        remaining -= take;
        rollsLeft -= 1;
      }
      if (lines.length === 0) return f;
      const items = [...f.items];
      items[idx] = { ...li, quantity: avail > 0 ? String(avail) : '', allocations: [] };
      items.splice(idx + 1, 0, ...lines);
      return { ...f, items };
    });
  }

  /** Quantity typed on a line. A Full Sleeve line can't exceed one roll: extra becomes more lines. */
  function setLineQty(id: string, value: string) {
    setForm((f) => {
      const idx = f.items.findIndex((x) => x.id === id);
      const li = f.items[idx];
      const grp = li?.skuSearch.group;
      const sku = li?.skuSearch.sku;
      const n = parseFloat(value);
      if (!li || !sku || !grp || grp.status !== 'FULL_SLEEVE' || !(n > grp.piece_qty)) {
        return { ...f, items: f.items.map((x) => x.id === id ? { ...x, quantity: value } : x) };
      }
      let remaining = n - grp.piece_qty;
      let rollsLeft = Math.max(0, grp.pieces - f.items.filter((o) =>
        o.skuSearch.sku?.id === sku.id && o.skuSearch.group?.status === 'FULL_SLEEVE').length);
      const lines: LineItem[] = [];
      while (remaining > 0 && rollsLeft > 0) {
        const take = Math.min(remaining, grp.piece_qty);
        lines.push({ ...makeLineItem(), skuSearch: { sku, query: sku.display_name, group: grp }, quantity: String(take) });
        remaining -= take;
        rollsLeft -= 1;
      }
      const items = f.items.map((x) => x.id === id ? { ...x, quantity: String(grp.piece_qty), allocations: [] } : x);
      items.splice(idx + 1, 0, ...lines);
      return { ...f, items };
    });
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
    const isDirect = form.isDirect;
    const validItems = isDirect
      ? form.items.filter((li) => li.manualName.trim())
      : form.items.filter((li) => li.skuSearch.sku);
    if (validItems.length === 0) {
      setError(isDirect ? 'Please type at least one product.' : 'Please add at least one SKU item.');
      return;
    }
    if (isDirect && validItems.some((li) => !(parseFloat(li.quantity) > 0))) {
      setError('Enter a quantity for every product.');
      return;
    }

    // Check against physical_prod_stock (atp_stock IS physical in this new system)
    const qtyBySku: Record<string, { sku: SkuWithAtp; total: number }> = {};
    for (const li of isDirect ? [] : validItems) {
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
      .map((li) => (isDirect ? li.manualName.trim() : li.skuSearch.sku!.display_name))
      .join(', ');

    // Final message carries the real order number and the lot classification
    const finalMessage = buildMessage({
      order_no,
      direct: isDirect,
      customer_name: form.customer_name,
      items: validItems.map((li) => isDirect
        ? { display_name: li.manualName.trim(), quantity: li.quantity, unit_code: li.manualUnit }
        : {
            display_name: li.skuSearch.sku!.display_name,
            quantity: li.quantity,
            unit_code: li.skuSearch.sku!.unit_code,
            detail: allocDetail(li.allocations),
          }),
      time_tag: form.time_tag,
      delivery_mode: form.delivery_mode,
      delivery_note: needsDeliveryNote ? form.delivery_note : '',
      assigned_to: form.assigned_to,
      notes: form.notes,
    });

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
        whatsapp_message: finalMessage || null,
        is_direct: isDirect,
        status: 'CREATED',
      })
      .select('*')
      .single();

    if (err) { setError(err.message); setSaving(false); return; }
    if (!created) { setError('Failed to create order.'); setSaving(false); return; }

    const orderId = (created as ProductionOrder).id;

    const itemRows = validItems.map((li) => isDirect
      ? {
          order_id:     orderId,
          sku_id:       null,
          sku_code:     'DIRECT',
          display_name: li.manualName.trim(),
          unit_code:    li.manualUnit,
          quantity:     Number(li.quantity),
        }
      : {
          order_id:     orderId,
          sku_id:       li.skuSearch.sku!.id,
          sku_code:     li.skuSearch.sku!.sku_code,
          display_name: li.skuSearch.sku!.display_name,
          unit_code:    li.skuSearch.sku!.unit_code,
          quantity:     li.quantity ? Number(li.quantity) : 1,
        });

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
    for (let i = 0; i < validItems.length && !isDirect; i++) {
      const li = validItems[i];
      const row = rows[i];
      const sku = li.skuSearch.sku;
      if (!row || !sku?.roll_length_mm) continue;       // only roll-tracked SKUs have lots
      const qtyNeeded = li.quantity ? Number(li.quantity) : 0;
      const totalAllocated = li.allocations.reduce((sum, a) => sum + a.qty, 0);

      let planned = false;
      // 1) the exact lots shown in the picker, when they cover the quantity
      if (li.allocations.length > 0 && totalAllocated === qtyNeeded) {
        const { error: allocErr } = await db.rpc('set_item_lot_allocations', {
          p_item_id: row.id,
          p_allocations: li.allocations.map((a) => ({ lot_id: a.lot_id, qty: a.qty })),
        });
        planned = !allocErr;
      }
      // 2) otherwise let the database plan it from the classification that was picked
      if (!planned && li.skuSearch.group) {
        const g = li.skuSearch.group;
        const { error: planErr } = await db.rpc('plan_item_lots', {
          p_item_id: row.id, p_status: g.status, p_piece_qty: g.piece_qty,
        });
        if (planErr) lotErrors.push(`${sku.sku_code}: ${planErr.message}`);
        else planned = true;
      }
      if (!planned && !li.skuSearch.group) {
        lotErrors.push(`${sku.sku_code}: pick Cut Pcs or Full Sleeve from the search list so the lots can be planned`);
      }
    }

    setSaving(false);

    if (lotErrors.length > 0) {
      const msg =
        `Order ${order_no} was created, but the lots could not be planned for: ${lotErrors.join('; ')}. ` +
        `When outward is recorded these items will use Cut Pcs first, then the oldest Full Sleeve.`;
      setError(msg);
      window.alert(msg);
    }

    const newOrder: ProductionOrder = {
      ...(created as ProductionOrder),
      items: rows,
    };

    setOrders((prev) => [newOrder, ...prev]);
    setForm(makeEmptyForm());
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

  const regularOrders = orders.filter((o) => !o.is_direct);
  const directOrders = orders.filter((o) => o.is_direct);
  const pendingDirect = directOrders.filter(
    (o) => o.status !== 'CANCELLED' && !(o.direct_inward_at && o.direct_outward_at)
  ).length;
  const activeOrders = regularOrders.filter(
    (o) => o.status !== 'CANCELLED' && o.status !== 'COMPLETED'
  );
  const closedOrders = regularOrders.filter(
    (o) => o.status === 'CANCELLED' || o.status === 'COMPLETED'
  );

  function renderOrderCard(order: ProductionOrder) {
    return (
            <div key={order.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-mono text-ink-3">{order.order_no}</span>
                    <span className={`badge ${STATUS_BADGE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
                    {order.is_direct && <span className="badge badge-brand">Direct</span>}
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
                          {(allocMap[item.id] ?? []).length > 0 && (
                            <span className="flex gap-1 flex-wrap">
                              {allocMap[item.id].map((p, k) => (
                                <span
                                  key={k}
                                  className={`badge ${p.label === 'Full Sleeve' ? 'badge-ok' : 'badge-warn'}`}
                                  title={p.label === 'Full Sleeve' && p.piece > p.qty ? `${p.qty} of a ${p.piece} sleeve — rest becomes Cut Pcs` : undefined}
                                >
                                  {p.label} {p.qty}
                                </span>
                              ))}
                            </span>
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

                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => showReceipt(order)}
                    title="Preview and print on thermal paper"
                  >
                    <Printer size={13} /> Print
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => pdfReceipt(order)}
                    title="Download as PDF"
                  >
                    <FileDown size={13} /> PDF
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

              {order.is_direct && (
                <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-ink-3 mr-1">Post in Inventory:</span>
                  {(['INWARD', 'OUTWARD'] as const).map((step) => {
                    const at = step === 'INWARD' ? order.direct_inward_at : order.direct_outward_at;
                    const by = step === 'INWARD' ? order.direct_inward_by : order.direct_outward_by;
                    return (
                      <button
                        key={step}
                        className={`btn btn-sm ${at ? 'btn-secondary' : 'btn-primary'}`}
                        onClick={() => markDirect(order, step, !at)}
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

  async function markDirect(order: ProductionOrder, step: 'INWARD' | 'OUTWARD', done: boolean) {
    if (!done && !window.confirm(`Un-mark ${step.toLowerCase()} as done for ${order.order_no}?`)) return;
    const { error: derr } = await db.rpc('set_direct_step', { p_order_id: order.id, p_step: step, p_done: done });
    if (derr) { window.alert(derr.message); return; }
    const at = done ? new Date().toISOString() : null;
    const by = done ? session.user.full_name : null;
    setOrders((prev) => prev.map((o) => o.id !== order.id ? o : (
      step === 'INWARD'
        ? { ...o, direct_inward_at: at, direct_inward_by: by }
        : { ...o, direct_outward_at: at, direct_outward_by: by }
    )));
  }

  async function showReceipt(order: ProductionOrder) {
    setReceipt(await loadReceiptModel(db, order));
  }
  async function pdfReceipt(order: ProductionOrder) {
    await downloadReceiptPdf(await loadReceiptModel(db, order));
  }

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

      {receipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setReceipt(null)}>
          <div className="bg-surface rounded-xl border border-line shadow-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-line">
              <p className="text-[14px] font-semibold">Thermal print preview · 80 mm</p>
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

      {/* ── 1. New order window (top) ── */}
      <Pane title="New Production Order" open={showForm} onToggle={() => setShowForm((v) => !v)}>
        <div className="p-5 space-y-4">

          {error && <p className="text-[13px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}

          <div>
            <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
              {([[false, 'Regular order'], [true, 'Direct order']] as const).map(([v, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setForm((f) => (f.isDirect === v ? f : { ...f, isDirect: v, items: [makeLineItem()] }))}
                  className={`px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                    form.isDirect === v ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
                  }`}
                >{label}</button>
              ))}
            </div>
            {form.isDirect && (
              <p className="text-[11px] text-ink-3 mt-1.5">
                Supplier ships straight to the customer — no SKU and no stock effect. It will be listed under Direct Orders so staff remember to post the inward and outward.
              </p>
            )}
          </div>

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
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => addItem()}>
                <Plus size={12} /> Add Item
              </button>
            </div>

            <div className="space-y-2">
              {form.items.map((li, idx) => {
                if (form.isDirect) {
                  return (
                    <div key={li.id} className="rounded-lg border border-line bg-subtle p-3">
                      <div className="flex gap-2 items-start">
                        <span className="text-[11px] text-ink-3 font-mono mt-2.5 w-4 shrink-0 text-center">{idx + 1}</span>
                        <input
                          className="field flex-1 min-w-0"
                          data-name-for={li.id}
                          placeholder="Type product name, press Enter for next line…"
                          value={li.manualName}
                          onChange={(e) => updateItem(li.id, { manualName: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (li.manualName.trim() && idx === form.items.length - 1) addItem(true);
                            }
                          }}
                        />
                        <input
                          className="field w-24 text-center"
                          type="number"
                          min="0"
                          placeholder="Qty"
                          value={li.quantity}
                          onChange={(e) => updateItem(li.id, { quantity: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (li.manualName.trim() && idx === form.items.length - 1) addItem(true);
                            }
                          }}
                        />
                        <select
                          className="field w-20"
                          value={li.manualUnit}
                          onChange={(e) => updateItem(li.id, { manualUnit: e.target.value as 'MM' | 'PCS' })}
                        >
                          <option value="MM">MM</option>
                          <option value="PCS">PCS</option>
                        </select>
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
                    </div>
                  );
                }
                const otherQty = li.skuSearch.sku
                  ? form.items
                      .filter((other) => other.id !== li.id && other.skuSearch.sku?.id === li.skuSearch.sku!.id)
                      .reduce((sum, other) => sum + (parseFloat(other.quantity) || 0), 0)
                  : 0;
                const grp = li.skuSearch.group ?? null;
                // Same classification picked on other lines also draws from this group's pool
                const otherGroupQty = grp
                  ? form.items
                      .filter((o) => o.id !== li.id && o.skuSearch.sku?.id === li.skuSearch.sku?.id &&
                        o.skuSearch.group?.status === grp.status && o.skuSearch.group?.piece_qty === grp.piece_qty)
                      .reduce((sum, o) => sum + (parseFloat(o.quantity) || 0), 0)
                  : otherQty;
                // A Cut Pcs pick may be topped up from new sleeves, so its limit includes free Full Sleeve stock.
                const freshTotal = (li.skuSearch.sku?.lot_groups ?? [])
                  .filter((g) => g.status === 'FULL_SLEEVE')
                  .reduce((a, g) => a + g.total_qty, 0);
                const otherFullQty = form.items
                  .filter((o) => o.id !== li.id && o.skuSearch.sku?.id === li.skuSearch.sku?.id && o.skuSearch.group?.status === 'FULL_SLEEVE')
                  .reduce((a, o) => a + (parseFloat(o.quantity) || 0), 0);
                const freshFree = Math.max(0, freshTotal - otherFullQty);
                const freshExtra = grp?.status === 'CUT_PCS' ? freshFree : 0;
                const grpAvail = grp ? Math.max(0, grp.total_qty - otherGroupQty) : 0;
                const shortfall = grp?.status === 'CUT_PCS' ? (parseFloat(li.quantity) || 0) - grpAvail : 0;
                const effectiveAtp = li.skuSearch.sku
                  ? (grp ? grp.total_qty + freshExtra - otherGroupQty : li.skuSearch.sku.atp_stock - otherQty)
                  : Infinity;

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
                          onChange={(val) => updateItem(li.id, {
                            skuSearch: val,
                            allocations: [],
                          })}
                          cacheVersion={skuVersion}
                          usedElsewhere={(sku, group) => usedElsewhereIn(form.items, li.id, sku, group)}
                          placeholder="Search SKU…"
                        />
                        {li.skuSearch.sku && (
                          <p className="text-[11px] text-ink-3 mt-0.5 pl-0.5">
                            {grp ? (
                              <>
                                <span className={`badge mr-1.5 ${grp.status === 'FULL_SLEEVE' ? 'badge-ok' : 'badge-warn'}`}>{groupLabel(grp)}</span>
                                {groupText(grp)}
                              </>
                            ) : (
                              <>{li.skuSearch.sku.brand_name} · {li.skuSearch.sku.exact_size}</>
                            )}
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
                          onChange={(e) => setLineQty(li.id, e.target.value)}
                        />
                        {li.skuSearch.sku && (
                          grp ? (
                            // Only the picked classification; live: what is left after THIS line's quantity
                            <p className="text-[10px] text-center mt-0.5 leading-tight">
                              <span className="text-ink-3">{li.skuSearch.sku.unit_code} · </span>
                              <span className={Math.max(0, grpAvail - (parseFloat(li.quantity) || 0)) === 0 ? 'text-warn font-semibold' : 'text-ok'}>
                                {Math.max(0, grpAvail - (parseFloat(li.quantity) || 0))} left
                              </span>
                              <span className="text-ink-3 block">of {grpAvail} {groupLabel(grp)}</span>
                            </p>
                          ) : (
                            <AtpBadge sku={li.skuSearch.sku} qty={li.quantity} otherQty={otherQty} />
                          )
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

                    {grp?.status === 'CUT_PCS' && shortfall > 0 && freshFree > 0 && (
                      <div className="pl-6 mt-2">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => addFromNewSleeve(li.id)}
                        >
                          <Plus size={12} /> Add from new sleeve ({shortfall} {li.skuSearch.sku?.unit_code} more)
                        </button>
                      </div>
                    )}

                    {isLotTracked && qtyNum > 0 && (
                      <LotAllocationPicker
                        skuId={li.skuSearch.sku!.id}
                        unitCode={li.skuSearch.sku!.unit_code}
                        qtyNeeded={qtyNum}
                        lotFilter={grp ? { status: grp.status, pieceQty: grp.piece_qty } : undefined}
                        reservedByEarlier={(() => {
                          const m: Record<string, number> = {};
                          for (const o of form.items.slice(0, idx)) for (const a of o.allocations) m[a.lot_id] = (m[a.lot_id] ?? 0) + a.qty;
                          return m;
                        })()}
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
              onClick={() => addItem()}
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
      </Pane>

      {/* ── 2. Orders ── */}
      <Pane
        title="Orders"
        subtitle={`${activeOrders.length} active · ${closedOrders.length} closed`}
        count={activeOrders.length}
        open={ordersOpen}
        onToggle={() => setOrdersOpen((v) => !v)}
      >
      <div className="p-4 space-y-3">
      {/* Empty state */}
      {regularOrders.length === 0 && (
        <div className="card p-10 text-center">
          <p className="text-[13px] text-ink-3">No production orders yet. Create one to get started.</p>
        </div>
      )}

      {/* ── Active Orders ── */}
      {activeOrders.length > 0 && (
        <div className="space-y-3">
          {activeOrders.map((order) => renderOrderCard(order))}
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
      </Pane>

      {/* ── 2b. Direct orders ── */}
      <Pane
        title="Direct Orders"
        subtitle="supplier ships straight to customer — remember to post inward and outward"
        count={pendingDirect}
        tone="warn"
        open={directOpen}
        onToggle={() => setDirectOpen((v) => !v)}
      >
        <div className="p-4 space-y-3">
          {directOrders.length === 0 && (
            <p className="text-[13px] text-ink-3">No direct orders yet. Choose “Direct order” when creating one.</p>
          )}
          {directOrders.map((order) => renderOrderCard(order))}
        </div>
      </Pane>

      {/* ── 3. Movements ── */}
      <Pane
        title="Movements"
        subtitle="latest stock movements and whether production stock has caught up"
        open={movementsOpen}
        onToggle={() => setMovementsOpen((v) => !v)}
      >
        <MovementsPane rows={movements} loading={loadingMovements} pendingMovementIds={new Set(pending.map((p) => p.movement_id))} />
      </Pane>

      {/* ── 4. Mismatch ── */}
      <Pane
        title="Mismatch"
        subtitle="book vs physical production stock, traced to its cause"
        count={mismatches.length + pending.length}
        tone="warn"
        open={mismatchOpen}
        onToggle={() => setMismatchOpen((v) => !v)}
      >
        <MismatchPane
          mismatches={mismatches}
          pending={pending}
          onRecordOutward={setOutwardTarget}
          onResolve={handleResolve}
          resolvingId={resolvingId}
          loadingMismatches={loadingMismatches}
        />
      </Pane>

    </div>
  );
}
