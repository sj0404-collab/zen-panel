// The HUB_TOKEN gate in npm-hub/src/server.js (regression, no deps).
//
// The hub is published on a public trycloudflare address and serves a file
// manager plus node-pty terminals, so "who may talk to it at all" is the
// difference between a session and remote shell. hub.yml has passed a
// per-launch token for a long time and the panel has always opened the hub as
// /m?zt=<token> - but nothing checked it.
//
// These cases load the gate straight out of server.js (so a rename or a
// rewrite that drops the check fails here instead of quietly opening the
// runner again).
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'npm-hub', 'src', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

const START = '// ─── GATE ─';
const END = 'app.use(express.static(';
const from = source.indexOf(START);
const to = source.indexOf(END);
if (from < 0 || to < 0 || to < from) {
  console.error('FAIL g0 gate block not found in server.js (markers moved?)');
  process.exit(1);
}
const gateBlock = source.slice(from, to);

// A no-op app: the gate registers one middleware, and nothing else in the
// block runs at load time. `require` is passed in because the spare token is
// derived with Node's crypto inside the block.
const app = { use() {} };
const mod = { exports: {} };
try {
  new Function('app', 'module', 'exports', 'require', gateBlock
    + '\n;module.exports = { gateGranted, gateDenySocket, HUB_TOKEN, GATE_COOKIE, SPARE_TOKEN };')(
    app, mod, mod.exports, require);
} catch (e) {
  console.error('FAIL g0 gate block does not evaluate: ' + e.message);
  process.exit(1);
}
const { gateGranted, gateDenySocket, HUB_TOKEN, GATE_COOKIE, SPARE_TOKEN } = mod.exports;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

