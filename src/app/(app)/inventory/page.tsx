import { requirePermission } from '@/lib/auth';
import InventoryBrowser from '@/components/inventory/InventoryBrowser';
import type { ProductType } from '@/lib/types';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string; action?: string; type?: string }>;
}) {
  const session = await requirePermission('inventory.view');
  const { sku, action, type } = await searchParams;

  const initialType: ProductType =
    type === 'V_BELT' || type === 'CONVEYOR_BELT' ? type : 'TIMING_BELT';

  return (
    <InventoryBrowser
      permissions={session.permissions}
      initialSku={sku}
      initialAction={action === 'inward' || action === 'outward' ? action : undefined}
      initialType={initialType}
    />
  );
}
