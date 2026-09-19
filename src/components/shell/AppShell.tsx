'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import SignOutButton from './SignOutButton';
import CommandPalette from './CommandPalette';
import type { UserProfile } from '@/lib/types';

interface AppShellProps {
  user: UserProfile;
  children: React.ReactNode;
}

const NAV_ITEMS: Array<{
  href: string;
  label: string;
  exact?: boolean;
  adminOnly?: boolean;
}> = [
  { href: '/', label: 'Dashboard', exact: true },
  { href: '/inventory', label: 'Inventory' },
  { href: '/product-master', label: 'Product Master' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/reports', label: 'Reports' },
  { href: '/admin/team', label: 'Team', adminOnly: true },
];

export function AppShell({ user, children }: AppShellProps) {
  const pathname = usePathname();
  const [cmdOpen, setCmdOpen] = useState(false);

  const isActive = (item: (typeof NAV_ITEMS)[number]) => {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  };

  const navItems = NAV_ITEMS.filter((item) => {
    if (item.adminOnly && user?.role !== 'admin') return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-6 lg:gap-8">
            <Link href="/" className="flex items-center gap-2 font-bold tracking-tight text-white group">
              <span className="w-8 h-8 rounded-lg bg-gradient-to-tr from-amber-500 to-orange-500 flex items-center justify-center text-slate-950 font-black shadow-md shadow-orange-500/20 group-hover:scale-105 transition-transform">
                B
              </span>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-black tracking-wider uppercase text-slate-100">Bhagyoday</span>
                <span className="text-[10px] tracking-widest uppercase text-slate-400 font-mono">Belts Enterprise</span>
              </div>
            </Link>

            <nav className="hidden md:flex items-center gap-1">
              {navItems.map((item) => {
                const active = isActive(item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-md transition-all ${
                      active
                        ? 'bg-slate-800/80 text-amber-400 shadow-sm border border-slate-700/50'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setCmdOpen(true)}
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-200 hover:border-slate-700 text-xs transition"
            >
              <span>Search catalog...</span>
              <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-slate-400 border border-slate-700">
                ⌘K
              </kbd>
            </button>

            <div className="hidden lg:flex flex-col items-end text-xs leading-tight">
              <span className="font-semibold text-slate-200">{user?.display_name || user?.email || 'User'}</span>
              <span className="text-[10px] text-amber-500/90 font-mono uppercase tracking-wider">{user?.role || 'Staff'}</span>
            </div>

            <SignOutButton />
          </div>
        </div>

        <div className="md:hidden border-t border-slate-900 bg-slate-950/95 px-4 py-2 flex items-center gap-1 overflow-x-auto">
          {navItems.map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider rounded whitespace-nowrap ${
                  active ? 'bg-slate-800 text-amber-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {children}
      </main>

      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </div>
  );
}

export default AppShell;
