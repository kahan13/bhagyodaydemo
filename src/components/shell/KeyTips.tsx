'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { runAction, type KeyAction } from '@/lib/keytips';

/**
 * Office-style key tips.  Press Alt+M and small coloured key badges appear ON the real screen:
 *   orange  = go to a page (sidebar)            D I T PU PR R M U E A L
 *   blue    = a control on the page you are on  (tabs, search, buttons — whatever carries data-kt)
 *   green   = do something from anywhere         IN Inward · O Outward · OR Order
 * Type the letters and that element is pressed. Where a key is the start of another (I / IN, O / OR, P…)
 * the shorter one waits 0.7 s for a second letter.  Esc or Alt+M leaves.
 */
type Tip = {
  keys: string; label: string; kind: 'nav' | 'page' | 'action';
  rect: { left: number; top: number; w: number; h: number } | null;
  run: () => void;
};

const NAV: Record<string, string> = {
  '/': 'D', '/inventory': 'I', '/transactions': 'T', '/purchase-orders': 'PU', '/production-orders': 'PR',
  '/reports': 'R', '/products': 'M', '/admin/team': 'U', '/admin/import': 'E', '/admin': 'A', '/admin/activity': 'L',
};
export const NAV_KEYS = NAV;

const COLORS = {
  nav:    { bg: '#4a4fc4', fg: '#ffffff' },   // indigo - go to a page
  page:   { bg: '#3d485e', fg: '#ffffff' },   // slate  - control on this page
  action: { bg: '#0f766e', fg: '#ffffff' },   // teal   - Inward / Outward / Order
};

export default function KeyTips({ allowedHrefs, canWrite }: { allowedHrefs: string[]; canWrite: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [buf, setBuf] = useState('');
  const [tips, setTips] = useState<Tip[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufRef = useRef('');
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    bufRef.current = ''; setBuf(''); setOpen(false);
  }, []);

  const scan = useCallback((): Tip[] => {
    const out: Tip[] = [];
    const seen = new Set<string>();
    document.querySelectorAll<HTMLElement>('[data-kt]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight) return;
      if ((el as HTMLButtonElement).disabled) return;
      const keys = (el.dataset.kt ?? '').toUpperCase();
      if (!keys || seen.has(keys)) return;
      const href = el.getAttribute('href');
      if (href && NAV[href] === keys && href !== '/' && href !== '/shortcuts' && !allowedHrefs.includes(href)) return;
      seen.add(keys);
      const isNav = !!el.closest('aside');
      out.push({
        keys, kind: isNav ? 'nav' : 'page',
        label: el.dataset.ktLabel ?? el.textContent?.trim() ?? keys,
        rect: { left: r.left, top: r.top, w: r.width, h: r.height },
        run: () => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
            el.focus(); if (el instanceof HTMLInputElement) el.select();
          } else el.click();
        },
      });
    });
    if (canWrite) {
      const act = (a: KeyAction) => () => runAction(a, pathname, (h) => router.push(h));
      const add = (keys: string, label: string, a: KeyAction) => {
        if (!seen.has(keys)) { seen.add(keys); out.push({ keys, label, kind: 'action', rect: null, run: act(a) }); }
      };
      add('IN', 'Record Inward', 'inward');
      add('O', 'Record Outward', 'outward');
      add('OR', 'New order', 'new-order');
    }
    return out;
  }, [allowedHrefs, canWrite, pathname, router]);

  const fire = useCallback((t: Tip) => {
    close();
    setTimeout(t.run, 0);
  }, [close]);

  // Alt+M toggles
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) {
        e.preventDefault(); e.stopPropagation();
        if (open) { close(); return; }
        returnFocus.current = document.activeElement as HTMLElement | null;
        (document.activeElement as HTMLElement | null)?.blur?.();
        setTips(scan());
        bufRef.current = ''; setBuf(''); setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close, scan]);

  // keep badges stuck to their elements while open
  useEffect(() => {
    if (!open) return;
    const re = () => setTips(scan());
    window.addEventListener('resize', re);
    window.addEventListener('scroll', re, true);
    return () => { window.removeEventListener('resize', re); window.removeEventListener('scroll', re, true); };
  }, [open, scan]);

  // close when the page changes
  useEffect(() => { close(); }, [pathname, close]);

  // while open the key tips own the keyboard
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'm') return;
      if (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { close(); returnFocus.current?.focus?.(); return; }
      if (e.key === 'Backspace') { bufRef.current = bufRef.current.slice(0, -1); setBuf(bufRef.current); return; }
      if (!/^[a-zA-Z]$/.test(e.key) || e.ctrlKey || e.metaKey) return;
      if (timer.current) clearTimeout(timer.current);
      const next = (bufRef.current + e.key).toUpperCase();
      const cands = tips.filter((t) => t.keys.startsWith(next));
      if (cands.length === 0) { bufRef.current = ''; setBuf(''); return; }
      bufRef.current = next; setBuf(next);
      const exact = cands.find((t) => t.keys === next);
      if (exact && cands.length === 1) fire(exact);
      else if (exact) timer.current = setTimeout(() => fire(exact), 700);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, tips, fire, close]);

  const actions = useMemo(() => tips.filter((t) => t.kind === 'action'), [tips]);
  if (!open) return null;

  const live = (t: Tip) => !buf || t.keys.startsWith(buf);
  const Badge = ({ t, style }: { t: Tip; style?: React.CSSProperties }) => {
    const c = COLORS[t.kind];
    return (
      <span
        title={t.label}
        onClick={() => fire(t)}
        style={{ background: c.bg, color: c.fg, ...style }}
        className="pointer-events-auto cursor-pointer select-none font-mono font-extrabold text-[15px] leading-none px-[7px] py-[5px] rounded-md border-2 border-white shadow-[0_2px_8px_rgba(0,0,0,0.45)]"
      >
        {t.keys.split('').map((ch, i) => (
          <span key={i} style={{ opacity: buf && i < buf.length ? 0.55 : 1 }}>{ch}</span>
        ))}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-[200] pointer-events-none">
      {/* badges placed on the real elements */}
      {tips.filter((t) => t.rect && live(t)).map((t) => {
        const r = t.rect!;
        const left = Math.min(Math.max(r.left + 6, 4), window.innerWidth - 60);
        const top = Math.max(r.top + r.h / 2 - 13, 4);
        return <Badge key={t.keys} t={t} style={{ position: 'fixed', left, top }} />;
      })}

      {/* actions that work from any page */}
      {actions.length > 0 && (
        <div className="fixed top-[10px] left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-xl bg-white border border-ok-line shadow-md px-3 py-2 pointer-events-auto text-[16px] font-semibold text-ink">
          {actions.filter(live).map((t) => (
            <span key={t.keys} className="flex items-center gap-2"><Badge t={t} />{t.label}</span>
          ))}
        </div>
      )}

      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-full bg-ink text-white px-4 py-2 text-[15px] font-semibold shadow-lg pointer-events-auto">
        <span>Key tips</span>
        <span className="rounded bg-warn-soft text-warn font-mono font-bold px-2 py-0.5 min-w-[40px] text-center">{buf || '…'}</span>
        <span className="opacity-90">type the letters · Backspace undo · Esc cancel</span>
      </div>
    </div>
  );
}
