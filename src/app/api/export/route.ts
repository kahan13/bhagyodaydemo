import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * CSV export for the transactions screen. Reports have their own richer PDF
 * and Excel exports in the browser; this exists so the filter set the user is
 * already looking at can be pulled down in one click.
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  if (!session.permissions.includes('reports.export')) {
    return NextResponse.json({ error: 'Your role cannot export.' }, { status: 403 });
  }

  const url = new URL(request.url);
  const db = await supabaseServer();

  let q = db.from('v_movements')
    .select('txn_no,occurred_at,txn_type,txn_mode,sku_code,exact_size,brand_name,family_code,quantity,unit_code,previous_stock,new_stock,user_name,channel,reference,notes')
    .order('occurred_at', { ascending: false })
    .limit(20000);

  const eq = (param: string, column: string) => {
    const value = url.searchParams.get(param);
    if (value) q = q.eq(column, value);
  };
  eq('type', 'txn_type');
  eq('mode', 'txn_mode');
  eq('product', 'product_type');
  eq('brand', 'brand_name');
  eq('family', 'family_code');
  eq('user', 'user_name');
  eq('channel', 'channel');

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const rows = data ?? [];
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape((r as Record<string, unknown>)[h])).join(',')),
  ].join('\n');

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="Bhagyoday_transactions_${stamp}.csv"`,
    },
  });
}
