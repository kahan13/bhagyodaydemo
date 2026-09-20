import { requirePermission } from '@/lib/auth';
import PurchaseOrdersView from '@/components/purchase-orders/PurchaseOrdersView';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Purchase Orders — Bhagyoday Belts' };

export default async function PurchaseOrdersPage() {
  await requirePermission('transactions.view');
  return <PurchaseOrdersView />;
}
