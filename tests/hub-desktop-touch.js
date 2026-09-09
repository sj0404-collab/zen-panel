// Hub mobile touch E2E (jsdom): touch buttons fire, hold menu opens,
// launchable tools are tappable.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const TOOLS = [
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', color: '#00d4aa', icon: 'OC', installed: true, launchable: true, version: '1.0' },
  { id: 'crush', name: 'Crush', cmd: 'crush', color: '#e11d48', icon: 'CR', installed: false, launchable: false, version: null },
  { id: 'qwen', name: 'Qwen', cmd: 'qwen', npx: '@qwen-code/qwen-code', color: '#7c3aed', icon: 'QW', installed: false, launchable: true, version: null },
];

const html = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/desktop.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/desktop-app.js'), 'utf8');

const inline = html.replace('<script src="desktop-app.js"></script>',
  '<script>\n' + appJs + '\n</script>');

const seen = [];
async function stubFetch(url) {
  const u = String(url);
  seen.push(u);
  if (u.includes('/api/storages/clone')) return { ok: true, json: async () => ({ success: true, path: '/home/u/repos/R' }) };
  if (u.includes('/api/git/clone')) return { ok: true, json: async () => ({ success: true, path: '/home/u/repos/R', existed: false }) };
  if (u.includes('/api/sessions/save')) return { ok: true, json: async () => ({ success: true, files: ['s.md', 's.diff'], pushed: true, note: '' }) };
  if (u.includes('/user/repos')) return { ok: true, headers: { get: () => '' }, json: async () => [{ full_name: 'o/R', private: false, fork: false, permissions: { push: true }, description: 'd', language: 'JS', stargazers_count: 1, updated_at: '2026-09-01T00:00:00Z', default_branch: 'main' }] };
  if (u.includes('api.github.com/user')) return { ok: true, headers: { get: (h) => String(h).toLowerCase() === 'x-oauth-scopes' ? 'repo' : '' }, json: async () => ({ login: 'octo', name: 'O', email: '' }) };
  if (u.includes('boom')) return { ok: true, json: async () => ({ success: false, error: 'nope' }) };
  const body = u.includes('/api/tools') ? { success: true, tools: TOOLS }
    : u.includes('/api/info') ? { success: true, home: '/home/u', mode: 'local', state: {} }
    : u.includes('/api/health') ? { success: true, providers: [], self: {} }
    : u.includes('/api/models/full') ? { success: true, models: [], providers: [] }
    : u.includes('/api/models') ? { success: true, models: [], selected: 'x' }
    : u.includes('/api/devices') ? { success: true, devices: [] }
    : u.includes('/api/storages') ? { success: true, storages: [] }
    : u.includes('/api/browse') ? { success: true, path: '/home/u', parent: '/home', items: [] }
    : { success: true };
  return { ok: true, json: async () => body };
}
const dom = new JSDOM(inline, {
  url: 'http://localhost:8090/m', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = stubFetch;
    window.__alerts = [];
    window.alert = m => { window.__alerts.push(String(m)); };
    window.Terminal = class { constructor(o) { this.options = o || {}; this.cols = 80; this.rows = 24; } loadAddon() {} open() {} write() {} focus() {} dispose() {} onData() {} onResize() {} };
    window.FitAddon = { FitAddon: class { fit() {} } };
    window.WebLinksAddon = { WebLinksAddon: class {} };
    window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  },
});
const { window } = dom;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

