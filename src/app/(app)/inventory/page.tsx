import { requirePermission } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase';
import InventoryBrowser from '@/components/inventory/InventoryBrowser';
import type { SkuStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Every row here comes from v_sku_status, which is built from the imported
 * master data and the movement ledger. The browser component reads the
 * hierarchy out of hier_l1/l2/l3, so nothing about belts is written in React.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: { sku?: string; action?: string; type?: string };
}) {
  const session = await requirePermission('inventory.view');

  const { data, error } = await supabaseServer()
    .from('v_sku_status')
    .select('*')
    .eq('is_active', true)
    .order('product_type')
    .order('hier_l1')
    .order('hier_l2')
    .order('hier_l3')
    .limit(20000);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-sm text-danger bg-danger-soft border border-danger/25 rounded px-3 py-2">
          Stock could not be loaded: {error.message}
        </p>
      </div>
    );
  }

  const rows = (data ?? []) as SkuStatus[];

  if (rows.length === 0) {
    return (
      <div className="p-6 max-w-lg">
        <div className="panel p-5">
          <h1 className="text-sm font-semibold mb-1">No products yet</h1>
          <p className="text-xs text-ink-2 leading-relaxed">
            The product master is empty. Import the master workbook to load brands, families,
            sizes and opening stock:
          </p>
          <pre className="mt-3 text-2xs bg-raised border border-line rounded p-2.5 overflow-x-auto">
npm run import:demo
          </pre>
        </div>
      </div>
    );
  }

  return (
    <InventoryBrowser
      rows={rows}
      permissions={session.permissions}
      initialSku={searchParams.sku}
      initialAction={searchParams.action === 'inward' || searchParams.action === 'outward' ? searchParams.action : undefined}
      initialType={searchParams.type === 'V_BELT' ? 'V_BELT' : 'TIMING_BELT'}
    />
  );
}
