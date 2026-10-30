'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { Plus, Pencil, Search, X, Loader, Send, ArrowRight, AlertTriangle } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import type {
  ProductionOrder,
  ProductType,
  Session,
  TimeTag,
  DeliveryMode,
} from '@/lib/types';
import { useListNav } from '@/lib/useListNav';
import { onDataChanged } from '@/lib/dataSync';
import { takeAction } from '@/lib/keytips';
import { fmtQty } from '@/lib/format';
import { isLotType, lotUnitWord } from '@/lib/lotUnit';
import { makeMatcher, hasQuery } from '@/lib/search';
import { loadSkus, peekSkus, invalidateSkuCache, getSkuVersion, type SkuWithAtp, type SkuPick } from './skuCache';
import { buildMessage, openWhatsApp, partLine, fromTag, totalLine, type AllocPart } from './poShared';

/**
 * Production Order — creating an order.
 * Following it afterwards (in progress, completed, outward, mismatch) happens on
 * "Production Order in Progress".
 *
 * A line is ONE product. For a roll-tracked product (timing belt, poly V belt) the line holds one
 * or more entries — "MM × PCS, taken from THIS roll" — the first one and any number of extensions
 * of the same product. Everything is saved together by create_production_order_full, in one go:
 * if a roll cannot give what was asked, nothing is created.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const TIME_TAGS: TimeTag[] = ['15-20 min', '30-40 min', '1 hour', '2 hours'];
const DELIVERY_MODES: DeliveryMode[] = ['Hand', 'Porter', 'Courier', 'Transportation'];

const CATEGORY_PILLS: [ProductType, string][] = [
  ['TIMING_BELT', 'Timing Belt'], ['V_BELT', 'V-Belt'], ['CONVEYOR_BELT', 'Conveyor'], ['POLY_V_BELT', 'Poly V Belt'],
];

/** The category last picked on any order line — the next new line starts there. */
let lastCategory: ProductType = 'TIMING_BELT';

const newId = () => Math.random().toString(36).slice(2);

// ─── Rolls (live, from the database) ──────────────────────────────────────────

interface Roll {
  id: string;
  lot_no: string;
  sku_id: string;
  status: 'FULL_SLEEVE' | 'CUT_PCS';
  /** what is physically on the roll */
  current_qty: number;
  /** what is left after OTHER orders' plans (this form's own entries are taken off on screen) */
  free_qty: number;
  roll_length_mm: number;
}
const rollLabel = (r: Roll) => (r.status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs');
/**
 * How the shop names a roll: "Cut Pcs of 230 mm", "Full Sleeve of 450 mm" — no lot numbers.
 * Two rolls that read the same get (1), (2) so they can still be told apart in the list.
 */
function rollNames(rolls: Roll[], unit: string): Record<string, string> {
  const base = (r: Roll) => `${rollLabel(r)} of ${fmtQty(r.current_qty, unit)}`;
  const total: Record<string, number> = {};
  for (const r of rolls) total[base(r)] = (total[base(r)] ?? 0) + 1;
  const seen: Record<string, number> = {};
  const out: Record<string, string> = {};
  for (const r of rolls) {
    const b = base(r);
    seen[b] = (seen[b] ?? 0) + 1;
    out[r.id] = total[b] > 1 ? `${b} (${seen[b]})` : b;
  }
  return out;
}

async function fetchRolls(skuIds: string[]): Promise<Record<string, Roll[]>> {
  const out: Record<string, Roll[]> = {};
  if (skuIds.length === 0) return out;
  const { data } = await supabaseBrowser()
    .from('v_lot_free')
    .select('id,lot_no,sku_id,status,current_qty,free_qty,roll_length_mm,created_at')
    .in('sku_id', skuIds)
    .in('status', ['FULL_SLEEVE', 'CUT_PCS'])
    .order('created_at', { ascending: true });
  for (const r of (data ?? []) as unknown as (Roll & { created_at: string })[]) {
    (out[r.sku_id] ??= []).push({
      ...r, current_qty: Number(r.current_qty), free_qty: Number(r.free_qty), roll_length_mm: Number(r.roll_length_mm),
    });
  }
  // opened rolls (Cut Pcs) first, then new ones; oldest first inside each
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => (a.status === b.status ? 0 : a.status === 'CUT_PCS' ? -1 : 1));
  }
  return out;
}

