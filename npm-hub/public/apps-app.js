/* apps-app.js — лаунчер телефона.
 *
 * Три источника, и все они локальные — раннер, воркфлоу и ADB тут не нужны:
 *
 *   1. ZenBridge в WebView панели — нативный ответ телефона: подписи, иконки
 *      и запуск через startActivity. Работает вообще без сети, потому что
 *      список лежит на устройстве.
 *   2. /api/apps — то, что панель положила в хаб в прошлый раз. Этим
 *      пользуется обычный браузер на том же телефоне, в том числе офлайн.
 *   3. Ничего — тогда страница честно говорит об этом и предлагает добавить
 *      себя на домашний экран.
 *
 * Запуск из веб-страницы возможен ровно одним способом — intent://, который
 * разруливает сам телефон. Никакого сервера в этом не участвует, поэтому
 * кнопка работает и при выключенной сети.
 */
'use strict';

var ALL = [];
var MODE = 'off';        // off | native | cached
var SOURCE = '';
var UPDATED = 0;
var PUSHED = '';

// The bridge is injected into the panel's WebView (MainActivity.kt), so this is
// the difference between "the phone answers" and "we read a cache file".
function nativeBridge() {
  var b = window.ZenBridge;
  return b && typeof b.listApps === 'function' && typeof b.launchApp === 'function' ? b : null;
}

function el(id) { return document.getElementById(id); }

function say(text, color) {
  var s = el('lc-state');
  if (s) { s.textContent = text; s.style.color = color || 'var(--t3)'; }
}

function note(html) {
  var n = el('lc-note');
  if (n) n.innerHTML = html || '';
}

// The gate is a switch, not a spinner: nothing is read and nothing is sent
// until it is pressed, so a visitor who only came to look costs the phone
// nothing. Inside the panel it also says what is about to happen.
function describePlan() {
  var b = nativeBridge();
  var w = el('lc-what');
  if (!w) return;
  if (b) {
    w.textContent = 'Панель на телефоне: список и запуск — нативно, без сети и без раннера.';
  } else {
    w.textContent = 'Браузер: список возьмём у хаба (последний раз отдала панель), запуск — через intent://.';
  }
}

function lcEnable() {
  var b = nativeBridge();
  say('читаю телефон…');
  if (b) return lcFromPhone(b);
  return lcFromHub();
}

// ── 1. the phone itself ──
function lcFromPhone(b) {
  var raw;
  try {
    raw = b.listApps();
  } catch (e) {
    // A bridge that throws is worse than no bridge: fall back rather than leave
    // the button dead.
    say('мост не ответил: ' + (e && e.message ? e.message : e), 'var(--err)');
    return lcFromHub();
  }
  var list;
  try {
    list = JSON.parse(raw || '[]');
  } catch (e) {
    say('список не разобрался: ' + (e && e.message ? e.message : e), 'var(--err)');
    return lcFromHub();
  }
  if (!list || !list.length) {
    note('Телефон не отдал ни одного приложения с иконкой запуска.');
    return lcFromHub();
  }
  MODE = 'native';
  SOURCE = 'ZenBridge';
  ALL = sanitize(list);
  say(ALL.length + ' приложений · с телефона, офлайн', 'var(--ok)');
  note('Режим: <b>панель-APK</b>. Откройте приложение — панель запустит его нативно, ' +
       'как обычную иконку. Список не уходил ни в какой раннер.');
  lcRender();
  lcPush();
}

// A label that is only whitespace would draw an empty row, and an icon longer
// than the page can paint is just a stall — both are trimmed here rather than
// in the markup.
function sanitize(list) {
  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var a = list[i] || {};
    var pkg = String(a.pkg || '').trim();
    if (!pkg || seen[pkg]) continue;
    seen[pkg] = 1;
    out.push({
      pkg: pkg,
      label: String(a.label || '').trim() || pkg,
      icon: typeof a.icon === 'string' && a.icon.length ? a.icon : ''
    });
  }
  out.sort(function (x, y) { return x.label.localeCompare(y.label, 'ru'); });
  return out;
}

