/* =========================================================================
 * sw.js — service worker панели: app shell, чтобы страница открылась без сети.
 *
 *   shell (html/js/css/svg/manifest) — stale-while-revalidate;
 *   навигация                         — network-first с откатом на кеш страницы;
 *   cdn.jsdelivr.net (xterm)          — cache-first, иначе офлайн-терминал пуст;
 *   /api/...                          — НЕ перехватываем: ответ кеширует
 *                                        offline.js, чтобы работал офлайн-баннер.
 * ========================================================================= */
var CACHE = 'hub-shell-v3';

var SHELL = [
  '/', '/d', '/m', '/term', '/files', '/git', '/linux',
  '/favicon.svg', '/manifest.webmanifest', '/hub.css',
  '/bridge.js', '/offline.js', '/remote-audio.js',
  '/dashboard-app.js', '/mobile-app.js', '/desktop-app.js', '/term-app.js',
  '/files-app.js', '/git-app.js', '/linux-app.js'
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

function isShellAsset(url) {
  return /\.(?:js|css|html?|svg|png|jpg|jpeg|webp|ico|woff2?|ttf|json|webmanifest)$/.test(url.pathname);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // xterm с CDN — без него офлайн-терминал не поднимется.
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        }).catch(function () { return hit; });
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // /api/ оставляем сети и offline.js: он умеет показать офлайн-баннер.
  if (url.pathname.indexOf('/api/') === 0) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('/m') || caches.match('/').then(function (h) {
            return h || new Response('<h1>Офлайн</h1><p>Нет сохранённой копии панели.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
          });
        });
      })
    );
    return;
  }

  if (isShellAsset(url)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
  }
});
