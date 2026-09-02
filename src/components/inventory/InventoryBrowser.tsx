'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, X, ChevronRight } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty, fmtDateTime, CHANNEL_LABEL } from '@/lib/format';
import { HIERARCHY, type Movement, type Permission, type ProductType, type SkuStatus } from '@/lib/types';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

type Action = 'inward' | 'outward' | 'adjust';

export default function InventoryBrowser({
  rows,
  permissions,
  initialSku,
  initialAction,
  initialType = 'TIMING_BELT',
}: {
  rows: SkuStatus[];
  permissions: Permission[];
  initialSku?: string;
  initialAction?: 'inward' | 'outward';
  initialType?: ProductType;
}) {
  const [type, setType] = useState<ProductType>(initialType);
  const [query, setQuery] = useState('');
  const [l1, setL1] = useState<string | null>(null);
  const [l2, setL2] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkuStatus | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [lowOnly, setLowOnly] = useState(false);

  const can = (p: Permission) => permissions.includes(p);
  const levels = HIERARCHY[type].levels;

  // deep link from the dashboard: /inventory?sku=...
  useEffect(() => {
    if (!initialSku) return;
    const hit = rows.find((r) => r.sku_code === initialSku);
    if (!hit) return;
    setType(hit.product_type);
    setL1(hit.hier_l1);
    setL2(hit.hier_l2);
    setSelected(hit);
    if (initialAction) setAction(initialAction);
  }, [initialSku, initialAction, rows]);

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (r.product_type !== type) return false;
      if (lowOnly && r.stock_status === 'OK') return false;
      if (!q) return true;
      return (
        r.display_name.toLowerCase().includes(q) ||
        r.sku_code.toLowerCase().includes(q) ||
        r.exact_size.toLowerCase().includes(q) ||
        r.brand_name.toLowerCase().includes(q) ||
        r.family_code.toLowerCase().includes(q)
      );
    });
  }, [rows, type, query, lowOnly]);

  // hierarchy is data, not code: hier_l1 -> hier_l2 -> SKU
  const tree = useMemo(() => {
    const map = new Map<string, Map<string, SkuStatus[]>>();
    for (const r of pool) {
      if (!map.has(r.hier_l1)) map.set(r.hier_l1, new Map());
      const branch = map.get(r.hier_l1)!;
      if (!branch.has(r.hier_l2)) branch.set(r.hier_l2, []);
      branch.get(r.hier_l2)!.push(r);
    }
    return map;
  }, [pool]);

  const l1Keys = useMemo(() => [...tree.keys()].sort(collator.compare), [tree]);
  const l2Keys = useMemo(
    () => (l1 && tree.has(l1) ? [...tree.get(l1)!.keys()].sort(collator.compare) : []),
    [tree, l1],
  );
  const leaves = useMemo(() => {
    if (!l1 || !l2) return [];
    return (tree.get(l1)?.get(l2) ?? []).slice().sort((a, b) => collator.compare(a.hier_l3, b.hier_l3));
  }, [tree, l1, l2]);

  // keep the selection valid while filtering
  useEffect(() => {
    if (l1 && !tree.has(l1)) { setL1(null); setL2(null); setSelected(null); }
    else if (l1 && l2 && !tree.get(l1)!.has(l2)) { setL2(null); setSelected(null); }
  }, [tree, l1, l2]);

  const countLow = (list: SkuStatus[]) => list.filter((r) => r.stock_status !== 'OK').length;
  const branchSkus = (key: string) => [...(tree.get(key)?.values() ?? [])].flat();

  function switchType(next: ProductType) {
    setType(next); setL1(null); setL2(null); setSelected(null);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-48px)]">
      {/* ------------------------------------------------------------- toolbar */}
      <div className="border-b border-line bg-surface px-4 lg:px-6 pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-base font-semibold tracking-tight mr-1">Inventory</h1>

          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              className="field pl-8"
              placeholder="Search size, brand or SKU"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink" onClick={() => setQuery('')} aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>

          <label className="flex items-center gap-1.5 text-xs text-ink-2 select-none">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="accent-[#1F4E79]" />
            Below minimum only
          </label>

          <span className="ml-auto text-2xs text-ink-3 num">{pool.length} SKUs</span>
        </div>

        {/* product type tabs - each one browses differently */}
        <div className="flex gap-5 mt-3 -mb-px">
          {(Object.keys(HIERARCHY) as ProductType[]).map((t) => (
            <button
              key={t}
              onClick={() => switchType(t)}
              className={`pb-2 text-sm border-b-2 transition-colors ${
                type === t ? 'border-accent text-accent font-medium' : 'border-transparent text-ink-2 hover:text-ink'
              }`}
            >
              {HIERARCHY[t].label}
              <span className="ml-1.5 text-2xs text-ink-3 num">
                {rows.filter((r) => r.product_type === t).length}
              </span>
            </button>
          ))}
          <span className="pb-2 ml-auto text-2xs text-ink-3 hidden md:block">
            {levels.join('  \u203a  ')}  &rsaquo;  Stock
          </span>
        </div>
      </div>

      {/* --------------------------------------------------------- drill panes */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex border-r border-line">
          {/* level 1 */}
          <div className="drill-col max-w-[220px]">
            <div className="drill-head">
              <span className="eyebrow">{levels[0]}</span>
              <span className="text-2xs text-ink-3 num">{l1Keys.length}</span>
            </div>
            <div className="scroll-y flex-1">
              {l1Keys.map((key) => {
                const skus = branchSkus(key);
                const low = countLow(skus);
                return (
                  <button
                    key={key}
                    data-active={l1 === key}
                    className="drill-item"
                    onClick={() => { setL1(key); setL2(null); setSelected(null); }}
                  >
                    <span className="truncate">{key}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {low > 0 && <span className="tag-low">{low}</span>}
                      <span className="text-2xs text-ink-3 num">{skus.length}</span>
                      <ChevronRight size={13} className="text-ink-3" />
                    </span>
                  </button>
                );
              })}
              {l1Keys.length === 0 && <p className="p-3 text-xs text-ink-3">No match.</p>}
            </div>
          </div>

          {/* level 2 */}
          <div className="drill-col max-w-[240px]">
            <div className="drill-head">
              <span className="eyebrow">{levels[1]}</span>
              <span className="text-2xs text-ink-3 num">{l2Keys.length}</span>
            </div>
            <div className="scroll-y flex-1">
              {!l1 && <p className="p-3 text-xs text-ink-3">Pick a {levels[0].toLowerCase()}.</p>}
              {l1 && l2Keys.map((key) => {
                const skus = tree.get(l1)!.get(key)!;
                const low = countLow(skus);
                return (
                  <button
                    key={key}
                    data-active={l2 === key}
                    className="drill-item"
                    onClick={() => { setL2(key); setSelected(null); }}
                  >
                    <span className="truncate">{key}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {low > 0 && <span className="tag-low">{low}</span>}
                      <span className="text-2xs text-ink-3 num">{skus.length}</span>
                      <ChevronRight size={13} className="text-ink-3" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* level 3 + stock */}
          <div className="drill-col">
            <div className="drill-head">
              <span className="eyebrow">{levels[2]}</span>
              <span className="eyebrow">Stock</span>
            </div>
            <div className="scroll-y flex-1">
              {!l2 && <p className="p-3 text-xs text-ink-3">Pick a {levels[1].toLowerCase()}.</p>}
              {l2 && leaves.map((r) => (
                <button
                  key={r.sku_code}
                  data-active={selected?.sku_code === r.sku_code}
                  className="drill-item"
                  onClick={() => setSelected(r)}
                >
                  <span className="truncate">
                    {r.hier_l3}
                    <span className="ml-2 text-2xs text-ink-3">{r.rack_location ?? ''}</span>
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {r.stock_status === 'OUT_OF_STOCK' && <span className="tag-out">Out</span>}
                    {r.stock_status === 'LOW_STOCK' && <span className="tag-low">Low</span>}
                    <span className="num font-medium">{fmtQty(r.current_stock, r.unit_code)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------- detail panel */}
        <aside className="w-[340px] shrink-0 bg-surface hidden xl:flex flex-col">
          <SkuPanel
            sku={selected}
            canTransact={can('transactions.create')}
            canAdjust={can('inventory.adjust')}
            canReverse={can('transactions.reverse')}
            onAction={setAction}
          />
        </aside>
      </div>

      {/* mobile / tablet: the panel slides over */}
      {selected && (
        <div className="xl:hidden fixed inset-0 z-40 flex">
          <div className="flex-1 bg-ink/20" onClick={() => setSelected(null)} aria-hidden />
          <aside className="w-full max-w-[360px] bg-surface shadow-panel flex flex-col">
            <SkuPanel
              sku={selected}
              canTransact={can('transactions.create')}
              canAdjust={can('inventory.adjust')}
              canReverse={can('transactions.reverse')}
              onAction={setAction}
              onClose={() => setSelected(null)}
            />
          </aside>
        </div>
      )}

      {action && selected && (
        <MovementDialog
          sku={selected}
          action={action}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); window.location.reload(); }}
        />
      )}
    </div>
  );
}

/* ============================================================ detail panel */

function SkuPanel({
  sku, canTransact, canAdjust, canReverse, onAction, onClose,
}: {
  sku: SkuStatus | null;
  canTransact: boolean;
  canAdjust: boolean;
  canReverse: boolean;
  onAction: (a: Action) => void;
  onClose?: () => void;
}) {
  const [history, setHistory] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sku) { setHistory([]); return; }
    let cancelled = false;
    setLoading(true);
    supabaseBrowser()
      .from('v_movements')
      .select('id, txn_no, occurred_at, txn_type, txn_mode, quantity, unit_code, previous_stock, new_stock, reference, notes, channel, user_name, is_reversed')
      .eq('sku_code', sku.sku_code)
      .order('occurred_at', { ascending: false })
      .limit(25)
      .then(({ data }) => {
        if (!cancelled) { setHistory((data ?? []) as Movement[]); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [sku]);

  if (!sku) {
    return (
      <div className="flex-1 grid place-items-center p-6 text-center border-l border-line">
        <p className="text-xs text-ink-3 max-w-[200px] leading-relaxed">
          Pick a product to see its stock, settings and movement history.
        </p>
      </div>
    );
  }

  const spec: [string, string | null][] = sku.product_type === 'TIMING_BELT'
    ? [
        ['Family', sku.family_name],
        ['Form', sku.belt_form === 'OPEN_ENDED' ? 'Open ended roll' : 'Endless'],
        ['Pitch', sku.pitch_mm ? `${sku.pitch_mm} mm` : null],
        ['Pitch length', sku.pitch_length_mm ? `${sku.pitch_length_mm} mm` : null],
        ['Width', sku.width_mm ? `${sku.width_mm} mm` : null],
        ['Teeth', sku.teeth ? String(sku.teeth) : null],
        ['Standard', sku.standard],
      ]
    : [
        ['Profile', sku.family_name],
        ['Group', sku.profile_group],
        ['Construction', sku.construction],
        ['Length', sku.nominal_length ? `${sku.nominal_length} (${sku.length_designation ?? ''})` : null],
      ];

  return (
    <div className="flex-1 min-h-0 flex flex-col border-l border-line">
      <div className="panel-head border-b">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{sku.exact_size}</p>
          <p className="text-2xs text-ink-3 truncate">{sku.brand_name} &middot; {sku.sku_code}</p>
        </div>
        {onClose && (
          <button className="btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="Close"><X size={15} /></button>
        )}
      </div>

      <div className="scroll-y flex-1">
        {/* stock */}
        <div className="px-4 py-3 border-b border-line">
          <div className="flex items-end justify-between">
            <div>
              <p className="eyebrow">In stock</p>
              <p className="num text-2xl font-semibold tracking-tight mt-0.5">
                {fmtQty(sku.current_stock, sku.unit_code)}
              </p>
            </div>
            {sku.stock_status === 'OUT_OF_STOCK' && <span className="tag-out mb-1">Out of stock</span>}
            {sku.stock_status === 'LOW_STOCK' && <span className="tag-low mb-1">Below minimum</span>}
            {sku.stock_status === 'OK' && <span className="tag-ok mb-1">In range</span>}
          </div>
          {sku.stock_status !== 'OK' && (
            <p className="text-2xs text-warn mt-1.5">
              Minimum {fmtQty(sku.min_stock_level, sku.unit_code)} &middot; supplier MOQ{' '}
              {fmtQty(sku.supplier_moq, sku.unit_code)} &rarr; order{' '}
              <span className="font-semibold">{fmtQty(sku.suggested_purchase_qty, sku.unit_code)}</span>
            </p>
          )}
        </div>

        {/* actions */}
        <div className="px-4 py-3 border-b border-line flex flex-wrap gap-2">
          <button className="btn-secondary btn-sm" disabled={!canTransact} onClick={() => onAction('inward')}>
            Inward
          </button>
          <button className="btn-primary btn-sm" disabled={!canTransact} onClick={() => onAction('outward')}>
            Outward
          </button>
          <button className="btn-secondary btn-sm" disabled={!canAdjust} onClick={() => onAction('adjust')}>
            Adjust
          </button>
        </div>

        {/* settings + spec */}
        <dl className="px-4 py-3 border-b border-line grid grid-cols-2 gap-y-2 gap-x-3 text-xs">
          <Row label="Unit" value={sku.unit_code} />
          <Row label="Minimum stock" value={fmtQty(sku.min_stock_level, sku.unit_code)} />
          <Row label="Supplier MOQ" value={fmtQty(sku.supplier_moq, sku.unit_code)} />
          <Row label="Reorder qty" value={fmtQty(sku.reorder_quantity, sku.unit_code)} />
          <Row label="Rack" value={sku.rack_location} />
          <Row label="Supplier" value={sku.supplier_name} />
          <Row label="Opening stock" value={fmtQty(sku.opening_stock, sku.unit_code)} />
          {spec.filter(([, v]) => v).map(([k, v]) => <Row key={k} label={k} value={v} />)}
        </dl>

        {/* history */}
        <div className="px-4 py-3">
          <p className="eyebrow mb-2">Movement history</p>
          {loading && <p className="text-xs text-ink-3">Loading...</p>}
          {!loading && history.length === 0 && (
            <p className="text-xs text-ink-3">No movements yet for this SKU.</p>
          )}
          <ul className="space-y-2">
            {history.map((m) => (
              <li key={m.id} className="text-xs border-b border-line/70 pb-2 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={
                    m.txn_type === 'INWARD' ? 'tag-in' : m.txn_type === 'OUTWARD' ? 'tag-out-mv' : 'tag-adj'
                  }>
                    {m.txn_mode === 'REVERSAL' ? 'Reversal' : m.txn_type.toLowerCase()}
                  </span>
                  <span className="num font-medium">
                    {m.txn_type === 'OUTWARD' ? '-' : m.txn_type === 'INWARD' ? '+' : ''}
                    {fmtQty(Math.abs(m.quantity), m.unit_code)}
                  </span>
                </div>
                <p className="text-ink-3 mt-1 num">
                  {fmtDateTime(m.occurred_at)} &middot; {fmtQty(m.previous_stock)} &rarr; {fmtQty(m.new_stock)}
                </p>
                <p className="text-ink-3">
                  {m.user_name} &middot; {CHANNEL_LABEL[m.channel] ?? m.channel}
                  {m.reference ? ` · ${m.reference}` : ''}
                  {m.is_reversed ? ' · reversed' : ''}
                </p>
              </li>
            ))}
          </ul>
          {canReverse && history.length > 0 && (
            <p className="text-2xs text-ink-3 mt-3">
              Wrong entry? Reverse it from Transactions - history is never deleted.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.05em] text-ink-3">{label}</dt>
      <dd className="text-ink mt-0.5">{value ?? '-'}</dd>
    </div>
  );
}

/* ========================================================== movement dialog */

function MovementDialog({
  sku, action, onClose, onDone,
}: {
  sku: SkuStatus;
  action: Action;
  onClose: () => void;
  onDone: () => void;
}) {
  const [qty, setQty] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = Number(qty || 0);
  const projected =
    action === 'inward' ? sku.current_stock + amount
      : action === 'outward' ? sku.current_stock - amount
      : amount;                                   // adjust = counted physical stock
  const delta = action === 'adjust' ? amount - sku.current_stock : amount;

  const title = action === 'inward' ? 'Record inward' : action === 'outward' ? 'Record outward' : 'Adjust stock';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);

    const body = action === 'adjust'
      ? { sku_code: sku.sku_code, txn_type: 'ADJUSTMENT', quantity: delta, notes, reference: reference || 'PHYSICAL COUNT', channel: 'WEB' }
      : { sku_code: sku.sku_code, txn_type: action.toUpperCase(), quantity: amount, notes, reference, channel: 'WEB' };

    const res = await fetch('/api/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setError(json.error ?? 'That did not go through.'); return; }
    onDone();
  }

  const invalid =
    !qty ||
    (action !== 'adjust' && amount <= 0) ||
    (action === 'outward' && amount > sku.current_stock) ||
    (action === 'adjust' && (delta === 0 || !notes.trim()));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4" role="dialog" aria-modal>
      <form onSubmit={submit} className="w-full max-w-[420px] bg-surface border border-line rounded shadow-modal">
        <div className="panel-head border-b">
          <h2 className="panel-title">{title}</h2>
          <button type="button" className="btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>

        <div className="p-4 space-y-3">
          <div className="bg-raised border border-line rounded px-3 py-2">
            <p className="text-sm font-medium">{sku.exact_size}</p>
            <p className="text-2xs text-ink-3">
              {sku.brand_name} &middot; {sku.family_name} &middot; {sku.sku_code}
            </p>
            <p className="num text-xs text-ink-2 mt-1">
              In stock {fmtQty(sku.current_stock, sku.unit_code)}
            </p>
          </div>

          <div>
            <label className="label" htmlFor="qty">
              {action === 'adjust' ? `Counted physical stock (${sku.unit_code})` : `Quantity (${sku.unit_code})`}
            </label>
            <input
              id="qty"
              className="field num text-base"
              inputMode="decimal"
              autoFocus
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
            />
          </div>

          <div>
            <label className="label" htmlFor="ref">Reference</label>
            <input
              id="ref"
              className="field"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={action === 'inward' ? 'Purchase PO-1042' : action === 'outward' ? 'Order SO-4108' : 'Stock count Aug 2026'}
            />
          </div>

          <div>
            <label className="label" htmlFor="notes">
              {action === 'adjust' ? 'Reason (required)' : 'Notes'}
            </label>
            <textarea
              id="notes"
              rows={2}
              className="field"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={action === 'adjust' ? 'Physical stock discrepancy' : 'Optional'}
            />
          </div>

          {qty && (
            <div className="border border-line rounded px-3 py-2 text-sm num">
              <div className="flex justify-between text-ink-2">
                <span>Current</span><span>{fmtQty(sku.current_stock, sku.unit_code)}</span>
              </div>
              <div className="flex justify-between text-ink-2">
                <span>{action === 'adjust' ? 'Adjustment' : action === 'inward' ? 'Inward' : 'Outward'}</span>
                <span>
                  {action === 'outward' ? '-' : delta >= 0 ? '+' : '-'}
                  {fmtQty(Math.abs(delta), sku.unit_code)}
                </span>
              </div>
              <div className="flex justify-between font-semibold border-t border-line mt-1.5 pt-1.5">
                <span>After</span><span>{fmtQty(projected, sku.unit_code)}</span>
              </div>
            </div>
          )}

          {action === 'outward' && amount > sku.current_stock && (
            <p className="text-xs text-danger">
              Only {fmtQty(sku.current_stock, sku.unit_code)} available.
            </p>
          )}

          {error && (
            <p className="text-xs text-danger bg-danger-soft border border-danger/25 rounded px-2.5 py-2">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-line bg-raised">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || invalid}>
            {busy ? 'Saving...' : title}
          </button>
        </div>
      </form>
    </div>
  );
}
