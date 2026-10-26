'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { onDataChanged } from '@/lib/dataSync';
import { fmtQty } from '@/lib/format';
import { makeMatcher } from '@/lib/search';
import { HIERARCHY, type ProductType } from '@/lib/types';
import InventoryTabs from './InventoryTabs';

/**
 * Physical inventory — what is actually on the shelf.
 * Creating a production order takes its items off the shelf straight away, so Physical drops at once.
 * Book inventory only drops when the outward is recorded. The gap is "with production".
 * This page is read-only: stock is only ever changed by recording an inward or outward.
 */
interface AtpRow { sku_code: string; current_stock: number; physical_prod_stock: number }

export default function PhysicalInventory() {
  const { skus, loading: catLoading } = useCatalog();
  const [rows, setRows] = useState<Record<string, AtpRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<ProductType>('TIMING_BELT');
  const [query, setQuery] = useState('');
  const [onlyGap, setOnlyGap] = useState(false);

  const load = useCallback(async () => {
    const { data, error: e } = await supabaseBrowser()
      .from('v_sku_atp')
      .select('sku_code,current_stock,physical_prod_stock')
      .range(0, 4999);
    if (e) { setError(e.message); setLoading(false); return; }
    const map: Record<string, AtpRow> = {};
    for (const r of (data ?? []) as unknown as AtpRow[]) map[r.sku_code] = r;
    setRows(map); setError(null); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => onDataChanged(() => { load(); }), [load]);

  const list = useMemo(() => {
    const match = makeMatcher(query);
    return skus
      .filter((s) => s.product_type === type && rows[s.sku_code])
      .filter((s) => match([s.exact_size, s.brand_name, s.family_code, s.sku_code]))
      .map((s) => {
        const r = rows[s.sku_code];
        const book = Number(r.current_stock), phys = Number(r.physical_prod_stock);
        return { s, book, phys, gap: book - phys };
      })
      .filter((x) => !onlyGap || x.gap !== 0);
  }, [skus, rows, type, query, onlyGap]);

  const withProduction = useMemo(
    () => skus.filter((s) => rows[s.sku_code] && Number(rows[s.sku_code].current_stock) !== Number(rows[s.sku_code].physical_prod_stock)).length,
    [skus, rows]);

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[21px] font-semibold">Inventory</h1>
        <InventoryTabs current="physical" />
      </div>

      <p className="text-[15px] text-ink-2 leading-relaxed max-w-[760px]">
        <strong>Physical</strong> is what is actually on the shelf: it goes down the moment a production order is created.
        <strong> Book</strong> goes down only when the outward is recorded. The difference is material that production
        already has, waiting for its outward to be recorded.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
          {(Object.keys(HIERARCHY) as ProductType[]).map((t) => (
            <button key={t} type="button" onClick={() => setType(t)}
              className={`px-3 py-1 rounded-md text-[14px] font-medium transition-colors ${
                type === t ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
              }`}>{HIERARCHY[t].label}</button>
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
          <input type="checkbox" checked={onlyGap} onChange={(e) => setOnlyGap(e.target.checked)} />
          Only where Physical and Book differ
          {withProduction > 0 && <span className="text-ink-3 num">({withProduction})</span>}
        </label>
        <span className="ml-auto text-[14px] text-ink-3 num">{list.length} SKUs</span>
      </div>

      {error && <p className="text-[15px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">Physical stock could not be loaded: {error}</p>}

      <div className="card overflow-auto max-h-[calc(100vh-300px)]">
        <table className="table text-[15px]">
          <thead>
            <tr>
              <th>Product</th>
              <th>Brand</th>
              <th className="text-right">Physical (on shelf)</th>
              <th className="text-right">Book (ledger)</th>
              <th className="text-right">With production</th>
            </tr>
          </thead>
          <tbody>
            {(loading || catLoading) && (
              <tr><td colSpan={5} className="py-8 text-center text-ink-3">Loading…</td></tr>
            )}
            {!loading && !catLoading && list.length === 0 && (
              <tr><td colSpan={5} className="py-8 text-center text-ink-3">
                {query || onlyGap ? 'Nothing matches.' : 'No products in this category.'}
              </td></tr>
            )}
            {list.map(({ s, book, phys, gap }) => (
              <tr key={s.sku_code}>
                <td className="font-medium whitespace-nowrap">{s.exact_size}</td>
                <td className="text-ink-2">{s.brand_name}</td>
                <td className="num text-right font-semibold whitespace-nowrap">{fmtQty(phys, s.unit_code)}</td>
                <td className="num text-right text-ink-2 whitespace-nowrap">{fmtQty(book, s.unit_code)}</td>
                <td className={`num text-right whitespace-nowrap ${gap !== 0 ? 'text-warn font-medium' : 'text-ink-3'}`}>
                  {gap === 0 ? '—' : fmtQty(gap, s.unit_code)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
