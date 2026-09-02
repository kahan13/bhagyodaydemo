'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  LayoutDashboard, Boxes, ArrowLeftRight, FileBarChart,
  Settings, ShieldCheck, Smartphone, LogOut, Menu, X,
} from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { ROLE_LABEL } from '@/lib/format';
import type { Permission, Session } from '@/lib/types';

type NavItem = { href: string; label: string; icon: typeof Boxes; needs?: Permission };

const OPERATIONS: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Boxes, needs: 'inventory.view' },
  { href: '/transactions', label: 'Transactions', icon: ArrowLeftRight, needs: 'transactions.view' },
  { href: '/reports', label: 'Reports', icon: FileBarChart, needs: 'reports.view' },
];

const ADMINISTRATION: NavItem[] = [
  { href: '/admin', label: 'Admin', icon: Settings, needs: 'settings.view' },
  { href: '/admin/activity', label: 'Activity trail', icon: ShieldCheck, needs: 'audit.view' },
];

export default function AppShell({
  session,
  demoData,
  children,
}: {
  session: Session;
  demoData: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const allowed = (item: NavItem) => !item.needs || session.permissions.includes(item.needs);
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.replace('/login');
    router.refresh();
  }

  const NavGroup = ({ title, items }: { title: string; items: NavItem[] }) => {
    const visible = items.filter(allowed);
    if (!visible.length) return null;
    return (
      <div className="mb-5">
        <p className="eyebrow px-3 mb-1.5">{title}</p>
        <nav>
          {visible.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setNavOpen(false)}
              aria-current={isActive(href) ? 'page' : undefined}
              className={`flex items-center gap-2.5 h-8 px-3 text-sm rounded-sm mx-1.5 transition-colors ${
                isActive(href)
                  ? 'bg-accent-soft text-accent font-medium'
                  : 'text-ink-2 hover:bg-raised hover:text-ink'
              }`}
            >
              <Icon size={15} strokeWidth={1.75} className="shrink-0" />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex">
      {/* ------------------------------------------------------------- sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-sidebar bg-surface border-r border-line flex flex-col
                    transition-transform lg:translate-x-0 ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="h-topbar flex items-center justify-between px-3 border-b border-line">
          <Link href="/" className="min-w-0">
            <p className="text-sm font-semibold tracking-tight truncate">Bhagyoday Belts</p>
            <p className="text-2xs text-ink-3 -mt-0.5">Inventory</p>
          </Link>
          <button className="lg:hidden btn-ghost h-7 w-7 p-0" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 py-4 scroll-y">
          <NavGroup title="Operations" items={OPERATIONS} />
          <div className="mx-3 mb-5 border-t border-line" />
          <NavGroup title="Administration" items={ADMINISTRATION} />
        </div>

        <Link
          href="/m"
          className="mx-1.5 mb-2 flex items-center gap-2.5 h-8 px-3 text-sm text-ink-2 rounded-sm hover:bg-raised hover:text-ink"
        >
          <Smartphone size={15} strokeWidth={1.75} />
          Phone view
        </Link>
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-30 bg-ink/20 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden />
      )}

      {/* ------------------------------------------------------------ content */}
      <div className="flex-1 min-w-0 lg:ml-sidebar flex flex-col">
        <header className="sticky top-0 z-20 h-topbar bg-surface border-b border-line flex items-center gap-3 px-4">
          <button className="lg:hidden btn-ghost h-7 w-7 p-0" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Menu size={17} />
          </button>

          {demoData && (
            <span className="tag-low hidden sm:inline-flex" title="Replace from Admin > Import master data">
              Demo data
            </span>
          )}

          <div className="ml-auto relative">
            <button
              className="flex items-center gap-2 h-8 pl-2 pr-2.5 rounded-sm hover:bg-raised"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
            >
              <span className="grid place-items-center h-6 w-6 rounded-sm bg-accent text-white text-2xs font-semibold">
                {session.user.full_name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
              </span>
              <span className="text-left hidden sm:block leading-tight">
                <span className="block text-xs font-medium">{session.user.full_name}</span>
                <span className="block text-2xs text-ink-3">{ROLE_LABEL[session.user.role_code]}</span>
              </span>
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 mt-1 w-56 z-20 panel p-1">
                  <div className="px-2.5 py-2 border-b border-line">
                    <p className="text-xs font-medium">{session.user.full_name}</p>
                    <p className="text-2xs text-ink-3">{session.user.email}</p>
                    <p className="text-2xs text-ink-3 mt-1">
                      {session.permissions.length} permissions from {ROLE_LABEL[session.user.role_code]}
                    </p>
                  </div>
                  <button onClick={signOut} className="w-full flex items-center gap-2 h-8 px-2.5 text-sm text-ink-2 hover:bg-raised rounded-sm">
                    <LogOut size={14} /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
