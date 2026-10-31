import { Suspense } from 'react';
import { ArrowDownLeft, ArrowUpRight, ShoppingCart, Check } from 'lucide-react';
import { requirePage, can } from '@/lib/auth';
import { supabaseServer, supabaseService } from '@/lib/supabase-server';

import { fmtQty, fmtRelative, fmtDate, fmtMmPcs, fmtLineQty } from '@/lib/format';
import { qtySplit, isAreaUnitCode } from '@/lib/lotView';
import DashboardActions from '@/components/dashboard/DashboardActions';
import ReorderPane, { type ReorderRow } from '@/components/dashboard/ReorderPane';
import Link from 'next/link';
import { loadItemParts } from '@/lib/orderParts';
import { ItemBlock } from '@/components/production-orders/poShared';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = { TIMING_BELT: 'Timing', V_BELT: 'V-Belt', CONVEYOR_BELT: 'Conveyor', POLY_V_BELT: 'Poly V', OPEN_ROLL: 'Open Roll' };
/** "mm" for timing belts, "ribs" for poly V belts — decided by the unit the product is stocked in. */
const wordOfUnit = (unit?: string | null): string => ((unit ?? '').toUpperCase() === 'RIB' ? 'ribs' : 'mm');

/* ── Lot wording helpers (timing belts only) ─────────────────────────────── */
type LotEntry = import('@/lib/lotView').LotEntry;
const LOT_NAME: Record<string, string> = { FULL_SLEEVE: 'Full Sleeve', CUT_PCS: 'Cut Pcs' };

