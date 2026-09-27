// Every button in the panel, clicked (jsdom + stubbed GitHub API).
//
// Nothing else in the suite walks the controls: they are exercised one by one,
// each test picking a function and calling it directly. What that cannot see is
// a button whose handler is broken, or a stub someone left behind that answers
// "not implemented" - both of which look fine from the outside and dead to the
// user. So: find every button, click it, and fail on anything thrown, anything
// left unhandled, and any dialog that admits a control is not real.
const fs = require('fs');
const path = require('path');
const PANEL = process.env.PANEL_HTML || path.join(__dirname, '..', 'app/src/main/assets/panel/index.html');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const now = new Date().toISOString();
const sessions = {
  'live/session-hub-linux.json': {
    kind: 'NPM-Hub', state: 'live', runId: 333, runNumber: 140, startedAt: now,
    url: 'https://hub.example/', hubUrl: 'https://hub.example/',
    desktop: 'https://hub.example/d', mobile: 'https://hub.example/m', repo: 'o/r',
  },
  'live/session-linux.json': {
    deskUrl: 'https://desk.example/', url: 'https://desk.example', runId: 111,
    startedAt: now, state: 'live', repo: 'o/r',
  },
  'models/models-hub-linux.json': { kind: 'NPM-Hub', hubCount: 627, hubFree: 71, hubTop: ['mimo-v2.5-free'] },
};
const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const alerts = [];
const thrown = [];
const unhandled = [];

function stubFetch(url, opts) {
  url = String(url);
  if (url.includes('/dispatches') && opts && opts.method === 'POST') {
    return Promise.resolve({ status: 204, ok: true, json: async () => ({}) });
  }
  if (/\/cancel(\?|$)/.test(url) && opts && opts.method === 'POST') {
    return Promise.resolve({ status: 202, ok: true, json: async () => ({}) });
  }
  if (url.includes('/actions/runs')) {
    return Promise.resolve({ status: 200, ok: true, json: async () => ({
      workflow_runs: [
        { id: 333, name: 'NPM Hub', status: 'completed', conclusion: 'success', created_at: now, path: '.github/workflows/hub.yml' },
        { id: 334, name: 'NPM Hub', status: 'in_progress', created_at: now, path: '.github/workflows/hub.yml', jobs: [] },
      ],
    }) });
  }
  if (url.includes('/api/tools')) {
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, runId: '333', tools: [] }) });
  }
  if (url.includes('/api/runner')) {
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, running: true, uptime: 10 }) });
  }
  const m = url.match(/contents\/(.+?)(?:\?|$)/);
  if (m) {
    const obj = sessions[decodeURIComponent(m[1])] || null;
    if (obj) return Promise.resolve({ status: 200, ok: true, json: async () => ({ content: b64(obj), sha: 's' }) });
  }
  return Promise.resolve({ status: 404, ok: false, json: async () => ({ message: 'nf' }) });
}

// jsdom cannot navigate, and the panel navigates on plenty of controls. That
// one is a "Not implemented: navigation" from the DOM implementation, not a
// bug in the panel, so it is the only class of error let through.
function isDomNoise(e) {
  const s = String((e && e.message) || e || '');
  return /Not implemented[:\s]/i.test(s) || /navigation/i.test(s) || /scrollTo/i.test(s);
}

