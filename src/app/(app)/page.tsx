import { Suspense } from 'react';
import { ArrowDownLeft, ArrowUpRight, ShoppingCart } from 'lucide-react';
import { requireSession, can } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { fmtQty, fmtRelative, fmtDate } from '@/lib/format';
import type { DashboardSummary, Movement, Sku } from '@/lib/types';
import DashboardActions from '@/components/dashboard/DashboardActions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'warn' | 'danger' }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className={`num text-[26px] font-semibold tracking-[-0.02em] mt-1.5 leading-none ${
        tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : ''
      }`}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-ink-3 mt-1.5">{sub}</p>}
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => <div key={i} className="card p-4 h-[92px] skeleton" />)}
    </div>
  );
}

async function Stats() {
  const db = await supabaseServer();
  const { data } = await db.rpc('dashboard_summary');
  const s = (data ?? {}) as DashboardSummary;
  const net = (s.today_inward ?? 0) - (s.today_outward ?? 0);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat
        label="Active SKUs"
        value={s.total_skus ?? 0}
        sub={`${s.timing_skus ?? 0} timing · ${s.vbelt_skus ?? 0} v-belt`}
      />
      <Stat
        label="Below minimum"
        value={s.low_stock ?? 0}
        sub={`${s.out_of_stock ?? 0} out of stock`}
        tone={(s.low_stock ?? 0) > 0 ? 'warn' : undefined}
      />
      <Stat
        label="Today's movements"
        value={(s.today_inward ?? 0) + (s.today_outward ?? 0) + (s.today_adjust ?? 0)}
        sub={`${s.today_inward ?? 0} in · ${s.today_outward ?? 0} out · net ${net >= 0 ? '+' : ''}${net}`}
      />
      <Stat
        label="This month"
        value={s.month_moves ?? 0}
        sub={`${(s.total_moves ?? 0).toLocaleString('en-IN')} recorded in total`}
      />
    </div>
  );
}

async function LowStock() {
  const db = await supabaseServer();
  const { data } = await db
    .from('v_sku_status')
    .select('sku_code,exact_size,brand_name,product_type,current_stock,min_stock_level,unit_code,stock_status,shortfall,suggested_purchase_qty')
    .eq('is_active', true)
    .in('stock_status', ['LOW_STOCK', 'OUT_OF_STOCK'])
    .order('shortfall', { ascending: false })
    .limit(10);

  const rows = (data ?? []) as Pick<Sku,
    'sku_code' | 'exact_size' | 'brand_name' | 'product_type' | 'current_stock' |
    'min_stock_level' | 'unit_code' | 'stock_status' | 'shortfall' | 'suggested_purchase_qty'>[];

  return (
    <section className="card">
      <div className="card-head">
        <div className="flex items-center gap-2">
          <h2 className="card-title">Needs reordering</h2>
          {rows.length > 0 && <span className="badge badge-warn">{rows.length}</span>}
        </div>
        <span className="text-[11px] text-ink-3 hidden sm:block">
          Suggested quantity respects supplier MOQ
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-8 text-[13px] text-ink-3 text-center">
          Everything is at or above its minimum level.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th><th>Brand</th>
                <th className="text-right">In stock</th>
                <th className="text-right">Minimum</th>
                <th className="text-right">Order</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku_code}>
                  <td className="font-medium">{r.exact_size}</td>
                  <td className="text-ink-2">{r.brand_name}</td>
                  <td className="num text-right">
                    <span className={r.stock_status === 'OUT_OF_STOCK' ? 'text-danger font-medium' : 'text-warn font-medium'}>
                      {fmtQty(r.current_stock, r.unit_code)}
                    </span>
                  </td>
                  <td className="num text-right text-ink-3">{fmtQty(r.min_stock_level, r.unit_code)}</td>
                  <td className="num text-right font-medium">{fmtQty(r.suggested_purchase_qty, r.unit_code)}</td>
                  <td className="text-right">
                    <Link href={`/inventory?sku=${encodeURIComponent(r.sku_code)}`} className="text-[12px] text-brand hover:underline">
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
  );
}

/* ── Latest Transactions Panel ────────────────────────────────────────────── */

type PurchaseOrderRow = {
  id: string;
  order_no: string;
  supplier_name: string | null;
  status: string;
  created_at: string;
  total_ordered: number;
  total_received: number;
  items_partial: number;
};

async function LatestTransactions() {
  const db = await supabaseServer();

  const [inwardRes, outwardRes, ordersRes] = await Promise.all([
    db
      .from('v_movements')
      .select('id,occurred_at,txn_type,quantity,unit_code,exact_size,brand_name,user_name,invoice_no,operated_by_name')
      .eq('txn_type', 'INWARD')
      .order('occurred_at', { ascending: false })
      .limit(5),
    db
      .from('v_movements')
      .select('id,occurred_at,txn_type,quantity,unit_code,exact_size,brand_name,user_name,invoice_no,operated_by_name')
      .eq('txn_type', 'OUTWARD')
      .order('occurred_at', { ascending: false })
      .limit(5),
    // Aggregate per order via items table
    db
      .from('purchase_orders')
      .select('id,order_no,supplier_name,status,created_at')
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const inward = (inwardRes.data ?? []) as Movement[];
  const outward = (outwardRes.data ?? []) as Movement[];
  const rawOrders = (ordersRes.data ?? []) as Omit<PurchaseOrderRow, 'total_ordered' | 'total_received' | 'items_partial'>[];

  // Fetch item aggregates for those orders
  let orders: PurchaseOrderRow[] = [];
  if (rawOrders.length > 0) {
    const orderIds = rawOrders.map((o) => o.id);
    const { data: itemsData } = await db
      .from('purchase_order_items')
      .select('order_id,ordered_qty,received_qty,status')
      .in('order_id', orderIds);

    const items = (itemsData ?? []) as { order_id: string; ordered_qty: number; received_qty: number; status: string }[];

    orders = rawOrders.map((o) => {
      const its = items.filter((i) => i.order_id === o.id);
      return {
        ...o,
        total_ordered: its.reduce((s, i) => s + (i.ordered_qty ?? 0), 0),
        total_received: its.reduce((s, i) => s + (i.received_qty ?? 0), 0),
        items_partial: its.filter((i) => i.status === 'PARTIAL').length,
      };
    });
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Latest transactions</h2>
        <Link href="/transactions" className="text-[12px] text-brand hover:underline">View all</Link>
      </div>

      <div className="divide-y divide-line">

        {/* ── INWARD ── */}
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="grid place-items-center h-6 w-6 rounded-md bg-ok-soft text-ok shrink-0">
              <ArrowDownLeft size={13} />
            </span>
            <span className="text-[13px] font-semibold text-ink-1">Inward</span>
          </div>

          {/* Purchase order fulfillment sub-pane */}
          {orders.length > 0 && (
            <div className="rounded-lg border border-line overflow-hidden">
              <div className="px-3 py-1.5 bg-surface-2 border-b border-line flex items-center justify-between">
                <span className="text-[11px] font-medium text-ink-2 flex items-center gap-1.5">
                  <ShoppingCart size={11} />
                  Purchase orders
                </span>
                <Link href="/purchase-orders" className="text-[11px] text-brand hover:underline">View all</Link>
              </div>
              {orders.map((o) => {
                const remaining = o.total_ordered - o.total_received;
                return (
                  <div key={o.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-line last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12px] font-medium text-ink-1">{o.order_no}</span>
                        {o.supplier_name && (
                          <span className="text-[11px] text-ink-3 truncate">· {o.supplier_name}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5">
                        <span className="text-[11px] text-ink-3">{fmtDate(o.created_at)}</span>
                        {o.items_partial > 0 && (
                          <span className="text-[11px] text-warn">{o.items_partial} item{o.items_partial > 1 ? 's' : ''} in progress</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[12px] font-semibold text-ink-1">
                        {o.total_received}<span className="text-ink-3 font-normal"> / {o.total_ordered}</span>
                      </div>
                      <div className="text-[10px] text-ink-3 mt-0.5">
                        {remaining > 0 ? `${remaining} remaining` : 'fulfilled'}
                      </div>
                    </div>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${
                      o.status === 'FULFILLED' ? 'bg-ok-soft text-ok'
                      : o.status === 'PARTIAL' ? 'bg-warn-soft text-warn'
                      : 'bg-brand-soft text-brand'
                    }`}>
                      {o.status === 'FULFILLED' ? 'Done' : o.status === 'PARTIAL' ? 'Partial' : 'Placed'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Recent inward movements */}
          {inward.length === 0 ? (
            <p className="text-[12px] text-ink-3 text-center py-2">No inward movements yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {inward.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] truncate">
                      <span className="font-medium">{m.exact_size}</span>
                      <span className="text-ink-3"> · {m.brand_name}</span>
                    </span>
                    <span className="block text-[11px] text-ink-3 truncate">
                      {m.operated_by_name ?? m.user_name} · {fmtRelative(m.occurred_at)}
                      {m.invoice_no && <> · <span className="font-mono">{m.invoice_no}</span></>}
                    </span>
                  </span>
                  <span className="num text-[12px] font-semibold text-ok shrink-0">
                    +{fmtQty(Math.abs(m.quantity), m.unit_code)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── OUTWARD ── */}
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="grid place-items-center h-6 w-6 rounded-md bg-brand-soft text-brand shrink-0">
              <ArrowUpRight size={13} />
            </span>
            <span className="text-[13px] font-semibold text-ink-1">Outward</span>
          </div>

          {outward.length === 0 ? (
            <p className="text-[12px] text-ink-3 text-center py-2">No outward movements yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {outward.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] truncate">
                      <span className="font-medium">{m.exact_size}</span>
                      <span className="text-ink-3"> · {m.brand_name}</span>
                    </span>
                    <span className="block text-[11px] text-ink-3 truncate">
                      {m.operated_by_name ?? m.user_name} · {fmtRelative(m.occurred_at)}
                      {m.invoice_no && <> · <span className="font-mono">{m.invoice_no}</span></>}
                    </span>
                  </span>
                  <span className="num text-[12px] font-semibold text-brand shrink-0">
                    −{fmtQty(Math.abs(m.quantity), m.unit_code)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

      </div>
    </section>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const session = await requireSession();
  const { denied } = await searchParams;
  const write = can(session, 'transactions.create');

  const hour = Number(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const db = await supabaseServer();

  const [usersRes, lastRefRes, lastInvRes] = await Promise.all([
    db.from('app_users').select('id,full_name').eq('is_active', true).order('full_name'),
    db.from('v_movements').select('reference').not('reference', 'is', null).order('occurred_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('v_movements').select('invoice_no').not('invoice_no', 'is', null).eq('txn_type', 'OUTWARD').order('occurred_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const users = (usersRes.data ?? []) as { id: string; full_name: string }[];
  const lastRef = (lastRefRes.data as { reference: string } | null)?.reference ?? null;
  const lastInvoice = (lastInvRes.data as { invoice_no: string } | null)?.invoice_no ?? null;

  return (
    <div className="p-4 lg:p-6 max-w-[1360px] mx-auto space-y-4">
      {denied && (
        <p className="text-[13px] text-warn bg-warn-soft rounded-lg px-3.5 py-2.5">
          Your role does not include <span className="font-mono text-[12px]">{denied}</span>.
          Ask a Super Admin if you need it.
        </p>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold">
            {greeting}, {session.user.full_name.split(' ')[0]}
          </h1>
          <p className="text-[13px] text-ink-3 mt-0.5" suppressHydrationWarning>
            {new Date().toLocaleDateString('en-IN', {
              timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            })}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <DashboardActions
            canWrite={write}
            users={users}
            lastRef={lastRef}
            lastInvoice={lastInvoice}
          />
        </div>
      </div>

      <Suspense fallback={<StatSkeleton />}>
        <Stats />
      </Suspense>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Suspense fallback={<div className="card h-[380px] skeleton" />}>
          <LowStock />
        </Suspense>
        <Suspense fallback={<div className="card h-[380px] skeleton" />}>
          <LatestTransactions />
        </Suspense>
      </div>
    </div>
  );
}
