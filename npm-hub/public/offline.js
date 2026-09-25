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
    try { if (window.top && window.self && window.top !== window.self) return null; } catch (e) {}
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
    if (retry) retry.onclick = function () { retryNow(true); };
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

  // ── Живая проверка хаба ──
  // Сбойный ответ (рестарт, 502 из туннеля, HTML вместо JSON) — ещё не офлайн:
  // один сбойный запрос не должен красить панель в «последние данные», пока
  // хаб на самом деле жив и отвечает. Поэтому офлайн подтверждаем отдельным
  // запросом к /api/info мимо обёртки и кеша.
  var probePending = null;
  var failTimer = null;
  function probe() {
    if (!realFetch) return Promise.resolve(false);
    if (probePending) return probePending;
    probePending = realFetch('/api/info?hub_probe=' + now(), {
      cache: 'no-store',
      headers: { 'x-hub-probe': '1' }
    }).then(function (r) {
      return !!(r && r.status >= 200 && r.status < 500);
    }).catch(function () {
      return false;
    }).then(function (ok) {
      probePending = null;
      return ok;
    });
    return probePending;
  }
  function markFailed() {
    if (failTimer) return;
    failTimer = setTimeout(function () {
      failTimer = null;
      probe().then(function (ok) { if (!ok) setOffline(true); });
    }, 1200);
  }
  function retryNow(withReload) {
    var btn = withReload ? document.getElementById('hub-offline-retry') : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Проверяем…'; }
    return probe().then(function (ok) {
      if (!ok) {
        if (btn) { btn.disabled = false; btn.textContent = 'Повторить'; }
        return false;
      }
      setOffline(false);
      flushQueue();
      if (withReload) location.reload();
      return true;
    });
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
function serveCached(key, res) {
  var c = load(key);
  if (!c) return null;
  markFailed();
  renderBanner();
  return new Response(c.body, {
    status: c.status || 200,
    headers: { 'content-type': c.ct || 'application/json', 'x-hub-offline': '1' }
  });
}
// IndexedDB — дубль localStorage для листингов, которых не хватило в 4 МБ.
function serveCachedIdb(key, res) {
  return idbGet('list', key).then(function (rec) {
    if (!rec || !rec.body) return null;
    markFailed();
    renderBanner();
    return new Response(rec.body, {
      status: rec.status || 200,
      headers: { 'content-type': rec.ct || 'application/json', 'x-hub-offline': '1' }
    });
  });
}
function serveErrJson(message) {
  markFailed();
  renderBanner();
  // Отдаём приличный JSON вместо HTML-страницы, чтобы .json() не падал.
  return new Response(JSON.stringify({ success: false, error: message || 'офлайн', offline: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-hub-offline': '1' }
  });
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
      if (!res) throw new Error('empty response');
      var ct = res.headers.get('content-type') || '';
      // Сервер жив и ответил JSON — это норма: кешируем.
      if (res.ok && !/^text\/html|^text\/xml/i.test(ct)) {
        setOffline(false);
        // Только текст/JSON: бинарные ответы (скачивание файла) в
        // localStorage превратились бы в мусор.
        if (/(json|text|javascript)/i.test(ct)) {
          try {
            res.clone().text().then(function (body) {
              store({ key: key, status: res.status, ct: ct, body: body });
              // Дубль в IndexedDB — листинги больших папок не помещаются в
              // localStorage (4 МБ). Если это /api/browse или /api/... (списки),
              // кладём и туда; назад отдаём при недоступности сервера.
              try { idbPut('list', { key: key, status: res.status, ct: ct, body: body, ts: Date.now() }); } catch (e) {}
            }).catch(function () {});
          } catch (e) {}
        }
        return res;
      }
      // Иначе: 5xx во время рестарта хаба, 502/1033 из туннеля, HTML-страница
      // ошибки вместо JSON (это и есть «html json failed»). Отдаём кеш.
      // Реальный JSON-ответ с кодом 4xx — это нормальная ошибка API: отдаём как есть.
      if (!/^text\/html|^text\/xml/i.test(ct) && res.status >= 400 && res.status < 500) {
        setOffline(false);
        if (/(json|text|javascript)/i.test(ct)) {
          try {
            res.clone().text().then(function (body) {
              store({ key: key, status: res.status, ct: ct, body: body });
            }).catch(function () {});
          } catch (e) {}
        }
        return res;
      }
      var hit = serveCached(key, res);
      if (hit) return hit;
      return serveCachedIdb(key, res).then(function (hit2) {
        if (hit2) return hit2;
        if (res.status >= 200 && res.status < 400) return serveErrJson('сервер ответил HTML вместо JSON');
        return serveErrJson('сервер недоступен (' + res.status + ')');
      });
    }).catch(function (err) {
      var hit = serveCached(key, err);
      if (hit) return hit;
      return serveCachedIdb(key, err).then(function (hit2) {
        if (hit2) return hit2;
        markFailed();
        throw err;
      });
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
  if (typeof setInterval === 'function') setInterval(function () { if (offline) retryNow(false); }, 5000);

  // ── Регистрация service worker (app shell) ──
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

// ── Большой кеш в IndexedDB: листинги папок и содержимое файлов ──
  // localStorage (4 МБ) хватит на листинги, но не на файлы. Для файлов —
  // отдельный кеш на устройстве: как у PWA, его не трогает смерть раннера.
  var IDB_DB = 'hub-files-cache';
  var IDB_VER = 1;
  var idbDb = null;
  function idbOpen() {
    if (idbDb) return Promise.resolve(idbDb);
    if (!('indexedDB' in window)) return Promise.reject(new Error('no indexedDB'));
    return new Promise(function (resolve, reject) {
      var rq = indexedDB.open(IDB_DB, IDB_VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('list')) db.createObjectStore('list', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('blob')) db.createObjectStore('blob', { keyPath: 'key' });
      };
      rq.onsuccess = function () { idbDb = rq.result; resolve(idbDb); };
      rq.onerror = function () { reject(rq.error); };
    });
  }
  function idbPut(store, obj) {
    if (!('indexedDB' in window)) return Promise.resolve();
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(obj);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    }).catch(function () {});
  }
  function idbGet(store, key) {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(store, 'readonly').objectStore(store).get(key);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    }).catch(function () { return null; });
  }
  function idbDel(store, key) {
    if (!('indexedDB' in window)) return Promise.resolve();
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () {});
  }
  function idbClear(store) {
    if (!('indexedDB' in window)) return Promise.resolve();
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () {});
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
    // Перепроверить связь и выйти из офлайна, не перезагружая страницу.
    retry: function () { return retryNow(false); },
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
        markFailed();
        return { success: true, queued: true, offline: true };
      });
    },
    pending: function () { return qLoad(); },
    flush: flushQueue,
    // Большой кеш на устройстве (IndexedDB, как у PWA): листинги папок и
    // содержимое файлов. Переживает смерть раннера и очистку localStorage —
    // данные остаются в браузере телефона/ноутбука.
    idb: {
      open: idbOpen,
      put: idbPut,
      get: idbGet,
      del: idbDel,
      clear: idbClear
    }
  };
})();
