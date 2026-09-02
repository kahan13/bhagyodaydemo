'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, X, ChevronRight, Package, TrendingDown } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty, fmtRelative, CHANNEL_LABEL } from '@/lib/format';
import { HIERARCHY, type Movement, type Permission, type ProductType, type Sku } from '@/lib/types';
import MovementDialog from '@/components/inventory/MovementDialog';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export default function InventoryBrowser({
  permissions, initialSku, initialAction, initialType,
}: {
  permissions: Permission[];
  initialSku?: string;
  initialAction?: 'inward' | 'outward';
  initialType: ProductType;
}) {
  const { skus, loading, error, applyStock } = useCatalog();
  const [type, setType] = useState<ProductType>(initialType);
  const [query, setQuery] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [l1, setL1] = useState<string | null>(null);
  const [l2, setL2] = useState<string | null>(null);
  const [selected, setSelected] = useState<Sku | null>(null);
  const [action, setAction] = useState<'inward' | 'outward' | 'adjust' | null>(null);

  const can = (p: Permission) => permissions.includes(p);
  const levels = HIERARCHY[type].levels;

  // Deep link from the dashboard or command palette.
  useEffect(() => {
    if (!initialSku || !skus.length) return;
    const hit = skus.find((s) => s.sku_code === initialSku);
    if (!hit) return;
    setType(hit.product_type);
    setL1(hit.hier_l1);
    setL2(hit.hier_l2);
    setSelected(hit);
    if (initialAction) setAction(initialAction);
  }, [initialSku, initialAction, skus]);

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skus.filter((s) => {
      if (s.product_type !== type) return false;
      if (lowOnly && s.stock_status === 'OK') return false;
      if (!q) return true;
      return (
        s.exact_size.toLowerCase().includes(q) ||
        s.brand_name.toLowerCase().includes(q) ||
        s.family_code.toLowerCase().includes(q) ||
        s.sku_code.toLowerCase().includes(q)
      );
    });
  }, [skus, type, query, lowOnly]);

  /* The tree is built from hier_l1/l2/l3, which the importer resolved.
     Timing belts nest family → size → brand; V-belts nest brand → profile →
     size. Neither path is written anywhere in this component. */
  const tree = useMemo(() => {
    const map = new Map<string, Map<string, Sku[]>>();
    for (const s of pool) {
      let branch = map.get(s.hier_l1);
      if (!branch) { branch = new Map(); map.set(s.hier_l1, branch); }
      const leaf = branch.get(s.hier_l2);
      if (leaf) leaf.push(s); else branch.set(s.hier_l2, [s]);
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
    return [...(tree.get(l1)?.get(l2) ?? [])].sort((a, b) => collator.compare(a.hier_l3, b.hier_l3));
  }, [tree, l1, l2]);

  useEffect(() => {
    if (l1 && !tree.has(l1)) { setL1(null); setL2(null); }
    else if (l1 && l2 && !tree.get(l1)!.has(l2)) setL2(null);
  }, [tree, l1, l2]);

  const lowIn = (list: Sku[]) => list.filter((s) => s.stock_status !== 'OK').length;
  const branchOf = (key: string) => [...(tree.get(key)?.values() ?? [])].flat();

  function switchType(next: ProductType) {
    setType(next); setL1(null); setL2(null); setSelected(null);
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-[13px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">
          Stock could not be loaded: {error}
        </p>
      </div>
    );
  }

  if (!loading && skus.length === 0) {
    return (
      <div className="p-6 max-w-lg">
        <div className="card p-6">
          <h1 className="text-[15px] font-semibold">No products yet</h1>
          <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">
            The product master is empty. Import the master workbook to load brands, families,
            sizes and opening stock.
          </p>
          <pre className="mt-3 text-[12px] bg-subtle border border-line rounded-lg p-3">npm run import:demo</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* --------------------------------------------------------- toolbar */}
      <div className="px-4 lg:px-6 pt-4 pb-0 border-b border-line bg-surface">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[17px] font-semibold">Inventory</h1>

          <div className="relative flex-1 min-w-[200px] max-w-[320px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              className="field pl-9"
              placeholder="Search size, brand or SKU"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink" onClick={() => setQuery('')} aria-label="Clear">
                <X size={14} />
              </button>
            )}
          </div>

          <button
            onClick={() => setLowOnly((v) => !v)}
            className={`btn btn-sm ${lowOnly ? 'btn-primary' : 'btn-secondary'}`}
          >
            <TrendingDown size={13} /> Below minimum
          </button>

          <span className="ml-auto text-[12px] text-ink-3 num">{pool.length} SKUs</span>
        </div>

        <div className="flex items-center gap-6 mt-3.5">
          {(Object.keys(HIERARCHY) as ProductType[]).map((t) => (
            <button
              key={t}
              onClick={() => switchType(t)}
              className={`relative pb-2.5 text-[13px] transition-colors ${
                type === t ? 'text-ink font-medium' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {HIERARCHY[t].label}
              <span className="ml-1.5 text-[11px] text-ink-3 num">
                {skus.filter((s) => s.product_type === t).length}
              </span>
              {type === t && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand rounded-full" />}
            </button>
          ))}

          <span className="ml-auto pb-2.5 text-[11px] text-ink-3 hidden md:block">
            {levels.join('  →  ')}  →  Stock
          </span>
        </div>
      </div>

      {/* ------------------------------------------------------ drill panes */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-3">
          <Column
            label={levels[0]}
            count={l1Keys.length}
            empty="Nothing matches."
            loading={loading}
          >
            {l1Keys.map((key) => {
              const list = branchOf(key);
              const low = lowIn(list);
              return (
                <button key={key} data-active={l1 === key} className="drill-item"
                  onClick={() => { setL1(key); setL2(null); }}>
                  <span className="truncate">{key}</span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {low > 0 && <span className="badge badge-warn">{low}</span>}
                    <span className="text-[11px] text-ink-3 num">{list.length}</span>
                    <ChevronRight size={13} className="text-ink-3" />
                  </span>
                </button>
              );
            })}
          </Column>

          <Column
            label={levels[1]}
            count={l2Keys.length}
            empty={`Pick a ${levels[0].toLowerCase()}.`}
            loading={loading}
          >
            {l1 && l2Keys.map((key) => {
              const list = tree.get(l1)!.get(key)!;
              const low = lowIn(list);
              return (
                <button key={key} data-active={l2 === key} className="drill-item" onClick={() => setL2(key)}>
                  <span className="truncate">{key}</span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {low > 0 && <span className="badge badge-warn">{low}</span>}
                    <span className="text-[11px] text-ink-3 num">{list.length}</span>
                    <ChevronRight size={13} className="text-ink-3" />
                  </span>
                </button>
              );
            })}
          </Column>

          <Column
            label={levels[2]}
            count={leaves.length}
            empty={`Pick a ${levels[1].toLowerCase()}.`}
            loading={loading}
            right="Stock"
          >
            {leaves.map((s) => (
              <button key={s.sku_code} data-active={selected?.sku_code === s.sku_code}
                className="drill-item" onClick={() => setSelected(s)}>
                <span className="truncate">
                  {s.hier_l3}
                  {s.rack_location && <span className="ml-2 text-[11px] text-ink-3">{s.rack_location}</span>}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {s.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger">Out</span>}
                  {s.stock_status === 'LOW_STOCK' && <span className="badge badge-warn">Low</span>}
                  <span className="num font-medium">{fmtQty(s.current_stock, s.unit_code)}</span>
                </span>
              </button>
            ))}
          </Column>
        </div>

        <aside className="w-[350px] shrink-0 border-l border-line bg-surface hidden xl:flex flex-col">
          <DetailPanel sku={selected} can={can} onAction={setAction} />
        </aside>
      </div>

      {/* smaller screens: the panel slides over */}
      {selected && (
        <div className="xl:hidden fixed inset-0 z-50 flex">
          <div className="flex-1 bg-ink/25" onClick={() => setSelected(null)} aria-hidden />
          <aside className="w-full max-w-[380px] bg-surface shadow-lg flex flex-col slide-up">
            <DetailPanel sku={selected} can={can} onAction={setAction} onClose={() => setSelected(null)} />
          </aside>
        </div>
      )}

      {action && selected && (
        <MovementDialog
          sku={selected}
          action={action}
          channel="WEB"
          onClose={() => setAction(null)}
          onDone={(newStock) => {
            applyStock(selected.sku_code, newStock);
            setSelected({ ...selected, current_stock: newStock });
            setAction(null);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ column */

function Column({
  label, count, empty, children, loading, right,
}: {
  label: string; count: number; empty: string; loading: boolean;
  children: React.ReactNode; right?: string;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div className="border-r border-line last:border-r-0 flex flex-col min-h-0">
      <div className="flex items-baseline justify-between px-4 h-10 border-b border-line shrink-0">
        <span className="eyebrow">{label}</span>
        <span className="text-[11px] text-ink-3 num">{right ?? count}</span>
      </div>
      <div className="flex-1 scroll p-1.5">
        {loading && (
          <div className="space-y-1.5 p-1.5">
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-8 skeleton" />)}
          </div>
        )}
        {!loading && !hasChildren && <p className="px-3 py-4 text-[12px] text-ink-3">{empty}</p>}
        {!loading && children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ detail panel */

function DetailPanel({
  sku, can, onAction, onClose,
}: {
  sku: Sku | null;
  can: (p: Permission) => boolean;
  onAction: (a: 'inward' | 'outward' | 'adjust') => void;
  onClose?: () => void;
}) {
  const [history, setHistory] = useState<Movement[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sku) { setHistory([]); return; }
    let cancelled = false;
    setBusy(true);

    void (async () => {
      const { data } = await supabaseBrowser()
        .from('v_movements')
        .select('id,txn_no,occurred_at,txn_type,txn_mode,quantity,unit_code,previous_stock,new_stock,reference,notes,channel,user_name,is_reversed')
        .eq('sku_code', sku.sku_code)
        .order('occurred_at', { ascending: false })
        .limit(20);

      if (cancelled) return;
      setHistory((data ?? []) as unknown as Movement[]);
      setBusy(false);
    })();

    return () => { cancelled = true; };
  }, [sku]);

  if (!sku) {
    return (
      <div className="flex-1 grid place-items-center p-8 text-center">
        <div>
          <Package size={22} className="mx-auto text-ink-3 mb-2.5" strokeWidth={1.5} />
          <p className="text-[13px] text-ink-3 max-w-[190px] leading-relaxed">
            Pick a product to see stock, settings and its full movement history.
          </p>
        </div>
      </div>
    );
  }

  const specs: [string, string | null][] = sku.product_type === 'TIMING_BELT'
    ? [
        ['Family', sku.family_name],
        ['Form', sku.belt_form === 'OPEN_ENDED' ? 'Open-ended roll' : 'Endless'],
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
        ['Length', sku.nominal_length ? `${sku.nominal_length} ${sku.length_designation ?? ''}` : null],
      ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="card-head border-b shrink-0">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold truncate">{sku.exact_size}</p>
          <p className="text-[11px] text-ink-3 truncate font-mono">{sku.brand_name} · {sku.sku_code}</p>
        </div>
        {onClose && (
          <button className="btn btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="Close"><X size={15} /></button>
        )}
      </div>

      <div className="flex-1 scroll">
        <div className="px-5 py-4 border-b border-line">
          <p className="eyebrow">In stock</p>
          <div className="flex items-end justify-between mt-1">
            <p className="num text-[30px] font-semibold tracking-[-0.025em] leading-none">
              {fmtQty(sku.current_stock, sku.unit_code)}
            </p>
            {sku.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger mb-1">Out of stock</span>}
            {sku.stock_status === 'LOW_STOCK' && <span className="badge badge-warn mb-1">Below minimum</span>}
            {sku.stock_status === 'OK' && <span className="badge badge-ok mb-1">In range</span>}
          </div>

          {sku.stock_status !== 'OK' && (
            <p className="text-[12px] text-warn mt-2.5 leading-relaxed">
              Minimum is {fmtQty(sku.min_stock_level, sku.unit_code)} and supplier MOQ is{' '}
              {fmtQty(sku.supplier_moq, sku.unit_code)} — order{' '}
              <span className="font-semibold">{fmtQty(sku.suggested_purchase_qty, sku.unit_code)}</span>.
            </p>
          )}
        </div>

        <div className="px-5 py-3.5 border-b border-line flex flex-wrap gap-2">
          <button className="btn btn-secondary btn-sm" disabled={!can('transactions.create')} onClick={() => onAction('inward')}>
            Inward
          </button>
          <button className="btn btn-primary btn-sm" disabled={!can('transactions.create')} onClick={() => onAction('outward')}>
            Outward
          </button>
          <button className="btn btn-secondary btn-sm" disabled={!can('inventory.adjust')} onClick={() => onAction('adjust')}>
            Adjust
          </button>
        </div>

        <dl className="px-5 py-4 border-b border-line grid grid-cols-2 gap-y-3 gap-x-4">
          <Field label="Unit" value={sku.unit_code} />
          <Field label="Minimum" value={fmtQty(sku.min_stock_level, sku.unit_code)} />
          <Field label="Supplier MOQ" value={fmtQty(sku.supplier_moq, sku.unit_code)} />
          <Field label="Reorder qty" value={fmtQty(sku.reorder_quantity, sku.unit_code)} />
          <Field label="Rack" value={sku.rack_location} />
          <Field label="Supplier" value={sku.supplier_name} />
          <Field label="Opening stock" value={fmtQty(sku.opening_stock, sku.unit_code)} />
          {specs.filter(([, v]) => v).map(([k, v]) => <Field key={k} label={k} value={v} />)}
        </dl>

        <div className="px-5 py-4">
          <p className="eyebrow mb-2.5">Movement history</p>
          {busy && <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 skeleton" />)}</div>}
          {!busy && history.length === 0 && <p className="text-[12px] text-ink-3">No movements yet.</p>}
          <ul className="space-y-2.5">
            {history.map((m) => (
              <li key={m.id} className="text-[12px]">
                <div className="flex items-center justify-between gap-2">
                  <span className={`badge ${
                    m.txn_type === 'INWARD' ? 'badge-ok'
                      : m.txn_type === 'OUTWARD' ? 'badge-brand' : 'badge-warn'
                  }`}>
                    {m.txn_mode === 'REVERSAL' ? 'Reversal' : m.txn_type.toLowerCase()}
                  </span>
                  <span className="num font-medium">
                    {m.txn_type === 'OUTWARD' ? '−' : m.txn_type === 'INWARD' ? '+' : '±'}
                    {fmtQty(Math.abs(m.quantity), m.unit_code)}
                  </span>
                </div>
                <p className="text-ink-3 num mt-1">
                  {fmtQty(m.previous_stock)} → {fmtQty(m.new_stock)} · {fmtRelative(m.occurred_at)}
                </p>
                <p className="text-ink-3 truncate">
                  {m.user_name} · {CHANNEL_LABEL[m.channel] ?? m.channel}
                  {m.reference ? ` · ${m.reference}` : ''}
                  {m.is_reversed ? ' · reversed' : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="text-[13px] mt-0.5">{value ?? '—'}</dd>
    </div>
  );
}
