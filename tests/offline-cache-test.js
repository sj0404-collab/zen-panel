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
    seen.push({ url: String(input), method: (init && init.method) || 'GET' });
    if (mode === 'fail') throw new Error('network down');
    return new Response(JSON.stringify({ ok: true, at: seen.length }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const sb = makeSandbox(mock);

  const first = await sb.fetch('https://hub.test/api/info');
  check('fetch stays transparent online', first.status === 200 && !first.headers.get('x-hub-offline'));
  await new Promise(r => setTimeout(r, 15)); // let the async clone().text() land

  mode = 'fail';
  const cached = await sb.fetch('https://hub.test/api/info');
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

  console.log('OFFLINE-CACHE: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
