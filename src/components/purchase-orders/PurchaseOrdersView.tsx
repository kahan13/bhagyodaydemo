'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Plus, X, Search, Check, Package,
  ChevronRight, Loader2, ArrowDownLeft, ClipboardCheck, Trash2, FileSpreadsheet, FileDown,
} from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { fmtQty, fmtDateTime, fmtMmPcs, fmtRolls, fmtArea } from '@/lib/format';
import Modal from '@/components/ui/Modal';
import { exportPoExcel, exportPoPdf, type PoExportOrder } from '@/lib/poExport';
import { isLotType, isRubber, lotUnitHead, lotUnitWord } from '@/lib/lotUnit';
import { useListNav } from '@/lib/useListNav';
import { makeMatcher } from '@/lib/search';
import { onDataChanged } from '@/lib/dataSync';
import { takeAction } from '@/lib/keytips';
import type { ProductType, Sku } from '@/lib/types';
import RollEntry, { SleeveToggle, rollsPayload, rollsTotal, type RollRows } from '@/components/inventory/RollEntry';
import RubberEntry, { rubberPayload, rubberTotal, emptyRubber, mFromTyped, type RubberRows } from '@/components/inventory/RubberEntry';

type ItemStatus  = 'PENDING' | 'PARTIAL' | 'FULFILLED';
type OrderStatus = 'PLACED'  | 'PARTIAL' | 'FULFILLED';

/** One delivery against a line; `txn_no` is filled once it has been recorded into stock. */
interface Receipt {
  id: string;
  qty_received: number;
  rolls: { rolls: number; roll_length: number; width?: number; cut?: boolean }[] | null;
  received_at: string;
  notes: string | null;
  inwarded_at: string | null;
  txn_no: string | null;
}

