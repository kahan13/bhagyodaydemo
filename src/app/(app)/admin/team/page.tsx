import { requirePermission } from '@/lib/auth';
import TeamView from '@/components/admin/TeamView';

export const dynamic = 'force-dynamic';

/** Super Admin only — users.edit is held by no other role. */
export default async function TeamPage() {
  await requirePermission('users.edit');
  return <TeamView />;
}
