'use client';

import { useState } from 'react';
import {
  Users, Tag, SlidersHorizontal, Upload, Download, Check, X, ShieldCheck,
} from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtDateTime, ROLE_LABEL } from '@/lib/format';
import type { Permission } from '@/lib/types';

interface UserRow {
  id: string; user_code: string | null; full_name: string; username: string;
  email: string | null; mobile: string | null; role_code: string;
  primary_device: string; is_active: boolean; last_login_at: string | null;
}
interface RoleRow { code: string; name: string; description: string | null; rank: number }
interface BrandRow { id: string; code: string; name: string; country_origin: string | null; is_active: boolean }
interface ImportRow { file_name: string; imported_at: string; mode: string; counts: Record<string, number> }

type Tab = 'users' | 'roles' | 'brands' | 'settings' | 'data';

const TABS: { id: Tab; label: string; icon: typeof Users; needs?: Permission }[] = [
  { id: 'users', label: 'Users', icon: Users, needs: 'users.view' },
  { id: 'roles', label: 'Roles', icon: ShieldCheck },
  { id: 'brands', label: 'Brands', icon: Tag },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
  { id: 'data', label: 'Data', icon: Upload },
];

export default function AdminView({
  permissions, users, roles, brands, settings, imports, skuCount,
}: {
  permissions: Permission[];
  users: UserRow[];
  roles: RoleRow[];
  brands: BrandRow[];
  settings: Record<string, Record<string, unknown>>;
  imports: ImportRow[];
  skuCount: number;
}) {
  const [tab, setTab] = useState<Tab>('users');
  const [negative, setNegative] = useState(
    Boolean((settings.allow_negative_stock as { enabled?: boolean })?.enabled),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const can = (p: Permission) => permissions.includes(p);
  const company = (settings.company ?? {}) as Record<string, string>;
  const source = (settings.data_source ?? {}) as Record<string, string>;
  const visible = TABS.filter((t) => !t.needs || can(t.needs));

  async function toggleNegative(next: boolean) {
    setNegative(next);
    setSaving(true);
    setSaved(false);
    const { error } = await supabaseBrowser()
      .from('app_settings')
      .update({ value: { enabled: next }, updated_at: new Date().toISOString() })
      .eq('key', 'allow_negative_stock');
    setSaving(false);
    if (error) { setNegative(!next); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  }

  async function backup() {
    const XLSX = await import('xlsx');
    const db = supabaseBrowser();

    const [skus, movements, brandRows, audit] = await Promise.all([
      db.from('v_sku_status').select('*').limit(20000),
      db.from('v_movements').select('*').order('occurred_at').limit(50000),
      db.from('brands').select('*'),
      db.from('audit_logs').select('*').order('occurred_at').limit(20000),
    ]);

    const book = XLSX.utils.book_new();
    const add = (name: string, rows: unknown[] | null) => {
      if (!rows?.length) return;
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), name);
    };
    add('Inventory', skus.data);
    add('Transactions', movements.data);
    add('Brands', brandRows.data);
    add('Audit_Log', audit.data);

    XLSX.writeFile(book, `Bhagyoday_Belts_Backup_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="p-4 lg:p-6 max-w-[1200px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-[19px] font-semibold">Admin</h1>
          <p className="text-[13px] text-ink-3 mt-0.5">
            Users, product master and system settings
          </p>
        </div>
        {source.status !== 'LIVE' && (
          <span className="badge badge-warn">Demo data loaded</span>
        )}
      </div>

      <div className="flex gap-1 border-b border-line mb-5">
        {visible.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`relative flex items-center gap-2 px-3 pb-2.5 pt-1 text-[13px] transition-colors ${
              tab === id ? 'text-ink font-medium' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <Icon size={15} strokeWidth={1.9} />
            {label}
            {tab === id && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand rounded-full" />}
          </button>
        ))}
      </div>

      {/* --------------------------------------------------------- users */}
      {tab === 'users' && (
        <section className="card overflow-hidden">
          <div className="card-head">
            <h2 className="card-title">User accounts</h2>
            <span className="text-[12px] text-ink-3 num">{users.length}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th><th>Username</th><th>Email</th><th>Role</th>
                  <th>Primary device</th><th>Status</th><th>Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="font-medium">{u.full_name}</td>
                    <td className="font-mono text-[12px] text-ink-2">{u.username}</td>
                    <td className="text-ink-3">{u.email ?? '—'}</td>
                    <td><span className="badge badge-brand">{ROLE_LABEL[u.role_code] ?? u.role_code}</span></td>
                    <td className="text-ink-2">{u.primary_device === 'MOBILE_PWA' ? 'Phone' : 'Desktop'}</td>
                    <td>
                      <span className={`badge ${u.is_active ? 'badge-ok' : 'badge-neutral'}`}>
                        {u.is_active ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="num text-ink-3">
                      {u.last_login_at ? fmtDateTime(u.last_login_at) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-3 text-[12px] text-ink-3 border-t border-line">
            Passwords are managed by Supabase Auth and are never stored in this application or in
            any spreadsheet. Create accounts from Supabase → Authentication, then link them here.
          </p>
        </section>
      )}

      {/* --------------------------------------------------------- roles */}
      {tab === 'roles' && (
        <section className="grid gap-3 md:grid-cols-2">
          {roles.map((r) => (
            <div key={r.code} className="card p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[14px] font-semibold">{r.name}</h3>
                <span className="badge badge-neutral font-mono">{r.code}</span>
              </div>
              <p className="text-[13px] text-ink-2 mt-1.5 leading-relaxed">{r.description}</p>
              <p className="text-[12px] text-ink-3 mt-3">
                {users.filter((u) => u.role_code === r.code).length} user(s) hold this role
              </p>
            </div>
          ))}
          <p className="md:col-span-2 text-[12px] text-ink-3">
            Permissions are enforced inside the database, not by hiding buttons. An operator who
            calls the API directly is still refused.
          </p>
        </section>
      )}

      {/* -------------------------------------------------------- brands */}
      {tab === 'brands' && (
        <section className="card overflow-hidden">
          <div className="card-head">
            <h2 className="card-title">Brands</h2>
            <span className="text-[12px] text-ink-3 num">{brands.length}</span>
          </div>
          <table className="table">
            <thead><tr><th>Code</th><th>Name</th><th>Origin</th><th>Status</th></tr></thead>
            <tbody>
              {brands.map((b) => (
                <tr key={b.id}>
                  <td className="font-mono text-[12px]">{b.code}</td>
                  <td className="font-medium">{b.name}</td>
                  <td className="text-ink-3">{b.country_origin ?? '—'}</td>
                  <td>
                    <span className={`badge ${b.is_active ? 'badge-ok' : 'badge-neutral'}`}>
                      {b.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-5 py-3 text-[12px] text-ink-3 border-t border-line">
            Brands come from the master workbook. Editing them here would drift from the source —
            change the spreadsheet and re-import instead.
          </p>
        </section>
      )}

      {/* ------------------------------------------------------ settings */}
      {tab === 'settings' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card p-5">
            <h2 className="card-title mb-3">Company</h2>
            <dl className="space-y-2.5">
              {[['Name', company.name], ['Address', company.address],
                ['Phone', company.phone], ['Email', company.email],
                ['GSTIN', company.gstin || '—']].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] text-ink-3">{k}</dt>
                  <dd className="text-[13px] mt-0.5">{v || '—'}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[12px] text-ink-3 mt-4">Printed on every exported report.</p>
          </section>

          <section className="card p-5">
            <h2 className="card-title mb-3">Stock rules</h2>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-[#5b5bd6] h-4 w-4"
                checked={negative}
                disabled={!can('settings.edit') || saving}
                onChange={(e) => void toggleNegative(e.target.checked)}
              />
              <span>
                <span className="block text-[13px] font-medium">Allow negative stock</span>
                <span className="block text-[12px] text-ink-3 mt-0.5 leading-relaxed">
                  Off by default. When off, an outward movement that would take stock below zero is
                  refused by the database, not just the interface.
                </span>
              </span>
            </label>
            {saved && (
              <p className="text-[12px] text-ok mt-3 flex items-center gap-1.5">
                <Check size={13} /> Saved
              </p>
            )}
            {!can('settings.edit') && (
              <p className="text-[12px] text-ink-3 mt-3">Your role cannot change settings.</p>
            )}
          </section>
        </div>
      )}

      {/* ---------------------------------------------------------- data */}
      {tab === 'data' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card p-5">
            <h2 className="card-title">Master data</h2>
            <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">
              {skuCount.toLocaleString('en-IN')} active SKUs are loaded, currently marked{' '}
              <span className="font-medium text-ink">{source.status ?? 'DEMO'}</span>.
            </p>
            <p className="text-[13px] text-ink-2 mt-3 leading-relaxed">
              Products, brands, families, units and opening stock all come from the master workbook.
              Nothing about belts is written in the application code, so replacing the demo data with
              the real file is a single command:
            </p>
            <pre className="mt-3 text-[12px] bg-subtle border border-line rounded-lg p-3 overflow-x-auto">
node scripts/import-master-excel.mjs \
  --file ./data/Bhagyoday_Real_Master.xlsx \
  --commit --with-history --replace</pre>
            <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">
              The importer validates every reference, replays the whole ledger to prove it never
              goes negative, and writes nothing if anything fails.
            </p>
          </section>

          <section className="card p-5">
            <h2 className="card-title">Backup</h2>
            <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">
              Downloads inventory, the full transaction register, brands and the activity trail as
              one workbook.
            </p>
            <button className="btn btn-secondary mt-4" onClick={backup} disabled={!can('settings.backup')}>
              <Download size={14} /> Download backup
            </button>
            {!can('settings.backup') && (
              <p className="text-[12px] text-ink-3 mt-2">Your role cannot download backups.</p>
            )}

            {imports.length > 0 && (
              <>
                <h3 className="text-[13px] font-medium mt-6 mb-2">Recent imports</h3>
                <ul className="space-y-2">
                  {imports.map((b, i) => (
                    <li key={i} className="text-[12px] border-b border-line pb-2 last:border-0">
                      <p className="font-mono">{b.file_name}</p>
                      <p className="text-ink-3 mt-0.5">
                        {fmtDateTime(b.imported_at)} · {b.mode.toLowerCase().replace(/_/g, ' ')} ·{' '}
                        {b.counts?.skus ?? 0} SKUs, {b.counts?.movements ?? 0} movements
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
