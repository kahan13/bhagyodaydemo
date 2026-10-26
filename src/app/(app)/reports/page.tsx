import { requirePage } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import ReportsView from '@/components/reports/ReportsView';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string }>;
}) {
  const { report } = await searchParams;
  const session = await requirePage('reports');
  const db = await supabaseServer();

  const [{ data: brands }, { data: families }, { data: company }] = await Promise.all([
    db.from('brands').select('name').eq('is_active', true).order('name'),
    db.from('product_families').select('code,product_type').eq('is_active', true).order('code'),
    db.from('app_settings').select('value').eq('key', 'company').maybeSingle(),
  ]);

  return (
    <ReportsView
      initialKind={report}
      canExport={session.permissions.includes('reports.export')}
      brands={(brands ?? []).map((b) => b.name as string)}
      families={(families ?? []).map((f) => f.code as string)}
      company={(company?.value ?? {}) as Record<string, string>}
    />
  );
}