function req(opts) {
  const o = opts || {};
  return {
    url: o.url || '/',
    method: o.method || 'GET',
    headers: Object.assign({}, o.headers || {}),
    socket: { remoteAddress: o.remoteAddress || '203.0.113.7' },
    get(name) {
      const v = this.headers[String(name).toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    },
  };
}

// ── the token is read from the env, exactly like hub.yml passes it ──
check('g1 token comes from HUB_TOKEN', typeof HUB_TOKEN === 'string' && typeof gateGranted === 'function');
check('g2 no token = no gate (local runs keep working)', gateGranted(req({ url: '/api/fs/list' })) === true);

// The real value has to be injected: the constant above is bound to this
// process' env. Re-evaluate the block with a token set to test the checks.
function loadWith(token) {
  return loadWithEnv({ HUB_TOKEN: token });
}

// The spare entrance is derived from GH_TOKEN + GITHUB_RUN_ID, so those have
// to be injectable too. The block is re-evaluated with the given env and the
// middleware is captured (the no-op app above never runs it).
function loadWithEnv(env, captureMiddleware) {
  const m = { exports: {} };
  let captured = null;
  const targetApp = captureMiddleware ? { use(fn) { captured = fn; } } : app;
  const saved = {};
  for (const k of ['HUB_TOKEN', 'GH_TOKEN', 'GITHUB_RUN_ID']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  try {
    new Function('app', 'module', 'exports', 'require', gateBlock
      + '\n;module.exports = { gateGranted, gateDenySocket, HUB_TOKEN, GATE_COOKIE, SPARE_TOKEN };')(
      targetApp, m, m.exports, require);
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return captureMiddleware ? { exports: m.exports, middleware: captured } : m.exports;
}

const T = 'a'.repeat(32);
const gated = loadWith(T);
check('g3 token is picked up from env', gated.HUB_TOKEN === T, gated.HUB_TOKEN);

check('g4 remote without token is denied', gated.gateGranted(req({ url: '/api/fs/list' })) === false);
check('g5 remote page without token is denied', gated.gateGranted(req({ url: '/m' })) === false);
check('g6 ?zt= grants', gated.gateGranted(req({ url: '/m?zt=' + T })) === true);
check('g7 ?token= grants', gated.gateGranted(req({ url: '/d?token=' + T })) === true);
check('g8 x-hub-token header grants (runner probe)', gated.gateGranted(req({
  url: '/api/tools', headers: { 'x-hub-token': T },
})) === true);
check('g9 cookie grants (SPA after the first ?zt=)', gated.gateGranted(req({
  url: '/api/info', headers: { cookie: 'other=1; ' + gated.GATE_COOKIE + '=' + T + '; z=2' },
})) === true);
check('g10 url-encoded cookie grants', gated.gateGranted(req({
  url: '/api/info', headers: { cookie: gated.GATE_COOKIE + '=' + encodeURIComponent(T) },
})) === true);
check('g11 wrong token denied', gated.gateGranted(req({ url: '/m?zt=' + 'b'.repeat(32) })) === false);
check('g12 empty token denied', gated.gateGranted(req({ url: '/m?zt=' })) === false);
check('g13 prefix of the token denied', gated.gateGranted(req({ url: '/m?zt=' + T.slice(0, 31) })) === false);
check('g14 token as a substring denied', gated.gateGranted(req({ url: '/m?zt=x' + T })) === false);
check('g15 loopback needs no token (runner self-probes)', gated.gateGranted(req({
  url: '/api/tools', remoteAddress: '127.0.0.1',
})) === true);
check('g16 ::ffff:127.0.0.1 is loopback too', gated.gateGranted(req({
  url: '/api/tools', remoteAddress: '::ffff:127.0.0.1',
})) === true);

// The hole this suite missed for as long as the gate has existed: cloudflared
// runs on the same runner and dials 127.0.0.1, so EVERY request off the
// internet also arrives as loopback. g15 and g16 above are exactly the shape
// of an attacker's request, and they passed. A proxy header is what tells the
// two apart - Cloudflare stamps CF-Connecting-IP/CF-Ray on everything it
// forwards, and a local curl has neither.
check('g16b loopback behind a proxy needs the token', gated.gateGranted(req({
  url: '/api/fs/list', remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '203.0.113.9' },
})) === false);
check('g16c x-forwarded-for counts as a proxy too', gated.gateGranted(req({
  url: '/m', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' },
})) === false);
check('g16d an empty remote address is not a free pass', gated.gateGranted(req({
  url: '/m', remoteAddress: '', headers: { 'cf-ray': '8a1b2c3d4e5f6789-LHR' },
})) === false);
check('g16e loopback behind a proxy still opens with the header token', gated.gateGranted(req({
  url: '/api/tools', remoteAddress: '127.0.0.1',
  headers: { 'cf-connecting-ip': '203.0.113.9', 'x-hub-token': T },
})) === true);
check('g16f ...and with the cookie the browser already holds', gated.gateGranted(req({
  url: '/api/tools', remoteAddress: '127.0.0.1',
  headers: { 'cf-connecting-ip': '203.0.113.9', cookie: 'hub_zt=' + T },
})) === true);
check('g16g an empty proxy header is not a proxy', gated.gateGranted(req({
  url: '/api/tools', remoteAddress: '127.0.0.1', headers: { 'cf-connecting-ip': '' },
})) === true);

// Upgrade sockets carry no express getters, so gateGranted has to work off
// req.url/req.headers alone - that is how the /ws gate is invoked.
check('g17 raw upgrade socket (?zt=) grants', gated.gateGranted(req({ url: '/ws?zt=' + T })) === true);
check('g18 raw upgrade socket without token denied', gated.gateGranted(req({ url: '/ws' })) === false);

// A denied socket must answer 401 by hand: a browser cannot render anything
// useful otherwise, and the panel needs the status to say "token rejected".
let written = '', destroyed = false;
const deny = gated.gateDenySocket(req({ url: '/ws' }), {
  write: (s) => { written += s; },
  destroy: () => { destroyed = true; },
});
check('g19 denied socket returns true', deny === true);
check('g20 denied socket answers 401', /^HTTP\/1\.1 401/.test(written), written.slice(0, 40));
check('g21 denied socket is destroyed', destroyed === true);
check('g22 allowed socket passes through', gated.gateDenySocket(req({ url: '/ws?zt=' + T }), {
  write: () => { written += 'SHOULD-NOT-WRITE'; }, destroy: () => { destroyed = 'BAD'; },
}) === false);
check('g23 allowed socket untouched', !written.includes('SHOULD-NOT-WRITE') && destroyed === true);

// ── Spare entrance (запасной вход) ──
// The panel can lose the per-launch token; the spare is a one-way, run-scoped
// hash of the GitHub token it launches with (the server holds the same value:
// hub.yml passes the panel's gh_token input as GH_TOKEN). It must grant like
// the real token, die with the run, and never become a universal key when the
// GitHub token is empty.
const crypto = require('crypto');
const spareOf = (gh, runId) => crypto.createHash('sha256').update(gh + ':hub-spare:' + runId, 'utf8').digest('hex');

const spareGated = loadWithEnv({ HUB_TOKEN: T, GH_TOKEN: 'ghp_x', GITHUB_RUN_ID: '999' });
const SPARE = spareOf('ghp_x', '999');
check('g24 spare token is derived from GH_TOKEN + run id', spareGated.SPARE_TOKEN === SPARE, spareGated.SPARE_TOKEN);
check('g25 ?zt=<spare> grants', spareGated.gateGranted(req({ url: '/m?zt=' + SPARE })) === true);
check('g26 wrong spare denied', spareGated.gateGranted(req({ url: '/m?zt=' + spareOf('ghp_y', '999') })) === false);
check('g27 spare of another run denied', spareGated.gateGranted(req({ url: '/m?zt=' + spareOf('ghp_x', '998') })) === false);
check('g28 spare works for a raw upgrade socket', spareGated.gateDenySocket(req({ url: '/ws?zt=' + SPARE }), {
  write: () => { written += 'SHOULD-NOT-WRITE'; }, destroy: () => { destroyed = 'BAD'; },
}) === false);

// Empty GH_TOKEN must disable the spare entirely: the constant hash of an
// empty string would otherwise be a universal key, and an empty candidate must
// never match an empty secret (gateEquals('','') is true).
const noGh = loadWithEnv({ HUB_TOKEN: T, GH_TOKEN: '', GITHUB_RUN_ID: '999' });
check('g29 empty GH_TOKEN disables the spare', noGh.SPARE_TOKEN === '', noGh.SPARE_TOKEN);
check('g30 empty candidate still denied with the spare disabled', noGh.gateGranted(req({ url: '/m?zt=' })) === false);
check('g31 no run id disables the spare too', loadWithEnv({ HUB_TOKEN: T, GH_TOKEN: 'ghp_x', GITHUB_RUN_ID: '' }).SPARE_TOKEN === '');

// The middleware sets the real run cookie even when the request came in with
// the spare: the browser then holds the proper run-scoped token, not the hash.
const captured = loadWithEnv({ HUB_TOKEN: T, GH_TOKEN: 'ghp_x', GITHUB_RUN_ID: '999' }, true);
let cookieSet = null, nextCalled = false;
captured.middleware(req({ url: '/m?zt=' + SPARE }), {
  cookie(name, val) { cookieSet = [name, val]; },
}, () => { nextCalled = true; });
check('g32 spare entrance sets the real run cookie', cookieSet && cookieSet[0] === 'hub_zt' && cookieSet[1] === T, JSON.stringify(cookieSet));
check('g33 spare entrance passes the middleware', nextCalled === true);

console.log(`HUB-GATE: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
