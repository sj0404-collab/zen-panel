// Hub APK connect page (jsdom): dispatch carries the gate token, the poll
// finds the live session, the open URL hits /m with ?zt= and #gh=.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'hub/src/main/assets/hub/index.html'), 'utf8');

const now = new Date().toISOString();
const liveSession = { state: 'live', kind: 'NPM-Hub', runId: '999', hubUrl: 'https://hub.local/', url: 'https://hub.local/', startedAt: now };
function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64'); }

const dispatches = [];
const runStates = new Map();
const cancelOrder = [];
let sessionMode = 'live'; // live | missing | flaky
let polls = 0;
async function stubFetch(url, opts) {
  const u = String(url);
  if (u.includes('/dispatches')) {
    if (opts.headers.Authorization === 'token BAD') return { ok: false, status: 401, json: async () => ({}) };
    dispatches.push(JSON.parse(opts.body));
    return { ok: true, status: 204, json: async () => ({}) };
  }
  if (u.includes('/actions/runs?')) {
    return { ok: true, status: 200, json: async () => ({ workflow_runs: Array.from(runStates.values()).map(x => ({ ...x })) }) };
  }
  const cancel = u.match(/\/actions\/runs\/(\d+)\/cancel$/);
  if (cancel && opts && opts.method === 'POST') {
    cancelOrder.push(Number(cancel[1]));
    runStates.set(Number(cancel[1]), { id: Number(cancel[1]), status: 'completed', conclusion: 'cancelled', path: '.github/workflows/hub.yml', name: 'NPM Hub' });
    return { ok: true, status: 202, json: async () => ({}) };
  }
  const one = u.match(/\/actions\/runs\/(\d+)$/);
  if (one) {
    const run = runStates.get(Number(one[1]));
    return { ok: !!run, status: run ? 200 : 404, json: async () => run || {} };
  }
  if (u.includes('/api/tools')) {
    // dead.local is an address that never answers (a dropped tunnel); the feed
    // only works out of trouble when the reserve is tested. Everything else:
    // zt=good answers, anything else is a token rejection.
    if (u.includes('dead.local')) return { ok: false, status: 502, json: async () => ({}) };
    return u.includes('zt=good')
      ? { ok: true, status: 200, json: async () => ({ success: true, runId: '999', tools: [] }) }
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
  await window.dispatchHub('ghp_x', 'zt123', '', true);
  check('c2c replace flag', dispatches[2].inputs.replace === true, JSON.stringify(dispatches[2]));

  // Stage X replaced the assertNoActiveSession() helper - which threw - with
  // detectSessionConflict(), which answers instead. The test kept calling the
  // helper that no longer exists, so it failed on every run with
  // "window.assertNoActiveSession is not a function" and took the whole Tests
  // job with it. Check the replacement and both of the answers it can give.
  runStates.set(7, { id: 7, status: 'in_progress', path: '.github/workflows/hub.yml', name: 'NPM Hub' });
  const hubConflict = await window.detectSessionConflict('ghp_x');
  check('c2d duplicate hub run detected', hubConflict === 'hub', hubConflict);

  runStates.clear();
  runStates.set(8, { id: 8, status: 'in_progress', path: '.github/workflows/agent.yml', name: 'Zen agent' });
  const otherConflict = await window.detectSessionConflict('ghp_x');
  check('c2d2 another session detected', otherConflict === 'other', otherConflict);

  runStates.clear();
  const noConflict = await window.detectSessionConflict('ghp_x');
  check('c2d3 no conflict when idle', noConflict === null, noConflict);

  runStates.clear();
  runStates.set(7, { id: 7, status: 'in_progress', path: '.github/workflows/hub.yml', name: 'NPM Hub' });
  let waitError = '';
  try { await window.waitForRunsToStop('ghp_x', [7], 0, 1); } catch (e) { waitError = e.message; }
  check('c2e cancellation wait times out safely', /не остановлен/.test(waitError), waitError);
  runStates.set(7, { id: 7, status: 'completed', conclusion: 'cancelled', path: '.github/workflows/hub.yml', name: 'NPM Hub' });
  check('c2f completed run needs no wait', await window.waitForRunsToStop('ghp_x', [7], 0, 1) === true);
  runStates.clear();
  runStates.set(7, { id: 7, status: 'queued', path: '.github/workflows/hub.yml', name: 'NPM Hub' });
  runStates.set(8, { id: 8, status: 'in_progress', path: '.github/workflows/hub.yml', name: 'NPM Hub' });
  cancelOrder.length = 0;
  const cancelledIds = await window.cancelCurrentRun('ghp_x');
  check('c2g all active runs cancelled', cancelledIds.length === 2 && cancelOrder.length === 2, JSON.stringify(cancelOrder));
  runStates.clear();

  sessionMode = 'live';
  const s = await window.readHubSession('ghp_x');
  check('c3 session parsed', s && s.hubUrl === 'https://hub.local/' && s.state === 'live', JSON.stringify(s));

  sessionMode = 'missing';
  check('c4 session 404 is null', (await window.readHubSession('ghp_x')) === null);

  check('c5 open url shape', window.buildOpenUrl(liveSession, 'ZZ') === 'https://hub.local/m?zt=ZZ',
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
  let msg10 = '';
  try { await window.preflightHub('https://hub.local', 'good', '1000'); } catch (e) { msg10 = e.message; }
  check('c10 preflight rejects another run', /другим запуском/.test(msg10), msg10);

  // Failover to the reserve (Z11 dual tunnels) and honest failure reporting.
  // firstReachableBase must walk from the dead main to the warm reserve, and
  // describeBaseFailure must never blame a reserve that was never published.
  const probeLive = await window.firstReachableBase(['https://dead.local', 'https://hub.local'], 'good', '999');
  check('c11 walks over to the reserve', probeLive.base === 'https://hub.local' &&
    probeLive.errors.length === 1 && /не принял токен|HTTP 404/.test(probeLive.errors[0].reason),
    JSON.stringify(probeLive));

  const probeDead = await window.firstReachableBase(['https://hub.local'], 'bad', '999');
  check('c12 single dead base probed once', probeDead.base === '' && probeDead.errors.length === 1, JSON.stringify(probeDead));
  const m12 = window.describeBaseFailure(['https://hub.local'], probeDead.errors, 'bad');
  check('c12b single address is not blamed on the reserve',
    /не принял токен/.test(m12) && m12.indexOf('Ни основной') < 0, m12);

  const m13 = window.describeBaseFailure(['https://hub.local'], probeDead.errors, '');
  check('c13 missing launch token is called out', /токен/.test(m13) && /zt/.test(m13), m13);

  const probeTwo = await window.firstReachableBase(['https://dead.local', 'https://hub.local'], 'bad', '999');
  const m14 = window.describeBaseFailure(['https://dead.local', 'https://hub.local'], probeTwo.errors, 'bad');
  check('c14 two dead bases keep the dual-address wording', /Ни основной, ни резервный/.test(m14), m14);

  console.log(`HUB-CONNECT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
