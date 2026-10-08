// Network-first service worker: always revalidates (ETag) so a redeploy shows up immediately; cache = offline fallback.
const CACHE = 'holdem-v4';
const V = '?v=4';
const ASSETS = ['./', './index.html', './css/style.css' + V, './js/app.js' + V, './js/engine.js' + V, './js/cards.js' + V, './js/evaluator.js' + V,
  './js/pots.js' + V, './js/bot.js' + V, './js/preflop.js' + V, './js/controller.js' + V, './js/net.js' + V, './js/relay.js' + V, './js/handinfo.js' + V, './js/sound.js' + V,
  './vendor/peerjs.min.js', './manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // (a navigation Request can't be re-initialised with options, so fetch its URL instead)
    (req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(req, { cache: 'no-cache' })).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match(req, { ignoreSearch: true })).then((r) => r || caches.match('./index.html')))
  );
});
