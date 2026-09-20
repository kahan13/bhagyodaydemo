import { Suspense } from 'react';
import { ArrowDownLeft, ArrowUpRight, ShoppingCart, Check } from 'lucide-react';
import { requireSession, can } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { supabaseService } from '@/lib/supabase-server';
import { fmtQty, fmtRelative, fmtDate } from '@/lib/format';
import type { DashboardSummary, Movement, Sku } from '@/lib/types';
import DashboardActions from '@/components/dashboard/DashboardActions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = { TIMING_BELT: 'Timing', V_BELT: 'V-Belt' };

/* ── Stats ───────────────────────────────────────────────────────────────── */
function Stat({ label, value, sub, tone }: {
  label: string; value: string | number; sub?: string; tone?: 'warn' | 'danger';
}) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className={`num text-[24px] font-semibold tracking-[-0.02em] mt-1.5 leading-none ${
        tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : ''
      }`}>{value}</p>
      {sub && <p className="text-[11px] text-ink-3 mt-1.5">{sub}</p>}
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
      <Stat label="Active SKUs" value={s.total_skus ?? 0} sub={`${s.timing_skus ?? 0} timing · ${s.vbelt_skus ?? 0} v-belt`} />
      <Stat label="Below minimum" value={s.low_stock ?? 0} sub={`${s.out_of_stock ?? 0} out of stock`} tone={(s.low_stock ?? 0) > 0 ? 'warn' : undefined} />
      <Stat label="Today's movements" value={(s.today_inward ?? 0) + (s.today_outward ?? 0) + (s.today_adjust ?? 0)} sub={`${s.today_inward ?? 0} in · ${s.today_outward ?? 0} out · net ${net >= 0 ? '+' : ''}${net}`} />
      <Stat label="This month" value={s.month_moves ?? 0} sub={`${(s.total_moves ?? 0).toLocaleString('en-IN')} recorded in total`} />
    </div>
  );
}

/* ── Transactions pane ───────────────────────────────────────────────────── */
type MovRow = {
  id: string; occurred_at: string; quantity: number; unit_code: string;
  exact_size: string; brand_name: string; invoice_no: string | null;
  product_type: string;
};

