// The launcher page (/apps): a local device feature, not a runner one.
//
// What is pinned here is the whole contract of the page, because each half of it
// is easy to break silently:
//   - inside the panel's WebView the phone answers natively (ZenBridge), the grid
//     draws with real labels and icons, and a tap calls launchApp;
//   - in a plain browser the list comes from the hub's cache and a tap goes out
//     as an intent:// URL, which is the only way a web page can start an app;
//   - neither path asks a runner, a workflow or ADB for anything, and the page
//     itself is in the offline shell so it opens with no network.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'npm-hub', 'public');

const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const html = fs.readFileSync(path.join(PUB, 'apps.html'), 'utf8');
const app = fs.readFileSync(path.join(PUB, 'apps-app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'npm-hub', 'src', 'server.js'), 'utf8');
const bridge = fs.readFileSync(path.join(PUB, 'bridge.js'), 'utf8');
const sw = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const mobileHtml = fs.readFileSync(path.join(PUB, 'mobile.html'), 'utf8');
const hubCss = fs.readFileSync(path.join(PUB, 'hub.css'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

const PHONE_APPS = [
  { label: 'Telegram', pkg: 'org.telegram.messenger', icon: 'iVBORw0KGgo=' },
  { label: 'Терминал', pkg: 'com.termux', icon: '' },
  { label: '  ', pkg: 'com.blank.label' },
  { label: 'Дубль', pkg: 'org.telegram.messenger' },
  { label: 'Файлы', pkg: 'com.android.documentsui' }
];

// The page is built from external files like every other standalone hub page,
// and jsdom does not fetch those. The real markup is kept and the real
// apps-app.js is inlined into it, so the selectors and the code under test are
// both the shipped ones.
function pageSource() {
  return html
    .replace(/\s*<script src="offline\.js"><\/script>/, '')
    .replace(/\s*<script src="bridge\.js"><\/script>/, '')
    .replace(/\s*<script src="apps-app\.js"><\/script>/,
      '\n<script>' + app.replace(/<\/script>/g, '<\\/script>') + '</script>');
}

function makePage(opts) {
  const calls = { launched: [], posts: [], gets: [] };
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  for (const t of ['log', 'info', 'warn', 'error']) vc.on(t, () => {});
  const dom = new JSDOM(pageSource(), {
    url: 'http://localhost:4700/apps', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      if (opts.native) {
        w.ZenBridge = {
          listApps: () => JSON.stringify(opts.apps || []),
          launchApp: pkg => calls.launched.push(pkg)
        };
      }
      w.fetch = (url, o) => {
        url = String(url);
        if (/\/api\/apps$/.test(url)) {
          if (o && o.method === 'POST') {
            calls.posts.push(JSON.parse(o.body));
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, count: (opts.apps || []).length, updatedAt: 1700000000000 }) });
          }
          calls.gets.push(url);
          if (opts.cached === 'none') return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, count: 0, apps: [] }) });
          if (opts.cached === 'offline') return Promise.reject(new Error('offline'));
          return Promise.resolve({
            ok: true, status: 200,
            json: async () => ({ success: true, updatedAt: 1700000000000, source: 'panel-webview', count: 3, apps: PHONE_APPS.slice(0, 3) })
          });
        }
        // bridge.js polls /api/info, /api/update and friends; they are not what
        // this suite is about.
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      };
      w.alert = () => {};
      w.scrollTo = () => {};
      // The intent:// navigation and the 1.4s fallback are jsdom's business,
      // not the suite's: fire timers at once and let the page finish.
      w.setTimeout = (fn) => { setImmediate(() => { try { fn(); } catch (e) {} }); return 0; };
      w.setInterval = () => 0;
      w.clearTimeout = () => {};
    }
  });
  return { dom, window: dom.window, document: dom.window.document, calls };
}

const settle = async (n) => { for (let i = 0; i < (n || 24); i++) await new Promise(r => setImmediate(r)); };
const tiles = (doc) => [...doc.querySelectorAll('.app-tile')];

