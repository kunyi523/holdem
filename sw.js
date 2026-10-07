// Network-first service worker: always tries fresh files, falls back to cache when offline.
const CACHE = 'holdem-v1';
const ASSETS = ['./', './index.html', './css/style.css', './js/app.js', './js/engine.js', './js/cards.js', './js/evaluator.js',
  './js/pots.js', './js/bot.js', './js/controller.js', './js/net.js', './vendor/peerjs.min.js', './manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
