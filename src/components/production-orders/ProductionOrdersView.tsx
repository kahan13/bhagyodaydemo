'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Plus, Pencil, Search, X, Loader, Send, ArrowRight } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import type {
  ProductionOrder,
  ProductionOrderItem,
  ProductType,
  Session,
  TimeTag,
  DeliveryMode,
} from '@/lib/types';
import { useListNav } from '@/lib/useListNav';
import { onDataChanged } from '@/lib/dataSync';
import { takeAction } from '@/lib/keytips';
import LotAllocationPicker, { type LotAllocation } from './LotAllocationPicker';
import type { LotGroup } from '@/lib/types';
import { groupText, groupLabel } from '@/components/inventory/LotBreakdown';
import { fmtQty } from '@/lib/format';
import { makeMatcher, hasQuery } from '@/lib/search';
import { loadSkus, peekSkus, invalidateSkuCache, getSkuVersion, type SkuWithAtp, type SkuPick } from './skuCache';
import { buildMessage, openWhatsApp } from './poShared';

/**
 * Production Order — creating an order.
 * Following it afterwards (in progress, completed, outward, mismatch) happens on
 * "Production Order in Progress".
 */

// ─── Constants ────────────────────────────────────────────────────────────────


const TIME_TAGS: TimeTag[] = ['15-20 min', '30-40 min', '1 hour', '2 hours'];
const DELIVERY_MODES: DeliveryMode[] = ['Hand', 'Porter', 'Courier', 'Transportation'];


const CATEGORY_PILLS: [ProductType, string][] = [
  ['TIMING_BELT', 'Timing Belt'], ['V_BELT', 'V-Belt'], ['CONVEYOR_BELT', 'Conveyor'],
];

/** The category last picked on any order line — the next new line starts there. */
let lastCategory: ProductType = 'TIMING_BELT';


// ─── ATP badge helper ─────────────────────────────────────────────────────────

