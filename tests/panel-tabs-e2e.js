// Panel tabs/models/save E2E (jsdom + stubbed GitHub API).
// Covers: model lines from models-*.json, tabbed second layer for all four
// slots, no-reload tab switching, manual saveSession() PUT, dead-tab drop.
const fs = require('fs');
const path = require('path');
const PANEL = process.env.PANEL_HTML || path.join(__dirname, '..', 'app/src/main/assets/panel/index.html');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');

const unhandled = [];
process.on('unhandledRejection', e => { unhandled.push(String((e && e.message) || e)); });

const now = new Date().toISOString();
const sessions = {
  'session-linux.json': { deskUrl: 'https://desk.example/', url: 'https://desk.example', runId: 111, startedAt: now, state: 'live', repo: 'o/r' },
  'session-agent.json': { agentUrl: 'https://agent.example/hub?token=T', url: 'https://agent.example', runId: 222, startedAt: now, state: 'live' },
  'session-hub.json': { hubUrl: 'https://hub.example/', url: 'https://hub.example/', desktop: 'https://hub.example/d', runId: 333, startedAt: now, state: 'live' },
};
const models = {
  'models-hub.json': { kind: 'NPM-Hub', hubCount: 627, hubFree: 71, hubTop: ['mimo-v2.5-free'], hubSelected: 'mimo-v2.5-free' },
  'models-agent.json': {
    kind: 'CLI-агент', startedAt: now, runId: 222, version: 1, updatedAt: 1, endpointIds: [],
    models: { 'mimo-v2.5-free': { state: 'live', ok: 5, fails: 1 }, 'dead-one': { state: 'dead', ok: 0, fails: 3 } },
  },
};
const puts = [];
const alerts = [];
const b64 = o => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
let force403 = false;
let etagOn = false, seenInm = '';
let confirmSeq = [];
const dispatches = [];
let contentsGets = 0;
let hubGate401 = false;
let promptAnswer = null;
const fetchUrls = [];
const promptCalls = [];
let hubNetFail = false;
function stub403() {
  return { status: 403, ok: false,
    headers: { get: (h) => h === 'x-ratelimit-reset' ? String(Math.floor(Date.now() / 1000) + 300) : null },
    json: async () => ({ message: 'limited' }) };
}
function stubFetch(url, opts) {
  url = String(url);
  if (url.includes('/contents/')) contentsGets++;
  if (url.includes('/force403') || force403) return Promise.resolve(stub403());
  if (etagOn && url.includes('session-linux.json')) {
    const inm = opts && opts.headers && opts.headers['If-None-Match'];
    if (inm) { seenInm = inm; return Promise.resolve({ status: 304, ok: false, headers: { get: () => null }, json: async () => ({}) }); }
    return Promise.resolve({ status: 200, ok: true, headers: { get: h => h === 'etag' ? '"e1"' : null }, json: async () => ({ content: b64(sessions['session-linux.json']), sha: 'e' }) });
  }
  if (opts && opts.method === 'PUT') {
    puts.push({ url, body: JSON.parse(opts.body) });
    return Promise.resolve({ status: 201, ok: true, json: async () => ({ content: {} }) });
  }
  fetchUrls.push(url);
  if (/^https:\/\/hub[^/]*\//.test(url)) {
    if (hubNetFail) return Promise.reject(new Error('net down'));
    if (hubGate401) return Promise.resolve({ status: 401, ok: false, json: async () => ({ success: false, error: 'hub token?' }) });
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true }) });
  }
  if (url.includes('/dispatches') && opts && opts.method === 'POST') {
    dispatches.push(JSON.parse(opts.body));
    return Promise.resolve({ status: 204, ok: true, json: async () => ({}) });
  }
  if (url.includes('/cancel') && opts && opts.method === 'POST') {
    return Promise.resolve({ status: 202, ok: true, json: async () => ({}) });
  }
  const m = url.match(/contents\/(.+?)\?/);
  const obj = m && (sessions[decodeURIComponent(m[1])] || models[decodeURIComponent(m[1])]);
  if (obj) return Promise.resolve({ status: 200, ok: true, json: async () => ({ content: b64(obj), sha: 'shatest' }) });
  return Promise.resolve({ status: 404, ok: false, json: async () => ({ message: 'nf' }) });
}

