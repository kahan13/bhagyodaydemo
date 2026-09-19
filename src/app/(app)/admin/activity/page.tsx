import { requirePermission } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import { fmtDateTime, CHANNEL_LABEL, ROLE_LABEL } from '@/lib/format';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 60;

interface AuditRow {
  id: string;
  occurred_at: string;
  user_name: string | null;
  role_code: string | null;
  action: string;
  entity_type: string;
  entity_reference: string | null;
  old_value: string | null;
  new_value: string | null;
  channel: string;
  description: string | null;
}

/**
 * The full activity trail across every user and every device. Gated on
 * audit.view, which only Super Admin holds — enforced by row level security on
 * audit_logs, not by hiding this page.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; action?: string; channel?: string }>;
}) {
  await requirePermission('audit.view');
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const db = await supabaseServer();

  let q = db.from('audit_logs')
    .select('id,occurred_at,user_name,role_code,action,entity_type,entity_reference,old_value,new_value,channel,description',
      { count: 'exact' })
    .order('occurred_at', { ascending: false });

  if (sp.action) q = q.eq('action', sp.action);
  if (sp.channel) q = q.eq('channel', sp.channel);

  const { data, count } = await q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const rows = (data ?? []) as AuditRow[];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  const link = (p: number) => {
    const params = new URLSearchParams();
    if (sp.action) params.set('action', sp.action);
    if (sp.channel) params.set('channel', sp.channel);
    params.set('page', String(p));
    return `/admin/activity?${params}`;
  };

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-[17px] font-semibold">Activity trail</h1>
          <p className="text-[12px] text-ink-3">
            Every action, every user, desktop and phone alike
          </p>
        </div>
        <span className="ml-auto text-[12px] text-ink-3 num">
          {count ?? 0} entries
        </span>
      </div>

      <div className="flex-1 min-h-0 scroll">
        {rows.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-ink-3">No activity recorded yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th><th>User</th><th>Role</th><th>Action</th><th>Entity</th>
                <th>Reference</th><th>Change</th><th>Device</th><th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num text-ink-2" suppressHydrationWarning>{fmtDateTime(r.occurred_at)}</td>
                  <td>{r.user_name ?? '—'}</td>
                  <td className="text-ink-3">{r.role_code ? ROLE_LABEL[r.role_code] ?? r.role_code : '—'}</td>
                  <td>
                    <span className={`badge ${
                      r.action === 'REVERSE' ? 'badge-warn'
                        : r.action === 'CREATE' ? 'badge-ok'
                        : r.action === 'LOGIN_FAILED' ? 'badge-danger' : 'badge-neutral'
                    }`}>
                      {r.action.toLowerCase()}
                    </span>
                  </td>
                  <td className="text-ink-2">{r.entity_type.toLowerCase()}</td>
                  <td className="max-w-[200px] truncate">{r.entity_reference ?? '—'}</td>
                  <td className="text-ink-3 num">
                    {r.old_value && r.new_value && r.old_value !== '-'
                      ? `${r.old_value} → ${r.new_value}` : '—'}
                  </td>
                  <td className="text-ink-3">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="max-w-[260px] truncate text-ink-3" title={r.description ?? ''}>
                    {r.description ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="border-t border-line bg-surface px-4 lg:px-6 h-12 flex items-center justify-between shrink-0">
        <p className="text-[12px] text-ink-3 num">Page {page} of {pages}</p>
        <div className="flex gap-2">
          <a className={`btn btn-secondary btn-sm ${page <= 1 ? 'pointer-events-none opacity-45' : ''}`} href={link(page - 1)}>
            Previous
          </a>
          <a className={`btn btn-secondary btn-sm ${page >= pages ? 'pointer-events-none opacity-45' : ''}`} href={link(page + 1)}>
            Next
          </a>
        </div>
      </div>
    </div>
  );
}
