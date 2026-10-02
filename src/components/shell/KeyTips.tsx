'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { runAction, type KeyAction } from '@/lib/keytips';
import { Kbd } from '@/components/shell/ShortcutsList';

/**
 * Excel-style key tips.  Alt+M opens a panel; type the letters and it goes there.
 *   Pages    D Dashboard · I Inventory · T Transactions · PU Purchase Orders · PR Production Orders · R Reports …
 *   Actions  IN Inward · O Outward · OR New order
 *   On this page: any element marked data-kt="X" (with data-kt-label) on the current page is listed
 *                 and pressed by its letter — so each page shows only its own keys.
 * Where one key is the start of another (I / IN, O / OR) the shorter one waits 0.7 s for a second letter.
 */
type Tip = { keys: string; label: string; group: 'Go to' | 'Do' | 'On this page'; run: () => void };

const PAGES: { keys: string; label: string; href: string }[] = [
  { keys: 'D',  label: 'Dashboard',         href: '/' },
  { keys: 'I',  label: 'Inventory',         href: '/inventory' },
  { keys: 'T',  label: 'Transactions',      href: '/transactions' },
  { keys: 'PU', label: 'Purchase Orders',   href: '/purchase-orders' },
  { keys: 'PR', label: 'Production Orders', href: '/production-orders' },
  { keys: 'R',  label: 'Reports',           href: '/reports' },
  { keys: 'M',  label: 'Product Master',    href: '/products' },
  { keys: 'U',  label: 'Teams & Users',     href: '/admin/team' },
  { keys: 'E',  label: 'Import Data',       href: '/admin/import' },
  { keys: 'A',  label: 'Admin',             href: '/admin' },
  { keys: 'L',  label: 'Activity log',      href: '/admin/activity' },
  { keys: 'K',  label: 'Keyboard shortcuts', href: '/shortcuts' },
];

