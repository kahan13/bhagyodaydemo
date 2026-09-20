import { NextResponse } from 'next/server';
import { supabaseService, supabaseServer } from '@/lib/supabase-server';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/* ── GET /api/purchase-orders ─────────────────────────────────────────────── */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });

  const svc = await supabaseService();

  const { data: orders, error: oErr } = await svc
    .from('purchase_orders')
    .select('id,order_no,supplier_name,notes,status,created_at')
    .order('created_at', { ascending: false });

  if (oErr) return NextResponse.json({ error: oErr.message }, { status: 500 });

  const orderIds = (orders ?? []).map((o: { id: string }) => o.id);
  let items: unknown[] = [];

  if (orderIds.length > 0) {
    const { data, error: iErr } = await svc
      .from('purchase_order_items')
      .select('id,order_id,sku_id,ordered_qty,received_qty,status,notes,created_at')
      .in('order_id', orderIds)
      .order('created_at');

    if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });

    // Fetch SKU details separately to avoid RLS join issues
    const skuIds = [...new Set((data ?? []).map((i: { sku_id: string }) => i.sku_id))];
    let skuMap: Record<string, { sku_code: string; exact_size: string; brand_name: string; unit_code: string; current_stock: number; product_type: string }> = {};

    if (skuIds.length > 0) {
      const { data: skuRows } = await svc
        .from('skus')
        .select('id,sku_code,exact_size,brand_name,unit_code,current_stock,product_type')
        .in('id', skuIds);
      for (const s of (skuRows ?? []) as { id: string; sku_code: string; exact_size: string; brand_name: string; unit_code: string; current_stock: number; product_type: string }[]) {
        skuMap[s.id] = s;
      }
    }

    items = (data ?? []).map((i: { sku_id: string; [key: string]: unknown }) => ({
      ...i,
      skus: skuMap[i.sku_id] ?? null,
    }));
  }

  return NextResponse.json({ orders: orders ?? [], items });
}

/* ── POST /api/purchase-orders ────────────────────────────────────────────── */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 }); }

  const action = String(body.action ?? '');
  const svc = await supabaseService();

  /* ── create order ── */
  if (action === 'create') {
    const supplier = body.supplier ? String(body.supplier).slice(0, 200) : null;
    const notes    = body.notes    ? String(body.notes).slice(0, 500)    : null;
    const rawItems = Array.isArray(body.items)
      ? (body.items as { sku_id: string; qty: number }[])
      : [];

    if (rawItems.length === 0)
      return NextResponse.json({ error: 'Add at least one product.' }, { status: 400 });

    const { count } = await svc
      .from('purchase_orders')
      .select('id', { count: 'exact', head: true });
    const orderNo = `PO-${String((count ?? 0) + 1).padStart(4, '0')}`;

    const { data: order, error: orderErr } = await svc
      .from('purchase_orders')
      .insert({ order_no: orderNo, supplier_name: supplier, notes, status: 'PLACED', created_by: session.user.id })
      .select('id')
      .single();

    if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 400 });

    const lineItems = rawItems.map((i) => ({
      order_id:     order.id,
      sku_id:       i.sku_id,
      ordered_qty:  Number(i.qty),
      received_qty: 0,
      status:       'PENDING',
    }));

    const { error: itemsErr } = await svc.from('purchase_order_items').insert(lineItems);
    if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 400 });

    return NextResponse.json({ order_id: order.id, order_no: orderNo }, { status: 201 });
  }

  /* ── receive item ── */
  if (action === 'receive') {
    const item_id      = String(body.item_id ?? '');
    const qty_received = Number(body.qty_received);
    const notes        = body.notes ? String(body.notes).slice(0, 500) : null;

    if (!item_id) return NextResponse.json({ error: 'item_id required.' }, { status: 400 });
    if (!Number.isFinite(qty_received) || qty_received <= 0)
      return NextResponse.json({ error: 'Enter a valid quantity.' }, { status: 400 });

    const { data: item, error: fetchErr } = await svc
      .from('purchase_order_items')
      .select('id,order_id,ordered_qty,received_qty')
      .eq('id', item_id)
      .single();

    if (fetchErr || !item) return NextResponse.json({ error: 'Item not found.' }, { status: 404 });

    const newReceived = (item.received_qty ?? 0) + qty_received;
    const newStatus   = newReceived >= item.ordered_qty ? 'FULFILLED' : 'PARTIAL';

    const { error: updateErr } = await svc
      .from('purchase_order_items')
      .update({ received_qty: newReceived, status: newStatus, notes })
      .eq('id', item_id);

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 400 });

    const { data: siblings } = await svc
      .from('purchase_order_items')
      .select('status')
      .eq('order_id', item.order_id);

    const allDone    = siblings?.every((s: { status: string }) => s.status === 'FULFILLED');
    const anyPartial = siblings?.some((s: { status: string }) => s.status === 'PARTIAL' || s.status === 'FULFILLED');
    const orderStatus = allDone ? 'FULFILLED' : anyPartial ? 'PARTIAL' : 'PLACED';

    await svc.from('purchase_orders').update({ status: orderStatus }).eq('id', item.order_id);
    return NextResponse.json({ ok: true });
  }

  /* ── delete order ── */
  if (action === 'delete') {
    const order_id = String(body.order_id ?? '');
    if (!order_id) return NextResponse.json({ error: 'order_id required.' }, { status: 400 });

    await svc.from('purchase_order_items').delete().eq('order_id', order_id);
    const { error } = await svc.from('purchase_orders').delete().eq('id', order_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  /* ── record fulfilled order as inward transaction ── */
  if (action === 'record_inward') {
    const order_id = String(body.order_id ?? '');
    if (!order_id) return NextResponse.json({ error: 'order_id required.' }, { status: 400 });

    const { data: items, error: iErr } = await svc
      .from('purchase_order_items')
      .select('id,sku_id,received_qty')
      .eq('order_id', order_id)
      .eq('status', 'FULFILLED');

    if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });
    if (!items || items.length === 0)
      return NextResponse.json({ error: 'No fulfilled items found.' }, { status: 400 });

    const skuIds = items.map((i: { sku_id: string }) => i.sku_id);
    const { data: skuRows } = await svc
      .from('skus')
      .select('id,sku_code,unit_code')
      .in('id', skuIds);
    const skuMap: Record<string, { sku_code: string; unit_code: string }> = {};
    for (const s of (skuRows ?? []) as { id: string; sku_code: string; unit_code: string }[]) {
      skuMap[s.id] = s;
    }

    const { data: order } = await svc
      .from('purchase_orders')
      .select('order_no')
      .eq('id', order_id)
      .single();

    // Use the user-authenticated client: record_movement checks auth.uid() internally
    const userDb = await supabaseServer();
    const errors: string[] = [];
    for (const item of items as { sku_id: string; received_qty: number }[]) {
      const sku = skuMap[item.sku_id];
      if (!sku) continue;
      const { error } = await userDb.rpc('record_movement', {
        p_sku_code:    sku.sku_code,
        p_txn_type:    'INWARD',
        p_quantity:    item.received_qty,
        p_unit_code:   sku.unit_code,
        p_reference:   (order as { order_no: string } | null)?.order_no ?? null,
        p_notes:       'Recorded from purchase order',
        p_channel:     'WEB',
        p_invoice_no:  null,
        p_operated_by: null,
      });
      if (error) errors.push(`${sku.sku_code}: ${error.message}`);
    }

    if (errors.length > 0) return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    await svc.from('purchase_orders').update({ status: 'FULFILLED' }).eq('id', order_id);
    return NextResponse.json({ ok: true, recorded: items.length });
  }

  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}
