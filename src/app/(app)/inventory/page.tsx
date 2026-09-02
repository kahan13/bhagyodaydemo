import { requirePermission } from '@/lib/auth';
import InventoryBrowser from '@/components/inventory/InventoryBrowser';
import type { ProductType } from '@/lib/types';

/**
 * Deliberately thin. The SKU data comes from the client-side catalogue cache,
 * so switching tabs, filtering and searching never touch the network.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string; action?: string; type?: string }>;
}) {
  const session = await requirePermission('inventory.view');
  const { sku, action, type } = await searchParams;

  return (
    <InventoryBrowser
      permissions={session.permissions}
      initialSku={sku}
      initialAction={action === 'inward' || action === 'outward' ? action : undefined}
      initialType={(type === 'V_BELT' ? 'V_BELT' : 'TIMING_BELT') as ProductType}
    />
  );
}
