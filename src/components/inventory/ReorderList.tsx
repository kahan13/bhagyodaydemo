'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { onDataChanged } from '@/lib/dataSync';
import { fmtMsl, fmtQty } from '@/lib/format';
import { isLotType, lotUnitWord } from '@/lib/lotUnit';
import { makeMatcher } from '@/lib/search';
import InventoryTabs from './InventoryTabs';

/**
 * Needs reordering — every product with a minimum stock level (MSL) that is below it.
 * Tick a row once its purchase order has been raised: it is crossed out for everybody.
 * The tick is only a reminder (no stock or order is touched) and it clears by itself
 * when the product is back above its MSL.
 */
interface Row {
  id: string;
  sku_code: string;
  product_type: 'TIMING_BELT' | 'V_BELT' | 'CONVEYOR_BELT' | 'POLY_V_BELT' | 'OPEN_ROLL';
  exact_size: string;
  brand_name: string;
  family_code: string;
  unit_code: string;
  current_stock: number;
  stock_pieces: number | null;
  min_stock_level: number;
  shortfall: number;
  suggested_purchase_qty: number;
  stock_status: string;
}

const TABS = [
  { id: 'ALL', label: 'All' },
  { id: 'TIMING_BELT', label: 'Timing belts' },
  { id: 'V_BELT', label: 'V-belts' },
  { id: 'CONVEYOR_BELT', label: 'Conveyor' },
  { id: 'POLY_V_BELT', label: 'Poly V' },
  { id: 'OPEN_ROLL', label: 'Open Roll' },
] as const;
const TYPE_SHORT: Record<string, string> = { TIMING_BELT: 'Timing', V_BELT: 'V-belt', CONVEYOR_BELT: 'Conveyor', POLY_V_BELT: 'Poly V', OPEN_ROLL: 'Open Roll' };
const TYPE_ORDER: Record<string, number> = { TIMING_BELT: 0, V_BELT: 1, CONVEYOR_BELT: 2, POLY_V_BELT: 3, OPEN_ROLL: 4 };

const stockLabel = (r: Row): string =>
  !isLotType(r.product_type)
    ? fmtQty(r.current_stock, r.unit_code)
    : `${fmtMsl(r.stock_pieces ?? 0, r.unit_code, r.product_type)} (${fmtQty(r.current_stock)} ${lotUnitWord(r.product_type)})`;

