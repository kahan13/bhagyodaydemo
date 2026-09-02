import { requireSession } from '@/lib/auth';
import { CatalogProvider } from '@/components/catalog/CatalogProvider';

/**
 * The phone experience shares the same catalogue cache and the same inventory
 * engine as the desktop app — only the interaction model differs.
 */
export default async function MobileLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return <CatalogProvider>{children}</CatalogProvider>;
}