interface OrderItem {
  id: string;
  order_id: string;
  sku_id: string;
  ordered_qty: number;
  ordered_pieces?: number | null;
  ordered_length_mm?: number | null;
  /** Open Roll / Rubber: the width of the ordered rolls (mm) */
  ordered_width_mm?: number | null;
  ordered_is_cut?: boolean;
  received_qty: number;
  /** pieces that have arrived (lot-wise lines) */
  received_pieces?: number;
  inwarded_qty?: number;
  status: ItemStatus;
  notes: string | null;
  created_at: string;
  receipts?: Receipt[];
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

/** Timing belts are ordered / received as MM × PCS (no fixed roll length on the product). */
const isRoll = (item: OrderItem): boolean => isLotType(item.skus?.product_type);
/** Open Roll / Rubber: ordered and received as WIDTH × LENGTH × ROLLS. */
const isRub = (item: OrderItem): boolean => isRubber(item.skus?.product_type);
/** Poly V belts are the same, measured in ribs instead of mm. */
const wordOf = (item: OrderItem): string => lotUnitWord(item.skus?.product_type);
/** "470 mm × 3 pcs" — what the line was ordered as. */
const orderedLabel = (item: OrderItem): string =>
  isRub(item) && item.ordered_pieces && item.ordered_length_mm
    ? fmtRolls(Number(item.ordered_width_mm), Number(item.ordered_length_mm), item.ordered_pieces)
  : item.ordered_pieces && item.ordered_length_mm
    ? `${fmtMmPcs(Number(item.ordered_length_mm), item.ordered_pieces, wordOf(item))}${item.ordered_is_cut ? ' cut pcs' : ''}` : '';
/**
 * A line ordered as MM × PCS is received lot by lot: every piece that arrives completes ONE ordered
 * piece, whatever its real length (485 mm against 500 mm still counts as that piece, the 15 mm is
 * simply not outstanding). Only whole pieces can be "left".
 */
const isLot = (item: OrderItem): boolean => !!item.ordered_pieces && !!item.ordered_length_mm;
const piecesLeft = (item: OrderItem): number =>
  Math.max(0, Number(item.ordered_pieces ?? 0) - Number(item.received_pieces ?? 0));
/** Still waiting for something from the supplier. A closed line is never open. */
const isOpen = (item: OrderItem): boolean =>
  item.status !== 'FULFILLED' &&
  (isLot(item) ? piecesLeft(item) > 0 : Number(item.ordered_qty) - Number(item.received_qty) > 0);
/** "500 mm × 1 pcs" for a lot line, "30 m" otherwise. */
const leftLabel = (item: OrderItem): string =>
  isRub(item) && isLot(item)
    ? fmtRolls(Number(item.ordered_width_mm), Number(item.ordered_length_mm), piecesLeft(item))
  : isLot(item)
    ? fmtMmPcs(Number(item.ordered_length_mm), piecesLeft(item), wordOf(item))
    : fmtQty(Number(item.ordered_qty) - Number(item.received_qty), item.skus?.unit_code);
/** Received but not yet recorded into stock. */
const pendingInward = (item: OrderItem): number =>
  Math.max(0, Number(item.received_qty) - Number(item.inwarded_qty ?? 0));

const TYPE_LABEL: Record<string, string> = { TIMING_BELT: 'Timing Belt', V_BELT: 'V-Belt', CONVEYOR_BELT: 'Conveyor Belt', POLY_V_BELT: 'Poly V Belt', OPEN_ROLL: 'Open Roll / Rubber' };

/** "470 mm × 2 pcs + 500 mm × 1 pcs" for a delivery of rolls, "30 m" for a plain quantity. */
const receiptLabel = (item: OrderItem, r: Receipt): string =>
  r.rolls && r.rolls.length > 0 && isRub(item)
    ? r.rolls.map((g) => fmtRolls(Number(g.width ?? item.ordered_width_mm), g.roll_length, g.rolls)).join(' + ')
  : r.rolls && r.rolls.length > 0
    ? r.rolls.map((g) => `${fmtMmPcs(g.roll_length, g.rolls, wordOf(item))}${g.cut ? ' cut' : ''}`).join(' + ')
    : fmtQty(r.qty_received, item.skus?.unit_code);

/** One purchase order as the order sheet for the supplier: what is wanted, nothing about receiving. */
function toExport(order: Order): PoExportOrder {
  return {
    order_no: order.order_no,
    supplier: order.supplier_name,
    notes: order.notes,
    created_at: order.created_at,
    lines: order.items.map((i) => {
      const unit = i.skus?.unit_code;
      const lot = isLot(i);
      const sleeve = i.ordered_is_cut ? 'Cut pcs' : 'Full sleeve';
      return {
        sku_code: i.skus?.sku_code ?? '—',
        size: i.skus?.exact_size ?? '—',
        brand: i.skus?.brand_name ?? '—',
        category: i.skus?.product_type ? (TYPE_LABEL[i.skus.product_type] ?? '') : '',
        quantity: isRub(i) && lot
          ? `${fmtRolls(Number(i.ordered_width_mm), Number(i.ordered_length_mm), i.ordered_pieces)} — ${fmtArea(Number(i.ordered_qty))} total`
          : lot
          ? `${fmtMmPcs(Number(i.ordered_length_mm), i.ordered_pieces, wordOf(i))} (${sleeve}) — ${fmtQty(i.ordered_qty, unit)} total`
          : fmtQty(i.ordered_qty, unit),
        form: lot && !isRub(i) ? sleeve : '',
      };
    }),
  };
}


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
    <span className={`text-[12px] font-semibold px-1.5 py-0.5 rounded ${map[status] ?? ''}`}>
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
    const match = makeMatcher(search);
    return skus
      .filter((s) => s.product_type === type && s.is_active)
      .filter((s) => match([s.exact_size, s.brand_name, s.sku_code]))
      .slice(0, 50);
  }, [skus, type, search]);

  const nav = useListNav({
    count: pool.length,
    open,
    setOpen,
    onPick: (i) => { const s = pool[i]; if (s && !selected.includes(s.id)) { onSelect(s); setSearch(''); setOpen(false); } },
    isDisabled: (i) => !!pool[i] && selected.includes(pool[i].id),
  });

  return (
    <div className="space-y-2">
      <div className="flex gap-1 p-0.5 bg-subtle rounded-md">
        {(['TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT', 'POLY_V_BELT', 'OPEN_ROLL'] as ProductType[]).map((t) => (
          <button
            key={t} type="button"
            onClick={() => { setType(t); setSearch(''); }}
            className={`flex-1 py-1 text-[14px] rounded font-medium transition-colors ${
              type === t ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
            }`}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      <div ref={ref} className="relative">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            ref={inputRef}
            className="field pl-8 text-[15px]"
            placeholder="Search size, brand or SKU…"
            value={search}
            autoComplete="off"
            onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={nav.onKeyDown}
            role="combobox"
            aria-expanded={open}
          />
        </div>
        {open && (
          <div ref={nav.listRef} className="absolute z-20 mt-1 w-full bg-surface border border-line rounded-lg shadow-lg max-h-64 overflow-y-auto">
            {pool.length === 0 ? (
              <p className="px-3 py-4 text-[14px] text-ink-3 text-center">No matches</p>
            ) : (
              pool.map((s, idx) => {
                const already = selected.includes(s.id);
                return (
                  <button
                    key={s.id} type="button" tabIndex={-1}
                    disabled={already}
                    data-nav-idx={idx}
                    onMouseEnter={() => nav.setCursor(idx)}
                    className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 border-b border-line last:border-0 ${
                      already ? 'opacity-40 cursor-not-allowed bg-subtle' : idx === nav.cursor ? 'bg-brand-soft' : 'hover:bg-subtle'
                    }`}
                    onMouseDown={() => { if (!already) { onSelect(s); setSearch(''); setOpen(false); } }}
                  >
                    <span>
                      <span className="text-[15px] font-medium">{s.exact_size}</span>
                      <span className="text-[13px] text-ink-3 ml-1.5">{s.brand_name}</span>
                      <span className="text-[12px] text-ink-3 ml-1.5">· {TYPE_LABEL[s.product_type]}</span>
                    </span>
                    <span className={`text-[14px] num shrink-0 ${
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

/* ── Receive Dialog — every open line of ONE purchase order, in one window ────── */
type Entry = { rows: RollRows; rub: RubberRows; qty: string; close: boolean; notes: string };

/** What a line would be if it all arrived as ordered (the "Fill as ordered" button). */
function asOrderedEntry(item: OrderItem): Entry {
  const lot = isLot(item), roll = isRoll(item);
  const ordLen = Number(item.ordered_length_mm) || 0;
  const remaining = Number(item.ordered_qty) - Number(item.received_qty);
  const cut = !!item.ordered_is_cut;
  let rows: RollRows = [{ qty: '', mm: '', cut }];
  let rub: RubberRows = emptyRubber();
  if (isRub(item)) {
    if (piecesLeft(item) > 0 && ordLen > 0)
      rub = [{ len: String(ordLen / 1000), wid: String(Number(item.ordered_width_mm) || ''), n: String(piecesLeft(item)) }];
  } else if (roll) {
    if (lot && piecesLeft(item) > 0) rows = [{ qty: String(piecesLeft(item)), mm: String(ordLen), cut }];
    else {
      const n = ordLen > 0 ? Math.floor(remaining / ordLen) : 0;
      if (n > 0) rows = [{ qty: String(n), mm: String(ordLen), cut }];
    }
  }
  return { rows, rub, qty: roll ? '' : String(remaining), close: false, notes: '' };
}
const blankEntry = (item: OrderItem): Entry => ({
  rows: [{ qty: '', mm: '', cut: !!item.ordered_is_cut }],
  // a rubber roll usually arrives as ordered: start the width so only the length and rolls need typing
  rub: isRub(item) ? [{ len: '', wid: String(Number(item.ordered_width_mm) || ''), n: '' }] : emptyRubber(),
  qty: '', close: false, notes: '',
});

/** What was typed for one line, and whether it is allowed. */
function readEntry(item: OrderItem, e: Entry) {
  const roll = isRoll(item), lot = isLot(item);
  const uWord = wordOf(item);
  const remaining = Number(item.ordered_qty) - Number(item.received_qty);
  const pcsLeft = piecesLeft(item);
  const rub = isRub(item);
  const rubList = rub ? rubberPayload(e.rub) : [];
  const rollList = roll && !rub ? rollsPayload(e.rows) : [];
  const rollTotal = rub ? rubberTotal(rubList) : rollsTotal(rollList);
  const pcsEntered = rub ? rubList.reduce((a, r) => a + r.rolls, 0) : rollList.reduce((a, r) => a + r.rolls, 0);
  const plain = Number(e.qty) || 0;
  const entered = roll ? rollTotal > 0 : plain > 0;
  let error = '';
  if (entered) {
    if (roll) {
      if (lot) {
        if (pcsEntered > pcsLeft) error = `That is ${pcsEntered} pieces but only ${pcsLeft} ${pcsLeft === 1 ? 'is' : 'are'} still to come.`;
      } else if (rollTotal > remaining) error = `That is ${rollTotal} ${uWord} but only ${remaining} ${uWord} is left.`;
    } else if (plain > remaining) error = `Maximum receivable is ${remaining}.`;
  }
  const total = roll ? rollTotal : plain;
  const showClose = !lot && entered && total < remaining;
  return { roll, rub, rubList, lot, uWord, remaining, rollList, rollTotal, plain, entered, error, total, showClose };
}

function ReceiveOrderDialog({
  order, onlyItemId, onClose, onDone,
}: { order: Order; onlyItemId?: string; onClose: () => void; onDone: (msg: string) => void }) {
  const lines = useMemo(
    () => order.items.filter((i) => isOpen(i) && (!onlyItemId || i.id === onlyItemId)),
    [order, onlyItemId],
  );
  const [entries, setEntries] = useState<Record<string, Entry>>(
    () => Object.fromEntries(lines.map((i) => [i.id, blankEntry(i)])),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);

  const patch = (id: string, p: Partial<Entry>) => setEntries((m) => ({ ...m, [id]: { ...m[id], ...p } }));
  const read  = (i: OrderItem) => readEntry(i, entries[i.id] ?? blankEntry(i));
  const filled = lines.filter((i) => read(i).entered);
  const anyError = filled.some((i) => read(i).error);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (filled.length === 0) { setErr('Enter what arrived on at least one line.'); return; }
    if (anyError) { setErr('Fix the lines marked in red first.'); return; }
    setBusy(true); setErr(null);
    const res = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'receive_items',
        order_id: order.id,
        lines: filled.map((i) => {
          const r = read(i), en = entries[i.id];
          return r.roll
            ? { item_id: i.id, rolls: r.rub ? r.rubList : r.rollList, notes: en.notes || null, complete: !r.lot && en.close }
            : { item_id: i.id, qty_received: r.plain, notes: en.notes || null, complete: en.close };
        }),
      }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(json.error ?? 'Something went wrong.'); return; }
    onDone(`${filled.length} line${filled.length === 1 ? '' : 's'} received on ${order.order_no}.`);
  };

  return (
    <Modal
      z={90}
      width="max-w-[780px]"
      title={<>Receive stock · <span className="font-mono">{order.order_no}</span></>}
      onClose={onClose}
      onSubmit={submit}
      bodyClassName="p-5 space-y-4"
      footer={
        <div className="flex items-center justify-between gap-3 w-full">
          <p className="text-[14px] text-ink-3">
            {filled.length === 0 ? 'Fill in only the lines that arrived.' : `${filled.length} of ${lines.length} line${lines.length === 1 ? '' : 's'} being received`}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || filled.length === 0}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <><Check size={14} /> Confirm receipt</>}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] text-ink-3">
          Only the lines you fill in are received — the rest stay open for the next delivery. Receiving does not change stock;
          press “Record Inward” afterwards.
        </p>
        {lines.length > 1 && (
          <button
            type="button" className="btn btn-secondary btn-sm shrink-0"
            onClick={() => setEntries(Object.fromEntries(lines.map((i) => [i.id, asOrderedEntry(i)])))}
          >
            Fill all as ordered
          </button>
        )}
      </div>

      {lines.map((item, idx) => {
        const r = read(item);
        const unit = item.skus?.unit_code;
        const en = entries[item.id] ?? blankEntry(item);
        const ordLen = Number(item.ordered_length_mm) || 0;
        return (
          <div key={item.id} className={`rounded-lg border p-3.5 space-y-3 ${r.error ? 'border-danger' : r.entered ? 'border-ok/60 bg-ok-soft/10' : 'border-line'}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">
                  <span className="text-ink-3 font-mono text-[13px] mr-1.5">{idx + 1}.</span>
                  {item.skus?.exact_size ?? '—'}
                  <span className="text-[13px] text-ink-3 font-normal ml-1.5">{item.skus?.brand_name ?? '—'}</span>
                  {item.skus?.product_type && <span className="text-[12px] px-1.5 py-0.5 rounded bg-subtle text-ink-3 font-medium ml-1.5">{TYPE_LABEL[item.skus.product_type]}</span>}
                </p>
                <div className="flex gap-x-4 gap-y-0.5 flex-wrap mt-0.5 text-[13px] text-ink-3 num">
                  {r.lot ? (
                    <>
                      <span>Ordered <strong className="text-ink">{orderedLabel(item)}</strong></span>
                      <span>Received <strong className="q-in">{item.received_pieces ?? 0} of {item.ordered_pieces} {isRub(item) ? 'rolls' : 'pcs'}</strong></span>
                      <span>Still to come <strong className="q-left">{leftLabel(item)}</strong></span>
                    </>
                  ) : (
                    <>
                      <span>Ordered <strong className="text-ink">{fmtQty(item.ordered_qty, unit)}</strong>{orderedLabel(item) ? ` (${orderedLabel(item)})` : ''}</span>
                      <span>Received <strong className="q-in">{fmtQty(item.received_qty, unit)}</strong></span>
                      <span>Left <strong className="q-left">{fmtQty(r.remaining, unit)}</strong></span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button type="button" className="text-[13px] text-brand font-medium hover:underline" onClick={() => patch(item.id, asOrderedEntry(item))}>Fill as ordered</button>
                {r.entered && <button type="button" className="text-[13px] text-ink-3 hover:text-danger" onClick={() => patch(item.id, blankEntry(item))}>Clear</button>}
              </div>
            </div>

            {r.rub ? (
              <>
                <RubberEntry rows={en.rub} onChange={(rub) => patch(item.id, { rub })} mode="rolls" />
                <p className="text-[12.5px] text-ink-3">
                  Type the <strong>real width and length</strong> that arrived — a roll that comes in a little different still counts as one received roll.
                </p>
              </>
            ) : r.roll ? (
              <>
                <RollEntry rows={en.rows} onChange={(rows) => patch(item.id, { rows })} maxTotal={r.lot ? undefined : r.remaining} unit={r.uWord} />
                {r.lot && ordLen > 0 && (
                  <p className="text-[12.5px] text-ink-3">
                    Type the <strong>real length</strong> that arrived — a {ordLen} {r.uWord} piece that comes in shorter or longer still counts as received.
                  </p>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2">
                <label className="label mb-0 whitespace-nowrap">Quantity receiving ({unit ?? 'units'})</label>
                <input
                  className="field num text-[16px] h-10 w-32"
                  inputMode="decimal" placeholder="0"
                  value={en.qty}
                  onChange={(e) => patch(item.id, { qty: e.target.value.replace(/[^0-9.]/g, '') })}
                />
              </div>
            )}

            {r.error && <p className="text-[13.5px] text-danger font-medium">{r.error}</p>}

            {r.showClose && !r.error && (
              <label className="flex items-start gap-2 text-[13.5px] text-ink-2 cursor-pointer">
                <input type="checkbox" className="mt-1" checked={en.close} onChange={(e) => patch(item.id, { close: e.target.checked })} />
                <span>This is the last delivery — mark the line complete. What did not arrive stops showing as outstanding.</span>
              </label>
            )}

            {r.entered && (
              <input
                className="field text-[14px]" placeholder="Note for this line (optional) — e.g. partial shipment, damaged"
                value={en.notes} onChange={(e) => patch(item.id, { notes: e.target.value })}
              />
            )}
          </div>
        );
      })}

      {err && <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-3 py-2">{err}</p>}
    </Modal>
  );
}

/* ── Close a line early ───────────────────────────────────────────────────── */
function CloseLineDialog({
  item, onClose, onDone,
}: { item: OrderItem; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    const res  = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'close_item', item_id: item.id }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(json.error ?? 'Something went wrong.'); return; }
    onDone();
  };
  return (
    <Modal
      z={90} width="max-w-[420px]" title="Close this line?" onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Keep open</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={go}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <><Check size={14} /> Close line</>}
          </button>
        </>
      }
    >
      <p className="text-[15px] text-ink-2">
        <strong>{item.skus?.exact_size ?? '—'}</strong> — nothing more is coming. The {leftLabel(item)} that has not arrived
        stops showing as outstanding. What was already received stays as it is.
      </p>
      {err && <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-3 py-2">{err}</p>}
    </Modal>
  );
}

/* ── Create Order Dialog — everything added here is ONE purchase order ─────── */
function CreateOrderDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [supplier, setSupplier] = useState('');
  const [notes, setNotes]       = useState('');
  const [lines, setLines]       = useState<{ sku: Sku; qty: string; mm: string; wid: string; cut: boolean }[]>([]);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState<string | null>(null);
  // the date and time this order is being made — the database stamps the real one on saving
  const [now] = useState(() => new Date().toISOString());

  const addSku     = (s: Sku) => {
    setLines((prev) => [...prev, { sku: s, qty: '', mm: '', wid: '', cut: false }]);
    setTimeout(() => {
      const boxes = document.querySelectorAll<HTMLInputElement>('[data-po-qty]');
      boxes[boxes.length - 1]?.focus();
    }, 60);
  };
  const removeLine = (i: number) => setLines((prev) => prev.filter((_, j) => j !== i));
  const setQty     = (i: number, v: string) =>
    setLines((prev) => prev.map((l, j) => j === i ? { ...l, qty: v.replace(/[^0-9.]/g, '') } : l));

  const setMm      = (i: number, v: string) =>
    setLines((prev) => prev.map((l, j) => j === i ? { ...l, mm: v.replace(/[^0-9.]/g, '') } : l));
  const setWid     = (i: number, v: string) =>
    setLines((prev) => prev.map((l, j) => j === i ? { ...l, wid: v.replace(/[^0-9.]/g, '') } : l));
  const setCut     = (i: number, cut: boolean) =>
    setLines((prev) => prev.map((l, j) => j === i ? { ...l, cut } : l));
  const isRubL     = (l: { sku: Sku }) => isRubber(l.sku.product_type);       // Open Roll / Rubber: width × length × rolls
  const isTiming   = (l: { sku: Sku }) => isLotType(l.sku.product_type) && !isRubL(l);   // timing + poly V belts
  // timing belts: total mm = MM × PCS (poly V: ribs) ; others: plain quantity
  const lineTotal  = (l: { sku: Sku; qty: string; mm: string; wid: string }) =>
    isRubL(l) ? Math.floor(Number(l.qty) || 0) * mFromTyped(l.mm) * (Number(l.wid) || 0) :
    isTiming(l) ? Math.floor(Number(l.qty) || 0) * (Number(l.mm) || 0) : Number(l.qty) || 0;

  const invalid = lines.length === 0 || lines.some((l) => lineTotal(l) <= 0 || ((isTiming(l) || isRubL(l)) && Math.floor(Number(l.qty)) < 1));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    setBusy(true); setErr(null);

    // All the lines go together: ONE purchase order, one number
    const res = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:   'create',
        supplier: supplier || null,
        notes:    notes    || null,
        items:    lines.map((l) => isRubL(l)
          ? { sku_id: l.sku.id, qty: lineTotal(l), pieces: Math.floor(Number(l.qty)), length_mm: mFromTyped(l.mm), width_mm: Number(l.wid) }
          : isTiming(l)
          ? { sku_id: l.sku.id, qty: lineTotal(l), pieces: Math.floor(Number(l.qty)), length_mm: Number(l.mm), cut: l.cut }
          : { sku_id: l.sku.id, qty: Number(l.qty) }),
      }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(json.error ?? 'Something went wrong.'); return; }

    onDone(`Purchase order ${json.order_no} placed with ${lines.length} item${lines.length === 1 ? '' : 's'}.`);
  };

  const selectedIds = lines.map((l) => l.sku.id);

  return (
    <Modal
      z={80}
      width="max-w-[700px]"
      title="New Purchase Order"
      onClose={onClose}
      onSubmit={submit}
      bodyClassName="p-6 space-y-5"
      footer={
        <div className="flex items-center justify-between gap-3 w-full">
          <p className="text-[14px] text-ink-3">
            {lines.length === 0
              ? 'Search and add products above'
              : `${lines.length} item${lines.length !== 1 ? 's' : ''} on ONE purchase order`}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || invalid}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <><Check size={14} /> Place Order</>}
            </button>
          </div>
        </div>
      }
    >
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
      <p className="text-[13px] text-ink-3 -mt-2">Date &amp; time: <strong className="text-ink">{fmtDateTime(now)}</strong> — saved automatically with the order.</p>

      <div>
        <label className="label mb-2">Add products</label>
        <SkuPicker onSelect={addSku} selected={selectedIds} />
      </div>

      {lines.length > 0 && (
        <div className="rounded-lg border border-line overflow-hidden">
          <div className="px-3 py-2 bg-subtle border-b border-line flex items-center justify-between">
            <span className="text-[13px] font-semibold text-ink-2 uppercase tracking-wide">
              Items — {lines.length} product{lines.length !== 1 ? 's' : ''}
            </span>
            <span className="text-[12px] text-ink-3">
              One PO number for all of them
            </span>
          </div>
          {lines.map((l, i) => (
            <div key={l.sku.id} className="flex items-center gap-4 px-4 py-3 border-b border-line last:border-0">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium truncate">{l.sku.exact_size}</p>
                <p className="text-[13px] text-ink-3">
                  {l.sku.brand_name}
                  <span className="mx-1.5">·</span>
                  <span className="text-brand">{TYPE_LABEL[l.sku.product_type]}</span>
                  <span className="mx-1.5">·</span>
                  in stock: {fmtQty(l.sku.current_stock, l.sku.unit_code)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                {isRubL(l) ? (
                  <>
                    <input
                      className="field num h-11 w-24 text-[16px]" inputMode="decimal"
                      value={l.wid} onChange={(e) => setWid(i, e.target.value)}
                      data-po-qty placeholder="WIDTH mm" aria-label="Width in mm" />
                    <span className="text-ink-3 font-semibold">×</span>
                    <input
                      className="field num h-11 w-24 text-[16px]" inputMode="decimal"
                      value={l.mm} onChange={(e) => setMm(i, e.target.value)}
                      placeholder="LENGTH m" aria-label="Length in metres" />
                    <span className="text-ink-3 font-semibold">×</span>
                    <input
                      className="field num h-11 w-20 text-[16px]" inputMode="numeric"
                      value={l.qty} onChange={(e) => setQty(i, e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="ROLLS" aria-label="Number of rolls" />
                    {lineTotal(l) > 0 && (
                      <span className="text-[14px] num q-total font-semibold whitespace-nowrap">= {fmtArea(lineTotal(l))}</span>
                    )}
                  </>
                ) : isTiming(l) ? (
                  <>
                    <input
                      className="field num h-11 w-24 text-[16px]" inputMode="decimal"
                      value={l.mm} onChange={(e) => setMm(i, e.target.value)}
                      data-po-qty placeholder={lotUnitHead(l.sku.product_type)} aria-label={`Length in ${lotUnitWord(l.sku.product_type)}`} />
                    <span className="text-ink-3 font-semibold">×</span>
                    <input
                      className="field num h-11 w-20 text-[16px]" inputMode="numeric"
                      value={l.qty} onChange={(e) => setQty(i, e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="PCS" aria-label="Number of pieces" />
                    <SleeveToggle cut={l.cut} onChange={(c) => setCut(i, c)} />
                    {lineTotal(l) > 0 && (
                      <span className="text-[14px] num q-total font-semibold whitespace-nowrap">= {lineTotal(l)} {lotUnitWord(l.sku.product_type)}</span>
                    )}
                  </>
                ) : (
                  <input
                    className="field num h-9 w-28 text-[15px]"
                    inputMode="decimal"
                    value={l.qty}
                    onChange={(e) => setQty(i, e.target.value)}
                    data-po-qty
                    placeholder={`qty (${l.sku.unit_code})`}
                  />
                )}
                <button type="button" onClick={() => removeLine(i)} className="text-ink-3 hover:text-danger p-1" aria-label="Remove">
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-3 py-2.5">{err}</p>}
    </Modal>
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
    <Modal
      z={90} width="max-w-[400px]" title={<span className="text-danger">Delete Order</span>} onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn bg-danger text-white hover:bg-danger/90" disabled={busy} onClick={confirm}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <><Trash2 size={14} /> Delete</>}
          </button>
        </>
      }
    >
      <p className="text-[15px] text-ink-2">
        Delete <strong>{order.order_no}</strong>? This will permanently remove the order and all its line items. This cannot be undone.
      </p>
      {err && <p className="text-[14px] text-danger bg-danger-soft rounded px-3 py-2">{err}</p>}
    </Modal>
  );
}

/* ── Order Card ───────────────────────────────────────────────────────────── */
function OrderCard({
  order, view, canEdit, company, onReceive, onCloseLine, onRecordInward, onDelete,
}: {
  order: Order;
  /** false = view only: no receive / close / record inward / delete */
  canEdit: boolean;
  /** progress = what is still to come; received = what has arrived (and can be recorded into stock). */
  view: 'progress' | 'received';
  company: Record<string, string>;
  onReceive: (order: Order, itemId?: string) => void;
  onCloseLine: (item: OrderItem) => void;
  onRecordInward: (order: Order, itemId?: string) => void;
  onDelete: (order: Order) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null);

  const shown        = order.items.filter((i) =>
    view === 'progress' ? isOpen(i) : Number(i.received_qty) > 0);
  const anyPending   = order.items.some((i) => pendingInward(i) > 0);
  const anyOpen      = order.items.some(isOpen);

  // Progress of the WHOLE order, whichever tab it is on
  const total        = order.items.length;
  const linesReceived = order.items.filter((i) => Number(i.received_qty) > 0).length;
  const linesRecorded = order.items.filter((i) => Number(i.inwarded_qty ?? 0) > 0).length;
  const linesWaiting  = order.items.filter((i) => pendingInward(i) > 0).length;

  const doExport = async (kind: 'xlsx' | 'pdf') => {
    setExporting(kind);
    try {
      const data = toExport(order);
      if (kind === 'xlsx') await exportPoExcel(data, company); else await exportPoPdf(data, company);
    } finally { setExporting(null); }
  };

  return (
    <div className="border border-line rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-surface">
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
              <span className="text-[15px] font-semibold">{order.order_no}</span>
              {order.supplier_name && (
                <span className="text-[14px] text-ink-3">· {order.supplier_name}</span>
              )}
              <StatusBadge status={order.status} />
            </div>
            <div className="flex items-center gap-x-3 gap-y-0.5 mt-0.5 flex-wrap">
              <span className="text-[13px] text-ink-3">🕐 {fmtDateTime(order.created_at)}</span>
              <span className="text-[13px] text-ink-3">{total} item{total !== 1 ? 's' : ''}</span>
              <span className="text-[13px] text-ink-2 num">Received <strong>{linesReceived}</strong> of {total}</span>
              {linesRecorded > 0 && (
                <span className="text-[13px] text-ok num font-medium">Inward recorded on {linesRecorded} item{linesRecorded !== 1 ? 's' : ''}</span>
              )}
              {linesWaiting > 0 && (view === 'received' ? (
                <span className="text-[13px] text-brand num font-medium">{linesWaiting} waiting to be recorded</span>
              ) : (
                <span className="text-[13px] text-ink-3">{linesWaiting} received — record inward in the Received tab</span>
              ))}
            </div>
          </div>
        </button>

        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <button type="button" className="btn btn-secondary h-7 px-2 text-[13px]" disabled={!!exporting} onClick={() => doExport('xlsx')} title="Download this purchase order as Excel">
            {exporting === 'xlsx' ? <Loader2 size={12} className="animate-spin" /> : <FileSpreadsheet size={12} />} Excel
          </button>
          <button type="button" className="btn btn-secondary h-7 px-2 text-[13px]" disabled={!!exporting} onClick={() => doExport('pdf')} title="Download this purchase order as PDF">
            {exporting === 'pdf' ? <Loader2 size={12} className="animate-spin" /> : <FileDown size={12} />} PDF
          </button>
          {canEdit && view === 'progress' && anyOpen && (
            <button
              type="button"
              className="btn btn-secondary h-7 px-2.5 text-[14px]"
              data-kt="H" data-kt-label="Receive (this order)"
              onClick={() => onReceive(order)}
            >
              <ArrowDownLeft size={12} /> Receive
            </button>
          )}
          {view === 'received' && anyPending && canEdit && (
            <button
              type="button"
              className="btn btn-primary h-7 px-2.5 text-[14px]"
              data-kt="K" data-kt-label="Record Inward (this order)"
              onClick={() => onRecordInward(order)}
            >
              <ClipboardCheck size={12} /> Record Inward
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-ghost h-7 w-7 p-0 text-ink-3 hover:text-danger"
              onClick={() => onDelete(order)}
              title="Delete order"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Items */}
      {expanded && (
        <div className="border-t border-line divide-y divide-line">
          {shown.length === 0 ? (
            <p className="px-4 py-4 text-[14px] text-ink-3 text-center">Nothing to show here.</p>
          ) : (
            shown.map((item) => {
              const open          = isOpen(item);
              const lot           = isLot(item);
              const itemPending   = pendingInward(item);
              const recorded      = Number(item.inwarded_qty ?? 0);
              const sizeName  = item.skus?.exact_size  ?? '—';
              const brandName = item.skus?.brand_name  ?? '—';
              const pType     = item.skus?.product_type;
              const unit      = item.skus?.unit_code;
              const receipts  = item.receipts ?? [];
              return (
                <div key={item.id} className="flex items-start gap-3 px-4 py-3 bg-surface-2/40">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[15px] font-medium">{sizeName}</span>
                      <span className="text-[13px] text-ink-3">{brandName}</span>
                      {pType && (
                        <span className="text-[12px] px-1.5 py-0.5 rounded bg-subtle text-ink-3 font-medium">
                          {TYPE_LABEL[pType]}
                        </span>
                      )}
                      <StatusBadge status={item.status} />
                    </div>
                    <div className="flex items-center gap-x-4 gap-y-0.5 mt-1.5 flex-wrap">
                      {lot ? (
                        <>
                          <span className="text-[13px] text-ink-3 num">
                            Ordered <strong className="text-ink">{orderedLabel(item)}</strong>
                          </span>
                          <span className="text-[13px] text-ink-3 num">
                            Received <strong className="q-in">{item.received_pieces ?? 0} of {item.ordered_pieces} {isRub(item) ? 'rolls' : 'pcs'}</strong>
                            {Number(item.received_qty) > 0 && <span> · {fmtQty(item.received_qty, unit ?? 'MM')}</span>}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-[13px] text-ink-3 num">
                            Total <strong className="text-ink">{fmtQty(item.ordered_qty, unit)}</strong>
                            {orderedLabel(item) && <span> ({orderedLabel(item)})</span>}
                          </span>
                          <span className="text-[13px] text-ink-3 num">
                            Received <strong className="q-in">{fmtQty(item.received_qty, unit)}</strong>
                            <span> of {fmtQty(item.ordered_qty, unit)}</span>
                          </span>
                        </>
                      )}
                      {open && (
                        <span className="text-[13px] text-warn num font-medium">
                          Left {leftLabel(item)}
                        </span>
                      )}
                      {Number(item.received_qty) > 0 && (itemPending > 0 ? (
                        view === 'received' ? (
                          <span className="text-[13px] text-brand num font-medium">
                            {fmtQty(itemPending, unit)} waiting to be recorded
                          </span>
                        ) : (
                          <span className="text-[13px] text-ink-3">
                            {fmtQty(itemPending, unit)} received — record inward in the Received tab
                          </span>
                        )
                      ) : (
                        <span className="text-[13px] text-ok num font-medium">
                          Inward recorded · in stock {fmtQty(recorded, unit)}
                        </span>
                      ))}
                    </div>

                    {/* Each delivery on this line, and the TXN it was recorded under */}
                    {receipts.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {receipts.map((r) => (
                          <li key={r.id} className="text-[13px] flex items-center gap-x-2 gap-y-0.5 flex-wrap">
                            <span className="text-ink-3">{fmtDateTime(r.received_at)}</span>
                            <span className="num font-medium">{receiptLabel(item, r)}</span>
                            {r.txn_no ? (
                              <span className="badge badge-ok font-mono" title={`Recorded into stock under ${r.txn_no} (reference ${order.order_no})`}>{r.txn_no}</span>
                            ) : (
                              view === 'received'
                                ? <span className="text-brand">waiting to be recorded</span>
                                : <span className="text-ink-3">not in stock yet</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                    {view === 'received' && canEdit && itemPending > 0 && (
                      <button
                        type="button"
                        className="btn btn-primary h-8 px-3 text-[14px]"
                        onClick={() => onRecordInward(order, item.id)}
                        title="Record only this product into stock — it gets its own TXN number"
                      >
                        <ClipboardCheck size={12} /> Record Inward
                      </button>
                    )}
                    {view === 'received' && itemPending === 0 && Number(item.received_qty) > 0 && (
                      <span className="text-[13px] text-ok font-medium flex items-center gap-1">
                        <Check size={12} /> Recorded
                      </span>
                    )}
                    {canEdit && view === 'progress' && Number(item.received_qty) > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost h-8 px-2.5 text-[14px] text-ink-3"
                        title="Nothing more is coming — stop showing the rest as outstanding"
                        onClick={() => onCloseLine(item)}
                      >
                        Close line
                      </button>
                    )}
                    {canEdit && view === 'progress' && open && (
                      <button
                        type="button"
                        className="btn btn-secondary h-8 px-3 text-[14px]"
                        onClick={() => onReceive(order, item.id)}
                      >
                        <ArrowDownLeft size={12} /> {lot ? 'Receive lot' : 'Receive'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {view === 'received' && anyPending && canEdit && (
            <div className="px-4 py-3 bg-ok-soft/20 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-ok">
                <ClipboardCheck size={14} />
                <span className="text-[14px] font-medium">
                  Received stock is waiting — press &quot;Record Inward&quot; to add it to inventory
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
export default function PurchaseOrdersView({
  canEdit = true, company = {},
}: { canEdit?: boolean; company?: Record<string, string> }) {
  const { allSkus: catalogSkus } = useCatalog();                    // ← catalog as SKU fallback

  const [orders, setOrders]         = useState<Order[]>([]);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState<'in_progress' | 'fulfilled'>('in_progress');
  const [showCreate, setShowCreate] = useState(false);
  const [receiveTarget, setReceiveTarget] = useState<{ order: Order; itemId?: string } | null>(null);
  const [closeItem, setCloseItem]       = useState<OrderItem | null>(null);
  const [recordTarget, setRecordTarget] = useState<Order | null>(null);
  const [recordItemId, setRecordItemId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Order | null>(null);
  const [recording, setRecording]       = useState(false);
  const [recordErr, setRecordErr]       = useState<string | null>(null);
  const [toast, setToast]               = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  };

  const load = useCallback(async () => {
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
        items: (itemMap.get(o.id) ?? []).map((item) => {
          // If the API already gave us SKU data, use it as-is
          if (item.skus) return item;

          // Otherwise fall back to the already-loaded catalog (avoids blank names)
          const cat = catalogSkus.find((s) => s.id === item.sku_id);
          if (!cat) return item;
          return {
            ...item,
            skus: {
              sku_code:      cat.sku_code,
              exact_size:    cat.exact_size,
              brand_name:    cat.brand_name,
              unit_code:     cat.unit_code,
              current_stock: cat.current_stock,
              product_type:  cat.product_type,
            },
          };
        }),
      }));

      setOrders(hydrated);
    } finally {
      setLoading(false);
    }
  }, [catalogSkus]);                                             // ← re-enrich when catalog loads

  useEffect(() => { load(); }, [load]);

  // live refresh when anything is saved (here, another screen, another tab)
  useEffect(() => onDataChanged(() => { load(); }), [load]);

  // opened here from another page by Alt+M → OR
  useEffect(() => { if (canEdit && takeAction(['new-order'])) setShowCreate(true); }, [canEdit]);

  // keyboard: "n" starts a new purchase order
  useEffect(() => {
    const h = (e: Event) => { if (canEdit && (e as CustomEvent).detail === 'new-order') setShowCreate(true); };
    window.addEventListener('bb:action', h);
    return () => window.removeEventListener('bb:action', h);
  }, [canEdit]);

  const closeRecord = () => { setRecordTarget(null); setRecordItemId(null); setRecordErr(null); };

  const handleRecordInward = async (order: Order) => {
    setRecording(true); setRecordErr(null);
    const res  = await fetch('/api/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        recordItemId
          ? { action: 'record_inward', order_id: order.id, item_ids: [recordItemId] }
          : { action: 'record_inward', order_id: order.id },
      ),
    });
    const json = await res.json();
    setRecording(false);
    if (!res.ok) { setRecordErr(json.error ?? 'Could not record.'); return; }
    closeRecord();
    const txns = (json.transactions ?? []) as { txn_no: string }[];
    showToast(
      `Recorded ${txns.length} transaction${txns.length !== 1 ? 's' : ''}` +
      (txns.length ? `: ${txns.slice(0, 4).map((t) => t.txn_no).join(', ')}${txns.length > 4 ? ` +${txns.length - 4} more` : ''}` : '') + '.',
    );
    load();
  };

  // A partly received order shows in both: what is left (In Progress) and what has arrived (Received).
  const inProgress = orders.filter((o) => o.items.some(isOpen));
  const fulfilled  = orders.filter((o) => o.items.some((i) => Number(i.received_qty) > 0));
  const displayed  = tab === 'in_progress' ? inProgress : fulfilled;

  return (
    <div className="p-4 lg:p-6 max-w-[1040px] mx-auto space-y-4">
      {toast && (
        <div className="fixed bottom-4 right-4 z-[100] max-w-[420px] bg-ink text-white text-[15px] px-4 py-2.5 rounded-lg shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold">Purchase Orders</h1>
          <p className="text-[15px] text-ink-3 mt-0.5">Track ordered stock and receive against items</p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" data-kt="N" data-kt-label="New purchase order" onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New Order
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-subtle rounded-lg w-fit">
        {([
          { key: 'in_progress', label: 'In Progress', count: inProgress.length, warn: true },
          { key: 'fulfilled',   label: 'Fulfilled / Received', count: fulfilled.length,  warn: false },
        ] as const).map(({ key, label, count, warn }) => (
          <button
            key={key} type="button"
            data-kt={key === 'in_progress' ? 'W' : 'F'}
            data-kt-label={key === 'in_progress' ? 'In Progress tab' : 'Fulfilled / Received tab'}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[15px] rounded-md font-medium transition-colors ${
              tab === key ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`text-[12px] font-semibold px-1.5 py-0.5 rounded ${
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
          <p className="text-[16px] text-ink-2 font-medium">
            {tab === 'in_progress' ? 'No orders in progress' : 'Nothing received yet'}
          </p>
          {tab === 'in_progress' && (
            <p className="text-[15px] text-ink-3 mt-1">Create a purchase order to start tracking received stock.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {displayed.map((o) => (
            <OrderCard
              key={o.id}
              view={tab === 'in_progress' ? 'progress' : 'received'}
              canEdit={canEdit}
              company={company}
              order={o}
              onReceive={(order, itemId) => setReceiveTarget({ order, itemId })}
              onCloseLine={(item) => setCloseItem(item)}
              onRecordInward={(order, itemId) => { setRecordItemId(itemId ?? null); setRecordTarget(order); }}
              onDelete={(order) => setDeleteTarget(order)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateOrderDialog
          onClose={() => setShowCreate(false)}
          onDone={(msg) => { setShowCreate(false); load(); showToast(msg); }}
        />
      )}

      {receiveTarget && (
        <ReceiveOrderDialog
          order={receiveTarget.order}
          onlyItemId={receiveTarget.itemId}
          onClose={() => setReceiveTarget(null)}
          onDone={(msg) => { setReceiveTarget(null); load(); showToast(msg); }}
        />
      )}

      {closeItem && (
        <CloseLineDialog
          item={closeItem}
          onClose={() => setCloseItem(null)}
          onDone={() => { setCloseItem(null); load(); showToast('Line closed.'); }}
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
      {recordTarget && (() => {
        const lines = recordTarget.items.filter((i) => pendingInward(i) > 0 && (!recordItemId || i.id === recordItemId));
        return (
          <Modal
            z={90} width="max-w-[480px]" title="Record as Inward?" onClose={closeRecord}
            footer={
              <>
                <button type="button" className="btn btn-secondary" onClick={closeRecord}>Cancel</button>
                <button
                  type="button" className="btn btn-primary" disabled={recording || lines.length === 0}
                  onClick={() => handleRecordInward(recordTarget)}
                >
                  {recording
                    ? <Loader2 size={14} className="animate-spin" />
                    : <><ArrowDownLeft size={14} /> Confirm &amp; Record</>
                  }
                </button>
              </>
            }
          >
            <p className="text-[15px] text-ink-2">
              This adds what has been received so far (not yet recorded) from <strong>{recordTarget.order_no}</strong> to stock — book and physical.
              <strong> Every product is recorded as its own transaction</strong> with its own TXN number and <strong>{recordTarget.order_no}</strong> as the reference,
              so any one of them can be reversed on its own.
            </p>
            <div className="bg-subtle rounded-lg p-3 space-y-2">
              {lines.map((item) => (
                <div key={item.id} className="flex items-center justify-between text-[14px] gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{item.skus?.exact_size ?? '—'}</span>
                    <span className="text-ink-3 ml-1.5">{item.skus?.brand_name ?? '—'}</span>
                  </div>
                  <span className="num font-semibold text-ok shrink-0">
                    +{fmtQty(pendingInward(item), item.skus?.unit_code)}
                  </span>
                </div>
              ))}
            </div>
            {recordErr && <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-3 py-2">{recordErr}</p>}
          </Modal>
        );
      })()}
    </div>
  );
}
