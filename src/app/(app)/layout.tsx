import { requireSession } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase';
import AppShell from '@/components/shell/AppShell';

export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  const { data: source } = await supabaseServer()
    .from('app_settings')
    .select('value')
    .eq('key', 'data_source')
    .maybeSingle();

  const isDemo = (source?.value as { status?: string } | null)?.status !== 'LIVE';

  return (
    <AppShell session={session} demoData={isDemo}>
      {children}
    </AppShell>
  );
}