async function Transactions() {
  const db = await supabaseServer();
  const [inRes, outRes] = await Promise.all([
    db.from('v_movements')
      .select('id,occurred_at,quantity,unit_code,exact_size,brand_name,invoice_no,product_type')
      .eq('txn_type', 'INWARD').order('occurred_at', { ascending: false }).limit(7),
    db.from('v_movements')
      .select('id,occurred_at,quantity,unit_code,exact_size,brand_name,invoice_no,product_type')
      .eq('txn_type', 'OUTWARD').order('occurred_at', { ascending: false }).limit(7),
  ]);

  const inward  = (inRes.data  ?? []) as MovRow[];
  const outward = (outRes.data ?? []) as MovRow[];

  function MovList({ rows, sign, color }: { rows: MovRow[]; sign: string; color: string }) {
    if (rows.length === 0)
      return <p className="py-6 text-[12px] text-ink-3 text-center">No movements yet.</p>;
    return (
      <ul className="divide-y divide-line">
        {rows.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] truncate">
                <span className="font-medium">{m.exact_size}</span>
                <span className="text-ink-3"> · {m.brand_name}</span>
              </span>
              <span className="flex items-center gap-1.5 mt-0.5">
                {m.product_type && (
                  <span className="text-[10px] px-1 py-0.5 rounded bg-subtle text-ink-3 font-medium">
                    {TYPE_LABEL[m.product_type] ?? m.product_type}
                  </span>
                )}
                <span className="text-[11px] text-ink-3">{fmtRelative(m.occurred_at)}</span>
                {m.invoice_no && (
                  <span className="text-[11px] font-mono text-ink-3">· {m.invoice_no}</span>
                )}
              </span>
            </span>
            <span className={`num text-[12px] font-semibold shrink-0 ${color}`}>
              {sign}{fmtQty(Math.abs(m.quantity), m.unit_code)}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Transactions</h2>
        <Link href="/transactions" className="text-[12px] text-brand hover:underline">View all</Link>
      </div>
      <div className="grid grid-cols-2 divide-x divide-line">
        <div>
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
            <span className="grid place-items-center h-5 w-5 rounded bg-ok-soft text-ok">
              <ArrowDownLeft size={11} />
            </span>
            <span className="text-[12px] font-semibold">Inward</span>
            <span className="ml-auto text-[11px] text-ink-3">{inward.length}</span>
          </div>
          <MovList rows={inward} sign="+" color="text-ok" />
        </div>
        <div>
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
            <span className="grid place-items-center h-5 w-5 rounded bg-brand-soft text-brand">
              <ArrowUpRight size={11} />
            </span>
            <span className="text-[12px] font-semibold">Outward</span>
            <span className="ml-auto text-[11px] text-ink-3">{outward.length}</span>
          </div>
          <MovList rows={outward} sign="−" color="text-brand" />
        </div>
      </div>
    </section>
  );
}

/* ── Purchase Orders pane (per-line-item rows) ───────────────────────────── */
type POItem = {
  id: string; order_id: string; sku_id: string;
  ordered_qty: number; received_qty: number; status: string;
  order_no: string; supplier_name: string | null; order_status: string; created_at: string;
  exact_size: string; brand_name: string; unit_code: string; product_type: string;
};

async function OrdersPane() {
  const svc = await supabaseService();

  const { data: rawOrders } = await svc
    .from('purchase_orders')
    .select('id,order_no,supplier_name,status,created_at')
    .order('created_at', { ascending: false })
    .limit(15);

  const orders = (rawOrders ?? []) as { id: string; order_no: string; supplier_name: string | null; status: string; created_at: string }[];

  let lineItems: POItem[] = [];

  if (orders.length > 0) {
    const orderIds = orders.map((o) => o.id);
    const { data: items } = await svc
      .from('purchase_order_items')
      .select('id,order_id,sku_id,ordered_qty,received_qty,status')
      .in('order_id', orderIds)
      .order('created_at');

    const its = (items ?? []) as { id: string; order_id: string; sku_id: string; ordered_qty: number; received_qty: number; status: string }[];

    if (its.length > 0) {
      const skuIds = [...new Set(its.map((i) => i.sku_id))];
      const { data: skuRows } = await svc
        .from('skus')
        .select('id,exact_size,brand_name,unit_code,product_type')
        .in('id', skuIds);

      const skuMap: Record<string, { exact_size: string; brand_name: string; unit_code: string; product_type: string }> = {};
      for (const s of (skuRows ?? []) as { id: string; exact_size: string; brand_name: string; unit_code: string; product_type: string }[]) {
        skuMap[s.id] = s;
      }

      const orderMap: Record<string, typeof orders[number]> = {};
      for (const o of orders) orderMap[o.id] = o;

      lineItems = its.map((i) => ({
        ...i,
        order_no:      orderMap[i.order_id]?.order_no ?? '',
        supplier_name: orderMap[i.order_id]?.supplier_name ?? null,
        order_status:  orderMap[i.order_id]?.status ?? '',
        created_at:    orderMap[i.order_id]?.created_at ?? '',
        exact_size:    skuMap[i.sku_id]?.exact_size  ?? '—',
        brand_name:    skuMap[i.sku_id]?.brand_name  ?? '—',
        unit_code:     skuMap[i.sku_id]?.unit_code   ?? '',
        product_type:  skuMap[i.sku_id]?.product_type ?? '',
      }));
    }
  }

  const inProgress = lineItems.filter((i) => i.status !== 'FULFILLED');
  const fulfilled  = lineItems.filter((i) => i.status === 'FULFILLED');

  function ItemBadge({ status }: { status: string }) {
    const map: Record<string, string> = {
      PENDING:   'bg-surface-2 text-ink-3 border border-line',
      PARTIAL:   'bg-warn-soft text-warn',
      FULFILLED: 'bg-ok-soft text-ok',
    };
    const lbl: Record<string, string> = { PENDING: 'Pending', PARTIAL: 'Partial', FULFILLED: 'Done' };
    return (
      <span className={`text-[10px] font-semibold px-1 py-0.5 rounded ${map[status] ?? ''}`}>
        {lbl[status] ?? status}
      </span>
    );
  }

  function ItemList({ rows }: { rows: POItem[] }) {
    if (rows.length === 0)
      return <p className="py-6 text-[12px] text-ink-3 text-center">None.</p>;
    return (
      <ul className="divide-y divide-line">
        {rows.map((i) => {
          const remaining = i.ordered_qty - i.received_qty;
          return (
            <li key={i.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[12px] font-medium truncate">{i.exact_size}</span>
                  <span className="text-[11px] text-ink-3 shrink-0">{i.brand_name}</span>
                  {i.product_type && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-subtle text-ink-3 font-medium shrink-0">
                      {TYPE_LABEL[i.product_type]}
                    </span>
                  )}
                  <ItemBadge status={i.status} />
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[11px] text-ink-3 font-mono">{i.order_no}</span>
                  <span className="text-[11px] text-ink-3">{fmtDate(i.created_at)}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[12px] font-semibold num">
                  {i.received_qty}
                  <span className="text-ink-3 font-normal">/{i.ordered_qty}</span>
                  <span className="text-[10px] text-ink-3 ml-0.5">{i.unit_code}</span>
                </div>
                {remaining > 0 ? (
                  <div className="text-[10px] text-warn num">{remaining} left</div>
                ) : (
                  <div className="text-[10px] text-ok flex items-center justify-end gap-0.5">
                    <Check size={10} /> done
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  const inProgressOrderCount = new Set(inProgress.map((i) => i.order_id)).size;

  return (
    <section className="card">
      <div className="card-head">
        <div className="flex items-center gap-2">
          <h2 className="card-title">Purchase Orders</h2>
          {inProgressOrderCount > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warn-soft text-warn">
              {inProgressOrderCount}
            </span>
          )}
        </div>
        <Link href="/purchase-orders" className="text-[12px] text-brand hover:underline">View all</Link>
      </div>
      <div className="grid grid-cols-2 divide-x divide-line">
        <div>
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
            <ShoppingCart size={11} className="text-warn" />
            <span className="text-[12px] font-semibold">In Progress</span>
            <span className="ml-auto text-[11px] text-ink-3">{inProgress.length}</span>
          </div>
          <ItemList rows={inProgress} />
        </div>
        <div>
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
            <ShoppingCart size={11} className="text-ok" />
            <span className="text-[12px] font-semibold">Fulfilled</span>
            <span className="ml-auto text-[11px] text-ink-3">{fulfilled.length}</span>
          </div>
          <ItemList rows={fulfilled} />
        </div>
      </div>
    </section>
  );
}

/* ── Needs reordering (compact, below the two panes) ────────────────────── */
async function LowStock() {
  const db = await supabaseServer();
  const { data } = await db
    .from('v_sku_status')
    .select('sku_code,exact_size,brand_name,current_stock,min_stock_level,unit_code,stock_status,shortfall,suggested_purchase_qty,product_type')
    .eq('is_active', true)
    .in('stock_status', ['LOW_STOCK', 'OUT_OF_STOCK'])
    .order('shortfall', { ascending: false })
    .limit(10);

  const rows = (data ?? []) as Pick<Sku,
    'sku_code'|'exact_size'|'brand_name'|'current_stock'|'min_stock_level'|
    'unit_code'|'stock_status'|'shortfall'|'suggested_purchase_qty'|'product_type'>[];

  return (
    <section className="card">
      <div className="card-head">
        <div className="flex items-center gap-2">
          <h2 className="card-title">Needs reordering</h2>
          {rows.length > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warn-soft text-warn">
              {rows.length}
            </span>
          )}
        </div>
        <Link href="/inventory" className="text-[12px] text-brand hover:underline">View inventory</Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-ink-3 text-center">All products at or above minimum.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Brand</th>
                <th>Type</th>
                <th className="text-right">Stock</th>
                <th className="text-right">Min</th>
                <th className="text-right">Order qty</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku_code}>
                  <td className="font-medium">{r.exact_size}</td>
                  <td className="text-ink-2">{r.brand_name}</td>
                  <td className="text-ink-3 text-[11px]">{TYPE_LABEL[r.product_type ?? ''] ?? r.product_type}</td>
                  <td className="num text-right">
                    <span className={r.stock_status === 'OUT_OF_STOCK' ? 'text-danger font-medium' : 'text-warn font-medium'}>
                      {fmtQty(r.current_stock, r.unit_code)}
                    </span>
                  </td>
                  <td className="num text-right text-ink-3">{fmtQty(r.min_stock_level, r.unit_code)}</td>
                  <td className="num text-right font-medium">{fmtQty(r.suggested_purchase_qty, r.unit_code)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const session = await requireSession();
  const { denied } = await searchParams;
  const write = can(session, 'transactions.create');

  const hour = Number(
    new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false })
  );
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const db = await supabaseServer();
  const [usersRes, lastRefRes, lastInvRes] = await Promise.all([
    db.from('app_users').select('id,full_name').eq('is_active', true).order('full_name'),
    db.from('v_movements').select('reference').not('reference', 'is', null).order('occurred_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('v_movements').select('invoice_no').not('invoice_no', 'is', null).eq('txn_type', 'OUTWARD').order('occurred_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const users       = (usersRes.data ?? []) as { id: string; full_name: string }[];
  const lastRef     = (lastRefRes.data as { reference: string } | null)?.reference    ?? null;
  const lastInvoice = (lastInvRes.data  as { invoice_no: string } | null)?.invoice_no ?? null;

  return (
    <div className="p-4 lg:p-6 max-w-[1400px] mx-auto space-y-4">
      {denied && (
        <p className="text-[13px] text-warn bg-warn-soft rounded-lg px-3.5 py-2.5">
          Your role does not include <span className="font-mono text-[12px]">{denied}</span>.
          Ask a Super Admin if you need it.
        </p>
      )}

      {/* Header */}
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
          <DashboardActions canWrite={write} users={users} lastRef={lastRef} lastInvoice={lastInvoice} />
        </div>
      </div>

      {/* Zone 1: Stats */}
      <Suspense fallback={<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0,1,2,3].map(i=><div key={i} className="card p-4 h-[88px] skeleton"/>)}</div>}>
        <Stats />
      </Suspense>

      {/* Zone 2: Transactions + Purchase Orders side by side */}
      <div className="grid gap-4 xl:grid-cols-2">
        <Suspense fallback={<div className="card h-[380px] skeleton" />}>
          <Transactions />
        </Suspense>
        <Suspense fallback={<div className="card h-[380px] skeleton" />}>
          <OrdersPane />
        </Suspense>
      </div>

      {/* Zone 3: Needs reordering — full width below */}
      <Suspense fallback={<div className="card h-[240px] skeleton" />}>
        <LowStock />
      </Suspense>
    </div>
  );
}
