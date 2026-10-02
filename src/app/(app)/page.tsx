import { Suspense } from 'react';
import { ArrowDownLeft, ArrowUpRight, ShoppingCart, Check, Package, Clock, Ban } from 'lucide-react';
import { requireSession, can } from '@/lib/auth';
import { supabaseServer, supabaseService } from '@/lib/supabase-server';

import { fmtQty, fmtRelative, fmtDate } from '@/lib/format';
import type { DashboardSummary, Movement, Sku, ProductionOrder, ProductionOrderItem } from '@/lib/types';
import DashboardActions from '@/components/dashboard/DashboardActions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = { TIMING_BELT: 'Timing', V_BELT: 'V-Belt', CONVEYOR_BELT: 'Conveyor' };

const PO_STATUS_LABEL: Record<string, string> = {
  CREATED:     'Created',
  SENT:        'Sent',
  IN_PROGRESS: 'In Progress',
  COMPLETED:   'Completed',
  CANCELLED:   'Cancelled',
};

const PO_STATUS_STYLE: Record<string, string> = {
  CREATED:     'bg-warn/10 text-warn',
  SENT:        'bg-brand/10 text-brand',
  IN_PROGRESS: 'bg-ok/10 text-ok',
  COMPLETED:   'bg-subtle text-ink-3',
  CANCELLED:   'bg-danger/10 text-danger',
};

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

/* ── Lot wording helpers (timing belts only) ─────────────────────────────── */
type LotEntry = { lot_no?: string; status: string; qty: number };
const LOT_NAME: Record<string, string> = { FULL_SLEEVE: 'Full Sleeve', CUT_PCS: 'Cut Pcs' };

/** "30 Cut Pcs + 50 Full Sleeve" — grouped by classification. */
function lotSplit(entries: LotEntry[]): string {
  const by = new Map<string, number>();
  for (const e of entries) by.set(e.status, (by.get(e.status) ?? 0) + Number(e.qty));
  return [...by.entries()]
    .sort((a, b) => (a[0] === 'CUT_PCS' ? -1 : 1) - (b[0] === 'CUT_PCS' ? -1 : 1))
    .map(([st, q]) => `${q} ${LOT_NAME[st] ?? st}`).join(' + ');
}
/** "4 × 50 mm rolls" for an inward's new lots. */
function rollsText(entries: LotEntry[]): string {
  const by = new Map<number, number>();
  for (const e of entries) by.set(Number(e.qty), (by.get(Number(e.qty)) ?? 0) + 1);
  return [...by.entries()].map(([len, n]) => `${n} × ${len} mm roll${n === 1 ? '' : 's'}`).join(' + ');
}
const rollsOf = (mm: number, len: number) => {
  const r = mm / len;
  return `${Number.isInteger(r) ? r : Math.round(r * 100) / 100} roll${r === 1 ? '' : 's'}`;
};

/* ── Transactions pane ───────────────────────────────────────────────────── */
type MovRow = {
  id: string; occurred_at: string; quantity: number; unit_code: string;
  exact_size: string; brand_name: string; invoice_no: string | null;
  product_type: string;
  txn_type?: string; lot_breakdown?: LotEntry[] | null; lot_tracked?: boolean;
};