// ─── SKU search ───────────────────────────────────────────────────────────────

function SkuCombobox({
  value,
  onChange,
  cacheVersion,
  placeholder = 'Search size, brand or code (h100 = h-100)',
  lead,
  headerRight,
}: {
  value: SkuPick;
  onChange: (val: SkuPick) => void;
  cacheVersion: number;
  placeholder?: string;
  /** shown before the category pills (the line number) */
  lead?: React.ReactNode;
  /** shown at the far right of the pill row (remove button) */
  headerRight?: React.ReactNode;
}) {
  const [skus, setSkus] = useState<SkuWithAtp[]>(peekSkus() ?? []);
  const [loadingSkus, setLoadingSkus] = useState(!peekSkus());
  const [open, setOpen] = useState(false);
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
  const found = !hasQuery(value.query)
    ? inCategory
    : inCategory.filter((s) => match([s.sku_code, s.display_name, s.exact_size, s.brand_name, s.search_text]));
  // Nothing to give (no free rolls / none on the shelf): struck out and kept at the end of the list.
  const noStock = (s: SkuWithAtp) =>
    isLotType(s.product_type)
      ? (s.lot_groups ?? []).reduce((a, g) => a + g.total_qty, 0) <= 0
      : s.atp_stock <= 0;
  const options = [...found.filter((s) => !noStock(s)), ...found.filter(noStock)].slice(0, 40);

  function selectOption(sku: SkuWithAtp) {
    onChange({ sku, query: sku.display_name });
    setOpen(false);
  }

  const nav = useListNav({
    count: options.length,
    open: open && options.length > 0,
    setOpen,
    onPick: (i) => { const o = options[i]; if (o) selectOption(o); },
  });

  function pickCategory(next: ProductType) {
    if (next === category) return;
    setCategory(next);
    lastCategory = next;
    // the chosen product belongs to the old category, so start the line afresh
    onChange({ sku: null, query: '' });
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
              aria-label="Clear"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* one plain list: just the SKU name — what is in stock is shown once a SKU is picked */}
        {open && options.length > 0 && (
          <div
            ref={(el) => { (dropdownRef as React.MutableRefObject<HTMLDivElement | null>).current = el; (nav.listRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
            className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg max-h-72 overflow-y-auto"
          >
            {options.map((sku, idx) => (
              <button
                key={sku.id}
                data-nav-idx={idx}
                tabIndex={-1}
                onMouseEnter={() => nav.setCursor(idx)}
                className={`w-full text-left px-3 py-2 text-[15px] font-medium truncate transition-colors ${
                  idx === nav.cursor ? 'bg-brand-soft' : 'hover:bg-subtle'
                } ${noStock(sku) ? 'line-through text-ink-3' : ''}`}
                onClick={() => selectOption(sku)}
                title={noStock(sku) ? 'Out of stock' : undefined}
                type="button"
              >
                <span className={`font-mono ${noStock(sku) ? '' : 'text-brand'}`}>{sku.sku_code}</span>{' – '}{sku.display_name}
              </button>
            ))}
          </div>
        )}

        {open && !loadingSkus && options.length === 0 && value.query.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg px-3 py-4 text-center text-[14px] text-ink-3"
          >
            No SKUs match &quot;{value.query}&quot;
          </div>
        )}
      </div>
    </div>
  );
}


// ─── Line item model ──────────────────────────────────────────────────────────

/** One "MM × PCS from this roll" entry. The first is the line itself; the rest are extensions. */
interface Segment {
  id: string;
  mm: string;
  pcs: string;
  lotId: string;
}

interface LineItem {
  id: string;
  skuSearch: SkuPick;
  /** plain quantity (V-belts, conveyor) */
  quantity: string;
  /** roll-tracked products: MM × PCS entries, each from a chosen roll */
  segs: Segment[];
  /** Direct orders only: typed product name / unit (no SKU), MM × PCS or plain quantity */
  pieces: string;
  mm: string;
  manualName: string;
  manualUnit: 'MM' | 'PCS';
}

const makeSeg = (): Segment => ({ id: newId(), mm: '', pcs: '', lotId: '' });

function makeLineItem(): LineItem {
  return {
    id: newId(),
    skuSearch: { sku: null, query: '' },
    quantity: '',
    segs: [makeSeg()],
    pieces: '',
    mm: '',
    manualName: '',
    manualUnit: 'MM',
  };
}

const segPcs = (s: Segment) => Math.floor(Number(s.pcs)) || 0;
const segMm = (s: Segment) => Number(s.mm) || 0;
const segQty = (s: Segment) => Math.round(segMm(s) * segPcs(s) * 100) / 100;
const segFilled = (s: Segment) => segMm(s) > 0 && segPcs(s) > 0;

/** Pieces × MM shown on a direct line. */
function lineQM(li: { quantity: string; pieces: string; mm: string }): { pieces: string; mm: string } {
  const q = Number(li.quantity) || 0;
  if ((Math.floor(Number(li.pieces)) || 0) * (Number(li.mm) || 0) === q) return { pieces: li.pieces, mm: li.mm };
  return q > 0 ? { pieces: '1', mm: String(q) } : { pieces: '', mm: '' };
}
/** pieces × mm of a direct line entered as MM × PCS. */
function directQm(li: LineItem): { pieces: number; mm: number } | null {
  if (li.manualUnit !== 'MM') return null;
  const qm = lineQM(li);
  const pieces = Math.floor(Number(qm.pieces)) || 0, mm = Number(qm.mm) || 0;
  return pieces > 0 && mm > 0 && pieces * mm === Number(li.quantity) ? { pieces, mm } : null;
}
const qmFields = (li: LineItem) => {
  const q = directQm(li);
  return q ? { pieces: String(q.pieces), mm: String(q.mm) } : {};
};
const qmColumns = (li: LineItem) => {
  const q = directQm(li);
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

/** How much of a roll the entries on this screen already use (optionally leaving one entry out). */
function usedOnRoll(items: LineItem[], lotId: string, exceptSegId?: string): number {
  let sum = 0;
  for (const li of items) for (const s of li.segs) {
    if (s.lotId === lotId && s.id !== exceptSegId) sum += segQty(s);
  }
  return sum;
}

/** What one entry can be told about its roll: how much is free for it, and whether it can be filled. */
function segStatus(items: LineItem[], rolls: Roll[], s: Segment) {
  const roll = rolls.find((r) => r.id === s.lotId);
  const need = segQty(s);
  const avail = roll ? Math.max(0, roll.free_qty - usedOnRoll(items, roll.id, s.id)) : 0;
  let problem = '';
  if (roll && segFilled(s)) {
    if (segMm(s) > roll.current_qty) problem = `a ${segMm(s)} piece is longer than this roll (${roll.current_qty})`;
    else if (need > avail) problem = `only ${avail} free on this roll`;
  }
  return { roll, need, avail, left: avail - need, problem };
}

/** The entries of a line as "parts" (for the message): FROM <roll> … */
function partsOf(li: LineItem, rolls: Roll[]): AllocPart[] {
  const out: AllocPart[] = [];
  li.segs.forEach((s, i) => {
    const roll = rolls.find((r) => r.id === s.lotId);
    if (!roll || !segFilled(s)) return;
    out.push({
      seg_no: i + 1, mm: segMm(s), pcs: segPcs(s), qty: segQty(s),
      size: roll.current_qty, lot_no: roll.lot_no, status: roll.status, label: rollLabel(roll),
    });
  });
  return out;
}

/** What a line is, before it is saved, in words: complete or what is missing / cannot be filled. */
function lineProblems(items: LineItem[], li: LineItem, rolls: Roll[]): string[] {
  const sku = li.skuSearch.sku;
  if (!sku) return [];
  const code = sku.sku_code;
  if (!isLotType(sku.product_type)) {
    return (parseFloat(li.quantity) || 0) > 0 ? [] : [`${code}: enter a quantity`];
  }
  const out: string[] = [];
  li.segs.forEach((s, i) => {
    const tag = li.segs.length > 1 ? `${code} (entry ${i + 1})` : code;
    if (!segFilled(s)) { out.push(`${tag}: enter ${lotUnitWord(sku.product_type).toUpperCase()} × PCS`); return; }
    if (!s.lotId) { out.push(`${tag}: pick the roll to take it from`); return; }
    const st = segStatus(items, rolls, s);
    if (!st.roll) { out.push(`${tag}: the roll you picked is no longer available — pick again`); return; }
    if (st.problem) out.push(`${tag}: can't be filled — ${st.problem}`);
  });
  return out;
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
  const [rolls, setRolls] = useState<Record<string, Roll[]>>({});

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

  // The live rolls of every roll-tracked product on the form. Re-read whenever a product is picked
  // or stock changes anywhere, so the "free" figures are always the real ones.
  const lotSkuKey = useMemo(
    () => Array.from(new Set(form.items.map((li) => (li.skuSearch.sku && isLotType(li.skuSearch.sku.product_type) ? li.skuSearch.sku.id : '')).filter(Boolean))).sort().join(','),
    [form.items],
  );
  useEffect(() => {
    let alive = true;
    const ids = lotSkuKey ? lotSkuKey.split(',') : [];
    fetchRolls(ids).then((r) => {
      if (!alive) return;
      // a product with no rolls at all still gets an (empty) entry, so the screen can tell "none" from "loading"
      for (const id of ids) r[id] ??= [];
      setRolls(r);
    });
    return () => { alive = false; };
  }, [lotSkuKey, skuVersion]);

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

  /** One line as the message wants it. */
  function messageItem(li: LineItem) {
    if (form.isDirect) {
      return { display_name: li.manualName.trim(), quantity: li.quantity, unit_code: li.manualUnit, ...qmFields(li) };
    }
    const sku = li.skuSearch.sku;
    if (!sku) return { display_name: '', quantity: '', unit_code: '' };
    if (isLotType(sku.product_type)) {
      const parts = partsOf(li, rolls[sku.id] ?? []);
      const total = parts.reduce((a, p) => a + p.qty, 0);
      return {
        display_name: sku.display_name,
        quantity: total > 0 ? String(total) : '',
        unit_code: sku.unit_code,
        total: parts.length > 1 ? totalLine({ quantity: total, unit_code: sku.unit_code }) : undefined,
        parts: parts.map((p) => ({ text: partLine(p, sku.unit_code), from: fromTag(p, sku.unit_code) })),
      };
    }
    return { display_name: sku.display_name, quantity: li.quantity, unit_code: sku.unit_code };
  }

  const messageFields = (isDirect: boolean, list: LineItem[]) => ({
    direct: isDirect,
    customer_name: form.customer_name,
    items: list.map(messageItem),
    time_tag: form.time_tag,
    delivery_mode: form.delivery_mode,
    delivery_note: needsDeliveryNote ? form.delivery_note : '',
    assigned_to: form.assigned_to,
    notes: form.notes,
  });
  const previewMessage = buildMessage(messageFields(form.isDirect, form.items));

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
  function removeItem(id: string) {
    setForm((f) => ({
      ...f,
      items: f.items.length > 1 ? f.items.filter((li) => li.id !== id) : f.items,
    }));
  }

  // entries of a roll-tracked line
  function updateSeg(itemId: string, segId: string, patch: Partial<Segment>) {
    setForm((f) => ({
      ...f,
      items: f.items.map((li) => li.id !== itemId ? li : { ...li, segs: li.segs.map((s) => s.id === segId ? { ...s, ...patch } : s) }),
    }));
  }
  function addSeg(itemId: string) {
    setForm((f) => ({
      ...f,
      items: f.items.map((li) => li.id !== itemId ? li : { ...li, segs: [...li.segs, makeSeg()] }),
    }));
  }
  function removeSeg(itemId: string, segId: string) {
    setForm((f) => ({
      ...f,
      items: f.items.map((li) => li.id !== itemId || li.segs.length <= 1 ? li : { ...li, segs: li.segs.filter((s) => s.id !== segId) }),
    }));
  }

  // ── WhatsApp settings ──────────────────────────────────────────────────────

  async function saveWhatsapp() {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'default_whatsapp_number', value: whatsappDraft }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? 'Could not save the WhatsApp number.');
      return;
    }
    setError(null);
    setWhatsapp(whatsappDraft.trim());
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

    // Roll-tracked lines: every entry needs MM × PCS and a roll that can really give it.
    if (!isDirect) {
      const problems = validItems.flatMap((li) => lineProblems(form.items, li, rolls[li.skuSearch.sku!.id] ?? []));
      if (problems.length > 0) { setError(problems.join('\n')); return; }

      // Plain-quantity products (V-belts, conveyor): the shelf count can be overruled, after asking.
      const qtyBySku: Record<string, { sku: SkuWithAtp; total: number }> = {};
      for (const li of validItems) {
        const sku = li.skuSearch.sku!;
        if (isLotType(sku.product_type)) continue;
        (qtyBySku[sku.id] ??= { sku, total: 0 }).total += parseFloat(li.quantity) || 0;
      }
      const overCommitted = Object.values(qtyBySku).filter(({ sku, total }) => total > sku.atp_stock);
      if (overCommitted.length > 0) {
        const names = overCommitted
          .map(({ sku, total }) => `${sku.sku_code} (need ${total}, physical stock ${sku.atp_stock})`)
          .join('\n');
        if (!window.confirm(`⚠ Quantity exceeds physical production stock:\n\n${names}\n\nProceed anyway?`)) return;
      }
    }

    setSaving(true);
    setError(null);

    // The message carries a placeholder; the database swaps in the real order number.
    const message = buildMessage({ ...messageFields(isDirect, validItems), order_no: '{{ORDER_NO}}' });

    const payload = {
      customer_name: form.customer_name || null,
      time_tag: form.time_tag || null,
      delivery_mode: form.delivery_mode || null,
      delivery_note: needsDeliveryNote ? (form.delivery_note || null) : null,
      assigned_to: form.assigned_to || null,
      notes: form.notes || null,
      whatsapp_number: whatsapp || null,
      whatsapp_message: message || null,
      is_direct: isDirect,
      items: validItems.map((li) => {
        if (isDirect) {
          return {
            display_name: li.manualName.trim(),
            unit_code: li.manualUnit,
            quantity: Number(li.quantity),
            ...(qmColumns(li)),
          };
        }
        const sku = li.skuSearch.sku!;
        if (isLotType(sku.product_type)) {
          return {
            sku_id: sku.id,
            display_name: sku.display_name,
            segments: li.segs.map((s) => ({ mm: segMm(s), pcs: segPcs(s), lot_id: s.lotId })),
          };
        }
        return { sku_id: sku.id, display_name: sku.display_name, quantity: Number(li.quantity) };
      }),
    };

    const { data, error: err } = await db.rpc('create_production_order_full', { p_order: payload });
    if (err || !data) {
      setSaving(false);
      setError(err?.message ?? 'Failed to create order.');
      // a roll may have been taken a moment ago — show the real figures again
      invalidateSkuCache();
      setSkuVersion(getSkuVersion());
      return;
    }
    const orderId = (data as { order_id: string }).order_id;

    const { data: created } = await db
      .from('production_orders')
      .select('*, items:production_order_items(*)')
      .eq('id', orderId)
      .single();

    setSaving(false);
    setCreatedOrder((created as ProductionOrder | null) ?? null);
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

                const sku = li.skuSearch.sku;
                const isLot = isLotType(sku?.product_type);
                const uWord = lotUnitWord(sku?.product_type);                 // mm / ribs
                const skuRolls = sku ? (rolls[sku.id] ?? null) : null;         // null = still loading
                const otherQty = sku && !isLot
                  ? form.items
                      .filter((o) => o.id !== li.id && o.skuSearch.sku?.id === sku.id)
                      .reduce((sum, o) => sum + (parseFloat(o.quantity) || 0), 0)
                  : 0;
                const plainFree = sku && !isLot ? sku.atp_stock - otherQty : 0;
                const plainQty = parseFloat(li.quantity) || 0;
                const lineTotal = li.segs.reduce((a, s) => a + segQty(s), 0);

                return (
                  <div key={li.id} className="rounded-lg border border-line bg-subtle p-3">
                    <SkuCombobox
                      value={li.skuSearch}
                      onChange={(val) => updateItem(li.id, {
                        skuSearch: val,
                        // a different product starts the line afresh
                        ...(val.sku?.id !== li.skuSearch.sku?.id ? { segs: [makeSeg()], quantity: '' } : {}),
                      })}
                      cacheVersion={skuVersion}
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
                    />

                    {sku && (
                      /* ── what is in stock for this SKU, now ── */
                      <div className="mt-2 rounded-lg border border-line bg-surface px-3 py-2">
                        <p className="eyebrow mb-1">Current inventory · {sku.sku_code}</p>
                        {isLot ? (
                          skuRolls === null ? (
                            <p className="text-[13px] text-ink-3">Loading rolls…</p>
                          ) : skuRolls.length === 0 ? (
                            <p className="text-[14px] text-danger font-medium">No rolls in stock — can&apos;t be filled.</p>
                          ) : (
                            <ul className="space-y-1">
                              {skuRolls.map((r) => {
                                const usedHere = usedOnRoll(form.items, r.id);
                                const free = Math.max(0, r.free_qty - usedHere);
                                const reservedElsewhere = r.current_qty - r.free_qty;
                                return (
                                  <li key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px]">
                                    <span className="num font-medium">{rollNames(skuRolls, sku.unit_code)[r.id]}</span>
                                    {reservedElsewhere > 0 && (
                                      <span className="text-warn text-[13px]">· {fmtQty(reservedElsewhere, sku.unit_code)} reserved by other orders</span>
                                    )}
                                    {usedHere > 0 && (
                                      <span className="text-[13px] text-ink-2">
                                        · this order takes {fmtQty(usedHere, sku.unit_code)} → <b className={free === 0 ? 'text-warn' : 'text-ok'}>{fmtQty(free, sku.unit_code)} left</b>
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          )
                        ) : (
                          <p className="text-[14px]">
                            <span className={`num font-semibold ${plainFree <= 0 ? 'text-danger' : 'text-ok'}`}>{fmtQty(sku.atp_stock, sku.unit_code)}</span> in stock
                            {sku.reserved_qty > 0 && <span className="text-warn"> · {fmtQty(sku.reserved_qty, sku.unit_code)} reserved by open orders</span>}
                            {plainQty > 0 && (
                              <span className={plainFree - plainQty < 0 ? 'text-danger font-semibold' : 'text-ink-3'}>
                                {' → '}{fmtQty(plainFree - plainQty, sku.unit_code)} after this line
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                    )}

                    {/* ── plain quantity (V-belt, conveyor) ── */}
                    {sku && !isLot && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="eyebrow">Quantity</span>
                        <input
                          className={`field w-28 text-center ${plainQty > plainFree ? 'border-danger focus:ring-danger/30' : ''}`}
                          type="number" min="0" placeholder={sku.unit_code}
                          value={li.quantity}
                          onChange={(e) => updateItem(li.id, { quantity: e.target.value })}
                        />
                        <span className="text-[13px] text-ink-3">{sku.unit_code}</span>
                        {plainQty > plainFree && (
                          <span className="text-[13px] text-danger font-semibold flex items-center gap-1">
                            <AlertTriangle size={13} /> Can&apos;t be filled — only {fmtQty(Math.max(0, plainFree), sku.unit_code)} in stock
                          </span>
                        )}
                      </div>
                    )}

                    {/* ── roll-tracked: MM × PCS entries, each from a chosen roll ── */}
                    {sku && isLot && skuRolls !== null && skuRolls.length > 0 && (
                      <div className="mt-3">
                        <div className="relative pl-6">
                          {/* the line that ties an extension to the entry above it */}
                          {li.segs.length > 1 && (
                            <span className="absolute left-[7px] top-5 bottom-5 w-px bg-brand/50" aria-hidden />
                          )}
                          {li.segs.map((s, si) => {
                            const st = segStatus(form.items, skuRolls, s);
                            const incomplete = !segFilled(s);
                            return (
                              <div key={s.id} className={`relative ${si > 0 ? 'mt-2.5' : ''}`}>
                                <span
                                  className={`absolute -left-6 top-[15px] h-[9px] w-[9px] rounded-full border-2 ${
                                    si === 0 ? 'bg-brand border-brand' : 'bg-surface border-brand/60'
                                  }`}
                                  aria-hidden
                                />
                                {si > 0 && <span className="absolute -left-[17px] top-[19px] h-px w-3 bg-brand/50" aria-hidden />}
                                <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
                                  <span className={`text-[12px] font-semibold uppercase tracking-wide mt-2.5 w-[74px] ${si === 0 ? 'text-ink-3' : 'text-brand'}`}>
                                    {si === 0 ? 'Entry' : `Extension ${si}`}
                                  </span>
                                  <input
                                    className={`field w-24 text-center ${st.problem ? 'border-danger' : ''}`}
                                    inputMode="decimal" placeholder={uWord.toUpperCase()} aria-label={uWord.toUpperCase()}
                                    value={s.mm}
                                    onChange={(e) => updateSeg(li.id, s.id, { mm: e.target.value.replace(/[^0-9.]/g, '') })}
                                  />
                                  <span className="mt-2 text-ink-3 font-semibold">×</span>
                                  <input
                                    className={`field w-16 text-center ${st.problem ? 'border-danger' : ''}`}
                                    inputMode="numeric" placeholder="PCS" aria-label="PCS"
                                    value={s.pcs}
                                    onChange={(e) => updateSeg(li.id, s.id, { pcs: e.target.value.replace(/[^0-9]/g, '') })}
                                  />
                                  <span className="mt-2 text-[14px] num font-semibold q-total whitespace-nowrap min-w-[78px]">
                                    {!incomplete ? `= ${fmtQty(st.need, sku.unit_code)}` : ''}
                                  </span>
                                  <div className="flex items-center gap-1.5 min-w-[230px] flex-1">
                                    <span className="eyebrow whitespace-nowrap">Take from</span>
                                    <select
                                      className={`field flex-1 min-w-0 ${!s.lotId && !incomplete ? 'border-warn' : ''}`}
                                      value={skuRolls.some((r) => r.id === s.lotId) ? s.lotId : ''}
                                      onChange={(e) => updateSeg(li.id, s.id, { lotId: e.target.value })}
                                      aria-label="Roll to take this from"
                                    >
                                      <option value="">Select roll…</option>
                                      {skuRolls.map((r) => {
                                        // what is free on this roll for THIS entry: after every OTHER entry on the form
                                        const freeFor = Math.max(0, r.free_qty - usedOnRoll(form.items, r.id, s.id));
                                        const fits = s.lotId === r.id || (freeFor > 0 && (st.need === 0 || (freeFor >= st.need && segMm(s) <= r.current_qty)));
                                        return (
                                          <option key={r.id} value={r.id} disabled={!fits}>
                                            {rollNames(skuRolls, sku.unit_code)[r.id]} · {fmtQty(freeFor, sku.unit_code)} free{!fits && st.need > 0 ? ' (too little)' : ''}
                                          </option>
                                        );
                                      })}
                                    </select>
                                  </div>
                                  {si > 0 && (
                                    <button
                                      type="button"
                                      className="btn btn-ghost h-8 w-8 p-0 mt-0.5 text-ink-3 hover:text-danger shrink-0"
                                      onClick={() => removeSeg(li.id, s.id)}
                                      title="Remove this extension"
                                    >
                                      <X size={14} />
                                    </button>
                                  )}
                                </div>
                                {/* live result of this choice */}
                                {st.roll && !incomplete && (
                                  <p className={`text-[13px] mt-1 ml-[82px] flex items-center gap-1 ${st.problem ? 'text-danger font-semibold' : 'text-ink-3'}`}>
                                    {st.problem ? (
                                      <><AlertTriangle size={12} /> Can&apos;t be filled — {st.problem}.</>
                                    ) : (
                                      <>{rollNames(skuRolls, sku.unit_code)[st.roll.id]}: {fmtQty(st.avail, sku.unit_code)} free → <b className={st.left === 0 ? 'text-warn' : 'text-ok'}>{fmtQty(st.left, sku.unit_code)} left</b> after this</>
                                    )}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => addSeg(li.id)}
                            title="Another MM × PCS of this same product, from another roll"
                          >
                            <Plus size={12} /> Extend this SKU
                          </button>
                          {lineTotal > 0 && (
                            <p className="text-[14px]">
                              <span className="eyebrow mr-1.5">Total</span>
                              <span className="num font-semibold q-total">{fmtQty(lineTotal, sku.unit_code)}</span>
                            </p>
                          )}
                        </div>
                      </div>
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
