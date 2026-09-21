/* vault-sw.js — service worker страницы «Внешняя память».
 * Своя область видимости (/external-memory.html), чтобы страница-зеркало
 * открывалась даже когда хаб/раннер лежит: оболочка кешируется сеть-в-первую,
 * /api/... не перехватываем — зеркало живёт в IndexedDB и не зависит от сети. */
var CACHE = 'vault-shell-v1';

var SHELL = [
  '/external-memory.html',
  '/vault.js',
  '/external-memory.webmanifest',
  '/favicon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) { if (n !== CACHE) return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  if (req.mode === 'navigate' || /external-memory\.html|vault\.js|external-memory\.webmanifest|favicon\.svg/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('/external-memory.html');
        });
      })
    );
  }
});