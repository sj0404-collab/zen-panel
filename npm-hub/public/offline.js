/* =========================================================================
 * offline.js — офлайн-режим панели.
 *
 * Подключается ПЕРВЫМ на каждой странице, до app/bridge-скриптов, потому что
 * подменяет window.fetch. Идея: ни одно приложение не должно знать про
 * офлайн. Обёртка запоминает каждый удачный GET на /api/... в localStorage и,
 * если сеть отвалилась, отдаёт последний сохранённый ответ. Страницы, как и
 * раньше, рисуют данные — просто из кеша, с пометкой «офлайн».
 *
 * Рядом регистрируется service worker (sw.js), который кеширует сам app shell
 * (html/js/css/xterm с CDN), чтобы страница вообще открылась без сети.
 *
 * API: window.HubOffline = { isOffline, lastSaved, save, load, remove, clear,
 *                            on(cb), bannershown }
 * ========================================================================= */
(function () {
  'use strict';

  var PREFIX = 'hubcache:';
  var MAX_ENTRIES = 300;
  var MAX_BYTES = 4 * 1024 * 1024;
  var offline = false;
  var lastSaved = 0;
  var listeners = [];

  function now() { return Date.now(); }
  function hhmm(t) {
    try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  // ── Хранилище: localStorage, чтобы данные пережили и закрытие вкладки ──
  function safeSet(k, v) {
    try { localStorage.setItem(k, v); return true; }
    catch (e) {
      // Переполнение: выкидываем половину самых старых записей и пробуем снова.
      try { prune(true); localStorage.setItem(k, v); return true; } catch (e2) { return false; }
    }
  }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeRemove(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function keys() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) out.push(k);
      }
    } catch (e) {}
    return out;
  }
  function prune(aggressive) {
    var ks = keys();
    var entries = [];
    for (var i = 0; i < ks.length; i++) {
      var raw = safeGet(ks[i]);
      var t = 0, len = (raw || '').length;
      try { t = JSON.parse(raw).t || 0; } catch (e) {}
      entries.push({ k: ks[i], t: t, len: len });
    }
    entries.sort(function (a, b) { return a.t - b.t; });
    var total = 0;
    for (var j = 0; j < entries.length; j++) total += entries[j].len;
    var drop = (aggressive ? Math.ceil(entries.length / 2) : Math.max(0, entries.length - MAX_ENTRIES));
    for (var d = 0; d < drop; d++) safeRemove(entries[d].k);
    if (!aggressive && total > MAX_BYTES) {
      var t2 = 0;
      for (var m = entries.length - 1; m >= 0; m--) {
        t2 += entries[m].len;
        if (t2 > MAX_BYTES) { for (var q = 0; q <= m; q++) safeRemove(entries[q].k); break; }
      }
    }
  }

  function store(entry) {
    if (!entry || typeof entry.body !== 'string') return;
    if (entry.body.length > 800000) return; // один ответ > ~0.8МБ не кешируем
    entry.t = now();
    safeSet(PREFIX + entry.key, JSON.stringify(entry));
    lastSaved = entry.t;
  }
  function load(key) {
    var raw = safeGet(PREFIX + key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function clearAll() {
    var ks = keys();
    for (var i = 0; i < ks.length; i++) safeRemove(ks[i]);
  }

  // ── Очередь изменяющих действий ──
  // Изменение, которое не ушло из-за обрыва, кладётся сюда и повторяется при
  // появлении связи. Ключ x-hub-idem стабилен для одного и того же действия,
  // поэтому повтор не выполнит его дважды (сервер отвечает сохранённым
  // ответом). Одинаковые действия схлопываются.
  var QKEY = 'hubqueue';
  function qLoad() { try { var v = JSON.parse(safeGet(QKEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function qSave(q) { safeSet(QKEY, JSON.stringify(q)); renderBanner(); }
  function qAdd(item) { var q = qLoad().filter(function (x) { return x.key !== item.key; }); q.push(item); qSave(q); }
  function qRemove(key) { qSave(qLoad().filter(function (x) { return x.key !== key; })); }
  function idemKey(method, url, body) {
    var s = method + ' ' + url + ' ' + body, h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'k' + h.toString(16) + '-' + s.length;
  }
  function makeItem(url, body, label) {
    var bodyStr = (typeof body === 'string') ? body : JSON.stringify(body || {});
    return { key: idemKey('POST', url, bodyStr), method: 'POST', url: url, headers: {}, body: bodyStr, label: label || url, ts: now() };
  }

  // ── Баннер офлайна ──
  var banner = null;
  function ensureBanner() {
    if (banner || !document.body) return banner;
    banner = document.createElement('div');
    banner.id = 'hub-offline-bar';
    banner.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
      'display:none', 'align-items:center', 'gap:8px', 'justify-content:center',
      'padding:6px 10px', 'font:600 12px/1.3 system-ui,sans-serif',
      'background:#7a5200', 'color:#ffe7ad', 'box-shadow:0 1px 6px rgba(0,0,0,.4)'
    ].join(';');
    banner.innerHTML = '<span id="hub-offline-text"></span>' +
      '<button id="hub-offline-retry" style="background:#ffe7ad;color:#4a3200;border:0;border-radius:6px;padding:3px 9px;font:600 12px system-ui;cursor:pointer">Повторить</button>';
    document.body.appendChild(banner);
    var retry = document.getElementById('hub-offline-retry');
    if (retry) retry.onclick = function () { location.reload(); };
    return banner;
  }
  function renderBanner() {
    if (!ensureBanner()) return;
    var n = (typeof qLoad === 'function') ? qLoad().length : 0;
    if (offline || n) {
      var txt = offline
        ? ('Офлайн — показаны последние данные' + (lastSaved ? ' (сохранено ' + hhmm(lastSaved) + ')' : ''))
        : 'Есть связь';
      if (n) txt += ' · в очереди: ' + n;
      var el = document.getElementById('hub-offline-text');
      if (el) el.textContent = (offline ? '⚡ ' : '⏳ ') + txt;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }
  function setOffline(v) {
    if (offline === v) return;
    offline = v;
    renderBanner();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](offline); } catch (e) {}
    }
  }

  // ── Обёртка fetch: прозрачный кеш GET /api/... ──
  // Всё, что не GET или не наш /api, идёт мимо. POST/PUT не кешируем: их
  // результат непредсказуем и повторять его офлайн нельзя.
  var realFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;
  function cacheable(req) {
    if (!realFetch) return null;
    var method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET') return null;
    var url;
    try { url = new URL(req.url, location.href); } catch (e) { return null; }
    if (url.origin !== location.origin) return null;
    if (url.pathname.indexOf('/api/') !== 0) return null;
    if (/token|secret|password|passwd|auth/i.test(url.pathname + url.search)) return null;
    return url;
  }
  if (realFetch) {
    window.fetch = function (input, init) {
      var req;
      try { req = (typeof input === 'string' || (input && input.url)) ? new Request(input, init) : input; }
      catch (e) { return realFetch(input, init); }
      var url = cacheable(req);
      if (!url) return realFetch(input, init);
      var key = url.pathname + url.search;
      return realFetch(input, init).then(function (res) {
        if (res && res.ok) {
          setOffline(false);
          var ct = res.headers.get('content-type') || 'application/json';
          // Только текст/JSON: бинарные ответы (скачивание файла) в
          // localStorage превратились бы в мусор.
          if (/(json|text|javascript)/i.test(ct)) {
            try {
              res.clone().text().then(function (body) {
                store({ key: key, status: res.status, ct: ct, body: body });
              }).catch(function () {});
            } catch (e) {}
          }
        }
        return res;
      }).catch(function (err) {
        var c = load(key);
        if (c) {
          setOffline(true);
          renderBanner();
          return new Response(c.body, {
            status: c.status || 200,
            headers: { 'content-type': c.ct || 'application/json', 'x-hub-offline': '1' }
          });
        }
        setOffline(true);
        throw err;
      });
    };
  }

  // ── Отправка очереди ──
  var flushing = false;
  function flushQueue() {
    if (flushing) return Promise.resolve();
    var q = qLoad();
    if (!q.length) return Promise.resolve();
    flushing = true;
    return (function next(i) {
      if (i >= q.length) { flushing = false; renderBanner(); return; }
      var it = q[i];
      return realFetch(it.url, {
        method: it.method,
        headers: Object.assign({ 'content-type': 'application/json', 'x-hub-idem': it.key }, it.headers || {}),
        body: it.body
      }).then(function (r) {
        // 2xx — сделано; 4xx — сервер отказал, повторять бессмысленно; 5xx —
        // временная беда, оставляем и пробуем позже.
        if (r && r.status >= 200 && r.status < 300) { qRemove(it.key); return next(i + 1); }
        if (r && r.status >= 400 && r.status < 500) { qRemove(it.key); return next(i + 1); }
        flushing = false; renderBanner();
      }).catch(function () { flushing = false; renderBanner(); });
    })(0);
  }

  // ── События сети ──
  window.addEventListener('online', function () { setOffline(false); flushQueue(); });
  window.addEventListener('offline', function () { setOffline(true); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { renderBanner(); flushQueue(); });
  else { renderBanner(); flushQueue(); }
  if (!navigator.onLine) setOffline(true);
  if (typeof setInterval === 'function') setInterval(function () { if (qLoad().length) flushQueue(); }, 30000);

  // ── Регистрация service worker (app shell) ──
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  window.HubOffline = {
    get isOffline() { return offline; },
    get lastSaved() { return lastSaved; },
    save: function (key, obj) { store({ key: key, status: 200, ct: 'application/json', body: JSON.stringify(obj) }); },
    load: load,
    remove: function (key) { safeRemove(PREFIX + key); },
    clear: clearAll,
    on: function (cb) { if (typeof cb === 'function') listeners.push(cb); },
    renderBanner: renderBanner,
    // Изменяющее действие: уходит сразу, а если связи нет — в очередь и
    // повторится само. Возвращает { queued: true }, когда связи не было.
    post: function (url, body, label) {
      var it = makeItem(url, body, label);
      return realFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-idem': it.key },
        body: it.body
      }).then(function (r) {
        setOffline(false);
        return r.json().catch(function () { return { success: r.ok }; });
      }).catch(function () {
        qAdd(it);
        setOffline(true);
        return { success: true, queued: true, offline: true };
      });
    },
    pending: function () { return qLoad(); },
    flush: flushQueue
  };
})();
