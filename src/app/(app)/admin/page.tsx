import { requirePermission } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import AdminView from '@/components/admin/AdminView';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const session = await requirePermission('settings.view');
  const db = await supabaseServer();

  const [users, roles, brands, settings, imports, counts] = await Promise.all([
    db.from('app_users').select('id,role_code,is_active').order('role_code'),
    db.from('roles').select('code,name,description,rank').order('rank'),
    db.from('brands').select('id,code,name,country_origin,is_active').order('name'),
    db.from('app_settings').select('key,value'),
    db.from('import_batches').select('file_name,imported_at,mode,counts').order('imported_at', { ascending: false }).limit(5),
    db.from('skus').select('id', { count: 'exact', head: true }).eq('is_active', true),
  ]);

  const settingsMap = Object.fromEntries((settings.data ?? []).map((s) => [s.key, s.value]));

  return (
    <AdminView
      permissions={session.permissions}
      users={(users.data ?? []) as never}
      roles={(roles.data ?? []) as never}
      brands={(brands.data ?? []) as never}
      settings={settingsMap as never}
      imports={(imports.data ?? []) as never}
      skuCount={counts.count ?? 0}
    />
  );
}