// ── 2. what the hub kept ──
function lcFromHub() {
  return fetch('/api/apps', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.apps || !d.apps.length) {
        MODE = 'cached';
        ALL = [];
        say('хаб пока ничего не знает про приложения', 'var(--warn)');
        note('Пусто, и это ожидаемо: список на телефоне есть только у панели-APK, ' +
             'а хаб хранит лишь то, что она ему отдала.<br><br>' +
             'Чтобы список появился здесь, откройте хаб <b>внутри панели</b> ' +
             '(Панель → Сессии → хаб) и нажмите кнопку ещё раз — панель отдаст список, ' +
             'и дальше эта страница будет рисовать его даже без сети.<br><br>' +
             'А пока можно добавить её на домашний экран: <button class="btn btn-sm" onclick="lcInstall()">📌 Добавить на экран</button>');
        lcRender();
        return;
      }
      MODE = 'cached';
      SOURCE = d.source || 'панель';
      UPDATED = d.updatedAt || 0;
      ALL = sanitize(d.apps);
      var ago = UPDATED ? lcAgo(UPDATED) : 'неизвестно когда';
      say(ALL.length + ' приложений · отдала панель ' + ago, 'var(--ok)');
      note('Режим: <b>браузер</b>. Список лежит в хабе (обновлён ' + ago + '), ' +
           'запуск — через <code>intent://</code>, то есть телефон открывает приложение сам. ' +
           'Если открыть эту страницу <b>внутри панели-APK</b>, пойдёт нативный режим: ' +
           'подписи, иконки и запуск без сети вовсе.');
      lcRender();
    })
    .catch(function () {
      // offline.js serves the last good answer from localStorage, so landing
      // here means the hub was never reached with a list at all.
      MODE = 'cached';
      ALL = [];
      say('хаб недоступен и списка в кеше нет', 'var(--warn)');
      note('Эта страница лежит в офлайн-кеше хаба, но список приложений в нём появится ' +
           'только после того, как панель отдаст его хотя бы раз.');
      lcRender();
    });
}

// The list is the phone's, but the hub is where the launcher lives, so the panel
// hands it over once. Best effort on purpose: offline this has to stay silent.
function lcPush() {
  return fetch('/api/apps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'panel-webview',
      device: String(navigator.userAgent || '').slice(0, 80),
      apps: ALL.map(function (a) { return a.icon ? { label: a.label, pkg: a.pkg, icon: a.icon } : { label: a.label, pkg: a.pkg }; })
    })
  }).then(function (r) {
    if (!r.ok) throw new Error('hub said ' + r.status);
    return r.json();
  }).then(function (d) {
    PUSHED = d && d.updatedAt ? 'список отдан хабу · ' + lcAgo(d.updatedAt) : 'список отдан хабу';
    say(ALL.length + ' приложений · с телефона, офлайн · ' + PUSHED, 'var(--ok)');
  }).catch(function () {
    PUSHED = '';
    say(ALL.length + ' приложений · с телефона, офлайн · хаб не дозвонился, список только здесь',
        'var(--warn)');
  });
}

