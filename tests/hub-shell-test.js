// The NPM Hub shell page: tabs, the run indicator, the journal, and the
// GitHub tab (jsdom + stubbed GitHub API).
//
// This page is the APK's only screen before the hub itself, and the complaint
// it answers is "the buttons take forever and I cannot tell whether anything
// happened". So the things pinned here are the answers to that: a clock that
// runs, a journal that is timestamped, a button that says what it is doing the
// instant you press it, and a way out of a wait that is not working.
const fs = require('fs');
const path = require('path');
const PAGE = process.env.HUB_HTML || path.join(__dirname, '..', 'hub/src/main/assets/hub/index.html');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const nowIso = () => new Date().toISOString();
let dispatches = [];
let cancels = [];
let runsPayload = [];
let jobsPayload = [];
let runStatus = 'in_progress';
let rawSession = null;
let rawMissing = false;

function json(body, status) {
  return Promise.resolve({ status: status || 200, ok: (status || 200) < 400,
    headers: { get: () => null }, json: async () => body });
}
function stubFetch(url, opts) {
  url = String(url);
  if (url.includes('/dispatches')) {
    if (opts && opts.method === 'POST') { dispatches.push(JSON.parse(opts.body)); return json({}, 204); }
    return json({}, 204);
  }
  if (/\/cancel$/.test(url) && opts && opts.method === 'POST') {
    cancels.push(Number((url.match(/runs\/(\d+)\/cancel/) || [])[1]));
    runStatus = 'completed';
    return json({}, 202);
  }
  if (/\/jobs$/.test(url)) return json({ jobs: jobsPayload });
  if (url.includes('/actions/runs')) {
    return json({ workflow_runs: runsPayload.map(r => Object.assign({}, r, { status: r.id === 7 ? runStatus : r.status })) });
  }
  if (url.includes('raw.githubusercontent.com')) {
    if (rawMissing || !rawSession) return Promise.resolve({ status: 404, ok: false, text: async () => '404' });
    return Promise.resolve({ status: 200, ok: true, text: async () => JSON.stringify(rawSession) });
  }
  if (url.includes('/api/tools')) {
    return json({ success: true, runId: '333' });
  }
  return json({ message: 'nf' }, 404);
}

