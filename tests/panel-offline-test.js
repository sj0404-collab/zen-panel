// Phase 3: the APK panel (one inlined HTML) carries an offline layer between
// the OFFLINE-LAYER markers. Extract it and drive it with a mock fetch, so the
// APK cache is tested the same behavioural way as the web one.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const panelPath = path.join(__dirname, '..', 'app/src/main/assets/panel/index.html');
const html = fs.readFileSync(panelPath, 'utf8');
const m = html.match(/\/\/ ── OFFLINE-LAYER-BEGIN[\s\S]*?\/\/ ── OFFLINE-LAYER-END/);
const layer = m ? m[0] : '';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

check('panel has an offline layer', layer.length > 1000);
check('panel offline layer installs before the panel code',
  html.indexOf('OFFLINE-LAYER-BEGIN') < html.indexOf('async function'));
check('panel keeps tokens out of the cache', /token\|secret\|password\|passwd\|auth/.test(layer));
check('panel never caches POST', /method !== 'GET'/.test(layer));
check('panel routes send-to-branch through the queue',
  html.includes('PanelOffline.post(`${base}/api/runner/backup`'));

function makeSandbox(mockFetch) {
  const mem = {};
  const el = () => ({ id: '', style: {}, innerHTML: '', textContent: '', appendChild() {} });
  const sandbox = {
    console, URL, Request, Response, Headers,
    navigator: { onLine: true },
    location: { href: 'https://panel.symbiosis.local/index.html', origin: 'https://panel.symbiosis.local', pathname: '/index.html' },
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
  vm.runInContext(layer, sandbox);
  return sandbox;
}

(async () => {
  let mode = 'ok', at = 0, failUrl = '';
  const mock = async (input) => {
    at++;
    if (mode === 'fail' && (!failUrl || String(input).includes(failUrl))) throw new Error('offline');
    return new Response(JSON.stringify({ repos: ['a'], at }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sb = makeSandbox(mock);

  const live = await sb.fetch('https://api.github.com/user/repos');
  check('panel fetch transparent online', live.status === 200 && !live.headers.get('x-panel-offline'));
  await new Promise(r => setTimeout(r, 1300));

  await sb.fetch('https://hub.example/api/info');
  await new Promise(r => setTimeout(r, 15));
  mode = 'fail'; failUrl = 'hub.example';
  const hubCached = await sb.fetch('https://hub.example/api/info');
  check('hub outage does not mark panel offline', hubCached.headers.get('x-panel-offline') === '1' && sb.PanelOffline.isOffline === false);
  failUrl = '';
  mode = 'ok';
  await sb.fetch('https://api.github.com/user/repos');

  mode = 'fail';
  const c = await sb.fetch('https://api.github.com/user/repos');
  check('panel serves cached GitHub data offline', c.headers.get('x-panel-offline') === '1');
  check('panel cached body intact', JSON.parse(await c.text()).repos[0] === 'a');
  check('panel offline flag raised', sb.PanelOffline.isOffline === true);

  let postThrew = false;
  try { await sb.fetch('https://api.github.com/user/repos', { method: 'POST' }); } catch (e) { postThrew = true; }
  check('panel POST fails offline (never replayed)', postThrew);

  let unknown = false;
  try { await sb.fetch('https://api.github.com/other'); } catch (e) { unknown = true; }
  check('panel unknown URL fails offline', unknown);

  // Queue: send-to-branch survives a dead network and replays once.
  mode = 'fail';
  const q = await sb.PanelOffline.post('https://hub.test/api/runner/backup', { items: [] }, 'save');
  check('apk offline action is queued', q.queued === true && sb.PanelOffline.pending().length === 1);
  await sb.PanelOffline.post('https://hub.test/api/runner/backup', { items: [] }, 'save');
  check('apk duplicate collapses', sb.PanelOffline.pending().length === 1);
  mode = 'ok';
  await sb.PanelOffline.flush();
  check('apk flush drains the queue', sb.PanelOffline.pending().length === 0);

  console.log('PANEL-OFFLINE: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