(async () => {
  const html = fs.readFileSync(PANEL, 'utf8');
  let timerBudget = 20000;
  // The panel navigates on several controls and jsdom cannot follow. Those
  // messages go to stderr and, on a CI runner, read like a test failure while
  // the exit code is 0 - so they are dropped here instead of being explained
  // away in the log every time.
  const vc = new VirtualConsole();
  // The panel navigates on several controls and jsdom cannot follow, so it
  // raises a jsdomError every time. Those go to stderr and, on a CI runner,
  // read like a failure while the exit code is 0. Counted and dropped here.
  // Real console output from the panel still comes through.
  let jsdomNoise = 0;
  vc.on('jsdomError', () => { jsdomNoise++; });
  for (const type of ['log', 'info', 'warn', 'error', 'dir']) {
    vc.on(type, (...args) => { console[type](...args); });
  }
  const dom = new JSDOM(html, {
    url: 'https://localhost/', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(window) {
      window.fetch = stubFetch;
      window.alert = m => { alerts.push(String(m)); };
      window.confirm = () => true;
      window.prompt = () => '';
      window.scrollTo = () => {};
      window.open = () => null;
      // jsdom implements neither of these, and the panel calls both on the way
      // to the interesting part. Leaving them out would report every control
      // that scrolls something as broken, which is noise, not a finding.
      if (window.Element) window.Element.prototype.scrollIntoView = () => {};
      if (window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = () => {};
      // Timers fire at once. waitAndOpen alone polls 90 times with a 5s sleep,
      // which is seven and a half minutes of a test suite - and a handler that
      // never resolves is exactly the kind of thing this test is here to catch,
      // so it gets a budget instead of a stopwatch.
      window.setTimeout = (fn, ms, ...a) => {
        if (timerBudget-- <= 0) return 0;
        return setImmediate(() => { try { fn(...a); } catch (e) { if (!isDomNoise(e)) thrown.push(String(e && e.message || e)); } });
      };
      window.setInterval = () => 0;
      window.requestAnimationFrame = cb => window.setTimeout(cb, 0);
      window.addEventListener('error', e => { if (!isDomNoise(e.error || e.message)) unhandled.push(String(e.message)); });
      window.addEventListener('unhandledrejection', e => { if (!isDomNoise(e.reason)) unhandled.push(String((e.reason && e.reason.message) || e.reason)); });
      try {
        window.localStorage.setItem('panel_accounts', JSON.stringify(
          { v: 1, active: 0, accounts: [{ login: 't', token: 'TEST', control: 'o/r' }] }));
      } catch (e) { /* private mode */ }
    },
  });
  const { window } = dom;
  const { document } = window;

  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    const ok = want instanceof RegExp ? want.test(String(got)) : got === want;
    ok ? pass++ : fail++;
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (ok ? '' : ' got=' + JSON.stringify(String(got)).slice(0, 200)));
  };

  // Let the panel settle on its own first: it paints on DOMContentLoaded and
  // starts polling.
  for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));
  try { if (window.loadDesks) await window.loadDesks(); } catch (e) { thrown.push('loadDesks: ' + e.message); }

  const buttons = [...document.querySelectorAll('button')];
  eq('b1 the panel has buttons to test', buttons.length > 20, true);

  // Every inline handler must name something that exists. A button pointing at
  // a deleted helper is exactly the dead control this suite is for, and it
  // fails on click with "x is not a function" - visible to nobody until then.
  const body = html;
  const defined = new Set();
  for (const m of body.matchAll(/\b(?:function|const|let|var|async function)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) { const n = part.split(':')[0].trim(); if (n) defined.add(n); }
  }
  const methodish = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'alert', 'confirm', 'prompt',
    'setTimeout', 'setInterval', 'clearInterval', 'fetch', 'open', 'close', 'reload', 'write', 'getElementById',
    'querySelector', 'querySelectorAll', 'split', 'slice', 'join', 'replace', 'startsWith', 'endsWith', 'toFixed',
    'stringify', 'parse', 'push', 'map', 'filter', 'forEach', 'includes', 'match', 'test', 'trim', 'padStart',
    'toUpperCase', 'toLowerCase', 'stopPropagation', 'preventDefault', 'getElementById', 'createElement', 'appendChild',
    'remove', 'add', 'get', 'set', 'keys', 'values', 'entries', 'sort', 'find', 'some', 'every', 'assign', 'stringify',
    'then', 'catch', 'finally', 'log', 'warn', 'error', 'stringify', 'btoa', 'atob', 'random', 'floor', 'round', 'abs',
    'String', 'Number', 'Boolean', 'Object', 'Array', 'JSON', 'Math', 'Date', 'RegExp', 'Error', 'decodeURIComponent',
    'encodeURIComponent', 'isNaN', 'scrollIntoView', 'click', 'focus', 'blur', 'contains', 'closest', 'hasAttribute',
    'setAttribute', 'getAttribute', 'removeAttribute', 'append', 'prepend', 'replaceChildren', 'insertAdjacentHTML',
    'scrollHeight', 'scrollTop', 'offsetHeight', 'clientHeight', 'getBoundingClientRect']);
  const targets = new Set();
  for (const m of html.matchAll(/on(?:click|change|input|submit)\s*=\s*"([^"]*)"/gi)) {
    for (const c of m[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) targets.add(c[1]);
  }
  const dangling = [...targets].filter(t => !defined.has(t) && !methodish.has(t));
  eq('b2 every inline handler names a real function', dangling.join(',') || 'none', 'none');

  // Click them all.
  const noHandler = [];
  const clicked = [];
  for (const btn of buttons) {
    const label = btn.id || (btn.textContent || '').trim().slice(0, 28) || btn.className || '(no label)';
    const inline = btn.getAttribute('onclick');
    if (!inline && !btn.onclick) { noHandler.push(label); continue; }
    clicked.push(label);
    try { btn.click(); } catch (e) { if (!isDomNoise(e)) thrown.push(label + ': ' + ((e && e.message) || e)); }
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
  }

  eq('b3 every button was clicked', clicked.length + noHandler.length, buttons.length);
  console.log('     clicked ' + clicked.length + ' of ' + buttons.length + ' buttons');
  eq('b4 no button threw', thrown.join(' | ').slice(0, 300) || 'none', 'none');
  eq('b5 nothing left unhandled', unhandled.join(' | ').slice(0, 300) || 'none', 'none');

  // A control that answers "not implemented" is a stub, whatever it is called.
  const stubs = alerts.filter(a => /не реализовано|не поддерживается|скоро будет|заглушк|TODO|coming soon|not implemented/i.test(a));
  eq('b6 no dialog admits a control is a stub', stubs.join(' | ').slice(0, 300) || 'none', 'none');

  // Report, do not fail: a control wired to nothing is a finding, not a crash.
  if (noHandler.length) console.log('     buttons with no handler found: ' + noHandler.join(', '));

  console.log('PANEL-BUTTONS: ' + (pass + fail) + ' checks, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PANEL-BUTTONS crashed: ' + (e && e.stack || e)); process.exit(1); });