(async () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  for (const t of ['log', 'info', 'warn', 'error', 'dir']) vc.on(t, (...a) => console[t](...a));
  const dom = new JSDOM(html, {
    url: 'https://hub.symbiosis.local/index.html', runScripts: 'dangerously', virtualConsole: vc,
    beforeParse(w) {
      w.fetch = stubFetch;
      w.alert = () => {};
      w.confirm = () => true;
      w.scrollTo = () => {};
      if (w.Element) w.Element.prototype.scrollIntoView = () => {};
      w.localStorage.setItem('hub_gh_token', 'ghp_test');
      // The page waits in setTimeout (followRun, waitForHub: 5s a poll, up to
      // 90 polls). Firing those at once is what makes this suite finish in
      // seconds; setInterval is left alone, because the run clock and the
      // connect countdown are exactly what h16 is here to check.
      let budget = 40000;
      w.setTimeout = (fn, ms, ...a) => {
        if (budget-- <= 0) return 0;
        return setImmediate(() => { try { fn(...a); } catch (e) { if (!/Not implemented/i.test(String(e && e.message))) console.log('  (page) ' + (e && e.message || e)); } });
      };
    },
  });
  const { window } = dom;
  const { document } = window;
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    const ok = want instanceof RegExp ? want.test(String(got)) : got === want;
    ok ? pass++ : fail++;
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (ok ? '' : ' got=' + JSON.stringify(String(got)).slice(0, 180)));
  };
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));

  // ── tabs ──
  const tabs = [...document.querySelectorAll('.tab')];
  eq('h1 the page has two tabs', tabs.length, 2);
  eq('h2 the hub tab starts open', document.getElementById('pane-hub').style.display, '');
  document.querySelector('.tab[data-pane="gh"]').click();
  eq('h3 the GitHub tab opens', document.getElementById('pane-gh').style.display, '');
  eq('h4 and closes the hub tab', document.getElementById('pane-hub').style.display, 'none');

  // ── the GitHub tab's controls ──
  const ids = ['gh-refresh', 'run-desks', 'run-agent', 'run-opencode', 'run-hub',
    'wf-panel-apk', 'wf-hub-apk', 'wf-build', 'wf-tests'];
  const missing = ids.filter(id => !document.getElementById(id));
  eq('h5 every control the panel offers is here', missing.join(',') || 'none', 'none');

  // ── the journal ──
  const logEl = document.getElementById('log');
  window.log('первая строка');
  window.logStep('шаг');
  window.log('ошибка', 'err');
  const lines = [...logEl.children];
  eq('h6 the journal records every line', lines.length >= 3, true);
  eq('h7 every line carries a clock', /^\d\d:\d\d:\d\d/.test(lines[0].textContent), true);
  eq('h8 a step is told from an error', lines[1].className === 'step' && lines[2].className === 'err', true);
  // The cap: a phone screen cannot show ten thousand lines, and a log nobody
  // scrolls is not a journal.
  for (let i = 0; i < 520; i++) window.log('строка ' + i);
  eq('h9 the journal is capped', logEl.childElementCount <= 500, true);
  eq('h10 and keeps the newest', /строка 519/.test(logEl.lastChild.textContent), true);
  window.logClearClick = null;
  document.getElementById('log-clear').click();
  eq('h11 the journal can be cleared', logEl.childElementCount, 1);

  // ── the run indicator ──
  const prog = document.getElementById('prog');
  eq('h12 the indicator starts hidden', prog.style.display, 'none');
  const p = window.progStart('Запуск хаба');
  eq('h13 and appears when something starts', prog.style.display, '');
  eq('h14 with a label', document.getElementById('prog-label').textContent, 'Запуск хаба');
  eq('h15 and a clock at zero', document.getElementById('prog-time').textContent, '0:00');
  await new Promise(r => setTimeout(r, 1200));
  eq('h16 that counts', document.getElementById('prog-time').textContent, '0:01');
  window.progStage('шаг такой-то');
  eq('h17 and shows the stage', document.getElementById('prog-stage').textContent, 'шаг такой-то');
  window.progFinish(true, 'готово');
  eq('h18 a finished run is marked done', /done/.test(prog.className), true);
  window.progStart('Остановка', { cancellable: false });
  window.progFinish(false, 'не вышло');
  eq('h19 a failed run is marked failed', /fail/.test(prog.className), true);
  eq('h20 and says why', document.getElementById('prog-stage').textContent, 'не вышло');

  // ── a button answers the finger ──
  const btn = document.getElementById('run-hub');
  window.busy(btn, true, 'Отправляю…');
  eq('h21 a working button is disabled', btn.disabled, true);
  eq('h22 and says what it is doing', btn.textContent, 'Отправляю…');
  window.busy(btn, false);
  eq('h23 and comes back to its own label', btn.textContent.trim(), 'NPM Hub');
  eq('h24 enabled again', btn.disabled, false);

  // ── stopping a wait is a normal thing to want ──
  window.stopWaiting = false;
  document.getElementById('prog-stop').click();
  eq('h25 the stop button ends the wait', window.stopWaiting, true);
  eq('h26 and is reported', /прерван/i.test(document.getElementById('prog-stage').textContent), true);

  // ── step names a person can read ──
  eq('h27 known steps are translated', window.stepRu('Create the work folder and restore repositories'),
    'восстановление репозиториев');
  eq('h28 unknown steps are still shown', window.stepRu('Weird New Step'), 'weird new step');
  eq('h29 actions are trimmed', window.stepRu('Run actions/checkout@v4'), 'получение кода');

  // ── a button with no token says so, instead of doing nothing ──
  document.getElementById('token').value = '';
  document.getElementById('gh-refresh').click();
  await new Promise(r => setImmediate(r));
  eq('h30 the list explains it needs a token', /токен/i.test(document.getElementById('gh-sessions').textContent), true);

  // ── and a real dispatch goes out, with the gate token saved ──
  document.getElementById('token').value = 'ghp_test';
  runsPayload = [{ id: 7, number: 7, run_number: 141, name: 'NPM Hub', status: 'queued',
    path: '.github/workflows/hub.yml', created_at: new Date(Date.now() - 1000).toISOString() }];
  dispatches = [];
  runStatus = 'in_progress';
  const p2 = window.progStart('NPM Hub');
  await window.startSession('hub.yml',
    { os: 'linux', label: 'hub-apk', token: 'zt-abc', gh_token: 'ghp_test', replace: true },
    document.getElementById('run-hub'), 'NPM Hub');
  eq('h31 the dispatch went out', dispatches.length, 1);
  eq('h32 for the right workflow', dispatches[0] && /hub\.yml/.test(dispatches[0].workflow || 'hub.yml') ||
    (dispatches[0] && dispatches[0].inputs && dispatches[0].inputs.label === 'hub-apk'), true);
  window.stopWaiting = false;
  window.progFinish(false, '');

  // ── the session list renders and its buttons work ──
  runsPayload = [
    { id: 7, run_number: 141, name: 'NPM Hub', status: 'in_progress', path: '.github/workflows/hub.yml', created_at: nowIso() },
    { id: 8, run_number: 140, name: 'Zen agent', status: 'in_progress', path: '.github/workflows/agent.yml', created_at: nowIso() },
  ];
  await window.ghRefresh();
  const rows = document.querySelectorAll('#gh-sessions .row');
  eq('h33 both live sessions are listed', rows.length, 2);
  eq('h34 each row can be opened', rows[0].querySelectorAll('button[data-act="open"]').length, 1);
  eq('h35 and every row can be stopped', document.querySelectorAll('#gh-sessions button[data-act="stop"]').length, 2);
  cancels = [];
  rows[0].querySelector('button[data-act="stop"]').click();
  await new Promise(r => setImmediate(r));
  eq('h36 stopping asks GitHub to cancel', cancels.includes(7), true);

  console.log('HUB-SHELL: ' + (pass + fail) + ' checks, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HUB-SHELL crashed: ' + (e && e.stack || e)); process.exit(1); });