(async () => {
  await sleep(600); // init + deferred fmBrowse

  // 1. toolUsable truth table
  check('t1 usable installed', window.toolUsable({ installed: true }) === true);
  check('t2 usable via npx', window.toolUsable({ installed: false, launchable: true }) === true);
  check('t3 unusable', window.toolUsable({ installed: false }) === false);
  check('t4 unusable empty', window.toolUsable({}) === false);

  // 2. dashboard: npx-launchable tool button enabled, truly-missing disabled
  const grid = window.document.getElementById('grid').innerHTML;
  check('t5 qwen enabled', /cdir-qwen[\s\S]{0,400}?>▶<\/button>/.test(grid) && !/cdir-qwen[\s\S]{0,200}disabled/.test(grid));
  check('t6 crush disabled', /disabled[^>]*>▶<\/button>/.test(grid));


  // 4. hold menu opens with tools for the tab cwd
  window.eval(`tabs.push({ id: 't1', cwd: '/home/u/repo' })`);
  window.openTermApplyMenu('t1');
  const menu = window.document.getElementById('term-apply-menu');
  check('t9 menu visible', menu.classList.contains('on'));
  check('t10 menu has usable tools', menu.innerHTML.includes('OpenCode') && menu.innerHTML.includes('Qwen'));
  check('t11 menu skips unusable', !menu.innerHTML.includes('Crush'));
  check('t12 menu shows cwd', menu.innerHTML.includes('~/repo'));

  // 5. double-fire guard (timer + contextmenu on one hold)
  window.openTermApplyMenu('t1');
  check('t13 still single menu', window.document.querySelectorAll('#term-apply-menu.on').length === 1);


  // 6. Go round-trips the [backend] prefix
  seen.length = 0;
  await window.eval(`fmBrowse('[gh-1] /sub')`);
  check('t14 prefix switches backend', seen.length && seen[0].includes('backend=gh-1') && seen[0].includes('path=%2Fsub'), seen[0]);
  check('t15 fmBackend updated', window.eval('fmBackend') === 'gh-1');

  // 7. browse failure is shown, not silent
  await window.eval(`fmBrowse('/boom')`);
  check('t16 error inline', window.document.getElementById('fm-info').textContent.includes('nope'));

  // 8. apply menu on virtual folders
  window.eval(`fmBackend='gh-1'; storages=[{id:'gh-1',name:'G',type:'github'}];`);
  window.toggleFmMenu({ stopPropagation() {} });
  const am = window.document.getElementById('fm-apply-menu');
  check('t17 github offers clone-open', am.classList.contains('on') && am.innerHTML.includes('Клонировать и открыть'));
  window.eval(`fmBackend='ftp-1'; storages=[{id:'ftp-1',name:'F',type:'ftp'}];`);
  window.__alerts.length = 0;
  window.toggleFmMenu({ stopPropagation() {} });
  check('t18 remote explains itself', window.__alerts.length === 1 && window.__alerts[0].includes('удал'), window.__alerts[0]);

  // 9. clone-and-open lands on local disk with the tool menu
  window.eval(`fmBackend='gh-1'; storages=[{id:'gh-1',name:'G',type:'github'}];`);
  await window.fmCloneOpen('gh-1');
  check('t19 back on local', window.eval('fmBackend') === 'local');
  check('t20 tool menu opens', window.document.getElementById('fm-apply-menu').innerHTML.includes('OpenCode'));


  // 10. repos: verify + access badges + one-tap open
  const vbtn = [...window.document.querySelectorAll('button')].filter(b => b.getAttribute('onclick') === 'verifyGhToken()');
  check('t21 verify btn', vbtn.length === 1, vbtn.length);
  window.document.getElementById('repos-token').value = 'ghp_x';
  await window.verifyGhToken();
  await sleep(50);
  check('t22 verify saves+renders', window.eval(`sessionStorage.getItem('gh_token')`) === 'ghp_x' && window.document.getElementById('repos-list').innerHTML.includes('o/R') && window.document.getElementById('repos-list').innerHTML.includes('\u2b16 push'));
  window.renderRepos([{ full_name: 'o/RO', private: true, fork: false, permissions: { pull: true }, description: '', language: '', stargazers_count: 0, updated_at: '', default_branch: 'main' }]);
  const rl = window.document.getElementById('repos-list').innerHTML;
  check('t23 read badge + open btn', rl.includes('\u2b16 read') && rl.includes('repoOpen(') && rl.includes('PRIVATE'));

  // 11. one-tap open clones and drops a terminal into the repo
  seen.length = 0;
  await window.repoOpen('o/R', 'main', true);
  check('t24 open clones', seen.some(u => u.includes('/api/git/clone')), seen.join('|'));
  check('t25 open lands in terminal', window.document.getElementById('p-terminal').classList.contains('on'));

  // 12. manual session save posts the active tab
  window.eval(`tabs.push({ id: 'term_9' }); activeTab = tabs[tabs.length-1];`);
  window.__alerts.length = 0;
  seen.length = 0;
  await window.saveTermSession();
  check('t26 save posts id', seen.some(u => u.includes('/api/sessions/save')), seen.join('|'));
  check('t27 save confirms', window.__alerts.length === 1 && window.__alerts[0].includes('Сессия сохранена') && window.__alerts[0].includes('запушено'), window.__alerts[0]);
  console.log(`HUB-DESK-TOUCH: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
