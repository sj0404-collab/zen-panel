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
// block runs at load time.
const app = { use() {} };
const mod = { exports: {} };
try {
  new Function('app', 'module', 'exports', gateBlock
    + '\n;module.exports = { gateGranted, gateDenySocket, HUB_TOKEN, GATE_COOKIE };')(
    app, mod, mod.exports);
} catch (e) {
  console.error('FAIL g0 gate block does not evaluate: ' + e.message);
  process.exit(1);
}
const { gateGranted, gateDenySocket, HUB_TOKEN, GATE_COOKIE } = mod.exports;

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
  const m = { exports: {} };
  const saved = process.env.HUB_TOKEN;
  process.env.HUB_TOKEN = token;
  try {
    new Function('app', 'module', 'exports', gateBlock
      + '\n;module.exports = { gateGranted, gateDenySocket, HUB_TOKEN, GATE_COOKIE };')(app, m, m.exports);
  } finally {
    if (saved === undefined) delete process.env.HUB_TOKEN; else process.env.HUB_TOKEN = saved;
  }
  return m.exports;
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

console.log(`HUB-GATE: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