export default function KeyTips({ allowedHrefs, canWrite }: { allowedHrefs: string[]; canWrite: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [buf, setBuf] = useState('');
  const [pageTips, setPageTips] = useState<{ keys: string; label: string; el: HTMLElement }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufRef = useRef('');
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    bufRef.current = ''; setBuf(''); setOpen(false);
    returnFocus.current?.focus?.();
  }, []);

  const tips: Tip[] = useMemo(() => {
    const out: Tip[] = [];
    for (const p of PAGES) {
      if (p.href !== '/' && p.href !== '/shortcuts' && !allowedHrefs.includes(p.href)) continue;
      out.push({ keys: p.keys, label: p.label, group: 'Go to', run: () => router.push(p.href) });
    }
    if (canWrite) {
      const act = (a: KeyAction) => () => runAction(a, pathname, (h) => router.push(h));
      out.push({ keys: 'IN', label: 'Record Inward',      group: 'Do', run: act('inward') });
      out.push({ keys: 'O',  label: 'Record Outward',     group: 'Do', run: act('outward') });
      out.push({ keys: 'OR', label: 'New order (page you are on, else Purchase Order)', group: 'Do', run: act('new-order') });
    }
    const taken = new Set(out.map((t) => t.keys));
    for (const t of pageTips) {
      if (taken.has(t.keys)) continue;
      taken.add(t.keys);
      out.push({
        keys: t.keys, label: t.label, group: 'On this page',
        run: () => {
          const el = t.el;
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
            el.focus(); if (el instanceof HTMLInputElement) el.select();
          } else el.click();
        },
      });
    }
    return out;
  }, [allowedHrefs, canWrite, pageTips, pathname, router]);

  const fire = useCallback((t: Tip) => { close(); setTimeout(t.run, 0); }, [close]);

  // Alt+M toggles the panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) {
        e.preventDefault(); e.stopPropagation();
        if (open) { close(); return; }
        returnFocus.current = document.activeElement as HTMLElement | null;
        // collect this page's own keys
        const found: { keys: string; label: string; el: HTMLElement }[] = [];
        document.querySelectorAll<HTMLElement>('[data-kt]').forEach((el) => {
          if (el.offsetParent === null) return;           // hidden
          if ((el as HTMLButtonElement).disabled) return;
          found.push({ keys: (el.dataset.kt ?? '').toUpperCase(), label: el.dataset.ktLabel ?? el.textContent?.trim() ?? '', el });
        });
        setPageTips(found);
        bufRef.current = ''; setBuf(''); setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  // while open, this panel owns the keyboard
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'm') return;     // handled above
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'Backspace') { bufRef.current = bufRef.current.slice(0, -1); setBuf(bufRef.current); return; }
      if (!/^[a-zA-Z]$/.test(e.key) || e.ctrlKey || e.metaKey) return;

      if (timer.current) clearTimeout(timer.current);
      const next = (bufRef.current + e.key).toUpperCase();
      const cands = tips.filter((t) => t.keys.startsWith(next));
      if (cands.length === 0) { bufRef.current = ''; setBuf(''); return; }   // no such key: start again
      bufRef.current = next; setBuf(next);
      const exact = cands.find((t) => t.keys === next);
      if (exact && cands.length === 1) fire(exact);
      else if (exact) timer.current = setTimeout(() => fire(exact), 700);   // I vs IN, O vs OR
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, tips, fire, close]);

  if (!open) return null;

  const groups: Tip['group'][] = ['Go to', 'Do', 'On this page'];
  return (
    <div className="fixed inset-0 z-[95] bg-ink/30 backdrop-blur-[2px] grid place-items-start justify-center pt-[8vh] p-4" onClick={close}>
      <div className="w-full max-w-[720px] max-h-[84vh] overflow-y-auto bg-surface rounded-2xl border border-line-strong shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 mb-1">
          <h2 className="text-[19px] font-semibold">Key tips</h2>
          <div className="flex items-center gap-2 text-[16px] text-ink-2">
            <span>Typed:</span>
            <span className="min-w-[56px] text-center px-2 py-1 rounded-lg border border-brand-line bg-brand-soft text-brand font-mono font-semibold tracking-wider">{buf || '—'}</span>
            <button className="btn btn-ghost h-8 px-2 text-[15px]" aria-label="Close" onClick={close}>Esc</button>
          </div>
        </div>
        <p className="text-[16px] text-ink-2 mb-4">Type the letters and you are there. Backspace undoes a letter. Press Alt+M again or Esc to close.</p>

        <div className="grid gap-4 sm:grid-cols-2">
          {groups.map((g) => {
            const list = tips.filter((t) => t.group === g);
            if (g === 'On this page' && list.length === 0) {
              return (
                <section key={g} className="rounded-xl border border-line p-3 sm:col-span-2">
                  <h3 className="text-[15px] font-semibold text-ink-2 mb-1">On this page</h3>
                  <p className="text-[16px] text-ink-2">No extra keys on this page — everything above works from anywhere.</p>
                </section>
              );
            }
            return (
              <section key={g} className={`rounded-xl border p-3 ${g === 'On this page' ? 'sm:col-span-2 border-brand-line bg-brand-soft/40' : 'border-line'}`}>
                <h3 className="text-[15px] font-semibold text-ink-2 mb-2">{g === 'On this page' ? `On this page (${pathname === '/' ? 'Dashboard' : pathname})` : g}</h3>
                <ul className={g === 'On this page' ? 'grid sm:grid-cols-2 gap-x-6 gap-y-1.5' : 'space-y-1.5'}>
                  {list.map((t) => {
                    const hit = buf && t.keys.startsWith(buf);
                    return (
                      <li key={t.keys + t.label}
                        className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1 text-[17px] ${buf ? (hit ? 'bg-brand-soft' : 'opacity-35') : ''}`}>
                        <button type="button" className="text-left text-ink" onClick={() => fire(t)}>{t.label}</button>
                        <span className="shrink-0 flex gap-1">
                          {t.keys.split('').map((c, i) => <Kbd key={i}>{c}</Kbd>)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
