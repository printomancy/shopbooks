// Service worker: caches the app so it opens with no connection.
// Bump VERSION whenever app files change so devices pick up the new build.
const VERSION = 'shopbooks-v0.6.0';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/js/app.js',
  '/js/db.js',
  '/js/sync.js',
  '/js/money.js',
  '/js/books.js',
  '/js/taxes.js',
  '/js/inventory.js',
  '/js/inventory/stock.js',
  '/js/tax/fl-dr15.js',
  '/js/ledger/chart.js',
  '/js/ledger/suggest.js',
  '/js/ledger/events.js',
  '/js/import/csv.js',
  '/js/import/common.js',
  '/js/import/nfcu-statement.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && !k.startsWith('fonts')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API calls always go to the network; the app handles being offline.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Fonts: cache on first use, then serve from cache.
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open('fonts-v1').then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') c.put(req, res.clone());
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App files: network first (so updates land quickly), cache when offline.
  // Page navigations fall back to the cached app shell.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
  );
});
