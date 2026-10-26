import { Lock } from 'lucide-react';
import { requireSession } from '@/lib/auth';
import { firstPageHref } from '@/lib/pages';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** A signed-in person with no page switched on yet. Ends the request here so nothing can loop. */
export default async function NoPagesPage() {
  const session = await requireSession();
  const next = firstPageHref(session);
  if (next !== '/no-pages') redirect(next);   // they do have a page now

  return (
    <div className="p-6 max-w-lg">
      <div className="card p-6">
        <span className="grid place-items-center h-9 w-9 rounded-lg bg-warn-soft text-warn mb-4"><Lock size={18} /></span>
        <h1 className="text-[17px] font-semibold">No pages are switched on for you yet</h1>
        <p className="text-[15px] text-ink-2 leading-relaxed mt-2">
          You are signed in as <span className="font-medium text-ink">{session.user.full_name}</span>, but an Admin has
          not given you any pages. Ask them to open <span className="font-medium text-ink">Teams &amp; Users</span> and
          switch on the pages you need.
        </p>
      </div>
    </div>
  );
}
