'use client';

/** Actions that can start from any page (Alt+M → IN / O / OR). */
export type KeyAction = 'inward' | 'outward' | 'new-order';

const PENDING = 'bb-pending-action';

/** Remember an action for the page we are about to open. */
export const queueAction = (a: KeyAction) => { try { sessionStorage.setItem(PENDING, a); } catch { /* ignore */ } };

/** The page that handles it calls this on mount; returns the waiting action (once). */
export function takeAction(accept: KeyAction[]): KeyAction | null {
  try {
    const a = sessionStorage.getItem(PENDING) as KeyAction | null;
    if (a && accept.includes(a)) { sessionStorage.removeItem(PENDING); return a; }
  } catch { /* ignore */ }
  return null;
}

/**
 * Run an action: if the right page is already open it hears the event straight away,
 * otherwise we queue it and open that page, which picks it up as it loads.
 */
export function runAction(a: KeyAction, pathname: string, go: (href: string) => void) {
  const home = a === 'new-order'
    ? (pathname.startsWith('/production-orders') ? '/production-orders' : '/purchase-orders')
    : '/';
  const here = a === 'new-order'
    ? pathname.startsWith('/production-orders') || pathname.startsWith('/purchase-orders')
    : pathname === '/';
  if (here) window.dispatchEvent(new CustomEvent('bb:action', { detail: a }));
  else { queueAction(a); go(home); }
}