async function Transactions() {
  const db = await supabaseServer();
  const [inRes, outRes] = await Promise.all([
    db.from('v_movements')
      .select('id,occurred_at,quantity,unit_code,exact_size,brand_name,invoice_no,product_type,lot_breakdown,lot_tracked')
      .eq('txn_type', 'INWARD').order('occurred_at', { ascending: false }).limit(7),
    db.from('v_movements')
      .select('id,occurred_at,quantity,unit_code,exact_size,brand_name,invoice_no,product_type,lot_breakdown,lot_tracked')
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
            <span className="shrink-0 text-right">
              {m.lot_tracked && m.lot_breakdown && m.lot_breakdown.length > 0 && (
                <span className="block text-[11px] text-ink-2 num leading-tight">
                  {sign === '+' ? rollsText(m.lot_breakdown) : lotSplit(m.lot_breakdown)}
                </span>
              )}
              <span className={`num text-[12px] font-semibold ${color}`}>
                {sign}{fmtQty(Math.abs(m.quantity), m.unit_code)}
              </span>
              {m.lot_tracked && m.lot_breakdown && m.lot_breakdown.length > 0 && (
                <span className="text-[10px] text-ink-3"> total</span>
              )}
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

/* ── Purchase Orders pane ────────────────────────────────────────────────── */
type POItem = {
  id: string; order_id: string; sku_id: string;
  ordered_qty: number; received_qty: number; status: string;
  order_no: string; supplier_name: string | null; order_status: string; created_at: string;
  exact_size: string; brand_name: string; unit_code: string; product_type: string;
  roll_len?: number;
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
        .from('v_sku_status')
        .select('id,exact_size,brand_name,unit_code,product_type,roll_length_mm')
        .in('id', skuIds);

      const skuMap: Record<string, { exact_size: string; brand_name: string; unit_code: string; product_type: string; roll_length_mm: number | null }> = {};
      for (const s of (skuRows ?? []) as { id: string; exact_size: string; brand_name: string; unit_code: string; product_type: string; roll_length_mm: number | null }[]) {
        skuMap[s.id] = s;
      }

      const orderMap: Record<string, typeof orders[number]> = {};
      for (const o of orders) orderMap[o.id] = o;

      lineItems = its.map((i) => ({
        ...i,
        order_no:      orderMap[i.order_id]?.order_no      ?? '',
        supplier_name: orderMap[i.order_id]?.supplier_name ?? null,
        order_status:  orderMap[i.order_id]?.status        ?? '',
        created_at:    orderMap[i.order_id]?.created_at    ?? '',
        exact_size:    skuMap[i.sku_id]?.exact_size        ?? '—',
        brand_name:    skuMap[i.sku_id]?.brand_name        ?? '—',
        unit_code:     skuMap[i.sku_id]?.unit_code         ?? '',
        product_type:  skuMap[i.sku_id]?.product_type      ?? '',
        roll_len:      skuMap[i.sku_id]?.product_type === 'TIMING_BELT' ? Number(skuMap[i.sku_id]?.roll_length_mm ?? 0) : 0,
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
                {i.roll_len ? (
                  <div className="text-[12px] font-semibold num">
                    {Number(i.received_qty) / i.roll_len}
                    <span className="text-ink-3 font-normal">/{Number(i.ordered_qty) / i.roll_len} rolls</span>
                  </div>
                ) : null}
                <div className={i.roll_len ? 'text-[10px] text-ink-3 num' : 'text-[12px] font-semibold num'}>
                  {i.received_qty}
                  <span className="text-ink-3 font-normal">/{i.ordered_qty}</span>
                  <span className="text-[10px] text-ink-3 ml-0.5">{i.unit_code}</span>
                </div>
                {remaining > 0 ? (
                  <div className="text-[10px] text-warn num">
                    {i.roll_len ? `${rollsOf(remaining, i.roll_len)} (${remaining} ${i.unit_code}) left` : `${remaining} left`}
                  </div>
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

/* ── Production Orders pane ──────────────────────────────────────────────── */
type ProdOrderRow = {
  id: string;
  order_no: string;
  customer_name: string | null;
  status: string;
  time_tag: string | null;
  delivery_mode: string | null;
  assigned_to: string | null;
  created_at: string;
  items: Array<{
    id: string;
    display_name: string;
    quantity: number;
    unit_code: string;
    is_fulfilled: boolean;
  }>;
};

async function ProductionOrdersPane() {
  const db = await supabaseServer();

  const { data } = await db
    .from('production_orders')
    .select('id,order_no,customer_name,status,time_tag,delivery_mode,assigned_to,created_at,production_order_items(id,display_name,quantity,unit_code,is_fulfilled)')
    .not('status', 'in', '("COMPLETED","CANCELLED")')
    .order('created_at', { ascending: false })
    .limit(10);

  const orders = ((data ?? []) as any[]).map((o) => ({
    ...o,
    items: o.production_order_items ?? [],
  })) as ProdOrderRow[];

  // Lots planned on each item (timing belts) -> "20 Cut Pcs + 50 Full Sleeve"
  const itemIds = orders.flatMap((o) => o.items.map((i) => i.id));
  const splitByItem: Record<string, string> = {};
  if (itemIds.length > 0) {
    const { data: allocs } = await db
      .from('lot_allocations')
      .select('item_id,allocated_qty,lot_status')
      .in('item_id', itemIds);
    const grouped: Record<string, LotEntry[]> = {};
    for (const a of (allocs ?? []) as { item_id: string; allocated_qty: number; lot_status: string | null }[]) {
      (grouped[a.item_id] ??= []).push({ status: a.lot_status ?? 'FULL_SLEEVE', qty: Number(a.allocated_qty) });
    }
    for (const [k, v] of Object.entries(grouped)) splitByItem[k] = lotSplit(v);
  }

  // Count summary
  const created    = orders.filter((o) => o.status === 'CREATED').length;
  const sent       = orders.filter((o) => o.status === 'SENT').length;
  const inProgress = orders.filter((o) => o.status === 'IN_PROGRESS').length;

  return (
    <section className="card">
      <div className="card-head">
        <div className="flex items-center gap-2">
          <h2 className="card-title">Production Orders</h2>
          {orders.length > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-brand/10 text-brand">
              {orders.length} active
            </span>
          )}
        </div>
        <Link href="/production-orders" className="text-[12px] text-brand hover:underline">View all</Link>
      </div>

      {/* Mini status summary bar */}
      {orders.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-line bg-subtle text-[11px]">
          {created > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-warn inline-block" />
              <span className="text-ink-3">{created} created</span>
            </span>
          )}
          {sent > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-brand inline-block" />
              <span className="text-ink-3">{sent} sent</span>
            </span>
          )}
          {inProgress > 0 && (
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-ok inline-block" />
              <span className="text-ink-3">{inProgress} in progress</span>
            </span>
          )}
        </div>
      )}

      {orders.length === 0 ? (
        <p className="px-5 py-6 text-[12px] text-ink-3 text-center">No active production orders.</p>
      ) : (
        <ul className="divide-y divide-line">
          {orders.map((o) => {
            const fulfilledCount = o.items.filter((i) => i.is_fulfilled).length;
            const totalItems     = o.items.length;
            return (
              <li key={o.id} className="flex items-start gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  {/* Order no + status + customer */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-mono text-ink-3">{o.order_no}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${PO_STATUS_STYLE[o.status] ?? 'bg-subtle text-ink-3'}`}>
                      {PO_STATUS_LABEL[o.status] ?? o.status}
                    </span>
                    {o.customer_name && (
                      <span className="text-[12px] font-medium text-ink truncate">{o.customer_name}</span>
                    )}
                  </div>

                  {/* Items summary */}
                  {o.items.length > 0 && (
                    <p className="text-[11px] text-ink-3 mt-0.5">
                      {o.items.map((i) => `${i.display_name} ×${i.quantity} ${i.unit_code}${splitByItem[i.id] ? ` (${splitByItem[i.id]})` : ''}`).join(' · ')}
                    </p>
                  )}

                  {/* Meta row */}
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {o.time_tag && (
                      <span className="text-[10px] text-ink-3">⏱ {o.time_tag}</span>
                    )}
                    {o.delivery_mode && (
                      <span className="text-[10px] text-ink-3">· {o.delivery_mode}</span>
                    )}
                    {o.assigned_to && (
                      <span className="text-[10px] text-ink-3">· {o.assigned_to}</span>
                    )}
                    <span className="text-[10px] text-ink-3 ml-auto">{fmtRelative(o.created_at)}</span>
                  </div>
                </div>

                {/* Fulfilment chip — only show if items exist */}
                {totalItems > 0 && (
                  <div className="shrink-0 text-right">
                    <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${
                      fulfilledCount === totalItems
                        ? 'bg-ok/10 text-ok'
                        : fulfilledCount > 0
                        ? 'bg-warn/10 text-warn'
                        : 'bg-subtle text-ink-3'
                    }`}>
                      {fulfilledCount}/{totalItems} posted
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ── Needs reordering (compact) ──────────────────────────────────────────── */
async function LowStock() {
  const db = await supabaseServer();
  const { data } = await db
    .from('v_sku_status')
    .select('sku_code,exact_size,brand_name,current_stock,min_stock_level,unit_code,stock_status,shortfall,suggested_purchase_qty,product_type')
    .eq('is_active', true)
    .in('stock_status', ['LOW_STOCK', 'OUT_OF_STOCK'])
    .order('shortfall', { ascending: false })
    .limit(8);

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
        <p className="px-5 py-4 text-[12px] text-ink-3 text-center">All products at or above minimum.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table text-[12px]">
            <thead>
              <tr>
                <th className="text-[11px]">Product</th>
                <th className="text-[11px]">Brand</th>
                <th className="text-right text-[11px]">Stock</th>
                <th className="text-right text-[11px]">Order qty</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sku_code} className="h-8">
                  <td className="font-medium py-1.5">{r.exact_size}</td>
                  <td className="text-ink-2 py-1.5">{r.brand_name}</td>
                  <td className="num text-right py-1.5">
                    <span className={r.stock_status === 'OUT_OF_STOCK' ? 'text-danger font-medium' : 'text-warn font-medium'}>
                      {fmtQty(r.current_stock, r.unit_code)}
                    </span>
                  </td>
                  <td className="num text-right font-medium py-1.5">{fmtQty(r.suggested_purchase_qty, r.unit_code)}</td>
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

      {/* Zone 3: Production Orders — full width */}
      <Suspense fallback={<div className="card h-[200px] skeleton" />}>
        <ProductionOrdersPane />
      </Suspense>

      {/* Zone 4: Reorder — compact, full width, last */}
      <Suspense fallback={<div className="card h-[160px] skeleton" />}>
        <LowStock />
      </Suspense>
    </div>
  );
}
