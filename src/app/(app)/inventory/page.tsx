import { requirePage } from '@/lib/auth';
import InventoryBrowser from '@/components/inventory/InventoryBrowser';
import PhysicalInventory from '@/components/inventory/PhysicalInventory';
import ReorderList from '@/components/inventory/ReorderList';
import type { ProductType } from '@/lib/types';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string; action?: string; type?: string; view?: string }>;
}) {
  const session = await requirePage('inventory');
  const { sku, action, type, view } = await searchParams;

  // Inventory has three views: Book (default), Physical, and Needs reordering
  if (view === 'physical') return <PhysicalInventory />;
  if (view === 'reorder') return <ReorderList canTick={session.permissions.includes('transactions.create')} />;

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
