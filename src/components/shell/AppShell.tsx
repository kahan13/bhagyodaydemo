'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, Boxes, ArrowLeftRight, FileText, Settings,
  ShieldCheck, Smartphone, Menu, X, Search, ChevronDown,
} from 'lucide-react';
import { ROLE_LABEL, initials } from '@/lib/format';
import type { Permission, Session } from '@/lib/types';
import SignOutButton from '@/components/shell/SignOutButton';
import CommandPalette from '@/components/shell/CommandPalette';

type Item = { href: string; label: string; icon: typeof Boxes; needs?: Permission };

const MAIN: Item[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inventory', label: 'Inventory', icon: Boxes, needs: 'inventory.view' },
  { href: '/transactions', label: 'Transactions', icon: ArrowLeftRight, needs: 'transactions.view' },
  { href: '/reports', label: 'Reports', icon: FileText, needs: 'reports.view' },
];

const ADMIN: Item[] = [
  { href: '/admin', label: 'Admin', icon: Settings, needs: 'settings.view' },
  { href: '/admin/activity', label: 'Activity', icon: ShieldCheck, needs: 'audit.view' },
];

export default function AppShell({
  session, demo, children,
}: {
  session: Session;
  demo: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => { setNavOpen(false); setMenuOpen(false); }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const allowed = (i: Item) => !i.needs || session.permissions.includes(i.needs);
  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const Group = ({ title, items }: { title?: string; items: Item[] }) => {
    const visible = items.filter(allowed);
    if (!visible.length) return null;
    return (
      <div className="mb-6">
        {title && <p className="eyebrow px-3 mb-2">{title}</p>}
        <nav className="space-y-0.5">
          {visible.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              prefetch
              aria-current={active(href) ? 'page' : undefined}
              className={`flex items-center gap-2.5 h-9 px-3 rounded-lg text-[13px] transition-colors ${
                active(href)
                  ? 'bg-brand-soft text-brand font-medium'
                  : 'text-ink-2 hover:bg-hover hover:text-ink'
              }`}
            >
              <Icon size={16} strokeWidth={1.9} className="shrink-0" />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    );
  };

  return (
    <div className="min-h-screen">
      {/* --------------------------------------------------------- sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[228px] bg-surface border-r border-line flex flex-col
                    transition-transform duration-200 lg:translate-x-0
                    ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="h-14 flex items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2.5 min-w-0">
            <span className="grid place-items-center h-7 w-7 rounded-lg bg-brand text-white shrink-0">
              <Boxes size={15} />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block text-[13px] font-semibold truncate">Bhagyoday Belts</span>
              <span className="block text-[10px] text-ink-3">Inventory</span>
            </span>
          </Link>
          <button className="btn btn-ghost lg:hidden h-7 w-7 p-0" onClick={() => setNavOpen(false)} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="px-3 pb-3">
          <button
            onClick={() => setPaletteOpen(true)}
            className="w-full flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line text-[13px] text-ink-3 hover:bg-subtle transition-colors"
          >
            <Search size={14} />
            <span>Search</span>
            <kbd className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-line bg-subtle text-ink-3">
              ⌘K
            </kbd>
          </button>
        </div>

        <div className="flex-1 px-3 scroll">
          <Group items={MAIN} />
          <Group title="Administration" items={ADMIN} />
        </div>

        <div className="p-3 border-t border-line">
          <Link
            href="/m"
            className="flex items-center gap-2.5 h-9 px-3 rounded-lg text-[13px] text-ink-2 hover:bg-hover hover:text-ink transition-colors"
          >
            <Smartphone size={16} strokeWidth={1.9} />
            Phone view
          </Link>
        </div>
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 bg-ink/25 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden />
      )}

      {/* --------------------------------------------------------- content */}
      <div className="lg:pl-[228px] flex flex-col min-h-screen">
        <header className="sticky top-0 z-30 h-14 bg-canvas/85 backdrop-blur-md border-b border-line flex items-center gap-3 px-4 lg:px-6">
          <button className="btn btn-ghost lg:hidden h-8 w-8 p-0" onClick={() => setNavOpen(true)} aria-label="Menu">
            <Menu size={18} />
          </button>

          {demo && (
            <span className="badge badge-warn" title="Replace from Admin → Import master data">
              Demo data
            </span>
          )}

          <div className="ml-auto relative">
            <button
              className="flex items-center gap-2 h-9 pl-1.5 pr-2 rounded-lg hover:bg-hover transition-colors"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
            >
              <span className="grid place-items-center h-7 w-7 rounded-lg bg-brand text-white text-[11px] font-semibold">
                {initials(session.user.full_name)}
              </span>
              <span className="hidden sm:block text-left leading-tight">
                <span className="block text-[12px] font-medium">{session.user.full_name}</span>
                <span className="block text-[10px] text-ink-3">{ROLE_LABEL[session.user.role_code]}</span>
              </span>
              <ChevronDown size={14} className="text-ink-3" />
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="absolute right-0 mt-1.5 w-60 z-20 card p-1.5 shadow-md fade-in">
                  <div className="px-2.5 py-2">
                    <p className="text-[13px] font-medium">{session.user.full_name}</p>
                    <p className="text-[11px] text-ink-3 truncate">{session.user.email}</p>
                    <p className="text-[11px] text-ink-3 mt-1.5">
                      {session.permissions.length} permissions via {ROLE_LABEL[session.user.role_code]}
                    </p>
                  </div>
                  <div className="border-t border-line mt-1 pt-1">
                    <SignOutButton variant="ghost" />
                  </div>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="flex-1 min-w-0">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