/** "30 mm Cut Pcs + 50 mm Full Sleeve" — grouped by classification, unit always shown. */
function lotSplit(entries: LotEntry[], unit: string): string {
  if (isAreaUnitCode(unit)) return qtySplit(entries, unit, false).map((p) => p.text).join(' + ');
  const by = new Map<string, number>();
  for (const e of entries) {
    const st = e.status === 'WASTED' ? 'Waste' : e.status;
    by.set(st, (by.get(st) ?? 0) + Number(e.qty));
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] === 'CUT_PCS' ? -1 : 1) - (b[0] === 'CUT_PCS' ? -1 : 1))
    .map(([st, q]) => `${fmtQty(q, unit)} ${LOT_NAME[st] ?? st}`).join(' + ');
}
/** "50 mm × 4 pcs" for an inward's new lots. */
function rollsText(entries: LotEntry[], unit?: string): string {
  if (isAreaUnitCode(unit)) return qtySplit(entries, unit ?? '', true).map((p) => p.text).join(' + ');
  const by = new Map<number, number>();
  for (const e of entries) by.set(Number(e.qty), (by.get(Number(e.qty)) ?? 0) + 1);
  return [...by.entries()].map(([len, n]) => fmtMmPcs(len, n, wordOfUnit(unit))).join(' + ');
}

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
      return <p className="py-6 text-[14px] text-ink-3 text-center">No movements yet.</p>;
    return (
      <ul className="divide-y divide-line">
        {rows.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] truncate">
                <span className="font-medium">{m.exact_size}</span>
                <span className="text-ink-3"> · {m.brand_name}</span>
              </span>
              <span className="flex items-center gap-1.5 mt-0.5">
                {m.product_type && (
                  <span className="text-[12px] px-1 py-0.5 rounded bg-subtle text-ink-3 font-medium">
                    {TYPE_LABEL[m.product_type] ?? m.product_type}
                  </span>
                )}
                <span className="text-[13px] text-ink-3">{fmtRelative(m.occurred_at)}</span>
                {m.invoice_no && (
                  <span className="text-[13px] font-mono text-ink-3">· {m.invoice_no}</span>
                )}
              </span>
            </span>
            <span className="shrink-0 text-right">
              {m.lot_tracked && m.lot_breakdown && m.lot_breakdown.length > 0 && (
                <span className="block text-[13px] text-ink-2 num leading-tight">
                  {sign === '+' ? rollsText(m.lot_breakdown, m.unit_code) : lotSplit(m.lot_breakdown, m.unit_code)}
                </span>
              )}
              <span className={`num text-[14px] font-semibold ${color}`}>
                {sign}{fmtQty(Math.abs(m.quantity), m.unit_code)}
              </span>
              {m.lot_tracked && m.lot_breakdown && m.lot_breakdown.length > 0 && (
                <span className="text-[12px] text-ink-3"> total</span>
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
        <Link href="/transactions" className="text-[14px] text-brand hover:underline">View all</Link>
      </div>
      <div className="grid grid-cols-2 divide-x divide-line">
        <div>
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
            <span className="grid place-items-center h-5 w-5 rounded bg-ok-soft text-ok">
              <ArrowDownLeft size={11} />
            </span>
            <span className="text-[14px] font-semibold">Inward</span>
            <span className="ml-auto text-[13px] text-ink-3">{inward.length}</span>
          </div>
          <MovList rows={inward} sign="+" color="text-ok" />
        </div>
        <div>
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
            <span className="grid place-items-center h-5 w-5 rounded bg-brand-soft text-brand">
              <ArrowUpRight size={11} />
            </span>
            <span className="text-[14px] font-semibold">Outward</span>
            <span className="ml-auto text-[13px] text-ink-3">{outward.length}</span>
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
  ordered_pieces?: number | null; ordered_length_mm?: number | null; received_pieces?: number;
  order_no: string; supplier_name: string | null; order_status: string; created_at: string;
  exact_size: string; brand_name: string; unit_code: string; product_type: string;
  ordered_as?: string;
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
    // received_pieces only exists once 033 has run; fall back to the older columns until then
    const full = await svc
      .from('purchase_order_items')
      .select('id,order_id,sku_id,ordered_qty,ordered_pieces,ordered_length_mm,ordered_is_cut,received_qty,received_pieces,status')
      .in('order_id', orderIds)
      .order('created_at');
    const items = full.error
      ? (await svc
          .from('purchase_order_items')
          .select('id,order_id,sku_id,ordered_qty,ordered_pieces,ordered_length_mm,ordered_is_cut,received_qty,status')
          .in('order_id', orderIds)
          .order('created_at')).data
      : full.data;

    const its = (items ?? []) as { id: string; order_id: string; sku_id: string; ordered_qty: number; ordered_pieces: number | null; ordered_length_mm: number | null; ordered_is_cut: boolean; received_qty: number; received_pieces?: number; status: string }[];

    if (its.length > 0) {
      const skuIds = [...new Set(its.map((i) => i.sku_id))];
      const { data: skuRows } = await svc
        .from('v_sku_status')
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
        order_no:      orderMap[i.order_id]?.order_no      ?? '',
        supplier_name: orderMap[i.order_id]?.supplier_name ?? null,
        order_status:  orderMap[i.order_id]?.status        ?? '',
        created_at:    orderMap[i.order_id]?.created_at    ?? '',
        exact_size:    skuMap[i.sku_id]?.exact_size        ?? '—',
        brand_name:    skuMap[i.sku_id]?.brand_name        ?? '—',
        unit_code:     skuMap[i.sku_id]?.unit_code         ?? '',
        product_type:  skuMap[i.sku_id]?.product_type      ?? '',
        ordered_as:    i.ordered_pieces && i.ordered_length_mm ? `${fmtMmPcs(Number(i.ordered_length_mm), i.ordered_pieces, wordOfUnit(skuMap[i.sku_id]?.unit_code))}${i.ordered_is_cut ? ' cut pcs' : ''}` : '',
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
      <span className={`text-[12px] font-semibold px-1 py-0.5 rounded ${map[status] ?? ''}`}>
        {lbl[status] ?? status}
      </span>
    );
  }

  function ItemList({ rows }: { rows: POItem[] }) {
    if (rows.length === 0)
      return <p className="py-6 text-[14px] text-ink-3 text-center">None.</p>;
    return (
      <ul className="divide-y divide-line">
        {rows.map((i) => {
          const lotLine   = !!i.ordered_pieces && !!i.ordered_length_mm;
          const pcsLeft   = lotLine ? Math.max(0, Number(i.ordered_pieces) - Number(i.received_pieces ?? 0)) : 0;
          const remaining = i.status === 'FULFILLED' ? 0 : lotLine ? pcsLeft : i.ordered_qty - i.received_qty;
          return (
            <li key={i.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[14px] font-medium truncate">{i.exact_size}</span>
                  <span className="text-[13px] text-ink-3 shrink-0">{i.brand_name}</span>
                  {i.product_type && (
                    <span className="text-[12px] px-1 py-0.5 rounded bg-subtle text-ink-3 font-medium shrink-0">
                      {TYPE_LABEL[i.product_type]}
                    </span>
                  )}
                  <ItemBadge status={i.status} />
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[13px] text-ink-3 font-mono">{i.order_no}</span>
                  <span className="text-[13px] text-ink-3">{fmtDate(i.created_at)}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                {i.ordered_as ? (
                  <div className="text-[14px] font-semibold num">{i.ordered_as}</div>
                ) : null}
                <div className={i.ordered_as ? 'text-[12px] text-ink-3 num' : 'text-[14px] font-semibold num'}>
                  {i.received_qty}
                  <span className="text-ink-3 font-normal">/{i.ordered_qty}</span>
                  <span className="text-[12px] text-ink-3 ml-0.5">{i.unit_code}</span>
                </div>
                {remaining > 0 ? (
                  <div className="text-[12px] text-warn num">
                    {lotLine ? `${fmtMmPcs(Number(i.ordered_length_mm), pcsLeft, wordOfUnit(i.unit_code))} left` : `${remaining} left`}
                  </div>
                ) : (
                  <div className="text-[12px] text-ok flex items-center justify-end gap-0.5">
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
            <span className="text-[12px] font-semibold px-1.5 py-0.5 rounded bg-warn-soft text-warn">
              {inProgressOrderCount}
            </span>
          )}
        </div>
        <Link href="/purchase-orders" className="text-[14px] text-brand hover:underline">View all</Link>
      </div>
      <div className="grid grid-cols-2 divide-x divide-line">
        <div>
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
            <ShoppingCart size={11} className="text-warn" />
            <span className="text-[14px] font-semibold">In Progress</span>
            <span className="ml-auto text-[13px] text-ink-3">{inProgress.length}</span>
          </div>
          <ItemList rows={inProgress} />
        </div>
        <div>
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
            <ShoppingCart size={11} className="text-ok" />
            <span className="text-[14px] font-semibold">Fulfilled</span>
            <span className="ml-auto text-[13px] text-ink-3">{fulfilled.length}</span>
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
    pieces: number | null;
    length_mm: number | null;
    width_mm: number | null;
    is_fulfilled: boolean;
  }>;
};

async function ProductionOrdersPane() {
  const db = await supabaseServer();
  const SELECT = 'id,order_no,customer_name,status,time_tag,delivery_mode,assigned_to,created_at,production_order_items(id,display_name,quantity,unit_code,pieces,length_mm,width_mm,is_fulfilled)';

  // Three groups, side by side: waiting to start · being made · done (latest ten)
  const [createdRes, progressRes, doneRes] = await Promise.all([
    db.from('production_orders').select(SELECT).eq('status', 'CREATED').order('created_at', { ascending: false }).limit(10),
    db.from('production_orders').select(SELECT).eq('status', 'IN_PROGRESS').order('created_at', { ascending: false }).limit(10),
    db.from('production_orders').select(SELECT).eq('status', 'COMPLETED').order('updated_at', { ascending: false }).limit(10),
  ]);
  const toRows = (d: unknown): ProdOrderRow[] =>
    ((d ?? []) as any[]).map((o) => ({ ...o, items: o.production_order_items ?? [] })) as ProdOrderRow[];
  const groups = [
    { key: 'active',   title: 'Active',      hint: 'Created, not started', dot: 'bg-warn', rows: toRows(createdRes.data),  empty: 'No active orders.' },
    { key: 'progress', title: 'In Progress', hint: 'Being made',           dot: 'bg-ok',   rows: toRows(progressRes.data), empty: 'Nothing in progress.' },
    { key: 'done',     title: 'Completed',   hint: 'Latest 10',            dot: 'bg-ink-3', rows: toRows(doneRes.data),    empty: 'No completed orders yet.' },
  ];

  // The rolls each item is taken FROM
  const itemIds = groups.flatMap((g) => g.rows.flatMap((o) => o.items.map((i) => i.id)));
  const parts = await loadItemParts(db, itemIds);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Production Orders</h2>
        <Link href="/production-orders/in-progress" className="text-[14px] text-brand hover:underline">View all</Link>
      </div>

      <div className="grid lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-line">
        {groups.map((g) => (
          <div key={g.key} className="min-w-0">
            <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-subtle">
              <span className={`w-2 h-2 rounded-full ${g.dot}`} />
              <span className="text-[14px] font-semibold">{g.title}</span>
              <span className="text-[12px] text-ink-3">· {g.hint}</span>
              <span className="ml-auto text-[13px] text-ink-3">{g.rows.length}</span>
            </div>
            {g.rows.length === 0 ? (
              <p className="px-4 py-5 text-[14px] text-ink-3 text-center">{g.empty}</p>
            ) : (
              <ul className="divide-y divide-line">
                {g.rows.map((o) => {
                  const posted = o.items.filter((i) => i.is_fulfilled).length;
                  return (
                    <li key={o.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[13px] font-mono text-ink-3">{o.order_no}</span>
                        {o.customer_name && <span className="text-[14px] font-medium text-ink truncate">{o.customer_name}</span>}
                        {o.items.length > 0 && (
                          <span className={`ml-auto text-[12px] font-semibold px-1.5 py-0.5 rounded ${
                            posted === o.items.length ? 'bg-ok/10 text-ok' : posted > 0 ? 'bg-warn/10 text-warn' : 'bg-subtle text-ink-3'
                          }`}>{posted}/{o.items.length} posted</span>
                        )}
                      </div>
                      <ul className="mt-1.5 space-y-1.5">
                        {o.items.map((i) => (
                          <li key={i.id}>
                            <ItemBlock name={i.display_name} item={i} parts={parts[i.id]} />
                          </li>
                        ))}
                      </ul>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap text-[12px] text-ink-3">
                        {o.time_tag && <span>⏱ {o.time_tag}</span>}
                        {o.delivery_mode && <span>· {o.delivery_mode}</span>}
                        {o.assigned_to && <span>· {o.assigned_to}</span>}
                        <span className="ml-auto">{fmtRelative(o.created_at)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── Needs reordering (compact) ──────────────────────────────────────────── */
async function LowStock() {
  const db = await supabaseServer();
  const PER_TYPE = 40;
  const types = ['TIMING_BELT', 'V_BELT', 'CONVEYOR_BELT', 'POLY_V_BELT', 'OPEN_ROLL'] as const;

  // One query per category so a long list in one category can never push another one off the pane.
  const [anyMslRes, ...perType] = await Promise.all([
    db.from('v_sku_status').select('sku_code', { count: 'exact', head: true }).eq('is_active', true).gt('min_stock_level', 0),
    ...types.map((t) =>
      db.from('v_sku_status')
        .select('id,sku_code,product_type,exact_size,brand_name,unit_code,current_stock,stock_pieces,min_stock_level,shortfall,suggested_purchase_qty,stock_status')
        .eq('is_active', true)
        .eq('product_type', t)
        .gt('min_stock_level', 0)
        .in('stock_status', ['LOW_STOCK', 'OUT_OF_STOCK'])
        .order('shortfall', { ascending: false })
        .limit(PER_TYPE)),
  ]);

  const rows = perType.flatMap((r) => (r.data ?? [])) as unknown as ReorderRow[];
  const capped = perType.some((r) => (r.data?.length ?? 0) >= PER_TYPE);

  // Ticks from Inventory → Needs reordering, so both lists agree (nothing to read until 035 is run)
  await db.rpc('prune_reorder_marks');
  const marks = await db.from('reorder_marks').select('sku_id');
  const ticked = ((marks.data ?? []) as { sku_id: string }[]).map((m) => m.sku_id);

  return <ReorderPane rows={rows} capped={capped} anyMsl={(anyMslRes.count ?? 0) > 0} ticked={ticked} />;
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const session = await requirePage('dashboard');
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
    <div className="p-4 lg:p-8 max-w-[1400px] mx-auto space-y-6">
      {denied && (
        <p className="text-[15px] text-warn bg-warn-soft rounded-lg px-3.5 py-2.5">
          Your role does not include <span className="font-mono text-[14px]">{denied}</span>.
          Ask an Admin if you need it.
        </p>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[21px] font-semibold">
            {greeting}, {session.user.full_name.split(' ')[0]}
          </h1>
          <p className="text-[15px] text-ink-3 mt-0.5" suppressHydrationWarning>
            {new Date().toLocaleDateString('en-IN', {
              timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DashboardActions canWrite={write} users={users} lastRef={lastRef} lastInvoice={lastInvoice} />
        </div>
      </div>

      {/* Zone 1: active production orders — what the shop floor is doing right now */}
      <Suspense fallback={<div className="card h-[200px] skeleton" />}>
        <ProductionOrdersPane />
      </Suspense>

      {/* Zone 2: Transactions + Purchase Orders side by side */}
      <div className="grid gap-6 xl:grid-cols-2">
        <Suspense fallback={<div className="card h-[380px] skeleton" />}>
          <Transactions />
        </Suspense>
        <Suspense fallback={<div className="card h-[380px] skeleton" />}>
          <OrdersPane />
        </Suspense>
      </div>

      {/* Zone 3: Reorder — compact, full width, last */}
      <Suspense fallback={<div className="card h-[160px] skeleton" />}>
        <LowStock />
      </Suspense>
    </div>
  );
}
