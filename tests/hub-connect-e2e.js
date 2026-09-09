// Hub APK connect page (jsdom): dispatch carries the gate token, the poll
// finds the live session, the open URL hits /m with ?zt= and #gh=.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'hub/src/main/assets/hub/index.html'), 'utf8');

const now = new Date().toISOString();
const liveSession = { state: 'live', kind: 'NPM-Hub', hubUrl: 'https://hub.local/', url: 'https://hub.local/', startedAt: now };
function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64'); }

const dispatches = [];
let sessionMode = 'live'; // live | missing | flaky
let polls = 0;
async function stubFetch(url, opts) {
  const u = String(url);
  if (u.includes('/dispatches')) {
    if (opts.headers.Authorization === 'token BAD') return { ok: false, status: 401, json: async () => ({}) };
    dispatches.push(JSON.parse(opts.body));
    return { ok: true, status: 204, json: async () => ({}) };
  }
  if (u.includes('/api/tools')) {
    return u.includes('zt=good')
      ? { ok: true, status: 200, json: async () => ({ success: true, tools: [] }) }
      : { ok: false, status: 401, json: async () => ({ success: false, error: 'hub token?' }) };
  }
  if (u.includes('session-hub-linux.json')) {
    polls++;
    if (sessionMode === 'missing') return { ok: false, status: 404, json: async () => ({}) };
    if (sessionMode === 'flaky' && polls < 3) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ content: b64(liveSession) }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
}

const dom = new JSDOM(html, {
  url: 'https://hub.symbiosis.local/index.html', runScripts: 'dangerously',
  beforeParse(window) { window.fetch = stubFetch; },
});
const { window } = dom;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

(async () => {
  const zt = window.genZt();
  check('c1 zt is 32 hex', /^[0-9a-f]{32}$/.test(zt), zt);

  await window.dispatchHub('ghp_x', 'zt123');
  const d = dispatches[0] || {};
  check('c2 dispatch ref+inputs', d.ref === 'main' && d.inputs && d.inputs.os === 'linux' &&
    d.inputs.token === 'zt123' && d.inputs.label === 'hub-apk' && d.inputs.gh_token === 'ghp_x' &&
    d.inputs.runner_linux === undefined, JSON.stringify(d));
  await window.dispatchHub('ghp_x', 'zt123', 'mypc');
  check('c2b dispatch runner', dispatches[1].inputs.runner_linux === 'mypc', JSON.stringify(dispatches[1]));

  sessionMode = 'live';
  const s = await window.readHubSession('ghp_x');
  check('c3 session parsed', s && s.hubUrl === 'https://hub.local/' && s.state === 'live', JSON.stringify(s));

  sessionMode = 'missing';
  check('c4 session 404 is null', (await window.readHubSession('ghp_x')) === null);

  check('c5 open url shape', window.buildOpenUrl(liveSession, 'ZZ') === 'https://hub.local/panel?zt=ZZ',
    window.buildOpenUrl(liveSession, 'ZZ'));

  sessionMode = 'flaky'; polls = 0;
  const w = await window.waitForHub('ghp_x', Date.now() - 1000, 5);
  check('c6 poll waits then live', w && w.state === 'live' && polls >= 3, polls);

  let msg = '';
  try { await window.dispatchHub('BAD', 'zt123'); } catch (e) { msg = e.message; }
  check('c7 bad token 401', /401/.test(msg), msg);

  check('c8 preflight ok', (await window.preflightHub('https://hub.local', 'good')) === true);
  let msg9 = '';
  try { await window.preflightHub('https://hub.local', 'bad'); } catch (e) { msg9 = e.message; }
  check('c9 preflight rejects bad zt', /не принял токен/.test(msg9), msg9);

  console.log(`HUB-CONNECT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
