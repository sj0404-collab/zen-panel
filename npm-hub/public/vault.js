/* Внешняя память: полное зеркало рабочей папки на устройстве.
 * Файлы кладутся в IndexedDB (hub-vault) и остаются доступны офлайн —
 * страница открывается как отдельный PWA и показывает репо и сборки,
 * даже когда хаб/раннер лежит. Файлы крупнее 50 МБ не качаются. */
var Vault = (function () {
  var MAX_BYTES = 50 * 1024 * 1024;
  var DB_NAME = 'hub-vault';
  var DB_VER = 1;
  var db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'path' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'path' });
        if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'k' });
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function reqGet(store, key) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var r = d.transaction(store).objectStore(store).get(key);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function reqPut(store, value) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var r = d.transaction(store, 'readwrite').objectStore(store).put(value);
        r.onsuccess = function () { resolve(); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function reqDel(store, key) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var r = d.transaction(store, 'readwrite').objectStore(store).delete(key);
        r.onsuccess = function () { resolve(); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function reqAll(store) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var out = [], r = d.transaction(store).objectStore(store).openCursor();
        r.onsuccess = function () {
          var c = r.result;
          if (c) { out.push(c.value); c.continue(); }
          else resolve(out);
        };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  var DBS = { get: reqGet, put: reqPut, del: reqDel, all: reqAll };
  var dbOverride = null;
  function dbGet(s, k) { return dbOverride ? dbOverride.get(s, k) : DBS.get(s, k); }
  function dbPut(s, v) { return dbOverride ? dbOverride.put(s, v) : DBS.put(s, v); }
  function dbDel(s, k) { return dbOverride ? dbOverride.del(s, k) : DBS.del(s, k); }
  function dbAll(s) { return dbOverride ? dbOverride.all(s) : DBS.all(s); }

  function getState() {
    return dbGet('state', 'sync').then(function (s) { return s || null; });
  }
  function setState(s) { return dbPut('state', Object.assign({ k: 'sync' }, s)); }

  function plan(locals, treeEnts, maxBytes) {
    var byPath = {};
    locals.forEach(function (m) { byPath[m.path] = m; });
    var treePaths = {};
    treeEnts.forEach(function (e) { treePaths[e.path] = true; });
    var dirty = [], big = [], mark = [];
    treeEnts.forEach(function (e) {
      if (e.isDir) return;
      if (e.size > (maxBytes || MAX_BYTES)) { big.push({ path: e.path, size: e.size }); return; }
      var prev = byPath[e.path];
      if (!prev || prev.size !== e.size || prev.mtime !== e.mtime || prev.serverDeleted || !prev.serverOk) {
        dirty.push(e);
      }
    });
    locals.forEach(function (m) {
      if (m.serverDeleted) return;
      if (!treePaths[m.path]) mark.push(m.path);
    });
    return { dirty: dirty, big: big, markDeleted: mark };
  }

  function download(url, path) {
    return url.fetch('/api/fs/download?path=' + encodeURIComponent(path)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    });
  }

  function sync(root, url, onProg, maxBytes) {
    var q = root ? ('?path=' + encodeURIComponent(root)) : '';
    return url.fetch('/api/fs/tree' + q).then(function (resp) {
      return resp.json();
    }).then(function (tree) {
      if (!tree || !tree.success) {
        return setState({ serverOk: false, lastError: (tree && tree.error) || 'error', serverSyncAt: Date.now() }).then(function () {
          return { ok: false, error: (tree && tree.error) || 'bad tree' };
        });
      }
      var limit = maxBytes || tree.maxBytes || MAX_BYTES;
      var locals = [];
      return dbAll('meta').then(function (metas) {
        locals = metas;
        var p = plan(locals, tree.entries || [], limit);
        var added = 0, updated = 0, failed = 0;
        var total = p.dirty.length, done = 0;
        var chain = Promise.resolve();
        p.dirty.forEach(function (e) {
          chain = chain.then(function () {
            return download(url, e.path).then(function (blob) {
              return Promise.all([
                dbPut('blobs', { path: e.path, blob: blob }),
                dbPut('meta', { path: e.path, isDir: false, size: e.size, mtime: e.mtime, serverOk: true, serverDeleted: false })
              ]);
            }).then(function () {
              var prev = byPathGet(locals, e.path);
              if (prev && prev.serverOk && !prev.serverDeleted) updated++; else added++;
              done++; if (onProg) onProg(done, total);
            }).catch(function () {
              failed++; done++; if (onProg) onProg(done, total);
            });
          });
        });
        var dirChain = Promise.resolve();
        (tree.entries || []).forEach(function (e) {
          if (!e.isDir) return;
          dirChain = dirChain.then(function () {
            return dbPut('meta', { path: e.path, isDir: true, size: 0, mtime: e.mtime, serverOk: true, serverDeleted: false });
          });
        });
        return chain.then(function () {
          return dirChain.then(function () {
            var markChain = Promise.resolve();
            p.markDeleted.forEach(function (pth) {
              markChain = markChain.then(function () {
                return dbGet('meta', pth).then(function (m) {
                  if (!m) return;
                  m.serverDeleted = true;
                  return dbPut('meta', m);
                });
              });
            });
            return markChain.then(function () {
              var bigCount = p.big.length;
              var skipSize = 0;
              p.big.forEach(function (b) { skipSize += b.size; });
              var state = {
                serverOk: true, lastError: null, serverSyncAt: Date.now(), serverRoot: tree.root,
                added: added, updated: updated, failed: failed, skipped: bigCount,
                skippedSize: skipSize, files: tree.files, totalBytes: tree.totalBytes,
                bigPaths: p.big.slice(0, 500), maxBytes: limit
              };
              return setState(state).then(function () { return { ok: true, state: state }; });
            });
          });
        });
      });
    }).catch(function (e) {
      return setState({ serverOk: false, lastError: String(e && e.message || e), serverSyncAt: Date.now() }).then(function () {
        return { ok: false, error: String(e && e.message || e) };
      });
    });
  }

  function byPathGet(list, pth) {
    for (var i = 0; i < list.length; i++) if (list[i].path === pth) return list[i];
    return null;
  }

  function remove(pth) {
    return Promise.all([dbDel('blobs', pth), dbDel('meta', pth)]);
  }

  function children(dir) {
    var prefix = dir + '/';
    return dbAll('meta').then(function (metas) {
      var out = [];
      metas.forEach(function (m) {
        if (m.path === dir) return;
        if (m.path.indexOf(prefix) !== 0) return;
        var rest = m.path.slice(prefix.length);
        if (!rest || rest.charAt(rest.length - 1) === '/') return;
        if (rest.indexOf('/') !== -1) return;
        out.push(m);
      });
      out.sort(function (a, b) {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.path.localeCompare(b.path);
      });
      return out;
    });
  }

  var api = {
    MAX_BYTES: MAX_BYTES,
    open: open, plan: plan, sync: sync, remove: remove, children: children,
    getState: getState, _db: DBS,
    setDb: function (impl) { dbOverride = impl || null; },
    usedBytes: function () {
      return dbAll('meta').then(function (metas) {
        var n = 0, s = 0;
        metas.forEach(function (m) { if (!m.isDir) { n++; s += m.size; } });
        return { files: n, size: s };
      });
    }
  };
  return api;
})();

