import { requirePermission } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import InventoryBrowser from '@/components/inventory/InventoryBrowser';
import type { ProductType } from '@/lib/types';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string; action?: string; type?: string }>;
}) {
  const session = await requirePermission('inventory.view');
  const { sku, action, type } = await searchParams;

  const db = await supabaseServer();
  const { data: labelRow } = await db
    .from('app_settings')
    .select('value')
    .eq('key', 'hierarchy_labels')
    .maybeSingle();

  const labelOverrides = labelRow?.value as
    | Partial<Record<ProductType, [string, string, string]>>
    | undefined;

  return (
    <InventoryBrowser
      permissions={session.permissions}
      initialSku={sku}
      initialAction={action === 'inward' || action === 'outward' ? action : undefined}
      initialType={(type === 'V_BELT' ? 'V_BELT' : 'TIMING_BELT') as ProductType}
      labelOverrides={labelOverrides}
    />
  );
}
