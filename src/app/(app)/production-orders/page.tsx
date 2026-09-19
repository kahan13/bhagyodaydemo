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
      .select('*')
      .order('created_at', { ascending: false }),
    db
      .from('app_settings')
      .select('value')
      .eq('key', 'default_whatsapp_number')
      .maybeSingle(),
  ]);

  const defaultWhatsapp = (setting?.value as string | null) ?? '';

  return (
    <ProductionOrdersView
      session={session}
      initialOrders={(orders ?? []) as ProductionOrder[]}
      defaultWhatsapp={defaultWhatsapp}
    />
  );
}