// ── drawing ──
function lcFilter() {
  var input = el('lc-q');
  var q = String(input && input.value || '').trim().toLowerCase();
  if (!q) return ALL;
  return ALL.filter(function (a) {
    return a.label.toLowerCase().indexOf(q) >= 0 || a.pkg.toLowerCase().indexOf(q) >= 0;
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function lcRender() {
  var grid = el('lc-grid'), tools = el('lc-tools'), count = el('lc-count'), empty = el('lc-empty');
  if (!grid) return;
  if (tools) tools.style.display = ALL.length ? 'flex' : 'none';
  var list = lcFilter();
  if (count) count.textContent = list.length === ALL.length
    ? ALL.length + ' приложений'
    : list.length + ' из ' + ALL.length;
  if (empty) {
    var showEmpty = ALL.length > 0 && !list.length;
    empty.style.display = showEmpty ? 'block' : 'none';
    empty.textContent = showEmpty ? 'Ничего не подходит под запрос.' : '';
  }
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    html += '<div class="app-tile" onclick="lcOpen(\'' + esc(a.pkg).replace(/'/g, '&#39;') + '\')" title="' + esc(a.pkg) + '">'
      + (a.icon
          ? '<img class="app-ico" src="data:image/png;base64,' + esc(a.icon) + '" alt="">'
          : '<div class="app-ico app-ico-txt">' + esc(a.label.slice(0, 2).toUpperCase()) + '</div>')
      + '<div class="app-name">' + esc(a.label) + '</div>'
      + '<div class="app-pkg">' + esc(a.pkg) + '</div>'
      + '</div>';
  }
  grid.innerHTML = html;
}

// ── launching ──
var fallbackTimer = 0;
var LAST_INTENT = '';

// The only way a web page starts an Android app: the phone resolves the intent
// itself, with no server and no network in the middle.
function lcIntent(pkg) {
  return 'intent://#Intent;package=' + encodeURIComponent(pkg) + ';end';
}

function lcOpen(pkg) {
  hideFallback();
  if (MODE === 'native') {
    var b = nativeBridge();
    if (b) {
      try {
        b.launchApp(pkg);
        return;
      } catch (e) {
        // Fall through: an intent still opens the app even if the bridge call
        // did not make it out.
      }
    }
  }
  LAST_INTENT = lcIntent(pkg);
  var url = LAST_INTENT;
  try { window.location.href = url; } catch (e) { window.location = url; }
  // Android keeps the page visible when nothing resolved the intent, so a
  // silent failure is the normal outcome for a package the phone will not
  // launch. Offer the store instead of pretending it worked.
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(function () {
    if (document.visibilityState === 'hidden') return;
    showFallback(pkg);
  }, 1400);
}

function showFallback(pkg) {
  var box = el('lc-fallback'), link = el('lc-fallback-link');
  if (link) {
    link.href = 'market://details?id=' + encodeURIComponent(pkg);
    link.onclick = function () { hideFallback(); };
  }
  if (box) box.classList.add('on');
}
function hideFallback() {
  var box = el('lc-fallback');
  if (box) box.classList.remove('on');
  clearTimeout(fallbackTimer);
}

// BeforeInstallPrompt is Chrome-only and only in a normal browser tab, which is
// exactly where a home-screen icon is what people are after.
var installPrompt = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  installPrompt = e;
});
function lcInstall() {
  if (!installPrompt) {
    note('Браузер не предложил установку. На Android: меню браузера → «Добавить на главный экран».');
    return;
  }
  installPrompt.prompt();
  installPrompt = null;
}

function lcAgo(ts) {
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'только что';
  if (s < 3600) return Math.round(s / 60) + ' мин назад';
  if (s < 86400) return Math.round(s / 3600) + ' ч назад';
  return Math.round(s / 86400) + ' дн назад';
}

document.addEventListener('DOMContentLoaded', function () {
  describePlan();
  if (!nativeBridge()) return;
  // Inside the panel the note can already tell the whole truth; the button is
  // still the switch, because reading the phone is not a thing to do silently.
  note('Панель на телефоне — список возьмём нативно, офлайн.');
});

// Exposed for the regression suite: the page is driven through these, exactly
// the way the button drives them.
window.lc = {
  state: function () { return { mode: MODE, source: SOURCE, updated: UPDATED, count: ALL.length, pushed: PUSHED }; },
  apps: function () { return ALL.slice(); },
  lastIntent: function () { return LAST_INTENT; },
  intent: lcIntent,
  install: lcInstall
};
