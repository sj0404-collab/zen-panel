// Phase 2: offline.js wraps fetch and replays the last GET /api response when
// the network is gone; sw.js caches the shell. The wrapper runs in a vm sandbox
// with a mock fetch, localStorage and Response, so this is a real behavioural
// test, not a grep.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'npm-hub', 'public');
const offlineSrc = fs.readFileSync(path.join(PUB, 'offline.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
const pages = ['mobile', 'desktop', 'term', 'dashboard', 'files', 'git', 'linux', 'index'];

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

// ── static wiring ──
for (const p of pages) {
  const html = fs.readFileSync(path.join(PUB, p + '.html'), 'utf8');
  check(p + ' links offline.js', /<script src="offline\.js"><\/script>/.test(html));
  check(p + ' links manifest', /rel="manifest" href="manifest\.webmanifest"/.test(html));
  const off = html.indexOf('offline.js');
  const appName = ['dashboard', 'files', 'git', 'linux'].includes(p) ? 'bridge.js'
    : (p === 'index' ? "fetch('/api/info')" : p + '-app.js');
  const app = html.indexOf(appName);
  check(p + ' offline.js loads first', off > -1 && app > -1 && off < app);
}
check('sw.js precaches shell', swSrc.includes("'/m'") && swSrc.includes("'/offline.js'"));
check('sw.js leaves /api/ to offline.js', /pathname\.indexOf\('\/api\/'\) === 0\) return/.test(swSrc));
check('sw.js caches the xterm CDN', swSrc.includes('cdn.jsdelivr.net'));
check('sw.js falls back to a cached page on navigate',
  /req\.mode === 'navigate'/.test(swSrc) && /caches\.match\('\/m'\)/.test(swSrc));

// The save-to-branch actions must go through the queue, not a bare fetch.
const mobileApp = fs.readFileSync(path.join(PUB, 'mobile-app.js'), 'utf8');
const desktopApp = fs.readFileSync(path.join(PUB, 'desktop-app.js'), 'utf8');
const filesApp = fs.readFileSync(path.join(PUB, 'files-app.js'), 'utf8');
check('mobile routes backup through HubOffline.post', mobileApp.includes("HubOffline.post('/api/runner/backup'"));
check('desktop routes backup through HubOffline.post', desktopApp.includes("HubOffline.post('/api/runner/backup'"));
check('mobile/desktop/files route gh/save through HubOffline.post',
  mobileApp.includes("HubOffline.post('/api/gh/save'") &&
  desktopApp.includes("HubOffline.post('/api/gh/save'") &&
  filesApp.includes("HubOffline.post('/api/gh/save'"));
const server = fs.readFileSync(path.join(__dirname, '..', 'npm-hub', 'src', 'server.js'), 'utf8');
check('server dedupes replayed actions', server.includes("req.get('x-hub-idem')") && server.includes('IDEM_DIR'));

// ── behavioural test of the fetch wrapper ──
function makeSandbox(mockFetch) {
  const mem = {};
  const el = () => ({ id: '', style: {}, innerHTML: '', textContent: '', appendChild() {} });
  const sandbox = {
    console, URL, Request, Response, Headers, setTimeout, clearTimeout,
    navigator: { onLine: true, userAgent: '' },
    location: { href: 'https://hub.test/m', origin: 'https://hub.test', pathname: '/m' },
    fetch: mockFetch,
    document: {
      readyState: 'complete',
      body: { appendChild() {} },
      createElement: el, getElementById: () => null, addEventListener() {}
    },
    localStorage: {
      getItem: k => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: k => { delete mem[k]; },
      key: i => Object.keys(mem)[i],
      get length() { return Object.keys(mem).length; }
    },
    addEventListener() {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(offlineSrc, sandbox);
  return sandbox;
}

(async () => {
  let mode = 'ok';
  const seen = [];
  const mock = async (input, init) => {
    seen.push({ url: String(input), method: (init && init.method) || 'GET', headers: (init && init.headers) || {} });
    if (mode === 'fail') throw new Error('network down');
    return new Response(JSON.stringify({ ok: true, at: seen.length }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const sb = makeSandbox(mock);

  const first = await sb.fetch('https://hub.test/api/info');
  check('fetch stays transparent online', first.status === 200 && !first.headers.get('x-hub-offline'));
  await new Promise(r => setTimeout(r, 15));

  mode = 'fail';
  const cached = await sb.fetch('https://hub.test/api/info');
  await new Promise(r => setTimeout(r, 1300));
  check('offline GET is served from cache', cached.headers.get('x-hub-offline') === '1');
  check('cached body is intact', JSON.parse(await cached.text()).ok === true);
  check('offline flag raised', sb.HubOffline.isOffline === true);

  let threwUnknown = false;
  try { await sb.fetch('https://hub.test/api/other'); } catch (e) { threwUnknown = true; }
  check('unknown endpoint still fails offline', threwUnknown);

  mode = 'ok';
  await sb.fetch('https://hub.test/api/sessions');
  await new Promise(r => setTimeout(r, 15));
  mode = 'fail';
  let postThrew = false;
  try { await sb.fetch('https://hub.test/api/sessions', { method: 'POST' }); } catch (e) { postThrew = true; }
  check('POST is never replayed from cache', postThrew);

  sb.HubOffline.save('my-state', { tabs: [1, 2] });
  const st = sb.HubOffline.load('my-state');
  check('HubOffline.save/load round-trips', st && st.body === '{"tabs":[1,2]}');

  // ── offline mutation queue ──
  mode = 'fail';
  const q1 = await sb.HubOffline.post('https://hub.test/api/runner/backup', { items: [{ path: '/x', dest: 'branch' }] }, 'save');
  check('offline post is queued, not lost', q1.queued === true);
  check('queue holds the action', sb.HubOffline.pending().length === 1);
  await sb.HubOffline.post('https://hub.test/api/runner/backup', { items: [{ path: '/x', dest: 'branch' }] }, 'save');
  check('duplicate queued action collapses', sb.HubOffline.pending().length === 1);

  mode = 'ok';
  seen.length = 0;
  await sb.HubOffline.flush();
  check('flush drains the queue', sb.HubOffline.pending().length === 0);
  check('flush replays as POST with an idem key',
    seen.some(s => s.method === 'POST' && (s.headers['x-hub-idem'] || s.headers['X-Hub-Idem'])));

  console.log('OFFLINE-CACHE: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
