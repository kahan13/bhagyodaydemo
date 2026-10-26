'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { fmtMsl, fmtQty } from '@/lib/format';

/**
 * "Needs reordering" pane for the dashboard — every product category, one tab each.
 * A product is listed when it HAS an MSL (minimum stock level) and its stock is below it.
 * Each tab is ordered by its own shortfall, so one category can never crowd out another
 * (timing belts are counted in mm, which used to push everything else off the list).
 */

export interface ReorderRow {
  sku_code: string;
  product_type: 'TIMING_BELT' | 'V_BELT' | 'CONVEYOR_BELT';
  exact_size: string;
  brand_name: string;
  unit_code: string;
  current_stock: number;
  stock_pieces: number | null;
  min_stock_level: number;
  shortfall: number;
  suggested_purchase_qty: number;
  stock_status: string;
}

const TABS: { id: 'ALL' | ReorderRow['product_type']; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'TIMING_BELT', label: 'Timing belts' },
  { id: 'V_BELT', label: 'V-belts' },
  { id: 'CONVEYOR_BELT', label: 'Conveyor' },
];
const TYPE_SHORT: Record<string, string> = { TIMING_BELT: 'Timing', V_BELT: 'V-belt', CONVEYOR_BELT: 'Conveyor' };
const TYPE_ORDER: Record<string, number> = { TIMING_BELT: 0, V_BELT: 1, CONVEYOR_BELT: 2 };

/** Timing belts: pieces (what MSL counts), with the length in brackets. Others: their own unit. */
function stockLabel(r: ReorderRow): string {
  if (r.product_type !== 'TIMING_BELT') return fmtQty(r.current_stock, r.unit_code);
  return `${fmtMsl(r.stock_pieces ?? 0, r.unit_code, r.product_type)} (${fmtQty(r.current_stock)} mm)`;
}

export default function ReorderPane({ rows, capped, anyMsl }: { rows: ReorderRow[]; capped: boolean; anyMsl: boolean }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('ALL');

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: rows.length };
    for (const r of rows) c[r.product_type] = (c[r.product_type] ?? 0) + 1;
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const list = tab === 'ALL' ? rows : rows.filter((r) => r.product_type === tab);
    return [...list].sort((a, b) =>
      (TYPE_ORDER[a.product_type] - TYPE_ORDER[b.product_type]) || (Number(b.shortfall) - Number(a.shortfall)));
  }, [rows, tab]);

  return (
    <section className="card">
      <div className="card-head">
        <div className="flex items-center gap-2">
          <h2 className="card-title">Needs reordering</h2>
          {rows.length > 0 && (
            <span className="text-[12px] font-semibold px-1.5 py-0.5 rounded bg-warn-soft text-warn">
              {rows.length}{capped ? '+' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Link href="/reports?report=needs_ordering" className="text-[14px] text-brand hover:underline">Report &amp; download</Link>
          <Link href="/inventory" className="text-[14px] text-brand hover:underline">View inventory</Link>
        </div>
      </div>

      <div className="px-5 border-b border-line flex gap-4 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`py-2 text-[14px] border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? 'border-primary text-primary font-medium' : 'border-transparent text-ink-2 hover:text-ink'}`}>
            {t.label} <span className="text-ink-3 num">{counts[t.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="px-5 py-5 text-[14px] text-ink-3 text-center">
          {!anyMsl
            ? 'No MSL is set on any product yet — import it under Import Data → 3 · MSL, or set it in Product Master.'
            : tab === 'ALL' ? 'Every product with an MSL is at or above it.' : 'Nothing below MSL in this category.'}
        </p>
      ) : (
        <div className="overflow-auto max-h-[340px]">
          <table className="table text-[14px]">
            <thead>
              <tr>
                <th className="text-[13px]">Product</th>
                {tab === 'ALL' && <th className="text-[13px]">Type</th>}
                <th className="text-[13px]">Brand</th>
                <th className="text-right text-[13px]">Stock</th>
                <th className="text-right text-[13px]">MSL</th>
                <th className="text-right text-[13px]">Order qty</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.sku_code} className="h-8">
                  <td className="font-medium py-1.5 whitespace-nowrap">{r.exact_size}</td>
                  {tab === 'ALL' && <td className="text-ink-3 py-1.5">{TYPE_SHORT[r.product_type]}</td>}
                  <td className="text-ink-2 py-1.5">{r.brand_name}</td>
                  <td className="num text-right py-1.5 whitespace-nowrap">
                    <span className={r.stock_status === 'OUT_OF_STOCK' ? 'text-danger font-medium' : 'text-warn font-medium'}>
                      {stockLabel(r)}
                    </span>
                  </td>
                  <td className="num text-right py-1.5 whitespace-nowrap text-ink-2">{fmtMsl(r.min_stock_level, r.unit_code, r.product_type)}</td>
                  <td className="num text-right font-medium py-1.5 whitespace-nowrap">{fmtMsl(r.suggested_purchase_qty, r.unit_code, r.product_type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
