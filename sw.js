// Network-first service worker: always fresh prices, falls back to the cached app shell offline.
const SHELL = 'gsfx-shell-v2';
const FILES = ['./', 'index.html', 'assets/app.css', 'assets/predict.css', 'assets/app.js', 'assets/calc.js', 'assets/predict.js', 'assets/predict-calc.js', 'assets/icon.svg', 'config/taxes.json', 'config/ibja-holidays.json'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // live data APIs: straight to network
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(SHELL).then((s) => s.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