(async () => {
  // ── the page is wired the way every other standalone hub page is ──
  check('a1 page loads the shared shell', /offline\.js/.test(html) && /bridge\.js/.test(html) && /apps-app\.js/.test(html));
  check('a2 page is its own hub page', /data-page="apps"/.test(html));
  check('a3 the enable button is on the page', /id="lc-enable"[^>]*onclick="lcEnable\(\)"/.test(html));

  // ── server: the route and the two halves of the cache ──
  check('a4 server serves /apps', /app\.get\('\/apps'/.test(server) && /'apps\.html'/.test(server));
  check('a5 server keeps the phone report on disk', /APPS_CACHE = path\.join\(hubTmp\(\), 'phone-apps\.json'\)/.test(server));
  check('a6 server answers GET /api/apps', /app\.get\('\/api\/apps'/.test(server));
  check('a7 server accepts the panel report', /app\.post\('\/api\/apps'/.test(server));
  check('a8 the launcher never borrows the runner', !/apps[\s\S]{0,400}getDefaultPhoneRunner|apps[\s\S]{0,400}PHONE_CTL/.test(server));
  check('a8b the cache cannot grow into the 50mb body parser',
    /APPS_JSON_MAX/.test(server) && /res\.status\(413\)/.test(server));

  // ── it is reachable from inside the hub, and offline ──
  check('a9 the hub topbar has the launcher', /\['apps', '📲 Лаунчер'\]/.test(bridge));
  check('a10 the hub front door links it', /href="\/apps"/.test(indexHtml));
  check('a11 the mobile drawer has it', /location\.href='\/apps'/.test(mobileHtml));
  check('a12 the page is in the offline shell', /'\/apps'/.test(sw) && /'\/apps-app\.js'/.test(sw));
  check('a13 the shell cache was bumped for the new files', /hub-shell-v5/.test(sw));
  check('a14 the manifest has a home-screen shortcut',
    Array.isArray(manifest.shortcuts) && manifest.shortcuts.some(s => s.url === '/apps'));
  check('a15 the topbar nav scrolls instead of squashing', /\.topbar-nav\{[^}]*overflow-x:auto/.test(hubCss));

  // ── 1. inside the panel: the phone answers ──
  const native = makePage({ native: true, apps: PHONE_APPS });
  await settle();
  check('a16 nothing is read before the button is pressed', tiles(native.document).length === 0 && native.calls.posts.length === 0);
  check('a17 the page says it will read the phone',
    /нативно, без сети и без раннера/.test(native.document.getElementById('lc-what').textContent));
  native.document.getElementById('lc-enable').click();
  await settle();
  check('a18 native mode drew the phone list', tiles(native.document).length === 4, tiles(native.document).length);
  check('a19 blank labels fall back to the package name',
    [...native.document.querySelectorAll('.app-tile')].some(t => t.querySelector('.app-name').textContent === 'com.blank.label'));
  check('a20 a duplicate package is one tile',
    [...native.document.querySelectorAll('.app-pkg')].filter(p => p.textContent === 'org.telegram.messenger').length === 1);
  check('a21 icons are drawn from what the phone sent',
    native.document.querySelector('.app-ico[src^="data:image/png;base64,"]') !== null);
  check('a22 the list went to the hub so a browser can show it too',
    native.calls.posts.length === 1 && native.calls.posts[0].apps.length === 4 && native.calls.posts[0].source === 'panel-webview');
  check('a23 native mode never reaches for an intent', native.window.lc.lastIntent() === '');
  tiles(native.document)[0].click();
  await settle(6);
  check('a24 a tap starts the app natively', native.calls.launched.length === 1 && typeof native.calls.launched[0] === 'string', native.calls.launched);

  // ── 2. plain browser on the phone: hub cache + intent:// ──
  const browser = makePage({ cached: 'some' });
  await settle();
  check('a25 browser mode does not claim a native list',
    /Браузер: список возьмём у хаба/.test(browser.document.getElementById('lc-what').textContent));
  browser.document.getElementById('lc-enable').click();
  await settle();
  check('a26 browser mode drew the cached list', tiles(browser.document).length === 3, tiles(browser.document).length);
  check('a27 browser mode read the hub cache', browser.calls.gets.some(u => /\/api\/api\/apps/.test(u) === false && /\/api\/apps$/.test(u)));
  check('a28 cached mode is honest about its age', /отдала панель/.test(browser.document.getElementById('lc-state').textContent));
  tiles(browser.document)[0].click();
  await settle(6);
  check('a29 browser mode launches with intent://',
    /^intent:\/\/#Intent;package=[^;]+;end$/.test(browser.window.lc.lastIntent()), browser.window.lc.lastIntent());
  check('a30 no native launch was attempted in a browser', browser.calls.launched.length === 0);

  // ── 3. an empty hub is a sentence, not an error ──
  const empty = makePage({ cached: 'none' });
  await settle();
  empty.document.getElementById('lc-enable').click();
  await settle();
  check('a31 an empty hub says so plainly',
    /хаб пока ничего не знает/.test(empty.document.getElementById('lc-state').textContent));
  check('a32 an empty hub explains how to fill it',
    /внутри панели/.test(empty.document.getElementById('lc-note').innerHTML));
  check('a33 an empty hub draws no tiles', tiles(empty.document).length === 0);

  // ── 4. offline: the page is cached, so a missing hub is survivable ──
  const offline = makePage({ cached: 'offline' });
  await settle();
  offline.document.getElementById('lc-enable').click();
  await settle();
  check('a34 an unreachable hub does not throw',
    /недоступен/.test(offline.document.getElementById('lc-state').textContent));
  check('a35 an unreachable hub still explains the next step',
    /офлайн-кеш/.test(offline.document.getElementById('lc-note').textContent));

  // ── 5. search, because a launcher without it is a wallpaper ──
  const search = makePage({ native: true, apps: PHONE_APPS });
  await settle();
  search.document.getElementById('lc-enable').click();
  await settle();
  const q = search.document.getElementById('lc-q');
  q.value = 'term';
  q.dispatchEvent(new search.window.Event('input'));
  await settle(4);
  check('a36 search narrows the grid', tiles(search.document).length === 1, tiles(search.document).length);
  q.value = 'telegram.messenger';
  q.dispatchEvent(new search.window.Event('input'));
  await settle(4);
  check('a37 search also matches the package', tiles(search.document).length === 1, tiles(search.document).length);
  q.value = 'нет-такого';
  q.dispatchEvent(new search.window.Event('input'));
  await settle(4);
  check('a38 an empty search says so instead of blanking the page',
    tiles(search.document).length === 0 && /Ничего не подходит/.test(search.document.getElementById('lc-empty').textContent));

  console.log('APPS-LAUNCHER: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
