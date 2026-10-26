import { requirePage } from '@/lib/auth';
import PurchaseOrdersView from '@/components/purchase-orders/PurchaseOrdersView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Purchase Orders — Bhagyoday Belts' };

export default async function PurchaseOrdersPage() {
  const session = await requirePage('purchase_orders');
  // view-only people can read every order but not create, receive, close or delete
  return <PurchaseOrdersView canEdit={session.permissions.includes('transactions.create')} />;
}
