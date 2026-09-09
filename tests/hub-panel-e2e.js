// Hub panel UI (jsdom): 4 tabs render over the /gh proxy + /api. fetch
// stubbed — no tokens, no network.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/panel.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/panel-app.js'), 'utf8');
const inline = html.replace('<script src="panel-app.js"></script>', '<script>\n' + appJs + '\n</script>');

const now = new Date().toISOString();
function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64'); }
const liveSession = { state: 'live', kind: 'NPM-Hub', os: 'linux', hubUrl: 'https://hub.local/', url: 'https://hub.local/', startedAt: now };

const seen = [], clones = [], cancels = [], dispatches = [];
async function stubFetch(url, opts) {
  const u = String(url);
  seen.push(u);
  const ok = data => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  if (u.includes('/api/git/clone')) {
    clones.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, path: '/home/runner/repos/R', existed: false }) };
  }
  if (u.includes('/cancel')) { cancels.push(u); return { ok: true, status: 204, json: async () => ({}) }; }
  if (u.includes('/dispatches')) { dispatches.push(JSON.parse(opts.body)); return { ok: true, status: 204, json: async () => ({}) }; }
  if (u.includes('/gh/user/repos')) {
    return ok([{ full_name: 'o/R', private: false, permissions: { push: true }, language: 'JS', stargazers_count: 1, updated_at: now, default_branch: 'main' }]);
  }
  if (/\/gh\/user(\?|$)/.test(u)) return ok({ login: 'octo', name: 'O', email: '', public_repos: 3 });
  if (u.includes('/gh/rate_limit')) return ok({ resources: { core: { remaining: 4990, limit: 5000 } } });
  if (u.includes('/actions/runs')) {
    return ok({ workflow_runs: [
      { id: 1, name: 'NPM Hub', run_number: 7, status: 'in_progress', created_at: now },
      { id: 2, name: 'Tests', run_number: 6, status: 'completed', conclusion: 'success', created_at: now },
    ] });
  }
  if (u.includes('session-hub-linux.json')) return ok({ content: b64(liveSession) });
  if (u.includes('/contents/')) return { ok: false, status: 404, json: async () => ({ success: false, error: '404: нет такого.' }) };
  return { ok: false, status: 404, json: async () => ({ success: false, error: '404' }) };
}

const dom = new JSDOM(inline, {
  url: 'http://localhost:8090/panel?zt=tok123', runScripts: 'dangerously',
  beforeParse(window) {
    window.fetch = stubFetch;
    window.confirm = () => true;
    window.alert = () => {};
    window.prompt = () => null;
  },
});
const { window } = dom;
const doc = window.document;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

(async () => {
  window.switchTab('repo');
  check('h1 tabs switch', doc.getElementById('p-repo').classList.contains('on') && doc.getElementById('t-repo').classList.contains('on'));

  await window.renderAccount();
  const acc = doc.getElementById('p-acc').innerHTML;
  check('h2 account shows login+limit', acc.includes('octo') && acc.includes('4990'), acc.slice(0, 120));

  await window.renderRepos();
  check('h3 repos render', doc.getElementById('p-repo').innerHTML.includes('o/R'));

  await window.repoOpen('o/R', 'main', null);
  check('h4 repo open clones without token', clones.length === 1 && clones[0].repo === 'o/R' && !('token' in clones[0]), JSON.stringify(clones));

  await window.renderActions();
  const act = doc.getElementById('p-act').innerHTML;
  check('h5 actions list', act.includes('#7') && act.includes('Выключить'), act.slice(0, 150));
  await window.cancelRun(1, null);
  check('h6 cancel posts', cancels.some(u => u.includes('/runs/1/cancel')), cancels.join('|'));

  await window.renderSessions();
  const sess = doc.getElementById('p-sess').innerHTML;
  check('h7 sessions render live hub', sess.includes('https://hub.local/') && sess.includes('чужой токен'), sess.slice(0, 200));

  const di = window.buildDispatchInputs('ZZ', 'mypc');
  check('h8 dispatch inputs shape', di.token === 'ZZ' && di.runner_linux === 'mypc' && di.os === 'linux' && !('gh_token' in di), JSON.stringify(di));
  check('h9 panel open url', window.hubOpenUrl('https://hub.local/', 'ZZ') === 'https://hub.local/m?zt=ZZ');

  console.log(`HUB-PANEL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
