import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase-server';
import { PRODUCT_TYPES, TYPE_META } from '@/lib/sheet-config';
import { historyCount, importErrorResponse } from '@/lib/sheet-import-server';

export const dynamic = 'force-dynamic';

/**
 * Wipe every product (SKU), its stock and lots, for ALL product types — a clean slate before a
 * fresh import. Refused for a type that already has movements or orders (so history is never
 * orphaned); clear those first with the "Clear data" panel.
 *
 * POST { confirm: "WIPE" }   → { wiped: { TIMING_BELT: n, … } }
 */
export async function POST(req: Request) {
  try {
    await requirePermission('settings.import');
    const body = await req.json().catch(() => ({}));
    if (body?.confirm !== 'WIPE') return NextResponse.json({ error: 'Type WIPE to confirm.' }, { status: 400 });

    const svc = await supabaseService();

    // Check every type first so it is all-or-nothing.
    for (const t of PRODUCT_TYPES) {
      const n = await historyCount(svc, t);
      if (n > 0) {
        return NextResponse.json({
          error: `${n} movement / order record(s) already reference ${TYPE_META[t].label.toLowerCase()}. ` +
            'Use the "Clear data" panel below to clear orders and transactions first, then wipe the products.',
        }, { status: 409 });
      }
    }

    const wiped: Record<string, number> = {};
    for (const t of PRODUCT_TYPES) {
      const { count } = await svc.from('skus').select('id', { count: 'exact', head: true }).eq('product_type', t);
      const { error } = await svc.rpc('wipe_catalog_type', { p_type: t });
      if (error) return NextResponse.json({ error: error.message }, { status: 409 });
      wiped[t] = count ?? 0;
    }
    return NextResponse.json({ wiped });
  } catch (e) {
    return importErrorResponse(e);
  }
}
