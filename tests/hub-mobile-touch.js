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

const html = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile-app.js'), 'utf8');

const inline = html.replace('<script src="mobile-app.js"></script>',
  '<script>\n' + appJs + '\n</script>');

const seen = [];
async function stubFetch(url) {
  const u = String(url);
  seen.push(u);
  if (u.includes('/api/storages/clone')) return { ok: true, json: async () => ({ success: true, path: '/home/u/repos/R' }) };
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

  // 3. touchend on zoom+ fires the action (the dead-button fix)
  const zoomBtns = [...window.document.querySelectorAll('.tc-btn')].filter(b => b.getAttribute('onclick') === 'zoomTerm(1)');
  check('t7 zoom btn found', zoomBtns.length === 1, zoomBtns.length);
  zoomBtns[0].dispatchEvent(new window.Event('touchend', { bubbles: true, cancelable: true }));
  check('t8 zoom fired on touchend', window.document.getElementById('zoom-label').textContent === '110%');

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

  console.log(`HUB-TOUCH: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
