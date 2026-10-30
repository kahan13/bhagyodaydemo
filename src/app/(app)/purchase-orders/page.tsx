import { requirePage } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import PurchaseOrdersView from '@/components/purchase-orders/PurchaseOrdersView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Purchase Orders — Bhagyoday Belts' };

export default async function PurchaseOrdersPage() {
  const session = await requirePage('purchase_orders');
  const db = await supabaseServer();
  const { data: company } = await db.from('app_settings').select('value').eq('key', 'company').maybeSingle();
  // view-only people can read every order but not create, receive, close or delete
  return (
    <PurchaseOrdersView
      canEdit={session.permissions.includes('transactions.create')}
      company={(company?.value ?? {}) as Record<string, string>}
    />
  );
}
