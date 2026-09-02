import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const TYPES = ['INWARD', 'OUTWARD', 'ADJUSTMENT'] as const;
const CHANNELS = ['WEB', 'MOBILE_PWA', 'MOBILE_VOICE'] as const;

/**
 * Records a stock movement.
 *
 * Authorisation is deliberately not decided here. This route validates the
 * shape of the request and then calls record_movement(), which re-checks the
 * caller's permissions, locks the SKU row, enforces the unit, blocks negative
 * stock and writes the audit entry inside one transaction. Hiding a button in
 * the UI is never what keeps an operator from adjusting stock.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 });
  }

  const sku_code = String(body.sku_code ?? '').trim();
  const txn_type = String(body.txn_type ?? '').toUpperCase();
  const quantity = Number(body.quantity);
  const channel = String(body.channel ?? 'WEB').toUpperCase();
  const reference = body.reference ? String(body.reference).slice(0, 120) : null;
  const notes = body.notes ? String(body.notes).slice(0, 500) : null;
  const unit_code = body.unit_code ? String(body.unit_code).toUpperCase() : null;

  if (!sku_code) return NextResponse.json({ error: 'Which product? SKU is missing.' }, { status: 400 });
  if (!TYPES.includes(txn_type as (typeof TYPES)[number])) {
    return NextResponse.json({ error: 'Transaction type must be inward, outward or adjustment.' }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity === 0) {
    return NextResponse.json({ error: 'Enter a quantity.' }, { status: 400 });
  }
  if (Math.abs(quantity) > 1_000_000) {
    return NextResponse.json({ error: 'That quantity looks wrong. Check it and try again.' }, { status: 400 });
  }
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
    return NextResponse.json({ error: 'Unknown device channel.' }, { status: 400 });
  }
  if (txn_type !== 'ADJUSTMENT' && quantity < 0) {
    return NextResponse.json({ error: 'Quantity must be positive.' }, { status: 400 });
  }

  const { data, error } = await supabaseServer().rpc('record_movement', {
    p_sku_code: sku_code,
    p_txn_type: txn_type,
    p_quantity: quantity,
    p_unit_code: unit_code,
    p_reference: reference,
    p_notes: notes,
    p_channel: channel,
  });

  if (error) {
    const denied = /does not allow|not signed in/i.test(error.message);
    return NextResponse.json({ error: error.message }, { status: denied ? 403 : 400 });
  }

  return NextResponse.json({ movement: data }, { status: 201 });
}