export default function ReorderList({ canTick }: { canTick: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('ALL');
  const [query, setQuery] = useState('');
  const [hideTicked, setHideTicked] = useState(false);
  const [anyMsl, setAnyMsl] = useState(true);

  const load = useCallback(async () => {
    const sb = supabaseBrowser();
    const [list, marks, msl] = await Promise.all([
      sb.from('v_sku_status')
        .select('id,sku_code,product_type,exact_size,brand_name,family_code,unit_code,current_stock,stock_pieces,min_stock_level,shortfall,suggested_purchase_qty,stock_status')
        .eq('is_active', true)
        .gt('min_stock_level', 0)
        .in('stock_status', ['LOW_STOCK', 'OUT_OF_STOCK'])
        .order('shortfall', { ascending: false })
        .range(0, 1999),
      sb.from('reorder_marks').select('sku_id'),
      sb.from('v_sku_status').select('sku_code', { count: 'exact', head: true }).eq('is_active', true).gt('min_stock_level', 0),
    ]);
    if (list.error) { setError(list.error.message); setLoading(false); return; }
    setRows((list.data ?? []) as unknown as Row[]);
    // the ticks table only exists once 035 has been run; without it the list still works
    setTicked(new Set(((marks.data ?? []) as { sku_id: string }[]).map((m) => m.sku_id)));
    setAnyMsl((msl.count ?? 0) > 0);
    setError(null); setLoading(false);
  }, []);

  // Forget ticks of products that are no longer low — once, when the page opens (best effort).
  // Not inside load(): load() runs after every save, and this must never re-trigger it.
  useEffect(() => {
    void (async () => { await supabaseBrowser().rpc('prune_reorder_marks'); await load(); })();
  }, [load]);
  useEffect(() => onDataChanged(() => { load(); }), [load]);

  async function toggle(r: Row) {
    if (!canTick) return;
    const next = !ticked.has(r.id);
    setTicked((prev) => { const n = new Set(prev); if (next) n.add(r.id); else n.delete(r.id); return n; });   // instant
    const { error: e } = await supabaseBrowser().rpc('set_reorder_mark', { p_sku_id: r.id, p_marked: next });
    if (e) {
      setTicked((prev) => { const n = new Set(prev); if (next) n.delete(r.id); else n.add(r.id); return n; });  // undo
      setError(e.message);
    } else setError(null);
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: rows.length };
    for (const r of rows) c[r.product_type] = (c[r.product_type] ?? 0) + 1;
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const match = makeMatcher(query);
    return rows
      .filter((r) => tab === 'ALL' || r.product_type === tab)
      .filter((r) => match([r.exact_size, r.brand_name, r.family_code, r.sku_code]))
      .filter((r) => !(hideTicked && ticked.has(r.id)))
      .sort((a, b) =>
        (Number(ticked.has(a.id)) - Number(ticked.has(b.id))) ||            // still-to-order first, ticked last
        (TYPE_ORDER[a.product_type] - TYPE_ORDER[b.product_type]) ||
        (Number(b.shortfall) - Number(a.shortfall)));
  }, [rows, tab, query, hideTicked, ticked]);

  const tickedCount = rows.filter((r) => ticked.has(r.id)).length;

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[21px] font-semibold">Inventory</h1>
        <InventoryTabs current="reorder" />
      </div>

      <p className="text-[15px] text-ink-2 leading-relaxed max-w-[760px]">
        Products below their minimum stock level. {canTick
          ? <>Tick a row once its purchase order is raised — it is crossed out for everyone. The tick is only a reminder, and it clears by itself once the stock is refilled.</>
          : <>Products already ordered are crossed out.</>}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              className={`px-3 py-1 rounded-md text-[14px] font-medium transition-colors whitespace-nowrap ${
                tab === t.id ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
              }`}>
              {t.label} <span className="text-ink-3 num">{counts[t.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px] max-w-[320px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input data-global-search className="field pl-9 pr-8" placeholder="Search size, brand or SKU   ( / )"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"><X size={14} /></button>
          )}
        </div>
        <label className="inline-flex items-center gap-2 text-[14px] text-ink-2 cursor-pointer">
          <input type="checkbox" checked={hideTicked} onChange={(e) => setHideTicked(e.target.checked)} />
          Hide ticked {tickedCount > 0 && <span className="text-ink-3 num">({tickedCount})</span>}
        </label>
        <Link href="/reports?report=needs_ordering" className="ml-auto text-[14px] text-brand hover:underline">
          Report &amp; download
        </Link>
      </div>

      {error && <p className="text-[15px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">{error}</p>}

      <div className="card overflow-auto max-h-[calc(100vh-300px)]">
        <table className="table text-[15px]">
          <thead>
            <tr>
              <th className="w-10 text-center" title="PO raised">
                <span className="sr-only">PO raised</span>✓
              </th>
              <th>Product</th>
              {tab === 'ALL' && <th>Type</th>}
              <th>Brand</th>
              <th className="text-right">Stock</th>
              <th className="text-right">MSL</th>
              <th className="text-right">Order qty</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="py-8 text-center text-ink-3">Loading…</td></tr>}
            {!loading && shown.length === 0 && (
              <tr><td colSpan={7} className="py-8 text-center text-ink-3">
                {query ? 'Nothing matches your search.'
                  : !anyMsl ? 'No MSL is set on any product yet — import it under Import Data → 3 · MSL, or set it in Product Master.'
                  : 'Every product with an MSL is at or above it.'}
              </td></tr>
            )}
            {shown.map((r) => {
              const done = ticked.has(r.id);
              return (
                <tr key={r.id} className={done ? 'opacity-55' : ''}>
                  <td className="text-center">
                    <input type="checkbox" checked={done} disabled={!canTick}
                      aria-label={`PO raised for ${r.exact_size}`}
                      onChange={() => toggle(r)} className="h-4 w-4 cursor-pointer disabled:cursor-default" />
                  </td>
                  <td className={`font-medium whitespace-nowrap ${done ? 'line-through' : ''}`}>{r.exact_size}</td>
                  {tab === 'ALL' && <td className="text-ink-3">{TYPE_SHORT[r.product_type]}</td>}
                  <td className={`text-ink-2 ${done ? 'line-through' : ''}`}>{r.brand_name}</td>
                  <td className={`num text-right whitespace-nowrap ${done ? 'line-through' : ''}`}>
                    <span className={r.stock_status === 'OUT_OF_STOCK' ? 'text-danger font-medium' : 'text-warn font-medium'}>{stockLabel(r)}</span>
                  </td>
                  <td className={`num text-right whitespace-nowrap text-ink-2 ${done ? 'line-through' : ''}`}>{fmtMsl(r.min_stock_level, r.unit_code, r.product_type)}</td>
                  <td className={`num text-right font-medium whitespace-nowrap ${done ? 'line-through' : ''}`}>{fmtMsl(r.suggested_purchase_qty, r.unit_code, r.product_type)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
