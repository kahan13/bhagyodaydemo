import { requireSession } from '@/lib/auth';
import MobileApp from '@/components/mobile/MobileApp';

export const dynamic = 'force-dynamic';

export default async function MobilePage() {
  const session = await requireSession();
  return <MobileApp session={session} />;
}
