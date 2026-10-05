'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, ChevronRight, Package, TrendingDown, ChevronDown } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty, fmtRelative, CHANNEL_LABEL } from '@/lib/format';
import { HIERARCHY, type Movement, type Permission, type ProductType, type Sku } from '@/lib/types';
import MovementDialog from '@/components/inventory/MovementDialog';
import SkuLotsPanel from '@/components/inventory/SkuLotsPanel';
import LotBreakdown, { groupsInline, groupText } from '@/components/inventory/LotBreakdown';
import { TYPE_META } from '@/lib/sheet-config';
import { useListNav } from '@/lib/useListNav';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** The two descriptive columns of the last pane: V-belt = Section, Size; others = Size, Make. */
const leafCells = (s: Sku): [string, string] =>
  s.product_type === 'V_BELT' ? [s.section ?? '', s.hier_l3] : [s.hier_l3, s.brand_name];

export default function InventoryBrowser({
  permissions, initialSku, initialAction, initialType,
}: {
  permissions: Permission[];
  initialSku?: string;
  initialAction?: 'inward' | 'outward';
  initialType: ProductType;
  labelOverrides?: Partial<Record<ProductType, [string, string, string]>>;
}) {
  const { skus, loading, error, applyStock, refresh } = useCatalog();
  const [type, setType] = useState<ProductType>(initialType);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'CUT_PCS' | 'FULL_SLEEVE' | 'ALL'>('ALL');
  const [view, setView] = useState<'drill' | 'list'>('drill');
  const [searchOpen, setSearchOpen] = useState(false);
  const [fFamily, setFFamily] = useState('');
  const [fSection, setFSection] = useState('');
  const [fMake, setFMake] = useState('');
  const [fSize, setFSize] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [l1, setL1] = useState<string | null>(null);
  const [l2, setL2] = useState<string | null>(null);
  const [selected, setSelected] = useState<Sku | null>(null);
  const [action, setAction] = useState<'inward' | 'outward' | 'adjust' | null>(null);

  // expanded row keys per column
  const [expandedL1, setExpandedL1] = useState<string | null>(null);
  const [expandedL2, setExpandedL2] = useState<string | null>(null);
  const [expandedL3, setExpandedL3] = useState<string | null>(null);

  // resizable column widths as percentages [l1, l2, l3]
  const [widths, setWidths] = useState<[number, number, number]>([33.33, 33.33, 33.34]);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ divider: 0 | 1; startX: number; startWidths: [number, number, number] } | null>(null);

  const can = (p: Permission) => permissions.includes(p);
  const levels: [string, string, string] = HIERARCHY[type].levels;

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

  // Cut Pcs / Full Sleeve tab: timing belts only. Keeps just the matching lot groups
  // and recomputes the stock figure from them, so every pane total follows the tab.
  const viewSkus = useMemo(() => {
    if (tab === 'ALL') return skus;
    return skus.flatMap((s): Sku[] => {
      if (s.product_type !== 'TIMING_BELT') return [s];
      const groups = (s.lot_groups ?? []).filter((g) => g.status === tab);
      if (groups.length === 0) return [];
      return [{ ...s, lot_groups: groups, current_stock: groups.reduce((a, g) => a + g.total_qty, 0) }];
    });
  }, [skus, tab]);

  const tabCount = (t: 'CUT_PCS' | 'FULL_SLEEVE') =>
    skus.filter((s) => s.product_type === 'TIMING_BELT' && (s.lot_groups ?? []).some((g) => g.status === t)).length;

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase();
    return viewSkus.filter((s) => {
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
  }, [viewSkus, type, query, lowOnly]);

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
    return [...(tree.get(l1)?.get(l2) ?? [])].sort((a, b) => {
      const [a1, a2] = leafCells(a);
      const [b1, b2] = leafCells(b);
      return collator.compare(a1, b1) || collator.compare(a2, b2);
    });
  }, [tree, l1, l2]);

  useEffect(() => {
    if (l1 && !tree.has(l1)) { setL1(null); setL2(null); }
    else if (l1 && l2 && !tree.get(l1)!.has(l2)) setL2(null);
  }, [tree, l1, l2]);

  const lowIn = (list: Sku[]) => list.filter((s) => s.stock_status !== 'OK').length;
  const branchOf = (key: string) => [...(tree.get(key)?.values() ?? [])].flat();

  function switchType(next: ProductType) {
    setType(next); setL1(null); setL2(null); setSelected(null);
    setFFamily(''); setFSection(''); setFMake(''); setFSize('');
    setExpandedL1(null); setExpandedL2(null); setExpandedL3(null);
  }

  function switchView(v: 'drill' | 'list') {
    setView(v);
    setTab(v === 'list' ? 'CUT_PCS' : 'ALL');   // list opens on Cut Pcs, drill-down on Show all
  }

  const origOf = (s: Sku) => skus.find((x) => x.sku_code === s.sku_code) ?? s;

  /** Jump straight to one product: right type, family, section, row selected, details open. */
  function openSku(s: Sku) {
    setType(s.product_type);
    setL1(s.hier_l1);
    setL2(s.hier_l2);
    setExpandedL1(null); setExpandedL2(null); setExpandedL3(null);
    setSelected(origOf(s));
    setSearchOpen(false);
  }

  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return viewSkus.filter((s) => {
      if (lowOnly && s.stock_status === 'OK') return false;
      return (
        s.exact_size.toLowerCase().includes(q) ||
        s.brand_name.toLowerCase().includes(q) ||
        s.family_code.toLowerCase().includes(q) ||
        s.sku_code.toLowerCase().includes(q) ||
        s.display_name.toLowerCase().includes(q)
      );
    }).slice(0, 8);
  }, [viewSkus, query, lowOnly]);

  const nav = useListNav({
    count: searchHits.length,
    open: searchOpen && searchHits.length > 0,
    setOpen: setSearchOpen,
    onPick: (i) => { if (searchHits[i]) openSku(searchHits[i]); },
  });

  // List view: rows of the current product type, narrowed by the filters
  const sectionOf = (s: Sku) => s.section ?? s.colour ?? s.hier_l2;
  const typeRows = useMemo(() => viewSkus.filter((s) => s.product_type === type), [viewSkus, type]);
  const uniq = (f: (s: Sku) => string) => [...new Set(typeRows.map(f).filter(Boolean))].sort(collator.compare);
  const familyOpts = useMemo(() => uniq((s) => s.hier_l1), [typeRows]);   // eslint-disable-line react-hooks/exhaustive-deps
  const sectionOpts = useMemo(() => uniq(sectionOf), [typeRows]);          // eslint-disable-line react-hooks/exhaustive-deps
  const makeOpts = useMemo(() => uniq((s) => s.brand_name), [typeRows]);   // eslint-disable-line react-hooks/exhaustive-deps
  const listRows = useMemo(() => {
    return pool
      .filter((s) =>
        (!fFamily || s.hier_l1 === fFamily) &&
        (!fSection || sectionOf(s) === fSection) &&
        (!fMake || s.brand_name === fMake) &&
        (!fSize || s.exact_size.toLowerCase().includes(fSize.toLowerCase()) || s.hier_l3.toLowerCase().includes(fSize.toLowerCase())))
      .sort((a, b) =>
        collator.compare(a.hier_l1, b.hier_l1) ||
        collator.compare(sectionOf(a), sectionOf(b)) ||
        collator.compare(a.hier_l3, b.hier_l3) ||
        collator.compare(a.brand_name, b.brand_name));
  }, [pool, fFamily, fSection, fMake, fSize]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── drag-to-resize ──────────────────────────────────────────────────────────
  const onDividerMouseDown = useCallback((divider: 0 | 1, e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { divider, startX: e.clientX, startWidths: [...widths] as [number, number, number] };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const totalW = containerRef.current.offsetWidth;
      const dx = ev.clientX - dragRef.current.startX;
      const dPct = (dx / totalW) * 100;
      const sw = dragRef.current.startWidths;
      const MIN = 15;

      if (dragRef.current.divider === 0) {
        const w0 = Math.max(MIN, Math.min(sw[0] + dPct, 100 - MIN * 2));
        const w1 = Math.max(MIN, sw[0] + sw[1] - w0);
        setWidths([w0, w1, 100 - w0 - w1]);
      } else {
        const w2 = Math.max(MIN, Math.min(sw[2] - dPct, 100 - MIN * 2));
        const w1 = Math.max(MIN, sw[1] + sw[2] - w2);
        setWidths([100 - w1 - w2, w1, w2]);
      }
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [widths]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-[15px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">
          Stock could not be loaded: {error}
        </p>
      </div>
    );
  }

  if (!loading && skus.length === 0) {
    return (
      <div className="p-6 max-w-lg">
        <div className="card p-6">
          <h1 className="text-[17px] font-semibold">No products yet</h1>
          <p className="text-[15px] text-ink-2 mt-2 leading-relaxed">
            The product master is empty. Import the master workbook to load brands, families,
            sizes and opening stock.
          </p>
          <pre className="mt-3 text-[14px] bg-subtle border border-line rounded-lg p-3">npm run import:demo</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh/var(--z,1)-56px)]">
      {/* toolbar */}
      <div className="px-4 lg:px-6 pt-4 pb-0 border-b border-line bg-surface">
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {([['CUT_PCS', `Cut Pcs (${tabCount('CUT_PCS')})`], ['FULL_SLEEVE', `Full Sleeve (${tabCount('FULL_SLEEVE')})`], ['ALL', 'Show all']] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              data-kt={k === 'CUT_PCS' ? 'C' : k === 'FULL_SLEEVE' ? 'F' : 'W'}
              data-kt-label={k === 'CUT_PCS' ? 'Cut Pcs tab' : k === 'FULL_SLEEVE' ? 'Full Sleeve tab' : 'Show all tab'}
              onClick={() => setTab(k)}
              className={`px-3 py-1 rounded-full text-[14px] font-medium border transition-colors ${
                tab === k ? 'bg-brand text-white border-brand' : 'bg-surface border-line text-ink-2 hover:border-brand hover:text-brand'
              }`}
            >{label}</button>
          ))}
          {tab !== 'ALL' && type !== 'TIMING_BELT' && (
            <span className="text-[13px] text-ink-3 ml-1">Tabs apply to timing belts only</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[19px] font-semibold">Inventory</h1>

          <div className="relative flex-1 min-w-[200px] max-w-[320px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              data-global-search
              data-kt="S" data-kt-label="Search products"
              className="field pl-9"
              placeholder="Search size, brand or SKU   ( / )"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
              onKeyDown={nav.onKeyDown}
              role="combobox"
              aria-expanded={searchOpen}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            />
            {searchOpen && searchHits.length > 0 && (
              <div ref={nav.listRef} className="absolute z-30 left-0 right-0 top-full mt-1 rounded-lg border border-line bg-surface shadow-lg max-h-80 overflow-y-auto">
                {searchHits.map((s, idx) => (
                  <button
                    key={s.sku_code}
                    type="button"
                    tabIndex={-1}
                    data-nav-idx={idx}
                    onMouseEnter={() => nav.setCursor(idx)}
                    onMouseDown={(e) => { e.preventDefault(); openSku(s); }}
                    className={`w-full text-left px-3 py-2 border-b border-line last:border-0 ${idx === nav.cursor ? 'bg-brand-soft' : 'hover:bg-subtle'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[15px] font-medium truncate">{s.exact_size} <span className="text-ink-2 font-normal">· {s.brand_name}</span></span>
                      <span className="text-[13px] text-ink-3 shrink-0">{HIERARCHY[s.product_type].short}</span>
                    </div>
                    <div className="text-[13px] text-ink-3 truncate">
                      {s.hier_l1} › {sectionOf(s)}
                      {s.lot_groups && s.lot_groups.length > 0
                        ? <span className="text-ink-2"> · {groupsInline(s.lot_groups)}</span>
                        : <span className="text-ink-2"> · {fmtQty(s.current_stock, s.unit_code)}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {query && (
              <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink" onClick={() => setQuery('')} aria-label="Clear">
                <X size={14} />
              </button>
            )}
          </div>

          <button
            data-kt="Z" data-kt-label="Below minimum only"
            onClick={() => setLowOnly((v) => !v)}
            className={`btn btn-sm ${lowOnly ? 'btn-primary' : 'btn-secondary'}`}
          >
            <TrendingDown size={13} /> Below minimum
          </button>

          <div className="ml-auto flex items-center gap-3">
            <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
              {([['drill', 'Drill-down'], ['list', 'List']] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  data-kt={v === 'list' ? 'V' : 'B'}
                  data-kt-label={v === 'list' ? 'List view' : 'Drill-down view'}
                  onClick={() => switchView(v)}
                  className={`px-3 py-1 rounded-md text-[14px] font-medium transition-colors ${
                    view === v ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
                  }`}
                >{label}</button>
              ))}
            </div>
            <span className="text-[14px] text-ink-3 num">{(view === 'list' ? listRows : pool).length} SKUs</span>
          </div>
        </div>

        <div className="flex items-center gap-6 mt-3.5">
          {(Object.keys(HIERARCHY) as ProductType[]).map((t) => (
            <button
              key={t}
              onClick={() => switchType(t)}
              className={`relative pb-2.5 text-[15px] transition-colors ${
                type === t ? 'text-ink font-medium' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {HIERARCHY[t].label}
              <span className="ml-1.5 text-[13px] text-ink-3 num">
                {skus.filter((s) => s.product_type === t).length}
              </span>
              {type === t && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand rounded-full" />}
            </button>
          ))}

          <span className="ml-auto pb-2.5 text-[13px] text-ink-3 hidden md:block">
            {levels.join('  →  ')}  →  Stock
          </span>
        </div>
      </div>

      {/* drill panes */}
      <div className="flex-1 min-h-0 flex">
        {view === 'list' ? (
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6 py-2.5 border-b border-line bg-surface">
              <select className="field w-auto h-8 text-[14px]" value={fFamily} onChange={(e) => setFFamily(e.target.value)}>
                <option value="">All families</option>
                {familyOpts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <select className="field w-auto h-8 text-[14px]" value={fSection} onChange={(e) => setFSection(e.target.value)}>
                <option value="">All {type === 'CONVEYOR_BELT' ? 'colours' : 'sections'}</option>
                {sectionOpts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <select className="field w-auto h-8 text-[14px]" value={fMake} onChange={(e) => setFMake(e.target.value)}>
                <option value="">All makes</option>
                {makeOpts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input
                className="field w-32 h-8 text-[14px]"
                placeholder="Size…"
                value={fSize}
                onChange={(e) => setFSize(e.target.value)}
              />
              {(fFamily || fSection || fMake || fSize) && (
                <button
                  className="text-[14px] text-brand hover:underline"
                  onClick={() => { setFFamily(''); setFSection(''); setFMake(''); setFSize(''); }}
                >Clear filters</button>
              )}
            </div>
            <div className="flex-1 scroll bg-surface">
              <table className="w-full text-[15px]">
                <thead className="sticky top-0 bg-surface z-10">
                  <tr className="text-left border-b border-line">
                    <th className="eyebrow px-4 lg:px-6 py-2 font-medium">Family</th>
                    <th className="eyebrow px-2 py-2 font-medium">{type === 'CONVEYOR_BELT' ? 'Colour' : 'Section'}</th>
                    <th className="eyebrow px-2 py-2 font-medium">Size</th>
                    <th className="eyebrow px-2 py-2 font-medium">Make</th>
                    <th className="eyebrow px-2 py-2 font-medium">Cut Pcs</th>
                    <th className="eyebrow px-2 py-2 font-medium">Full Sleeve</th>
                    <th className="eyebrow px-4 lg:px-6 py-2 font-medium text-right">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={7} className="p-6"><Skelly /></td></tr>}
                  {!loading && listRows.length === 0 && (
                    <tr><td colSpan={7} className="p-6 text-center text-ink-3">Nothing matches.</td></tr>
                  )}
                  {listRows.map((s) => {
                    const cut = (s.lot_groups ?? []).filter((g) => g.status === 'CUT_PCS');
                    const full = (s.lot_groups ?? []).filter((g) => g.status === 'FULL_SLEEVE');
                    const active = selected?.sku_code === s.sku_code;
                    return (
                      <tr
                        key={s.sku_code}
                        onClick={() => setSelected(origOf(s))}
                        className={`border-b border-line cursor-pointer hover:bg-subtle ${active ? 'bg-brand/5' : ''}`}
                      >
                        <td className="px-4 lg:px-6 py-2 text-ink-2">{s.hier_l1}</td>
                        <td className="px-2 py-2">{sectionOf(s)}</td>
                        <td className="px-2 py-2 font-medium">{s.hier_l3}</td>
                        <td className="px-2 py-2 text-ink-2">{s.brand_name}</td>
                        <td className="px-2 py-2 num">
                          {s.product_type !== 'TIMING_BELT' ? <span className="text-ink-3">—</span>
                            : cut.length ? cut.map((g) => <div key={g.piece_qty}>{groupText(g)}</div>) : <span className="text-ink-3">—</span>}
                        </td>
                        <td className="px-2 py-2 num">
                          {s.product_type !== 'TIMING_BELT' ? <span className="text-ink-3">—</span>
                            : full.length ? full.map((g) => <div key={g.piece_qty}>{groupText(g)}</div>) : <span className="text-ink-3">—</span>}
                        </td>
                        <td className="px-4 lg:px-6 py-2 text-right">
                          <span className="inline-flex items-center gap-1.5 justify-end">
                            {s.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger">Out</span>}
                            {s.stock_status === 'LOW_STOCK' && <span className="badge badge-warn">Low</span>}
                            <span className="num font-medium">{fmtQty(s.current_stock, s.unit_code)}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
        <div ref={containerRef} className="flex-1 min-w-0 flex select-none">

          {/* L1 column */}
          <div className="flex flex-col min-h-0 border-r border-line" style={{ width: `${widths[0]}%` }}>
            <ColHeader label={levels[0]} right={String(l1Keys.length)} />
            <div className="flex-1 scroll p-1.5">
              {loading && <Skelly />}
              {!loading && l1Keys.length === 0 && <Empty text="Nothing matches." />}
              {!loading && l1Keys.map((key) => {
                const list = branchOf(key);
                const low = lowIn(list);
                const isActive = l1 === key;
                const isExpanded = expandedL1 === key;
                return (
                  <div key={key}>
                    <div
                      data-active={isActive}
                      className="drill-item cursor-pointer"
                      onClick={() => { setL1(key); setL2(null); }}
                    >
                      <span className="truncate">{key}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {low > 0 && <span className="badge badge-warn">{low}</span>}
                        <span className="text-[13px] text-ink-3 num">{list.length}</span>
                        <button
                          className="text-ink-3 hover:text-ink p-0.5"
                          onClick={(e) => { e.stopPropagation(); setExpandedL1(isExpanded ? null : key); }}
                          aria-label={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      </span>
                    </div>
                    {isExpanded && (
                      <div className="mx-1.5 mb-1 px-3 py-2 rounded-md bg-subtle border border-line text-[14px] space-y-1">
                        <p className="text-ink-3">SKUs: <span className="text-ink font-medium">{list.length}</span></p>
                        <p className="text-ink-3">Below min: <span className={low > 0 ? 'text-warn font-medium' : 'text-ink'}>{low}</span></p>
                        <p className="text-ink-3">In stock: <span className="text-ink font-medium">{list.filter(s => s.stock_status === 'OK').length}</span></p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* divider 0 */}
          <div
            className="w-1 shrink-0 cursor-col-resize hover:bg-brand/30 active:bg-brand/50 transition-colors"
            onMouseDown={(e) => onDividerMouseDown(0, e)}
          />

          {/* L2 column */}
          <div className="flex flex-col min-h-0 border-r border-line" style={{ width: `${widths[1]}%` }}>
            <ColHeader label={levels[1]} right={String(l2Keys.length)} />
            <div className="flex-1 scroll p-1.5">
              {loading && <Skelly />}
              {!loading && !l1 && <Empty text={`Pick a ${levels[0].toLowerCase()}.`} />}
              {!loading && l1 && l2Keys.map((key) => {
                const list = tree.get(l1)!.get(key)!;
                const low = lowIn(list);
                const isActive = l2 === key;
                const isExpanded = expandedL2 === key;
                return (
                  <div key={key}>
                    <div
                      data-active={isActive}
                      className="drill-item cursor-pointer"
                      onClick={() => setL2(key)}
                    >
                      <span className="truncate">{key}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {low > 0 && <span className="badge badge-warn">{low}</span>}
                        <span className="text-[13px] text-ink-3 num">{list.length}</span>
                        <button
                          className="text-ink-3 hover:text-ink p-0.5"
                          onClick={(e) => { e.stopPropagation(); setExpandedL2(isExpanded ? null : key); }}
                          aria-label={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      </span>
                    </div>
                    {isExpanded && (
                      <div className="mx-1.5 mb-1 px-3 py-2 rounded-md bg-subtle border border-line text-[14px] space-y-1">
                        <p className="text-ink-3">SKUs: <span className="text-ink font-medium">{list.length}</span></p>
                        <p className="text-ink-3">Below min: <span className={low > 0 ? 'text-warn font-medium' : 'text-ink'}>{low}</span></p>
                        <p className="text-ink-3">Brands: <span className="text-ink font-medium">{[...new Set(list.map(s => s.brand_name))].join(', ')}</span></p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* divider 1 */}
          <div
            className="w-1 shrink-0 cursor-col-resize hover:bg-brand/30 active:bg-brand/50 transition-colors"
            onMouseDown={(e) => onDividerMouseDown(1, e)}
          />

          {/* L3 column */}
          <div className="flex flex-col min-h-0" style={{ width: `${widths[2]}%` }}>
            <div className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 px-4 h-10 items-center border-b border-line shrink-0">
              <span className="eyebrow">{TYPE_META[type].leafColumns[0]}</span>
              <span className="eyebrow">{TYPE_META[type].leafColumns[1]}</span>
              <span className="eyebrow text-right">Stock</span>
            </div>
            <div className="flex-1 scroll p-1.5">
              {loading && <Skelly />}
              {!loading && !l2 && <Empty text={`Pick a ${levels[1].toLowerCase()}.`} />}
              {!loading && l2 && leaves.map((s) => {
                const isActive = selected?.sku_code === s.sku_code;
                const isExpanded = expandedL3 === s.sku_code;
                return (
                  <div key={s.sku_code}>
                    <div
                      data-active={isActive}
                      className="drill-item cursor-pointer"
                      onClick={() => setSelected(skus.find((x) => x.sku_code === s.sku_code) ?? s)}
                    >
                      <div className="w-full min-w-0">
                        <div className="grid grid-cols-[1fr_1fr_1.1fr] gap-2 items-center">
                          <span className="font-medium truncate">{leafCells(s)[0]}</span>
                          <span className="text-ink-2 truncate">{leafCells(s)[1]}</span>
                          <span className="flex items-center gap-1.5 justify-end">
                            {s.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger">Out</span>}
                            {s.stock_status === 'LOW_STOCK' && <span className="badge badge-warn">Low</span>}
                            <span className="num font-medium">{fmtQty(s.current_stock, s.unit_code)}</span>
                            <button
                              className="text-ink-3 hover:text-ink p-0.5"
                              onClick={(e) => { e.stopPropagation(); setExpandedL3(isExpanded ? null : s.sku_code); }}
                              aria-label={isExpanded ? 'Collapse' : 'Expand'}
                            >
                              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                          </span>
                        </div>
                        {s.lot_groups && s.lot_groups.length > 0 && (
                          <LotBreakdown groups={s.lot_groups} className="mt-1.5 pb-0.5" />
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="mx-1.5 mb-1 px-3 py-2 rounded-md bg-subtle border border-line text-[14px] space-y-1">
                        <p className="text-ink-3 font-mono">{s.sku_code}</p>
                        <p className="text-ink-3">Min: <span className="text-ink font-medium">{fmtQty(s.min_stock_level, s.unit_code)}</span></p>
                        {s.rack_location && <p className="text-ink-3">Location: <span className="text-ink font-medium">{s.rack_location}</span></p>}
                        {s.remarks && <p className="text-ink-3">Remark: <span className="text-ink">{s.remarks}</span></p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        )}

        <aside className="w-[350px] shrink-0 border-l border-line bg-surface hidden xl:flex flex-col">
          <DetailPanel
            sku={selected}
            can={can}
            onAction={setAction}
            onStockChange={() => { void refresh(); }}
          />
        </aside>
      </div>

      {selected && (
        <div className="xl:hidden fixed inset-0 z-50 flex">
          <div className="flex-1 bg-ink/25" onClick={() => setSelected(null)} aria-hidden />
          <aside className="w-full max-w-[380px] bg-surface shadow-lg flex flex-col slide-up">
            <DetailPanel
              sku={selected}
              can={can}
              onAction={setAction}
              onClose={() => setSelected(null)}
              onStockChange={() => { void refresh(); }}
            />
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

/* ── small helpers ── */

function ColHeader({ label, right }: { label: string; right: string }) {
  return (
    <div className="flex items-baseline justify-between px-4 h-10 border-b border-line shrink-0">
      <span className="eyebrow">{label}</span>
      <span className="text-[13px] text-ink-3 num">{right}</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-3 py-4 text-[14px] text-ink-3">{text}</p>;
}

function Skelly() {
  return (
    <div className="space-y-1.5 p-1.5">
      {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-8 skeleton" />)}
    </div>
  );
}

/* ── detail panel ── */

function DetailPanel({
  sku, can, onAction, onClose, onStockChange,
}: {
  sku: Sku | null;
  can: (p: Permission) => boolean;
  onAction: (a: 'inward' | 'outward' | 'adjust') => void;
  onClose?: () => void;
  onStockChange?: () => void;
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
          <p className="text-[15px] text-ink-3 max-w-[190px] leading-relaxed">
            Pick a product to see stock, settings and its full movement history.
          </p>
        </div>
      </div>
    );
  }

  const specs: [string, string | null][] = sku.product_type === 'CONVEYOR_BELT'
    ? [
        ['Product Family', sku.family_name],
        ['Colour', sku.colour ?? null],
        ['Length', sku.length_mm ? `${sku.length_mm}` : null],
        ['Width', sku.width_mm ? `${sku.width_mm}` : null],
        ['Thickness', sku.thickness_mm ? `${sku.thickness_mm}` : null],
      ]
    : [
        ['Product Family', sku.family_name],
        ['Section', sku.section ?? null],
      ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="card-head border-b shrink-0">
        <div className="min-w-0">
          <p className="text-[16px] font-semibold truncate">{sku.exact_size}</p>
          <p className="text-[13px] text-ink-3 truncate font-mono">{sku.brand_name} · {sku.sku_code}</p>
        </div>
        {onClose && (
          <button className="btn btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="Close"><X size={15} /></button>
        )}
      </div>

      <div className="flex-1 scroll">
        <div className="px-5 py-4 border-b border-line">
          <p className="eyebrow">In stock</p>
          <div className="flex items-end justify-between mt-1">
            <p className="num text-[32px] font-semibold tracking-[-0.025em] leading-none">
              {fmtQty(sku.current_stock, sku.unit_code)}
            </p>
            {sku.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger mb-1">Out of stock</span>}
            {sku.stock_status === 'LOW_STOCK' && <span className="badge badge-warn mb-1">Below minimum</span>}
            {sku.stock_status === 'OK' && <span className="badge badge-ok mb-1">In range</span>}
          </div>

          <LotBreakdown groups={sku.lot_groups} className="mt-3" />

          {sku.stock_status !== 'OK' && (
            <p className="text-[14px] text-warn mt-2.5 leading-relaxed">
              Minimum is {fmtQty(sku.min_stock_level, sku.unit_code)}.
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

        <RemarkEditor key={sku.id} sku={sku} canEdit={can('products.edit')} onSaved={() => onStockChange?.()} />

        <dl className="px-5 py-4 border-b border-line grid grid-cols-2 gap-y-3 gap-x-4">
          <Field label="Unit" value={sku.unit_code} />
          <Field label="Minimum" value={fmtQty(sku.min_stock_level, sku.unit_code)} />
          <Field label="Location" value={sku.rack_location} />
          <Field label="Opening stock" value={fmtQty(sku.opening_stock, sku.unit_code)} />
          {specs.filter(([, v]) => v).map(([k, v]) => <Field key={k} label={k} value={v} />)}
        </dl>

        {/* ── Lot breakdown (timing belts with lot tracking) ── */}
        <div className="px-5 py-4 border-b border-line">
          <p className="eyebrow mb-3">Stock lots</p>
          <SkuLotsPanel
            skuId={sku.id}
            skuCode={sku.sku_code}
            unitCode={sku.unit_code}
            can={can}
            onStockChange={onStockChange}
          />
        </div>

        <div className="px-5 py-4">
          <p className="eyebrow mb-2.5">Movement history</p>
          {busy && <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 skeleton" />)}</div>}
          {!busy && history.length === 0 && <p className="text-[14px] text-ink-3">No movements yet.</p>}
          <ul className="space-y-2.5">
            {history.map((m) => (
              <li key={m.id} className="text-[14px]">
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

/** Manual remark on a product — saved straight to the product master. */
function RemarkEditor({ sku, canEdit, onSaved }: { sku: Sku; canEdit: boolean; onSaved: () => void }) {
  const [text, setText] = useState(sku.remarks ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const dirty = text.trim() !== (sku.remarks ?? '');

  const save = async () => {
    setSaving(true); setMsg('');
    const r = await fetch('/api/products', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sku.id, remarks: text.trim() }),
    });
    setSaving(false);
    if (!r.ok) { const j = await r.json().catch(() => ({})); setMsg(j.error ?? 'Could not save'); return; }
    sku.remarks = text.trim() || null;
    setMsg('Saved'); onSaved();
  };

  if (!canEdit && !sku.remarks) return null;
  return (
    <div className="px-5 py-4 border-b border-line">
      <p className="eyebrow mb-2">Remark</p>
      {canEdit ? (
        <>
          <textarea className="field w-full text-[14px] min-h-[56px]" value={text} placeholder="Add a manual remark…"
            onChange={(e) => { setText(e.target.value); setMsg(''); }} />
          <div className="flex items-center gap-2 mt-2">
            <button className="btn btn-secondary btn-sm" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save remark'}
            </button>
            {msg && <span className="text-[13px] text-ink-3">{msg}</span>}
          </div>
        </>
      ) : <p className="text-[14px] text-ink-2">{sku.remarks}</p>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[13px] text-ink-3">{label}</dt>
      <dd className="text-[15px] mt-0.5">{value ?? '—'}</dd>
    </div>
  );
}
