import { requirePermission } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import ProductMasterView from '@/components/products/ProductMasterView';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const session = await requirePermission('products.view');
  const db = await supabaseServer();

  const [brands, families] = await Promise.all([
    db.from('brands').select('id,code,name,has_timing_belts,has_v_belts').eq('is_active', true).order('name'),
    db.from('product_families').select('id,code,name,product_type').order('product_type').order('name'),
  ]);

  return (
    <ProductMasterView
      permissions={session.permissions}
      brands={brands.data ?? []}
      families={families.data ?? []}
    />
  );
}
