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
  let mode = 'ok', at = 0;
  const mock = async () => {
    at++;
    if (mode === 'fail') throw new Error('offline');
    return new Response(JSON.stringify({ repos: ['a'], at }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sb = makeSandbox(mock);

  const live = await sb.fetch('https://api.github.com/user/repos');
  check('panel fetch transparent online', live.status === 200 && !live.headers.get('x-panel-offline'));
  await new Promise(r => setTimeout(r, 15));

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

  console.log('PANEL-OFFLINE: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
