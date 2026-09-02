import Link from 'next/link';
import { requireSession, fmtQty, fmtTime, CHANNEL_LABEL, can } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase';
import type { DashboardSummary, Movement, SkuStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

function Metric({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="px-4 py-3 border-r border-line last:border-r-0 flex-1 min-w-[130px]">
      <p className="eyebrow">{label}</p>
      <p className="num text-xl font-semibold mt-1 tracking-tight">{value}</p>
      {hint && <p className="text-2xs text-ink-3 mt-0.5">{hint}</p>}
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { denied?: string };
}) {
  const session = await requireSession();
  const db = supabaseServer();

  const [{ data: summary }, { data: lowStock }, { data: recent }] = await Promise.all([
    db.rpc('dashboard_summary'),
    db
      .from('v_sku_status')
      .select('sku_code, display_name, product_type, brand_name, exact_size, current_stock, min_stock_level, unit_code, stock_status, shortfall, suggested_purchase_qty')
      .eq('is_active', true)
      .in('stock_status', ['LOW_STOCK', 'OUT_OF_STOCK'])
      .order('shortfall', { ascending: false })
      .limit(12),
    db
      .from('v_movements')
      .select('id, txn_no, occurred_at, txn_type, txn_mode, quantity, unit_code, new_stock, display_name, user_name, channel, reference')
      .order('occurred_at', { ascending: false })
      .limit(10),
  ]);

  const s = (summary ?? {}) as DashboardSummary;
  const low = (lowStock ?? []) as Pick<
    SkuStatus,
    'sku_code' | 'display_name' | 'product_type' | 'brand_name' | 'exact_size' | 'current_stock' | 'min_stock_level' | 'unit_code' | 'stock_status' | 'shortfall' | 'suggested_purchase_qty'
  >[];
  const movements = (recent ?? []) as Movement[];

  return (
    <div className="p-4 lg:p-6 max-w-[1400px]">
      {searchParams.denied && (
        <p className="mb-4 text-xs text-warn bg-warn-soft border border-warn/25 rounded px-3 py-2">
          Your role does not include <span className="font-mono">{searchParams.denied}</span>. Ask a Super Admin if you need it.
        </p>
      )}

      <div className="flex items-end justify-between gap-4 mb-4">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Dashboard</h1>
          <p className="text-xs text-ink-3">
            {new Date().toLocaleDateString('en-IN', {
              timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
            })}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {can(session, 'transactions.create') && (
            <>
              <Link href="/inventory?action=inward" className="btn-secondary">Record inward</Link>
              <Link href="/inventory?action=outward" className="btn-primary">Record outward</Link>
            </>
          )}
          <Link href="/inventory" className="btn-secondary">Search stock</Link>
        </div>
      </div>

      {/* stock overview */}
      <section className="panel mb-4">
        <div className="panel-head">
          <h2 className="panel-title">Stock overview</h2>
          <span className="text-2xs text-ink-3">Active SKUs</span>
        </div>
        <div className="flex flex-wrap divide-line">
          <Metric label="Total SKUs" value={s.total_skus ?? 0} />
          <Metric label="Timing belts" value={s.timing_skus ?? 0} hint="Family / size / brand" />
          <Metric label="V-belts" value={s.vbelt_skus ?? 0} hint="Brand / profile / size" />
          <Metric label="Below minimum" value={s.low_stock ?? 0} hint="Reorder level breached" />
          <Metric label="Out of stock" value={s.out_of_stock ?? 0} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        {/* today's movement */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Today&apos;s movement</h2>
            <Link href="/transactions?range=today" className="text-2xs text-accent hover:underline">
              Open transactions
            </Link>
          </div>
          <div className="flex divide-x divide-line">
            <Metric label="Inward" value={s.today_inward ?? 0} />
            <Metric label="Outward" value={s.today_outward ?? 0} />
            <Metric label="Adjustments" value={s.today_adjustments ?? 0} />
            <Metric label="This month" value={s.month_movements ?? 0} hint="All movements" />
          </div>
        </section>

        {/* recent transactions */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Latest movements</h2>
            <Link href="/transactions" className="text-2xs text-accent hover:underline">See all</Link>
          </div>
          <div className="max-h-[262px] scroll-y">
            {movements.length === 0 ? (
              <p className="p-4 text-xs text-ink-3">Nothing recorded yet. Record an inward to get started.</p>
            ) : (
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Time</th><th>Product</th><th className="num">Qty</th><th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
                    <tr key={m.id}>
                      <td className="num text-ink-3">{fmtTime(m.occurred_at)}</td>
                      <td className="max-w-[220px] truncate" title={m.display_name}>
                        <span
                          className={
                            m.txn_type === 'INWARD' ? 'tag-in mr-1.5'
                              : m.txn_type === 'OUTWARD' ? 'tag-out-mv mr-1.5' : 'tag-adj mr-1.5'
                          }
                        >
                          {m.txn_type === 'ADJUSTMENT' ? 'ADJ' : m.txn_type.slice(0, 3)}
                        </span>
                        {m.display_name}
                      </td>
                      <td className="num">{fmtQty(m.quantity, m.unit_code)}</td>
                      <td className="text-ink-2">
                        {m.user_name}
                        <span className="text-ink-3"> &middot; {CHANNEL_LABEL[m.channel] ?? m.channel}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      {/* low stock */}
      <section className="panel mt-4">
        <div className="panel-head">
          <h2 className="panel-title">Needs reordering</h2>
          <span className="text-2xs text-ink-3">
            Minimum stock is the reorder trigger. Supplier MOQ sets the suggested quantity.
          </span>
        </div>
        {low.length === 0 ? (
          <p className="p-4 text-xs text-ink-3">Every active SKU is at or above its minimum stock level.</p>
        ) : (
          <div className="scroll-y max-h-[420px]">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Product</th><th>Brand</th><th>Type</th>
                  <th className="num">In stock</th><th className="num">Minimum</th>
                  <th className="num">Suggested purchase</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {low.map((r) => (
                  <tr key={r.sku_code}>
                    <td className="font-medium">{r.exact_size}</td>
                    <td className="text-ink-2">{r.brand_name}</td>
                    <td className="text-ink-3">{r.product_type === 'TIMING_BELT' ? 'Timing' : 'V-belt'}</td>
                    <td className="num">{fmtQty(r.current_stock, r.unit_code)}</td>
                    <td className="num text-ink-3">{fmtQty(r.min_stock_level, r.unit_code)}</td>
                    <td className="num font-medium">{fmtQty(r.suggested_purchase_qty, r.unit_code)}</td>
                    <td>
                      <span className={r.stock_status === 'OUT_OF_STOCK' ? 'tag-out' : 'tag-low'}>
                        {r.stock_status === 'OUT_OF_STOCK' ? 'Out of stock' : 'Low'}
                      </span>
                    </td>
                    <td className="text-right">
                      <Link href={`/inventory?sku=${encodeURIComponent(r.sku_code)}`} className="text-2xs text-accent hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
