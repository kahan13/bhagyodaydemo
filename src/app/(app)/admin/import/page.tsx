import { requirePermission } from '@/lib/auth';
import ImportView from '@/components/admin/ImportView';

export default async function ImportPage() {
  await requirePermission('settings.import');
  return <ImportView />;
}
