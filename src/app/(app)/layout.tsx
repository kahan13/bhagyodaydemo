import { requireSession } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import AppShell from '@/components/shell/AppShell';
import { CatalogProvider } from '@/components/catalog/CatalogProvider';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  const db = await supabaseServer();
  const { data } = await db.from('app_settings').select('value').eq('key', 'data_source').maybeSingle();
  const demo = (data?.value as { status?: string } | null)?.status !== 'LIVE';

  return (
    <CatalogProvider>
      <AppShell session={session} demo={demo}>
        {children}
      </AppShell>
    </CatalogProvider>
  );
}
