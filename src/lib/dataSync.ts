'use client';

/**
 * Live refresh without reloading the page.
 *
 * Any successful save (a POST/PATCH/PUT/DELETE to our /api routes or to Supabase) is noticed here
 * and announced with one "data changed" event. The shell reacts by refreshing the server-rendered
 * pages and the product catalogue; Purchase Orders and Production Orders listen too and reload
 * their own lists. Other open tabs are told through a BroadcastChannel.
 *
 * Nothing needs to remember to call this: every screen that saves is covered automatically.
 */
export const DATA_CHANGED = 'bb:data-changed';

let channel: BroadcastChannel | null = null;
const getChannel = () => {
  if (typeof BroadcastChannel === 'undefined') return null;
  return (channel ??= new BroadcastChannel('bb-data'));
};

/** Subscribe to "data changed" (from this tab, another tab, focus or the timer). Returns unsubscribe. */
export function onDataChanged(cb: () => void): () => void {
  const local = () => cb();
  window.addEventListener(DATA_CHANGED, local);
  const ch = getChannel();
  const remote = () => cb();
  ch?.addEventListener('message', remote);
  return () => {
    window.removeEventListener(DATA_CHANGED, local);
    ch?.removeEventListener('message', remote);
  };
}

/** Tell everything (this tab + other tabs) that data changed. */
export function notifyDataChanged() {
  window.dispatchEvent(new Event(DATA_CHANGED));
  try { getChannel()?.postMessage('changed'); } catch { /* ignore */ }
}

let installed = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Wraps window.fetch once so successful writes announce themselves. */
export function installFetchWatcher() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const orig = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    try {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && res.ok) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const ours = url.includes('/api/') && !url.includes('/api/voice');
        const supa = url.includes('/rest/v1/');
        if (ours || supa) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(notifyDataChanged, 350);   // several saves in a row -> one refresh
        }
      }
    } catch { /* never break a request because of bookkeeping */ }
    return res;
  };
}
