/* Bhagyoday Belts — service worker
 *
 * Deliberately conservative: the app shell is cached so it opens instantly from
 * the home screen, but stock figures and movements are always fetched from the
 * network. Serving a stale stock number to a worker cutting belts would be
 * worse than making them wait.
 */

const SHELL = 'bhagyoday-shell-v2';
const SHELL_URLS = ['/m', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache data or auth traffic.
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/auth/')) return;

  // Static build assets are immutable — cache first.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then((hit) =>
        hit || fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(request, copy));
          return res;
        })),
    );
    return;
  }

  // Pages: network first, cached shell only when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/m').then((hit) => hit ?? Response.error())),
    );
  }
});
