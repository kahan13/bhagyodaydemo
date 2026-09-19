import { requirePermission } from '@/lib/auth';
import ImportMappedView from '@/components/admin/ImportMappedView';

export default async function ImportPage() {
  await requirePermission('settings.import');
  return <ImportMappedView />;
}
