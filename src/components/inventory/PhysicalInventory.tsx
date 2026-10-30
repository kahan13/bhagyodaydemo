'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X, AlertTriangle, Check } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { onDataChanged } from '@/lib/dataSync';
import { fmtQty } from '@/lib/format';
import { makeMatcher } from '@/lib/search';
import { HIERARCHY, type ProductType } from '@/lib/types';
import InventoryTabs from './InventoryTabs';
import MismatchWindow from '@/components/production-orders/MismatchWindow';

/**
 * Physical inventory — what is actually on the shelf.
 * Creating a production order takes its items off the shelf straight away, so Physical drops at once.
 * Book inventory only drops when the outward is recorded.
 * A difference between the two is never shown as one netted figure (an order waiting for its outward and a
 * waste pull in opposite directions and would hide each other). The row only says "Mismatch detected";
 * its button opens the same transaction-by-transaction list as the Mismatch tab.
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
  // products that have at least one mismatch (by SKU id), and the window that explains them
  const [mismatchIds, setMismatchIds] = useState<Set<string>>(new Set());
  const [window_, setWindow] = useState<null | { skuId?: string; title: string }>(null);

  const loadMismatch = useCallback(async () => {
    const db = supabaseBrowser();
    const ids = new Set<string>();
    // book and physical differ, or an order is still waiting for its outward
    let res = await db.from('v_production_stock_status').select('sku_id,is_mismatched,open_item_count')
      .or('is_mismatched.eq.true,open_item_count.gt.0').range(0, 4999);
    if (res.error) {
      res = await db.from('v_production_stock_status').select('sku_id,is_mismatched').eq('is_mismatched', true).range(0, 4999);
    }
    for (const r of (res.data ?? []) as unknown as { sku_id: string }[]) ids.add(r.sku_id);
    // a waste / adjustment that has not been applied to physical stock yet
    const pend = await db.from('prod_pending_adjustments').select('sku_id').is('resolved_at', null).range(0, 4999);
    for (const r of (pend.data ?? []) as unknown as { sku_id: string }[]) ids.add(r.sku_id);
    setMismatchIds(ids);
  }, []);

  const load = useCallback(async () => {
    loadMismatch();
    const { data, error: e } = await supabaseBrowser()
      .from('v_sku_atp')
      .select('sku_code,current_stock,physical_prod_stock')
      .range(0, 4999);
    if (e) { setError(e.message); setLoading(false); return; }
    const map: Record<string, AtpRow> = {};
    for (const r of (data ?? []) as unknown as AtpRow[]) map[r.sku_code] = r;
    setRows(map); setError(null); setLoading(false);
  }, [loadMismatch]);

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
        return { s, book, phys, mismatch: mismatchIds.has(s.id) };
      })
      .filter((x) => !onlyGap || x.mismatch);
  }, [skus, rows, type, query, onlyGap, mismatchIds]);

  const mismatchCount = useMemo(
    () => skus.filter((s) => rows[s.sku_code] && mismatchIds.has(s.id)).length,
    [skus, rows, mismatchIds]);

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[21px] font-semibold">Inventory</h1>
        <InventoryTabs current="physical" />
      </div>

      <p className="text-[15px] text-ink-2 leading-relaxed max-w-[760px]">
        <strong>Physical</strong> is what is actually on the shelf: it goes down the moment a production order is created.
        <strong> Book</strong> goes down only when the outward is recorded (or a waste is marked). When the two do not agree for a
        reason that still needs action, the product shows <strong>Mismatch detected</strong> — press <em>View</em> to see each cause.
      </p>

      {mismatchCount > 0 ? (
        <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[15px] text-warn font-medium flex items-center gap-2">
            <AlertTriangle size={16} />
            Mismatch detected on {mismatchCount} product{mismatchCount === 1 ? '' : 's'}
          </p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setWindow({ title: 'All mismatches' })}>
            View all mismatches
          </button>
        </div>
      ) : !loading && (
        <p className="text-[14px] text-ok flex items-center gap-1.5"><Check size={14} /> No mismatch — book and physical stock agree everywhere.</p>
      )}

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
          Only products with a mismatch
          {mismatchCount > 0 && <span className="text-ink-3 num">({mismatchCount})</span>}
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
              <th>Mismatch</th>
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
            {list.map(({ s, book, phys, mismatch }) => (
              <tr key={s.sku_code}>
                <td className="font-medium whitespace-nowrap">{s.exact_size}</td>
                <td className="text-ink-2">{s.brand_name}</td>
                <td className="num text-right font-semibold whitespace-nowrap">{fmtQty(phys, s.unit_code)}</td>
                <td className="num text-right text-ink-2 whitespace-nowrap">{fmtQty(book, s.unit_code)}</td>
                <td className="whitespace-nowrap">
                  {mismatch ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="badge badge-warn inline-flex items-center gap-1"><AlertTriangle size={12} /> Mismatch detected</span>
                      <button type="button" className="btn btn-secondary btn-sm h-7"
                        onClick={() => setWindow({ skuId: s.id, title: `Mismatches · ${s.sku_code}` })}>View</button>
                    </span>
                  ) : <span className="text-ink-3">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {window_ && (
        <MismatchWindow skuId={window_.skuId} title={window_.title} onClose={() => { setWindow(null); loadMismatch(); }} />
      )}
    </div>
  );
}
