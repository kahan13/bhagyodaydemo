import { NextResponse } from 'next/server';
import { supabaseService, supabaseServer } from '@/lib/supabase-server';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/* ── GET /api/purchase-orders ─────────────────────────────────────────────── */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  if (!session.permissions.includes('transactions.view'))
    return NextResponse.json({ error: 'Your account cannot see purchase orders.' }, { status: 403 });

  const svc = await supabaseService();

  const { data: orders, error: oErr } = await svc
    .from('purchase_orders')
    .select('id,order_no,supplier_name,notes,status,created_at')
    .order('created_at', { ascending: false });

  if (oErr) return NextResponse.json({ error: oErr.message }, { status: 500 });

  const orderIds = (orders ?? []).map((o: { id: string }) => o.id);
  let items: unknown[] = [];

  if (orderIds.length > 0) {
    const cols = 'id,order_id,sku_id,ordered_qty,ordered_pieces,ordered_length_mm,ordered_is_cut,received_qty,inwarded_qty,status,notes,created_at';
    // 043 adds ordered_width_mm (Open Roll / Rubber); try with it first, then without
    const wide = await svc
      .from('purchase_order_items')
      .select(`${cols},received_pieces,variance_qty,ordered_width_mm`)
      .in('order_id', orderIds)
      .order('created_at');
    const full = !wide.error ? wide : await svc
      .from('purchase_order_items')
      .select(`${cols},received_pieces,variance_qty`)
      .in('order_id', orderIds)
      .order('created_at');
    // database not yet upgraded with 033: fall back to the old columns
    const old  = full.error
      ? await svc.from('purchase_order_items').select(cols).in('order_id', orderIds).order('created_at')
      : null;
    const data = (old ? old.data : full.data) as { sku_id: string; [key: string]: unknown }[] | null;
    const iErr = old ? old.error : full.error;

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

    // Every delivery received against these lines, and — once recorded into stock — its TXN number.
    const lineIds = (data ?? []).map((i) => String(i.id));
    type Rec = { id: string; order_item_id: string; qty_received: number; rolls: unknown; received_at: string; notes: string | null; inwarded_at: string | null; inwarded_movement_id: string | null };
    const recRes = lineIds.length > 0
      ? await svc.from('purchase_order_receipts')
          .select('id,order_item_id,qty_received,rolls,received_at,notes,inwarded_at,inwarded_movement_id')
          .in('order_item_id', lineIds)
          .order('received_at')
      : { data: [] as Rec[] };
    const recs = ((recRes.data ?? []) as unknown as Rec[]);
    const movIds = [...new Set(recs.map((r) => r.inwarded_movement_id).filter((x): x is string => !!x))];
    const txnById: Record<string, string> = {};
    if (movIds.length > 0) {
      const { data: movs } = await svc.from('inventory_movements').select('id,txn_no').in('id', movIds);
      for (const m of (movs ?? []) as { id: string; txn_no: string }[]) txnById[m.id] = m.txn_no;
    }
    const recsByItem: Record<string, unknown[]> = {};
    for (const r of recs) {
      (recsByItem[r.order_item_id] ??= []).push({
        id: r.id, qty_received: Number(r.qty_received), rolls: r.rolls, received_at: r.received_at, notes: r.notes,
        inwarded_at: r.inwarded_at, txn_no: r.inwarded_movement_id ? (txnById[r.inwarded_movement_id] ?? null) : null,
      });
    }

    items = (data ?? []).map((i: { sku_id: string; [key: string]: unknown }) => ({
      ...i,
      skus: skuMap[i.sku_id] ?? null,
      receipts: recsByItem[String(i.id)] ?? [],
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
  // Every change to a purchase order needs write access (view-only accounts can read, not change)
  if (!session.permissions.includes('transactions.create'))
    return NextResponse.json({ error: 'Your account can view purchase orders but not change them.' }, { status: 403 });
  const svc = await supabaseService();

  /* ── create order: everything in the window is ONE purchase order ── */
  if (action === 'create') {
    const supplier = body.supplier ? String(body.supplier).slice(0, 200) : null;
    const notes    = body.notes    ? String(body.notes).slice(0, 500)    : null;
    const rawItems = Array.isArray(body.items)
      ? (body.items as { sku_id: string; qty: number; pieces?: number; length_mm?: number; width_mm?: number; cut?: boolean }[])
      : [];

    if (rawItems.length === 0)
      return NextResponse.json({ error: 'Add at least one product.' }, { status: 400 });

    // One database call: one PO number, every line, all or nothing.
    const userDb = await supabaseServer();
    const { data, error } = await userDb.rpc('create_purchase_order_full', {
      p_supplier: supplier,
      p_notes: notes,
      p_items: rawItems.map((i) => ({
        sku_id: i.sku_id,
        qty: Number(i.qty),
        pieces: Number(i.pieces) > 0 && Number(i.length_mm) > 0 ? Math.floor(Number(i.pieces)) : null,
        length_mm: Number(i.pieces) > 0 && Number(i.length_mm) > 0 ? Number(i.length_mm) : null,
        width_mm: Number(i.width_mm) > 0 ? Number(i.width_mm) : null,
        cut: i.cut === true,
      })),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    const r = data as { order_id: string; order_no: string; lines: number };
    return NextResponse.json({ order_id: r.order_id, order_no: r.order_no, lines: r.lines, orders: [{ order_id: r.order_id, order_no: r.order_no }] }, { status: 201 });
  }

  /* ── receive several lines of one PO in one go ── */
  if (action === 'receive_items') {
    const order_id = String(body.order_id ?? '');
    if (!order_id) return NextResponse.json({ error: 'order_id required.' }, { status: 400 });
    const rawLines = Array.isArray(body.lines) ? (body.lines as Record<string, unknown>[]) : [];
    const lines = rawLines.map((l) => {
      const rolls = Array.isArray(l.rolls)
        ? (l.rolls as { rolls: number; roll_length: number; width?: number; cut?: boolean }[])
            .map((r) => ({ rolls: Math.floor(Number(r.rolls)), roll_length: Number(r.roll_length), cut: r.cut === true,
                           ...(Number(r.width) > 0 ? { width: Number(r.width) } : {}) }))
            .filter((r) => r.rolls > 0 && r.roll_length > 0)
        : [];
      return {
        item_id: String(l.item_id ?? ''),
        rolls,
        qty: rolls.length ? null : Number(l.qty_received),
        complete: l.complete === true,
        notes: l.notes ? String(l.notes).slice(0, 500) : null,
      };
    }).filter((l) => l.item_id && (l.rolls.length > 0 || (Number.isFinite(l.qty) && (l.qty as number) > 0)));
    if (lines.length === 0) return NextResponse.json({ error: 'Enter what was received on at least one line.' }, { status: 400 });

    const userDb = await supabaseServer();
    const { data, error } = await userDb.rpc('receive_po_items', { p_order_id: order_id, p_lines: lines });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, lines_received: (data as { lines_received: number }).lines_received });
  }

  /* ── receive item (one delivery; timing belts in rolls) ── */
  if (action === 'receive') {
    const item_id = String(body.item_id ?? '');
    const notes   = body.notes ? String(body.notes).slice(0, 500) : null;
    if (!item_id) return NextResponse.json({ error: 'item_id required.' }, { status: 400 });

    const rolls = Array.isArray(body.rolls)
      ? (body.rolls as { rolls: number; roll_length: number; width?: number; cut?: boolean }[])
          .map((r) => ({ rolls: Math.floor(Number(r.rolls)), roll_length: Number(r.roll_length), cut: r.cut === true,
                         ...(Number(r.width) > 0 ? { width: Number(r.width) } : {}) }))
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
      p_complete: body.complete === true,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  /* ── close a line early: nothing more is coming, the rest stops being outstanding ── */
  if (action === 'close_item') {
    const item_id = String(body.item_id ?? '');
    if (!item_id) return NextResponse.json({ error: 'item_id required.' }, { status: 400 });
    const userDb = await supabaseServer();
    const { error } = await userDb.rpc('close_po_item', { p_item_id: item_id });
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

  /* ── record inward: post what was received but is not yet in stock (partial is fine) ──
        Every SKU — and every delivery of it — becomes its own transaction with its own TXN number,
        carrying the PO number as its reference, so any one of them can be reversed alone. ── */
  if (action === 'record_inward') {
    const order_id = String(body.order_id ?? '');
    const itemIds  = Array.isArray(body.item_ids) ? (body.item_ids as unknown[]).map(String)
                   : body.item_id ? [String(body.item_id)] : null;
    if (!order_id && !(itemIds && itemIds.length)) return NextResponse.json({ error: 'order_id or item_id required.' }, { status: 400 });

    let orderId = order_id;
    if (!orderId && itemIds) {
      const { data: one } = await svc.from('purchase_order_items').select('order_id').eq('id', itemIds[0]).maybeSingle();
      orderId = (one as { order_id: string } | null)?.order_id ?? '';
      if (!orderId) return NextResponse.json({ error: 'Purchase order item not found.' }, { status: 404 });
    }

    const userDb = await supabaseServer();
    const { data, error } = await userDb.rpc('record_po_inward', { p_order_id: orderId, p_item_ids: itemIds });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    const r = data as { lines: number; transactions: { txn_no: string; sku_code: string; qty: number }[] };
    return NextResponse.json({ ok: true, recorded: r.transactions?.length ?? r.lines, lines: r.lines, transactions: r.transactions ?? [] });
  }

  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
}
