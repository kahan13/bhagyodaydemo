'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Check, X, UserPlus, AlertCircle, ShieldCheck } from 'lucide-react';
import { fmtDateTime, ROLE_LABEL } from '@/lib/format';

interface TeamMember {
  id: string | null;
  auth_user_id: string | null;
  email: string;
  full_name: string;
  role_code: string | null;
  is_active: boolean;
  last_login_at: string | null;
  last_sign_in_at: string | null;
  status: 'active' | 'pending' | 'disabled' | 'orphaned';
  is_configured_admin: boolean;
  is_self: boolean;
}

const ROLES = ['SUPER_ADMIN', 'MANAGER', 'INVENTORY_OPERATOR', 'VIEWER'] as const;

const STATUS: Record<TeamMember['status'], { label: string; cls: string; note: string }> = {
  active:   { label: 'Active',       cls: 'badge-ok',      note: 'Can sign in' },
  pending:  { label: 'Needs a role', cls: 'badge-warn',    note: 'Created in Supabase, no role assigned yet' },
  disabled: { label: 'Disabled',     cls: 'badge-neutral', note: 'Blocked from signing in' },
  orphaned: { label: 'No login',     cls: 'badge-neutral', note: 'A name on past records, with no Supabase account' },
};

export default function TeamView() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authDown, setAuthDown] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/team');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load the team.');
      setMembers(json.members as TeamMember[]);
      setAuthDown(Boolean(json.auth_unavailable));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(member: TeamMember, patch: Record<string, unknown>) {
    setSavingKey(member.email);
    setError(null);
    setNotice(null);

    const res = await fetch('/api/team', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: member.id,
        auth_user_id: member.auth_user_id,
        email: member.email,
        ...patch,
      }),
    });

    const json = await res.json();
    setSavingKey(null);

    if (!res.ok) { setError(json.error ?? 'That change did not save.'); return; }
    setNotice(`Saved ${member.full_name}.`);
    setTimeout(() => setNotice(null), 2600);
    await load();
  }

  const pending = members.filter((m) => m.status === 'pending').length;

  return (
    <div className="p-4 lg:p-6 max-w-[1100px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-[19px] font-semibold">Teams &amp; Users</h1>
          <p className="text-[13px] text-ink-3 mt-0.5">
            Accounts come from Supabase. Roles and names are set here.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /> Refresh
        </button>
      </div>

      {authDown && (
        <p className="mb-3 text-[13px] text-warn bg-warn-soft rounded-lg px-3.5 py-2.5 flex items-start gap-2">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          Supabase accounts could not be listed, so people who have never signed in are missing
          from this list. Check that <span className="font-mono text-[12px]">SUPABASE_SERVICE_ROLE_KEY</span>{' '}
          is set.
        </p>
      )}

      {pending > 0 && (
        <p className="mb-3 text-[13px] text-ink-2 bg-brand-soft rounded-lg px-3.5 py-2.5 flex items-start gap-2">
          <UserPlus size={15} className="mt-0.5 shrink-0 text-brand" />
          {pending === 1 ? 'One account is' : `${pending} accounts are`} waiting for a role. Until
          you give them one they can sign in but will see nothing.
        </p>
      )}

      {error && (
        <p className="mb-3 text-[13px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">{error}</p>
      )}
      {notice && (
        <p className="mb-3 text-[13px] text-ok bg-ok-soft rounded-lg px-3.5 py-2.5 flex items-center gap-1.5">
          <Check size={14} /> {notice}
        </p>
      )}

      <section className="card overflow-hidden">
        <div className="card-head">
          <h2 className="card-title">People</h2>
          <span className="text-[12px] text-ink-3 num">{members.length}</span>
        </div>

        {loading && (
          <div className="p-4 space-y-2">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-11 skeleton" />)}
          </div>
        )}

        {!loading && members.length === 0 && (
          <p className="px-5 py-8 text-[13px] text-ink-3 text-center">
            Nobody yet. Add an account in Supabase → Authentication → Users.
          </p>
        )}

        {!loading && members.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Role</th><th>Status</th>
                  <th>Last sign-in</th><th className="text-right">Access</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const busy = savingKey === m.email;
                  const locked = m.is_configured_admin;
                  return (
                    <tr key={m.email} className={busy ? 'opacity-60' : undefined}>
                      <td>
                        {editing === m.email ? (
                          <span className="flex items-center gap-1.5">
                            <input
                              className="field h-8 w-[150px]"
                              value={draftName}
                              autoFocus
                              onChange={(e) => setDraftName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  setEditing(null);
                                  void save(m, { full_name: draftName });
                                }
                                if (e.key === 'Escape') setEditing(null);
                              }}
                            />
                            <button className="btn btn-ghost btn-sm px-1.5"
                              onClick={() => { setEditing(null); void save(m, { full_name: draftName }); }}>
                              <Check size={13} />
                            </button>
                            <button className="btn btn-ghost btn-sm px-1.5" onClick={() => setEditing(null)}>
                              <X size={13} />
                            </button>
                          </span>
                        ) : (
                          <button
                            className="font-medium hover:text-brand transition-colors text-left"
                            title="Click to rename"
                            onClick={() => { setEditing(m.email); setDraftName(m.full_name); }}
                          >
                            {m.full_name}
                            {m.is_self && <span className="badge badge-neutral ml-1.5">you</span>}
                          </button>
                        )}
                      </td>

                      <td className="text-ink-3">{m.email}</td>

                      <td>
                        <span className="flex items-center gap-1.5">
                          <select
                            className="field h-8 w-[152px]"
                            value={m.role_code ?? ''}
                            disabled={busy || locked || m.is_self}
                            onChange={(e) => void save(m, { role_code: e.target.value })}
                          >
                            {!m.role_code && <option value="">Choose a role…</option>}
                            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                          </select>
                          {locked && <ShieldCheck size={14} className="text-brand shrink-0" />}
                        </span>
                      </td>

                      <td title={STATUS[m.status].note}>
                        <span className={`badge ${STATUS[m.status].cls}`}>{STATUS[m.status].label}</span>
                      </td>

                      <td className="num text-ink-3">
                        {m.last_sign_in_at ? fmtDateTime(m.last_sign_in_at)
                          : m.last_login_at ? fmtDateTime(m.last_login_at) : 'Never'}
                      </td>

                      <td className="text-right">
                        <button
                          className={`btn btn-sm ${m.is_active ? 'btn-danger' : 'btn-secondary'}`}
                          disabled={busy || locked || m.is_self || !m.id}
                          onClick={() => void save(m, { is_active: !m.is_active })}
                        >
                          {m.is_active ? 'Disable' : 'Enable'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="card p-5 mt-4">
        <h2 className="card-title">How this works</h2>
        <ol className="text-[13px] text-ink-2 mt-2.5 space-y-2 list-decimal pl-4 leading-relaxed">
          <li>
            Create the account in Supabase → Authentication → Users, with
            <span className="font-medium text-ink"> Auto Confirm User</span> ticked.
          </li>
          <li>It appears here as <span className="badge badge-warn">Needs a role</span>.</li>
          <li>Pick a role. It applies the moment they sign in — they do not need to sign in first.</li>
          <li>Click a name to rename. Disable revokes access without deleting their history.</li>
        </ol>
        <p className="text-[12px] text-ink-3 mt-3.5 leading-relaxed">
          The account marked with a shield is the one set in
          <span className="font-mono"> ADMIN_EMAIL</span>. It stays Super Admin no matter what is
          clicked here — to move it, change the variable and redeploy. You cannot change your own
          role or disable yourself, so the system can never be left without an admin.
        </p>
      </div>
    </div>
  );
}
