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
      .select('id,order_id,sku_id,ordered_qty,ordered_pieces,ordered_length_mm,ordered_is_cut,received_qty,inwarded_qty,status,notes,created_at')
      .in('order_id', orderIds)
      .order('created_at');

    if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });

    const skuIds = [...new Set((data ?? []).map((i: { sku_id: string }) => i.sku_id))];
    let skuMap: Record<string, { sku_code: string; exact_size: string; brand_name: string; unit_code: string; current_stock: number; product_type: string}> = {};

    if (skuIds.length > 0) {
      const { data: skuRows } = await svc
        .from('v_sku_status')
        .select('id,sku_code,exact_size,brand_name,unit_code,current_stock,product_type')
        .in('id', skuIds);
      for (const s of (skuRows ?? []) as { id: string; sku_code: string; exact_size: string; brand_name: string; unit_code: string; current_stock: number; product_type: string}[]) {
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

  /* ── create order: ONE PO per item, no clubbing ── */
  if (action === 'create') {
    const supplier = body.supplier ? String(body.supplier).slice(0, 200) : null;
    const notes    = body.notes    ? String(body.notes).slice(0, 500)    : null;
    const rawItems = Array.isArray(body.items)
      ? (body.items as { sku_id: string; qty: number; pieces?: number; length_mm?: number; cut?: boolean }[])
      : [];

    if (rawItems.length === 0)
      return NextResponse.json({ error: 'Add at least one product.' }, { status: 400 });

    // Fetch current PO count once, then increment for each new order
    const { count: currentCount } = await svc
      .from('purchase_orders')
      .select('id', { count: 'exact', head: true });

    const createdOrders: { order_id: string; order_no: string }[] = [];

    for (let idx = 0; idx < rawItems.length; idx++) {
      const item   = rawItems[idx];
      const orderNo = `PO-${String((currentCount ?? 0) + createdOrders.length + 1).padStart(4, '0')}`;

      const { data: order, error: orderErr } = await svc
        .from('purchase_orders')
        .insert({ order_no: orderNo, supplier_name: supplier, notes, status: 'PLACED', created_by: session.user.id })
        .select('id')
        .single();

      if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 400 });

      const { error: itemsErr } = await svc.from('purchase_order_items').insert({
        order_id:     order.id,
        sku_id:       item.sku_id,
        ordered_qty:  Number(item.qty),
        // timing belts: what was ordered as QTY x MM (ordered_qty stays the total in mm)
        ordered_pieces:    Number(item.pieces) > 0 && Number(item.length_mm) > 0 ? Math.floor(Number(item.pieces)) : null,
        ordered_length_mm: Number(item.pieces) > 0 && Number(item.length_mm) > 0 ? Number(item.length_mm) : null,
        ordered_is_cut:    item.cut === true,
        received_qty: 0,
        status:       'PENDING',
      });

      if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 400 });

      createdOrders.push({ order_id: order.id, order_no: orderNo });
    }

    return NextResponse.json({ orders: createdOrders }, { status: 201 });
  }

  /* ── receive item (one delivery; timing belts in rolls) ── */
  if (action === 'receive') {
    const item_id = String(body.item_id ?? '');
    const notes   = body.notes ? String(body.notes).slice(0, 500) : null;
    if (!item_id) return NextResponse.json({ error: 'item_id required.' }, { status: 400 });

    const rolls = Array.isArray(body.rolls)
      ? (body.rolls as { rolls: number; roll_length: number; cut?: boolean }[])
          .map((r) => ({ rolls: Math.floor(Number(r.rolls)), roll_length: Number(r.roll_length), cut: r.cut === true }))
          .filter((r) => r.rolls > 0 && r.roll_length > 0)
      : [];
    const qty = Number(body.qty_received);
    if (rolls.length === 0 && (!Number.isFinite(qty) || qty <= 0))
      return NextResponse.json({ error: 'Enter what was received.' }, { status: 400 });

    const userDb = await supabaseServer();
    const { error } = await userDb.rpc('receive_po_item', {
      p_item_id: item_id,
      p_qty:     rolls.length ? null : qty,
      p_rolls:   rolls.length ? rolls : null,
      p_notes:   notes,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
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

  /* ── record inward: post everything received but not yet in stock (partial is fine) ── */
  if (action === 'record_inward') {
    const order_id = String(body.order_id ?? '');
    const item_id  = body.item_id ? String(body.item_id) : '';
    if (!order_id && !item_id) return NextResponse.json({ error: 'order_id or item_id required.' }, { status: 400 });

    let itemIds: string[] = [];
    if (item_id) {
      itemIds = [item_id];
    } else {
      const { data: items, error: iErr } = await svc
        .from('purchase_order_items')
        .select('id,received_qty,inwarded_qty')
        .eq('order_id', order_id);
      if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 });
      itemIds = (items ?? [])
        .filter((i: { received_qty: number; inwarded_qty: number }) => Number(i.received_qty) > Number(i.inwarded_qty))
        .map((i: { id: string }) => i.id);
    }
    if (itemIds.length === 0)
      return NextResponse.json({ error: 'Nothing received is waiting to be recorded.' }, { status: 400 });

    const userDb = await supabaseServer();
    const errors: string[] = [];
    let posted = 0;
    for (const id of itemIds) {
      const { error } = await userDb.rpc('record_po_item_inward', { p_item_id: id });
      if (error) errors.push(error.message); else posted += 1;
    }
    if (errors.length > 0) return NextResponse.json({ error: errors.join('; '), recorded: posted }, { status: 400 });
    return NextResponse.json({ ok: true, recorded: posted });
  }

  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}
