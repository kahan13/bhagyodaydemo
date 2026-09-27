import { requireSession } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import ProductionOrdersView from '@/components/production-orders/ProductionOrdersView';
import type { ProductionOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ProductionOrdersPage() {
  const session = await requireSession();
  const db = await supabaseServer();

  const [{ data: orders }, { data: setting }] = await Promise.all([
    db
      .from('production_orders')
      .select('*, production_order_items(*)')
      .order('created_at', { ascending: false }),
    db
      .from('app_settings')
      .select('value')
      .eq('key', 'default_whatsapp_number')
      .maybeSingle(),
  ]);

  const defaultWhatsapp = (setting?.value as string | null) ?? '';

  // Supabase PostgREST returns joined rows under the actual table name.
  // Remap production_order_items → items so the component type lines up.
  const mappedOrders: ProductionOrder[] = (orders ?? []).map((o: any) => ({
    ...o,
    items: o.production_order_items ?? [],
  }));

  return (
    <ProductionOrdersView
      session={session}
      initialOrders={mappedOrders}
      defaultWhatsapp={defaultWhatsapp}
    />
  );
}