function AtpBadge({ sku, qty, otherQty = 0 }: { sku: SkuWithAtp; qty: string; otherQty?: number }) {
  const effectiveAtp = sku.atp_stock - otherQty;
  const entered = parseFloat(qty) || 0;
  const afterAlloc = effectiveAtp - entered;

  let colour: string;
  if (effectiveAtp <= 0) colour = 'text-danger font-semibold';
  else if (sku.product_type !== 'TIMING_BELT' && effectiveAtp < (sku.min_stock_level ?? 0)) colour = 'text-warn font-semibold';
  else colour = 'text-ok';

  return (
    <p className="text-[12px] text-center mt-0.5 leading-tight">
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
  placeholder = 'Search size, brand or code (h100 = h-100)',
  lead,
  headerRight,
  below,
  trailing,
}: {
  value: SkuPick;
  onChange: (val: SkuPick) => void;
  cacheVersion: number;
  /** Quantity other order lines already use of this SKU / classification (screen-only deduction) */
  usedElsewhere?: (sku: SkuWithAtp, group: LotGroup | null) => number;
  placeholder?: string;
  /** shown before the category pills (the line number) */
  lead?: React.ReactNode;
  /** shown at the far right of the pill row (remove button) */
  headerRight?: React.ReactNode;
  /** shown under the search box (what was picked) */
  below?: React.ReactNode;
  /** shown to the right of the search box, level with it (quantity) */
  trailing?: React.ReactNode;
}) {
  const [skus, setSkus] = useState<SkuWithAtp[]>(peekSkus() ?? []);
  const [loadingSkus, setLoadingSkus] = useState(!peekSkus());
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'CUT_PCS' | 'FULL_SLEEVE' | 'ALL'>('CUT_PCS');
  // Which kind of belt is being searched. A new line starts on whatever was used last,
  // so ten V-belt lines in a row don't need ten clicks.
  const [category, setCategory] = useState<ProductType>(value.sku?.product_type ?? lastCategory);
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

  // Only the chosen category is searched, so "A-38" can never turn up a conveyor or a timing belt.
  const inCategory = skus.filter((s) => s.product_type === category);
  const match = makeMatcher(value.query);
  const filtered = !hasQuery(value.query)
    ? inCategory.slice(0, 40)
    : inCategory.filter((s) => match([s.sku_code, s.display_name, s.exact_size, s.brand_name, s.search_text])).slice(0, 40);

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
    .filter((o) => !o.group || category !== 'TIMING_BELT' || tab === 'ALL' || o.group.status === tab)
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

  const nav = useListNav({
    count: options.length,
    open: open && allOptions.length > 0,
    setOpen,
    onPick: (i) => {
      const o = options[i];
      if (!o) return;
      const used = usedElsewhere ? usedElsewhere(o.sku, o.group) : 0;
      const avail = Math.max(0, (o.group ? o.group.total_qty : o.sku.atp_stock) - used);
      if (o.group && avail <= 0) return;
      selectOption(o.sku, o.group);
    },
    isDisabled: (i) => {
      const o = options[i];
      if (!o || !o.group) return false;
      const used = usedElsewhere ? usedElsewhere(o.sku, o.group) : 0;
      return Math.max(0, o.group.total_qty - used) <= 0;
    },
  });

  function pickCategory(next: ProductType) {
    if (next === category) return;
    setCategory(next);
    lastCategory = next;
    // the chosen product belongs to the old category, so start the line afresh
    onChange({ sku: null, query: '' });
    setTab(next === 'TIMING_BELT' ? 'CUT_PCS' : 'ALL');
    inputRef.current?.focus();
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        {lead}
        <div className="flex gap-1 flex-wrap" role="group" aria-label="Product category">
          {CATEGORY_PILLS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => pickCategory(t)}
              aria-pressed={category === t}
              className={`px-2.5 py-0.5 rounded-full text-[13px] font-medium border transition-colors ${
                category === t ? 'bg-brand text-white border-brand' : 'bg-surface border-line text-ink-2 hover:border-brand hover:text-brand'
              }`}
            >{label}</button>
          ))}
        </div>
        {headerRight && <div className="ml-auto">{headerRight}</div>}
      </div>

      {/* search and quantity share one row, so the boxes line up */}
      <div className="flex gap-2 items-start">
      <div className="flex-1 min-w-0">
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
          onKeyDown={nav.onKeyDown}
          role="combobox"
          aria-expanded={open}
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
          ref={(el) => { (dropdownRef as React.MutableRefObject<HTMLDivElement | null>).current = el; (nav.listRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
          className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg max-h-72 overflow-y-auto"
        >
          {category === 'TIMING_BELT' && (
          <div className="sticky top-0 z-10 flex gap-1 bg-surface border-b border-line px-2 py-1.5">
            {([['CUT_PCS', `Cut Pcs (${cutCount})`], ['FULL_SLEEVE', `Full Sleeve (${fullCount})`], ['ALL', 'Show all']] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTab(k)}
                className={`px-2.5 py-1 rounded-full text-[13px] font-medium border transition-colors ${
                  tab === k ? 'bg-brand text-white border-brand' : 'bg-surface border-line text-ink-2 hover:border-brand'
                }`}
              >{label}</button>
            ))}
          </div>
          )}
          {options.length === 0 && (
            <p className="px-3 py-4 text-center text-[14px] text-ink-3">
              Nothing in this tab — try {tab === 'CUT_PCS' ? 'Full Sleeve' : 'Show all'}.
            </p>
          )}
          {options.map(({ sku, group }, idx) => {
            const used = usedElsewhere ? usedElsewhere(sku, group) : 0;
            const avail = Math.max(0, (group ? group.total_qty : sku.atp_stock) - used);
            const atpColour =
              avail <= 0
                ? 'text-danger'
                : !group && sku.product_type !== 'TIMING_BELT' && avail < (sku.min_stock_level ?? 0)
                ? 'text-warn'
                : 'text-ok';
            return (
              <button
                key={`${sku.id}-${group?.status ?? 'x'}-${group?.piece_qty ?? 0}`}
                data-nav-idx={idx}
                tabIndex={-1}
                onMouseEnter={() => nav.setCursor(idx)}
                className={`w-full text-left px-3 py-2 transition-colors flex items-center justify-between gap-2 ${
                  group && avail <= 0 ? 'opacity-40 cursor-not-allowed' : idx === nav.cursor ? 'bg-brand-soft' : 'hover:bg-subtle'
                }`}
                disabled={!!group && avail <= 0}
                onClick={() => selectOption(sku, group)}
                type="button"
              >
                <div className="min-w-0">
                  <div className="text-[15px] font-medium truncate">
                    <span className="font-mono text-brand">{sku.sku_code}</span>{' – '}{sku.display_name}
                    {group && (
                      <span className={`badge ml-2 ${group.status === 'FULL_SLEEVE' ? 'badge-ok' : 'badge-warn'}`}>
                        {groupLabel(group)}
                      </span>
                    )}
                  </div>
                  <div className="text-[13px] text-ink-3 truncate">{sku.brand_name} · {sku.exact_size}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[13px] text-ink-3">{group ? groupText(group) : sku.unit_code}</div>
                  <div className={`text-[13px] font-medium ${atpColour}`}>
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
          className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg px-3 py-4 text-center text-[14px] text-ink-3"
        >
          No SKUs match &quot;{value.query}&quot;
        </div>
      )}
      </div>
      {below}
      </div>
      {trailing}
      </div>
    </div>
  );
}


// ─── Line item row type ───────────────────────────────────────────────────────

interface LineItem {
  id: string;
  skuSearch: SkuPick;
  quantity: string;
  /** MM × PCS entry (timing belts, and direct lines in MM). quantity = pieces × mm. */
  pieces: string;
  mm: string;
  /** Direct orders: typed product name / unit (no SKU) */
  manualName: string;
  manualUnit: 'MM' | 'PCS';
  /** Which physical lots (rolls) this line should draw from. Only meaningful
   *  for timing belts (lot-tracked by product type); empty for everything else — those post
   *  straight to the book ledger exactly as they always have. */
  allocations: LotAllocation[];
}

function makeLineItem(): LineItem {
  return {
    id: Math.random().toString(36).slice(2),
    skuSearch: { sku: null, query: '' },
    quantity: '',
    pieces: '',
    mm: '',
    manualName: '',
    manualUnit: 'MM',
    allocations: [],
  };
}

/** Pieces × MM shown on a line. If the quantity was changed by other logic (spill into extra lines,
 *  shortfall cap …) the stored boxes no longer match, so show it as 1 × quantity. */
function lineQM(li: { quantity: string; pieces: string; mm: string }): { pieces: string; mm: string } {
  const q = Number(li.quantity) || 0;
  if ((Math.floor(Number(li.pieces)) || 0) * (Number(li.mm) || 0) === q) return { pieces: li.pieces, mm: li.mm };
  return q > 0 ? { pieces: '1', mm: String(q) } : { pieces: '', mm: '' };
}
/** pieces × mm of a line, only for lines entered as MM × PCS (timing belts / direct MM lines). */
function qmOf(li: LineItem, isDirect: boolean): { pieces: number; mm: number } | null {
  const isQm = isDirect ? li.manualUnit === 'MM' : li.skuSearch.sku?.product_type === 'TIMING_BELT';
  if (!isQm) return null;
  const qm = lineQM(li);
  const pieces = Math.floor(Number(qm.pieces)) || 0, mm = Number(qm.mm) || 0;
  return pieces > 0 && mm > 0 && pieces * mm === Number(li.quantity) ? { pieces, mm } : null;
}
const qmFields = (li: LineItem, isDirect: boolean) => {
  const q = qmOf(li, isDirect);
  return q ? { pieces: String(q.pieces), mm: String(q.mm) } : {};
};
const qmColumns = (li: LineItem, isDirect: boolean) => {
  const q = qmOf(li, isDirect);
  return q ? { pieces: q.pieces, length_mm: q.mm } : {};
};
const qmTotal = (pieces: string, mm: string): string => {
  const t = (Math.floor(Number(pieces)) || 0) * (Number(mm) || 0);
  return t > 0 ? String(Math.round(t * 100) / 100) : '';
};

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
  defaultWhatsapp,
}: {
  session: Session;
  defaultWhatsapp: string;
}) {
  const [form, setForm] = useState(makeEmptyForm);
  const [whatsapp, setWhatsapp] = useState(defaultWhatsapp);
  const [editingWhatsapp, setEditingWhatsapp] = useState(false);
  const [whatsappDraft, setWhatsappDraft] = useState(defaultWhatsapp);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdOrder, setCreatedOrder] = useState<ProductionOrder | null>(null);
  const [skuVersion, setSkuVersion] = useState(0);

  const { refresh: refreshCatalog } = useCatalog();
  const db = supabaseBrowser();
  const canCreate = session.permissions.includes('transactions.create');

  function focusFirst() {
    setTimeout(() => document.querySelector<HTMLInputElement>('[data-new-order-first]')?.focus(), 60);
  }

  // opened here from another page by Alt+M → OR
  useEffect(() => {
    if (takeAction(['new-order'])) focusFirst();
  }, []);

  // keyboard: "n" puts the cursor in the first field
  useEffect(() => {
    const h = (e: Event) => { if ((e as CustomEvent).detail === 'new-order') focusFirst(); };
    window.addEventListener('bb:action', h);
    return () => window.removeEventListener('bb:action', h);
  }, []);

  function refreshAll() {
    refreshCatalog();            // Inventory view must see the new reservation
    invalidateSkuCache();
    setSkuVersion(getSkuVersion());
  }

  // stock changed anywhere (here, another screen, another tab): the search list must not go stale
  useEffect(() => onDataChanged(() => { invalidateSkuCache(); setSkuVersion(getSkuVersion()); }), []);

  function resetForm() {
    setError(null);
    setForm(makeEmptyForm());
    focusFirst();
  }

  if (!canCreate) {
    return (
      <div className="p-4 lg:p-6 max-w-[700px] mx-auto">
        <div className="card p-8 text-center space-y-3">
          <h1 className="text-[19px] font-semibold">Production Order</h1>
          <p className="text-[15px] text-ink-3">Your role cannot create production orders. You can follow and finish them on the next page.</p>
          <Link href="/production-orders/in-progress" className="btn btn-primary inline-flex">
            Production Order in Progress <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    );
  }

  const needsDeliveryNote = form.delivery_mode === 'Courier' || form.delivery_mode === 'Transportation';

  const previewMessage = buildMessage({
    direct: form.isDirect,
    customer_name: form.customer_name,
    items: form.items.map((li) => form.isDirect
      ? { display_name: li.manualName, quantity: li.quantity, unit_code: li.manualUnit, ...qmFields(li, true) }
      : {
          display_name: li.skuSearch.sku?.display_name ?? '',
          quantity: li.quantity,
          unit_code: li.skuSearch.sku?.unit_code ?? '',
          detail: allocDetail(li.allocations),
          ...qmFields(li, false),
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
  function setLineQty(id: string, value: string, patch: Partial<LineItem> = {}) {
    setForm((f) => {
      const idx = f.items.findIndex((x) => x.id === id);
      const li = f.items[idx];
      const grp = li?.skuSearch.group;
      const sku = li?.skuSearch.sku;
      const n = parseFloat(value);
      if (!li || !sku || !grp || grp.status !== 'FULL_SLEEVE' || !(n > grp.piece_qty)) {
        return { ...f, items: f.items.map((x) => x.id === id ? { ...x, quantity: value, ...patch } : x) };
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
        ? { display_name: li.manualName.trim(), quantity: li.quantity, unit_code: li.manualUnit, ...qmFields(li, true) }
        : {
            display_name: li.skuSearch.sku!.display_name,
            quantity: li.quantity,
            unit_code: li.skuSearch.sku!.unit_code,
            detail: allocDetail(li.allocations),
            ...qmFields(li, false),
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
          ...qmColumns(li, true),
        }
      : {
          order_id:     orderId,
          sku_id:       li.skuSearch.sku!.id,
          sku_code:     li.skuSearch.sku!.sku_code,
          display_name: li.skuSearch.sku!.display_name,
          unit_code:    li.skuSearch.sku!.unit_code,
          quantity:     li.quantity ? Number(li.quantity) : 1,
          ...qmColumns(li, false),
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
      if (!row || sku?.product_type !== 'TIMING_BELT') continue;       // only roll-tracked SKUs have lots
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

    setCreatedOrder(newOrder);
    setForm(makeEmptyForm());
    refreshAll();
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto space-y-4">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold">Production Order</h1>
          <p className="text-[15px] text-ink-3 mt-0.5">Create a new order. Follow it afterwards on Production Order in Progress.</p>
        </div>
        <div className="flex items-center gap-2 text-[15px]">
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
              <button className="text-brand text-[14px] hover:underline" onClick={() => { setWhatsappDraft(whatsapp); setEditingWhatsapp(true); }}>
                <Pencil size={12} className="inline mr-0.5" />Change
              </button>
            </>
          )}
        </div>
      </div>

      {/* The order just created */}
      {createdOrder && (
        <div className="rounded-xl border border-ok/40 bg-ok-soft px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[15px] text-ok font-medium">
            Order <span className="font-mono">{createdOrder.order_no}</span> created.
          </p>
          <div className="flex items-center gap-2">
            <button className="btn btn-secondary btn-sm" onClick={() => openWhatsApp(createdOrder, whatsapp)}>
              <Send size={13} /> Send on WhatsApp
            </button>
            <Link href="/production-orders/in-progress" className="btn btn-primary btn-sm">
              Open in progress <ArrowRight size={13} />
            </Link>
            <button className="btn btn-ghost h-7 w-7 p-0" aria-label="Dismiss" onClick={() => setCreatedOrder(null)}><X size={14} /></button>
          </div>
        </div>
      )}

      {/* ── New order ── */}
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">New Production Order</h2>
          <button className="btn btn-secondary btn-sm" data-kt="N" data-kt-label="New production order" onClick={resetForm}>
            <Plus size={13} /> New
          </button>
        </div>
        <div className="p-5 space-y-4">
          {error && <p className="text-[15px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}

          <div>
            <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
              {([[false, 'Regular order'], [true, 'Direct order']] as const).map(([v, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setForm((f) => (f.isDirect === v ? f : { ...f, isDirect: v, items: [makeLineItem()] }))}
                  className={`px-3.5 py-1.5 rounded-md text-[14px] font-medium transition-colors ${
                    form.isDirect === v ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
                  }`}
                >{label}</button>
              ))}
            </div>
            {form.isDirect && (
              <p className="text-[13px] text-ink-3 mt-1.5">
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
                data-new-order-first
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
                        <span className="text-[13px] text-ink-3 font-mono mt-2.5 w-4 shrink-0 text-center">{idx + 1}</span>
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
                        {li.manualUnit === 'MM' ? (
                          (() => {
                            const qm = lineQM(li);
                            const enter = (e: React.KeyboardEvent) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (li.manualName.trim() && idx === form.items.length - 1) addItem(true);
                              }
                            };
                            return (
                              <>
                                <input
                                  className="field w-24 text-center" inputMode="decimal" placeholder="MM"
                                  value={qm.mm}
                                  onChange={(e) => { const m = e.target.value.replace(/[^0-9.]/g, ''); updateItem(li.id, { pieces: qm.pieces, mm: m, quantity: qmTotal(qm.pieces, m) }); }}
                                />
                                <span className="mt-2 text-ink-3 font-semibold">×</span>
                                <input
                                  className="field w-16 text-center" inputMode="numeric" placeholder="PCS"
                                  value={qm.pieces}
                                  onChange={(e) => { const p = e.target.value.replace(/[^0-9]/g, ''); updateItem(li.id, { pieces: p, mm: qm.mm, quantity: qmTotal(p, qm.mm) }); }}
                                  onKeyDown={enter}
                                />
                                <span className="mt-2 text-[14px] num font-semibold q-total whitespace-nowrap min-w-[70px]">
                                  {li.quantity ? `= ${li.quantity} mm` : ''}
                                </span>
                              </>
                            );
                          })()
                        ) : (
                        <input
                          className="field w-24 text-center"
                          type="number"
                          min="0"
                          placeholder="Qty"
                          value={li.quantity}
                          onChange={(e) => updateItem(li.id, { quantity: e.target.value, pieces: '', mm: '' })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              if (li.manualName.trim() && idx === form.items.length - 1) addItem(true);
                            }
                          }}
                        />
                        )}
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

                // Timing belts are lot-tracked (each lot has its own length). Everything else
                // goes straight to the book ledger, no lot picker shown.
                const isLotTracked = li.skuSearch.sku?.product_type === 'TIMING_BELT';
                const qtyNum = parseFloat(li.quantity) || 0;

                return (
                  <div key={li.id} className="rounded-lg border border-line bg-subtle p-3">
                    <SkuCombobox
                      value={li.skuSearch}
                      onChange={(val) => updateItem(li.id, {
                        skuSearch: val,
                        allocations: [],
                      })}
                      cacheVersion={skuVersion}
                      usedElsewhere={(sku, group) => usedElsewhereIn(form.items, li.id, sku, group)}
                      placeholder="Search size, brand or code (h100 = h-100)"
                      lead={<span className="text-[13px] text-ink-3 font-mono w-4 text-center">{idx + 1}</span>}
                      headerRight={
                        <button
                          type="button"
                          className="btn btn-ghost h-7 w-7 p-0 text-ink-3 hover:text-danger"
                          onClick={() => removeItem(li.id)}
                          disabled={form.items.length === 1}
                          title="Remove item"
                        >
                          <X size={14} />
                        </button>
                      }
                      below={li.skuSearch.sku && (
                          <p className="text-[13px] text-ink-3 mt-0.5 pl-0.5">
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
                      trailing={
                      <div className={`${isLotTracked ? 'w-52' : 'w-24'} shrink-0`}>
                        {isLotTracked ? (() => {
                          const qm = lineQM(li);
                          const over = !!li.skuSearch.sku && parseFloat(li.quantity) > effectiveAtp;
                          const cls = `field text-center ${over ? 'border-danger focus:ring-danger/30' : ''}`;
                          return (
                            <div className="flex items-center gap-1.5">
                              <input className={`${cls} w-24`} inputMode="decimal" placeholder="MM" value={qm.mm}
                                onChange={(e) => { const m = e.target.value.replace(/[^0-9.]/g, ''); setLineQty(li.id, qmTotal(qm.pieces, m), { pieces: qm.pieces, mm: m }); }} />
                              <span className="text-ink-3 font-semibold">×</span>
                              <input className={`${cls} w-16`} inputMode="numeric" placeholder="PCS" value={qm.pieces}
                                onChange={(e) => { const p = e.target.value.replace(/[^0-9]/g, ''); setLineQty(li.id, qmTotal(p, qm.mm), { pieces: p, mm: qm.mm }); }} />
                            </div>
                          );
                        })() : (
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
                        )}
                        {isLotTracked && li.quantity && (
                          <p className="text-[14px] num font-semibold q-total text-center mt-0.5">= {fmtQty(li.quantity, li.skuSearch.sku?.unit_code)}</p>
                        )}
                        {li.skuSearch.sku && (
                          grp ? (
                            // Only the picked classification; live: what is left after THIS line's quantity
                            <p className="text-[12px] text-center mt-0.5 leading-tight">
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
                      }
                    />

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
              className="mt-2 w-full rounded-lg border border-dashed border-line py-2 text-[14px] text-ink-3 hover:border-brand hover:text-brand transition-colors"
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
                    className={`px-3 py-1.5 rounded-full text-[14px] font-medium border transition-colors ${
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
                    className={`px-3 py-1.5 rounded-full text-[14px] font-medium border transition-colors ${
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
            <pre className="text-[14px] text-ink-2 whitespace-pre-wrap font-sans leading-relaxed">{previewMessage}</pre>
          </div>

          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={resetForm}>Clear</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? <Loader size={14} className="animate-spin" /> : <Plus size={14} />}
              Create Order
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
