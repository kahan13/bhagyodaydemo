import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Creates a linked reversing entry. There is no delete endpoint anywhere in
 * this application, and the database refuses deletes on inventory_movements,
 * so a wrong entry is always corrected in the open.
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

  const movement_id = String(body.movement_id ?? '');
  const reason = String(body.reason ?? '').trim();
  const channel = String(body.channel ?? 'WEB').toUpperCase();

  if (!/^[0-9a-f-]{36}$/i.test(movement_id)) {
    return NextResponse.json({ error: 'Which transaction? The reference is missing.' }, { status: 400 });
  }
  if (reason.length < 3) {
    return NextResponse.json({ error: 'Give a reason for the reversal.' }, { status: 400 });
  }

  const { data, error } = await supabaseServer().rpc('reverse_movement', {
    p_movement_id: movement_id,
    p_reason: reason.slice(0, 500),
    p_channel: ['WEB', 'MOBILE_PWA', 'MOBILE_VOICE'].includes(channel) ? channel : 'WEB',
  });

  if (error) {
    const denied = /does not allow|not signed in/i.test(error.message);
    return NextResponse.json({ error: error.message }, { status: denied ? 403 : 400 });
  }

  return NextResponse.json({ reversal: data }, { status: 201 });
}
