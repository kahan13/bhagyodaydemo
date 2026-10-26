import { requirePage } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import ProductionOrdersView from '@/components/production-orders/ProductionOrdersView';

export const dynamic = 'force-dynamic';

/** Production Order — create an order. Everything after creation is on /production-orders/in-progress. */
export default async function ProductionOrdersPage() {
  const session = await requirePage('production_orders');
  const db = await supabaseServer();

  const { data: setting } = await db
    .from('app_settings')
    .select('value')
    .eq('key', 'default_whatsapp_number')
    .maybeSingle();

  return (
    <ProductionOrdersView
      session={session}
      defaultWhatsapp={(setting?.value as string | null) ?? ''}
    />
  );
}
