import { requirePage } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import InProgressView from '@/components/production-orders/InProgressView';
import type { ProductionOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Production Order in Progress — follow, finish and reconcile orders (office tabs, or the workshop inbox). */
export default async function ProductionOrdersInProgressPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requirePage('production_in_progress');
  const { tab } = await searchParams;
  const db = await supabaseServer();

  const [{ data: orders }, { data: reads }, { data: setting }] = await Promise.all([
    db.from('production_orders').select('*, production_order_items(*)').order('created_at', { ascending: false }),
    // row-level security returns only this person's own "opened" marks
    db.from('production_order_reads').select('order_id'),
    db.from('app_settings').select('value').eq('key', 'default_whatsapp_number').maybeSingle(),
  ]);

  // PostgREST returns joined rows under the table name; the screens use `items`.
  const mapped: ProductionOrder[] = (orders ?? []).map((o: any) => ({
    ...o,
    items: o.production_order_items ?? [],
  }));

  return (
    <InProgressView
      session={session}
      initialOrders={mapped}
      initialReadIds={(reads ?? []).map((r: { order_id: string }) => r.order_id)}
      defaultWhatsapp={(setting?.value as string | null) ?? ''}
      initialTab={tab}
    />
  );
}