/* ==================== UI ==================== */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (function () {
    var $ = function (id) { return document.getElementById(id); };
    var BUILD_EXT = /\.(?:apk|aab|tar|tar\.xz|tgz|zip|7z|gz|bz2|deb|rpm|msi|exe|dmg|dex|jar|war)$/i;
    var curDir = null;
    var onlyBuilds = false;
    var filter = '';

    function fmt(n) {
      if (n == null) return '?';
      if (n < 1024) return n + ' Б';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ';
      if (n < 1073741824) return (n / 1048576).toFixed(1) + ' МБ';
      return (n / 1073741824).toFixed(2) + ' ГБ';
    }

    function setStatus(html, cls) {
      var s = $('vault-status');
      if (s) { s.innerHTML = html; s.className = 'vault-status' + (cls ? ' ' + cls : ''); }
    }

    function renderHeader(st, used) {
      var last = $('vault-last');
      if (last) {
        var parts = [];
        if (st && st.serverOk) parts.push('<span class="ok-dot"></span> сервер доступен');
        if (st && st.serverSyncAt) parts.push('обновлено ' + new Date(st.serverSyncAt).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
        if (st && !st.serverOk) parts.push('<span class="bad-dot"></span> сервер недоступен — показаны копии');
        if (used) parts.push('зеркало: ' + fmt(used.size) + ' · ' + used.files + ' файл(ов)');
        if (st && st.skipped) parts.push('пропущено >50 МБ: ' + st.skipped + ' (' + fmt(st.skippedSize) + ')');
        last.innerHTML = parts.join(' · ') || 'ещё не синхронизировано';
      }
      var root = $('vault-root');
      if (root && st && st.serverRoot && !root.value) root.value = st.serverRoot;
    }

    function render() {
      var st = null;
      Vault.getState().then(function (s) {
        st = s;
        return Vault.usedBytes();
      }).then(function (used) {
        renderHeader(st, used);
        if (!curDir && st && st.serverRoot) curDir = st.serverRoot;
        if (!curDir) { out('<div class="vault-empty">Выбери путь («изменить») и нажми «Синхронизировать».</div>'); return; }
        return Vault.children(curDir).then(function (items) {
          var filt = filter.toLowerCase();
          var rows = items.map(function (m) {
            var name = m.path.slice(curDir.length + 1);
            if (filt && name.toLowerCase().indexOf(filt) === -1 && !(m.isDir && (onlyBuilds === false))) return null;
            if (onlyBuilds && m.isDir) return null;
            if (onlyBuilds && !BUILD_EXT.test(name)) return null;
            return m;
          }).filter(Boolean);
          if (!rows.length) { out('<div class="vault-empty">Пусто' + (onlyBuilds ? ' — сборок нет' : '') + '.</div>'); return; }
          var html = rows.map(function (m) {
            var name = m.path.slice(curDir.length + 1);
            var icon = m.isDir ? '📁' : (BUILD_EXT.test(name) ? '📦' : '📄');
            var size = m.isDir ? '' : '<span class="v-size">' + fmt(m.size) + '</span>';
            var badge = '';
            if (!m.isDir && m.size > Vault.MAX_BYTES && !m.serverDeleted) badge += '<span class="v-skip">⏏ &gt;50 МБ</span>';
            if (m.serverDeleted) badge += '<span class="v-del">удалено на сервере</span>';
            var acts = '';
            if (m.isDir) {
              acts = '<button class="v-btn" onclick="VaultUI.open(\'' + jsQuote(m.path) + '\')">открыть</button>';
            } else if (m.size <= Vault.MAX_BYTES) {
              acts = '<button class="v-btn v-pri" onclick="VaultUI.get(\'' + jsQuote(m.path) + '\')">⬇ скачать</button>';
              acts += '<button class="v-btn" title="удалить из зеркала" onclick="VaultUI.drop(\'' + jsQuote(m.path) + '\',\'' + jsQuote(name) + '\')">🗑</button>';
            }
            return '<div class="v-row">' +
              '<span class="v-ico">' + icon + '</span>' +
              '<span class="v-name">' + escHtml(name) + size + '</span>' +
              badge + acts + '</div>';
          }).join('');
          out(html);
        });
      });
    }

    function out(html) { var l = $('vault-list'); if (l) l.innerHTML = html; }
    function escHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function jsQuote(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, '\\\''); }

    var syncing = false;
    async function doSync() {
      if (syncing) return;
      syncing = true;
      var btn = $('vault-sync'); if (btn) btn.disabled = true;
      var rootV = ($('vault-root') && $('vault-root').value.trim()) || '';
      setStatus('Синхронизация…');
      try {
        var r = await Vault.sync(rootV, { fetch: window.fetch.bind(window) }, function (d, t) {
          setStatus('Синхронизация… ' + d + '/' + t + ' файлов');
        });
        if (r.ok) setStatus('Готово: добавлено ' + r.state.added + ', обновлено ' + r.state.updated + (r.state.failed ? ', ошибок ' + r.state.failed : '') + (r.state.skipped ? ', пропущено >50 МБ: ' + r.state.skipped : ''), 'ok');
        else setStatus('Ошибка: нет связи с хабом — показаны сохранённые копии.', 'err');
      } finally {
        syncing = false;
        if (btn) btn.disabled = false;
        render();
      }
    }

    // Фоновая дозеркализация: зеркало должно накапливать репо и файлы, пока
    // хаб жив, — не только один раз при первом открытии и не по кнопке.
    // Синхронизируемся по возврату на вкладку и каждые 5 минут (только онлайн).
    function maybeSync() {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      Vault.getState().then(function (st) {
        if (!st || !st.serverSyncAt || Date.now() - st.serverSyncAt > 60 * 1000) doSync();
      }).catch(function () {});
    }

    var UI = {
      open: function (p) { curDir = p; render(); },
      get: function (p) {
        Vault._db.get('blobs', p).then(function (rec) {
          if (!rec || !rec.blob) { setStatus('Этот файл не зеркалируется (крупнее 50 МБ или пропущен).', 'err'); return; }
          var a = document.createElement('a');
          a.href = URL.createObjectURL(rec.blob);
          a.download = p.split(/[/\\]/).pop();
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        });
      },
      drop: function (p, name) {
        if (!confirm('Удалить «' + name + '» из зеркала? (на сервере файл останется)')) return;
        Vault.remove(p).then(function () { setStatus('Удалено из зеркала: ' + name, 'ok'); render(); });
      },
      openRoot: function () { curDir = null; render(); },
      toggleBuilds: function () { onlyBuilds = !onlyBuilds; var b = $('vault-builds'); if (b) b.classList.toggle('on'); render(); }
    };

    document.addEventListener('DOMContentLoaded', function () {
      var root = $('vault-root'), syncBtn = $('vault-sync');
      if (syncBtn) syncBtn.addEventListener('click', doSync);
      if (root) root.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSync(); });
      var filt = $('vault-filter');
      if (filt) filt.addEventListener('input', function () { filter = filt.value; render(); });
      render();
      setStatus('Загружаю зеркало…');
      if (typeof navigator !== 'undefined' && navigator.onLine !== false) doSync();
      document.addEventListener('visibilitychange', function () { if (!document.hidden) maybeSync(); });
      setInterval(function () { if (!document.hidden) maybeSync(); }, 5 * 60 * 1000);
      window.addEventListener('online', function () {
        Vault.getState().then(function (st) {
          if (!st || !st.serverSyncAt || Date.now() - st.serverSyncAt > 60 * 1000) doSync();
          else { setStatus('Связь вернулась — зеркало актуально.', 'ok'); render(); }
        });
      });
      window.addEventListener('offline', function () { setStatus('Нет сети — показаны сохранённые копии.', 'err'); });
      window.VaultUI = UI;
    });
  })();
}