(async () => {
  const html = fs.readFileSync(PANEL, 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://localhost/', runScripts: 'dangerously',
    beforeParse(window) {
      window.fetch = stubFetch;
      window.alert = m => { alerts.push(String(m)); };
      window.confirm = () => confirmSeq.length ? confirmSeq.shift() : true;
      window.prompt = (m, d) => { promptCalls.push([m, d]); return promptAnswer; };
      window.scrollTo = () => {};
      window.requestAnimationFrame = cb => setTimeout(cb, 0);
      window.localStorage.setItem('panel_accounts', JSON.stringify(
        { v: 1, active: 0, accounts: [{ login: 't', token: 'TEST', control: 'o/r' }] }));
    },
  });
  const { document } = dom.window;
  let pass = 0, fail = 0;
  const eq = (n, got, want) => {
    const ok = want instanceof RegExp ? want.test(String(got)) : got === want;
    ok ? pass++ : fail++;
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (ok ? '' : ' got=' + JSON.stringify(String(got)).slice(0, 160)));
  };
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    for (;;) { try { const v = fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) return null; await new Promise(r => setTimeout(r, 200)); }
  };

  await dom.window.loadDesks();
  eq('p1 card visible', document.getElementById('desks-card').style.display, '');
  eq('p2 model line', document.getElementById('desk-model-agent')?.textContent || '', /mimo-v2\.5-free.*1\/2/);
  eq('p3 save buttons', document.querySelectorAll('#desks button').length >= 2 &&
    [...document.querySelectorAll('#desks button')].some(b => b.textContent === 'Сохранить'), true);
  eq('p3b hub model line', document.getElementById('desk-model-hub')?.textContent || '', /Модели: 627 \(71 бесплатных\)/);

  dom.window.expandDesk('agent');
  await waitFor(() => document.getElementById('desk-overlay'));
  eq('p4 overlay', !!document.getElementById('desk-overlay'), true);
  const tabs = [...document.querySelectorAll('#desk-tabs button')].map(b => b.textContent);
  eq('p5 tabs', JSON.stringify(tabs), JSON.stringify(['Linux', 'CLI-агент', 'NPM-Hub']));
  const fa = () => document.getElementById('desk-frame-agent');
  const fl = () => document.getElementById('desk-frame-linux');
  eq('p6 agent shown', fa() && fa().style.display, 'block');
  eq('p7 linux hidden', fl() && fl().style.display, 'none');
  eq('p8 frame url kept', fa().dataset.url, /agent\.example/);
  const srcBefore = fa().src;

  dom.window.switchDeskTab('linux');
  eq('p9 switch shows linux', fl().style.display, 'block');
  eq('p10 agent kept mounted', !!fa() && fa().style.display === 'none' && fa().src === srcBefore, true);

  await dom.window.loadDesks(); // simulated re-poll must not reload frames
  eq('p11 repoll keeps frames', !!fa() && fa().src === srcBefore && !!document.getElementById('desk-overlay'), true);

  await dom.window.saveSession('agent');
  eq('p12 save PUT path', puts.length === 1 && /contents\/saved\/agent-\d{8}T\d{6}\.json/.test(puts[0].url), true);
  const bundle = puts.length && JSON.parse(Buffer.from(puts[0].body.content, 'base64').toString('utf8'));
  eq('p13 save bundle', puts.length === 1 && puts[0].body.branch === 'session-state' &&
    bundle.session.runId === 222 && !!bundle.models.models['mimo-v2.5-free'] && !!bundle.savedAt, true);
  eq('p14 save alert', alerts.some(a => a.startsWith('Сохранено: saved/agent-')), true);

  dom.window.expandDesk('hub');
  await waitFor(() => document.getElementById('desk-frame-hub')?.style.display === 'block');
  eq('p16c hub tab opens', document.getElementById('desk-frame-hub')?.dataset.url, /hub\.example/);
  await dom.window.saveSession('hub');
  eq('p16d hub save PUT', puts.length === 2 && /contents\/saved\/hub-\d{8}T\d{6}\.json/.test(puts[1].url) &&
    JSON.parse(Buffer.from(puts[1].body.content, 'base64').toString('utf8')).models.hubCount === 627, true);

  sessions['session-agent.json'].runId = 555; // file re-owned by a newer run
  await dom.window.stopRun(222);
  eq('p16e ownership respected', puts.length, 2);
  sessions['session-agent.json'].runId = 222;
  await dom.window.stopRun(222);
  eq('p16f stop PUT', puts.length === 3 && /contents\/session-agent\.json$/.test(puts[2].url) &&
    puts[2].body.branch === 'session-state' && puts[2].body.sha === 'shatest' &&
    JSON.parse(Buffer.from(puts[2].body.content, 'base64').toString('utf8')).state === 'ended', true);
  await dom.window.stopRun(999); // unknown runId: nothing to mark
  eq('p16g unknown run ignored', puts.length, 3);

  sessions['session-agent.json'].state = 'ended'; // runner died; next poll drops the tab
  await dom.window.loadDesks();
  eq('p15 dead tab dropped', !document.getElementById('desk-frame-agent') &&
    [...document.querySelectorAll('#desk-tabs button')].map(b => b.textContent).join(',') === 'Linux,NPM-Hub', true);

  try { await dom.window.api('https://x.test/force403'); eq('p17 403 marked', false, true); }
  catch (e) { eq('p17 403 marked', !!e.is403 && /Пауза/.test(e.message), true); }

  force403 = true;
  alerts.length = 0;
  const t403 = Date.now();
  await dom.window.waitAndOpen('hub');
  eq('p18 stops fast on 403', Date.now() - t403 < 15000, true);
  eq('p19 pause shown', document.getElementById('btn-hub').textContent, 'Пауза (403)');
  eq('p20 alert raised', alerts.length > 0, true);
  force403 = false;

  sessions['session-agent-linux.json'] = { agentUrl: 'https://aglin.example/hub', url: 'https://aglin.example', runId: 444, startedAt: now, state: 'live' };
  sessions['session-hub-windows.json'] = { hubUrl: 'https://hubwin.example/', url: 'https://hubwin.example/', runId: 555, startedAt: now, state: 'live' };
  await dom.window.loadDesks();
  eq('p21 os tabs', [...document.querySelectorAll('#desk-tabs button')].map(b => b.textContent).join(','), 'Linux,CLI-агент Linux,NPM-Hub Windows,NPM-Hub');
  eq('p22 liveSlotOf', dom.window.liveSlotOf('agent') + '|' + dom.window.liveSlotOf('hub'), 'agent-linux|hub-windows');
  eq('p23 hub token url', dom.window.deskSlotUrl('hub-windows'), /hubwin\.example.*#gh=TEST/);
  const s24 = await dom.window.readSessionSlot('agent-linux');
  eq('p24 os slot read', !!(s24 && s24._slot === 'agent-linux' && s24.agentUrl), true);

  alerts.length = 0;
  const t25 = Date.now();
  await dom.window.waitAndOpen('hub-windows');
  eq('p25 wait os slot', Date.now() - t25 < 15000 && dom.window.eval('READY.slot') === 'hub-windows' &&
    document.getElementById('btn-hub').textContent.startsWith('Поднимаю'), true);

  etagOn = true;
  const u1 = 'https://api.github.com/repos/o/r/contents/session-linux.json?ref=session-state&t=1';
  const u2 = 'https://api.github.com/repos/o/r/contents/session-linux.json?ref=session-state&t=2';
  const b1 = await dom.window.api(u1);
  const b2 = await dom.window.api(u2);
  eq('p26 etag 304', seenInm === '"e1"' && JSON.stringify(b1) === JSON.stringify(b2), true);
  etagOn = false;

  force403 = true;
  await dom.window.refresh();
  eq('p27 refresh parks on 403', dom.window.eval('sessPausedUntil') > Date.now(), true);
  try { await dom.window.api('https://x.test/force403'); eq('p28 unbanMs', false, true); }
  catch (e) { eq('p28 unbanMs', e.unbanMs > 0 && e.unbanMs <= 300000, true); }
  force403 = false;

  eq('p29 token shape', /^[0-9a-f]{32}$/.test(dom.window.genHubToken()), true);
  dom.window.eval('HUB_TOKENS["hub-windows"]="ZTTEST"');
  eq('p30 zt in url', dom.window.deskSlotUrl('hub-windows'), /hubwin\.example\/\?zt=ZTTEST#gh=TEST/);

  sessions['session-hub-linux.json'] = { hubUrl: 'https://hublin.example/', url: 'https://hublin.example/', runId: 666, startedAt: now, state: 'live' };
  dispatches.length = 0; alerts.length = 0; confirmSeq.length = 0;
  await dom.window.launchHub();
  const d1 = dispatches[0] || {};
  eq('p31 launch hub', d1.ref === 'main' && d1.inputs.os === 'linux' && d1.inputs.label === 'hub' &&
    /^[0-9a-f]{32}$/.test(d1.inputs.token || '') &&
    d1.inputs.runner_linux === 'ubuntu-latest' && d1.inputs.runner_windows === 'windows-latest' &&
    dom.window.eval('READY.slot') === 'hub-linux', true);
  confirmSeq.push(true, false);
  await dom.window.launchHub();
  const d2 = (dispatches[1] || {}).inputs || {};
  eq('p32 self-hosted runner', d2.runner_linux === 'self-hosted' && d2.runner_windows === 'self-hosted', true);

  contentsGets = 0;
  const lc = await dom.window.loadCreds();
  eq('p33 creds reuse desks', contentsGets <= 1 && lc && lc._slot === 'agent-linux', true);

  dom.window.eval('HUB_TOKENS["hub-windows"]="ZTTEST"');
  await dom.window.expandDesk('hub-windows');
  await waitFor(() => document.getElementById('desk-frame-hub-windows')?.style.display === 'block');
  eq('p34 probe opens gated frame', document.getElementById('desk-frame-hub-windows')?.src || '', /zt=ZTTEST/);

  hubGate401 = true;
  const openBefore = dom.window.eval('deskOpen');
  const tokBefore = dom.window.eval('HUB_TOKENS["hub-linux"]');
  confirmSeq.push(false); promptAnswer = null;
  await dom.window.expandDesk('hub-linux');
  eq('p35 recovery abort', dom.window.eval('deskOpen') === openBefore && dom.window.eval('HUB_TOKENS["hub-linux"]') === tokBefore, true);

  confirmSeq.push(false); promptAnswer = 'MANUAL1';
  await dom.window.expandDesk('hub-linux');
  await waitFor(() => document.getElementById('desk-frame-hub-linux')?.style.display === 'block');
  eq('p36 manual token', dom.window.eval('HUB_TOKENS["hub-linux"]') === 'MANUAL1' &&
    (document.getElementById('desk-frame-hub-linux')?.src || '').includes('zt=MANUAL1'), true);
  hubGate401 = false;

  dom.window.eval('HUB_TOKENS["hub-linux"]="REUSE1"');
  dispatches.length = 0; confirmSeq.length = 0;
  await dom.window.launchHub();
  eq('p37 token reused', ((dispatches[0] || {}).inputs || {}).token === 'REUSE1', true);
  eq('p38 notify url token', /zt=REUSE1/.test(dom.window.eval('READY.url')) && /#gh=TEST/.test(dom.window.eval('READY.url')), true);

  dom.window.eval('HUB_TOKENS["hub-linux"]="NEW1"');
  dom.window.eval('DESKS["hub-linux"]={hubUrl:"https://hub.local/?zt=OLD&x=1"}');
  const dupe = dom.window.eval('deskSlotUrl("hub-linux")');
  eq('p39 zt idempotent', (dupe.match(/zt=/g) || []).length === 1 && dupe.includes('zt=NEW1') && dupe.includes('x=1') && !dupe.includes('zt=OLD'), true);

  fetchUrls.length = 0;
  await dom.window.expandDesk('hub-linux');
  await waitFor(() => (document.getElementById('desk-frame-hub-linux')?.src || '').includes('zt=NEW1'));
  eq('p40 probe url clean', fetchUrls.some(u => u === 'https://hub.local/api/tools'), true);
  eq('p41 open diagnostic', (document.getElementById('boot-log')?.textContent || '').includes('hub-linux') &&
    (document.getElementById('boot-log')?.textContent || '').includes('zt ok'), true);

  promptCalls.length = 0;
  await dom.window.eval('openExternal("https://example.com/x?y=1")');
  eq('p42 link prompt fallback', promptCalls.length === 1 && promptCalls[0][1] === 'https://example.com/x?y=1', true);

  dom.window.eval(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__clip = s; } }, configurable: true })`);
  await dom.window.eval('openExternal("https://example.com/z")');
  eq('p43 link clipboard', dom.window.eval('window.__clip') === 'https://example.com/z', true);

  hubNetFail = true;
  await dom.window.expandDesk('hub-windows');
  eq('p44 probe netfail logged', (document.getElementById('boot-log')?.textContent || '').includes('сеть недоступна'), true);
  eq('p45 open hints vpn', (document.getElementById('boot-log')?.textContent || '').includes('не отвечает (VPN?)'), true);
  hubNetFail = false;
  dom.window.eval(`LIVE = { url: 'https://hub.local', hubUrl: 'https://hub.local', _slot: 'hub-linux', kind: 'NPM-Hub' };
    HUB_TOKENS['hub-linux'] = 'tok123'; previewOpen = false; renderPreview();`);
  const p46src = document.querySelector('#preview iframe')?.src || '';
  eq('p46 preview carries zt', p46src.includes('zt=tok123'), true);
  eq('p46b preview launcher root', new URL(p46src).pathname, '/');
  dom.window.eval(`delete HUB_TOKENS['hub-linux']; previewOpen = false; renderPreview();`);
  eq('p47 preview no-token hint', (document.getElementById('preview')?.innerHTML || '').includes('Открыть стол'), true);
  dom.window.eval(`LIVE = null; previewOpen = false; renderPreview();`);
  const realFetch = dom.window.fetch;
  dom.window.eval(`fetch = async () => ({ ok: false, status: 429, headers: { get: () => null } });`);
  let msg429 = '', pause429 = 0;
  try { await dom.window.eval('api("https://api.github.com/zen429probe")'); }
  catch (e) { msg429 = e.message; pause429 = e.unbanMs || 0; }
  dom.window.fetch = realFetch;
  eq('p48 429 hint', msg429.includes('429') && msg429.includes('лишние'), true);
  eq('p48b 429 pauses polls', pause429 > 0, true);
  // expandDesk does not await loadDesks; let it land before close()
  await new Promise(r => setTimeout(r, 400));

  dom.window.close();
  await new Promise(r => setTimeout(r, 500));
  eq('p16 no unhandled rejections', unhandled.length, 0);
  if (unhandled.length) console.log('unhandled:', unhandled.slice(0, 3));
  console.log(`PANEL-TABS: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PANEL-TABS ERROR:', e); process.exit(1); });
