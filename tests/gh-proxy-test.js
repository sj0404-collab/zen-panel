// gh-proxy unit tests (plain node, no jsdom): allowlist, ETag cache,
// hub.yml token dynasty, error mapping. fetchImpl stubbed — no network.
process.env.GH_TOKEN = 'server-pat';
const gh = require('../npm-hub/src/gh-proxy');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

(async () => {
  check('g1 allow user', gh.allow('GET', ['user']) === 'user');
  check('g2 allow runs', gh.allow('GET', ['repos', 'o', 'r', 'actions', 'runs']) === 'repos/o/r/actions/runs');
  check('g3 reject bad owner', gh.allow('GET', ['repos', 'o!', 'r', 'actions', 'runs']) === null);
  check('g4 reject traversal', gh.allow('GET', ['repos', 'o', 'r', 'contents', '..', 'x']) === null);
  check('g5 reject method', gh.allow('DELETE', ['user']) === null);
  check('g6 reject workflow ext', gh.allow('POST', ['repos', 'o', 'r', 'actions', 'workflows', 'x.sh', 'dispatches']) === null);

  // ETag: first GET caches, 304 serves the cache without a body.
  gh.resetCache();
  let lastHeaders = null;
  const stub = async (url, opts) => {
    lastHeaders = opts.headers;
    if (opts.headers['If-None-Match']) return { status: 304, ok: false, headers: { get: () => null }, json: async () => ({}) };
    return { status: 200, ok: true, headers: { get: h => (h === 'etag' ? '"e1"' : null) }, json: async () => ({ login: 'octo' }) };
  };
  const r1 = await gh.request('GET', 'user', { fetchImpl: stub });
  check('g7 get user', r1.status === 200 && r1.body.login === 'octo' && r1.cached === false);
  const r2 = await gh.request('GET', 'user', { fetchImpl: stub });
  check('g8 304 cached', r2.cached === true && r2.body.login === 'octo' && lastHeaders['If-None-Match'] === '"e1"');

  // Dynasty: hub.yml dispatch inherits the server token.
  let seenBody = null;
  const stubPost = async (url, opts) => {
    seenBody = JSON.parse(opts.body);
    return { status: 204, ok: true, headers: { get: () => null }, json: async () => ({}) };
  };
  await gh.request('POST', 'repos/o/r/actions/workflows/hub.yml/dispatches',
    { body: { ref: 'main', inputs: { os: 'linux', token: 'zt1' } }, fetchImpl: stubPost });
  check('g9 dynasty injects gh_token', seenBody.inputs.gh_token === 'server-pat' && seenBody.inputs.token === 'zt1', seenBody.inputs);
  await gh.request('POST', 'repos/o/r/actions/workflows/other.yml/dispatches',
    { body: { ref: 'main', inputs: {} }, fetchImpl: stubPost });
  check('g10 no inject elsewhere', seenBody.inputs.gh_token === undefined, seenBody.inputs);

  // Errors map to friendly messages with status.
  const stub401 = async () => ({ status: 401, ok: false, headers: { get: () => null }, json: async () => ({}) });
  let msg = '', st = 0;
  try { await gh.request('GET', 'user', { fetchImpl: stub401 }); } catch (e) { msg = e.message; st = e.status; }
  check('g11 401 mapped', /401/.test(msg) && st === 401, msg);

  delete process.env.GH_TOKEN;
  let msg501 = '';
  try { await gh.request('GET', 'user', { fetchImpl: stub }); } catch (e) { msg501 = e.message; }
  check('g12 no token 501', /501/.test(msg501), msg501);
  process.env.GH_TOKEN = 'server-pat';

  console.log(`GH-PROXY: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
