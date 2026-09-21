#!/usr/bin/env node
/**
 * Tunnel manager — ngrok / localtunnel / cloudflare.
 *
 * A tunnel URL is not considered ready just because cloudflared printed it.
 * Quick tunnels announce their hostname before the Cloudflare edge has a
 * connector, which is the short window in which visitors get Error 1033.
 * Cloudflare quick-tunnel hostnames are also ephemeral, so a dead connector
 * must never be returned as a live URL by the hub.
 *
 * Usage: startTunnel(port, 'ngrok'|'localtunnel'|'cloudflare')
 * Returns: { url, type, close, onExit } or { error }
 */
const { execSync, spawn, execFile } = require('child_process');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const START_TIMEOUT_MS = 120000;
const CLOUDFLARE_READY_TIMEOUT_MS = 90000;
const CLOUDFLARE_PROBE_TIMEOUT_MS = 8000;

// ─── helpers ───────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function findBin(name) {
  try {
    execSync(`${IS_WIN ? 'where' : 'which'} ${name}`, { stdio: 'ignore', timeout: 3000 });
    return name;
  } catch {
    return null;
  }
}

function terminate(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  try {
    if (IS_WIN && proc.pid) {
      // cloudflared is sometimes started through cmd.exe on Windows. Killing
      // only cmd leaves the connector alive and the next start races it.
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      proc.kill('SIGTERM');
    }
  } catch {}
}

function error1033(status, body) {
  return status === 530 || /\b1033\b|error\s*code\s*:\s*1033/i.test(String(body || ''));
}

/**
 * Probe the public URL without treating a Cloudflare error page as success.
 * 401/403/404 are valid here: they prove that the request reached the local
 * application through the tunnel. 5xx and Error 1033 mean the connector is
 * not ready (or has gone away).
 */
function probePublicUrl(url, timeoutMs = CLOUDFLARE_PROBE_TIMEOUT_MS, redirects = 0) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, error: 'invalid public URL' }); }
    if (!/^https?:$/.test(parsed.protocol)) return resolve({ ok: false, error: 'unsupported public URL' });

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, {
      headers: { 'user-agent': 'zen-panel-tunnel-health/1' },
      timeout: timeoutMs
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        // The body is only used to identify the Cloudflare error page. Do not
        // retain an entire HTML response in a long-running hub process.
        if (body.length < 65536) body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
          const next = new URL(res.headers.location, parsed).toString();
          probePublicUrl(next, timeoutMs, redirects + 1).then(resolve);
          return;
        }
        const status = Number(res.statusCode || 0);
        resolve({
          ok: status >= 200 && status < 500 && !error1033(status, body),
          status,
          body
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', err => resolve({ ok: false, error: err.message }));
  });
}

async function waitForPublicUrl(url, isAlive, timeoutMs = CLOUDFLARE_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = 'edge is still starting';
  while (Date.now() < deadline) {
    if (typeof isAlive === 'function' && !isAlive()) {
      return { ok: false, error: 'cloudflared exited before the edge became ready' };
    }
    const probe = await probePublicUrl(url);
    if (probe.ok) return probe;
    last = probe.status ? `HTTP ${probe.status}` : (probe.error || last);
    await sleep(2000);
  }
  return { ok: false, error: `public edge did not become ready (${last})` };
}

/**
 * Start a child and wait for a URL in either stdout or stderr. The returned
 * object also exposes lifecycle hooks so the server can remove a URL as soon
 * as the connector exits instead of keeping a dead 1033 link in the UI.
 */
function spawnTunnel(args, urlRegex, opts = {}) {
  const { timeoutMs: requestedTimeout, ...spawnOpts } = opts;
  const timeoutMs = Number(requestedTimeout || START_TIMEOUT_MS);
  return new Promise(resolve => {
    let proc;
    try {
      proc = spawn(args[0], args.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: IS_WIN,
        ...spawnOpts
      });
    } catch (err) {
      resolve({ error: `spawn error: ${err.message}` });
      return;
    }

    let output = '';
    let settled = false;
    let intentional = false;
    let exited = false;
    let exitCode = null;
    let exitSignal = null;
    const exitListeners = [];
    let timer;

    const kill = () => terminate(proc);
    const fail = message => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      resolve({ error: message, output: output.slice(-12000) });
    };
    const finish = url => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        url,
        close: () => {
          intentional = true;
          kill();
        },
        onExit: fn => {
          if (typeof fn !== 'function') return () => {};
          if (exited) setImmediate(() => fn({ code: exitCode, signal: exitSignal, intentional }));
          else exitListeners.push(fn);
          return () => {
            const i = exitListeners.indexOf(fn);
            if (i >= 0) exitListeners.splice(i, 1);
          };
        },
        isAlive: () => !exited && proc.exitCode === null && !proc.signalCode,
        pid: proc.pid
      };
      resolve(result);
    };
    const scan = chunk => {
      output = (output + String(chunk)).slice(-120000);
      const match = output.match(urlRegex);
      if (match && match[1]) finish(match[1]);
    };

    timer = setTimeout(() => fail(`timed out waiting for tunnel address (${Math.round(timeoutMs / 1000)}s)`), timeoutMs);
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('error', err => fail(`spawn error: ${err.message}`));
    proc.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (!settled) {
        fail(`tunnel exited before reporting an address (code ${code || 0}${signal ? `, ${signal}` : ''})`);
        return;
      }
      const info = { code, signal, intentional };
      for (const fn of exitListeners.splice(0)) {
        try { fn(info); } catch {}
      }
    });
  });
}

// ─── NGROK ─────────────────────────────────────────────────────────
const NGROK_TOKEN_FILE = path.join(os.homedir(), '.npm-hub-ngrok-token');

function loadNgrokToken() {
  try {
    if (fs.existsSync(NGROK_TOKEN_FILE)) return fs.readFileSync(NGROK_TOKEN_FILE, 'utf8').trim();
  } catch {}
  return null;
}

function saveNgrokToken(token) {
  try {
    fs.writeFileSync(NGROK_TOKEN_FILE, token, { mode: 0o600 });
    return true;
  } catch { return false; }
}

async function startNgrok(port) {
  const bin = findBin('ngrok');
  if (!bin) return { error: 'ngrok not found.\nInstall: https://ngrok.com/download\nOr: choco install ngrok\nOr: scoop install ngrok' };

  const ngrokToken = process.env.NGROK_AUTHTOKEN || loadNgrokToken();
  const ngrokArgs = ngrokToken
    ? [bin, 'http', String(port), '--log=stdout', `--authtoken=${ngrokToken}`]
    : [bin, 'http', String(port), '--log=stdout'];
  const result = await spawnTunnel(ngrokArgs, /url=(https:\/\/[^\s]+)/, { timeoutMs: 45000 });
  if (result.url) return {
    url: result.url, type: 'ngrok', close: result.close,
    onExit: result.onExit, isAlive: result.isAlive,
    healthCheck: () => probePublicUrl(result.url)
  };

  // Some ngrok versions do not print the URL even though their local API is
  // available. Preserve that fallback, but still health-check the URL before
  // exposing it to the panel.
  try {
    const apiResult = await new Promise(resolve => {
      const req = http.get('http://127.0.0.1:4040/api/tunnels', res => {
        let body = '';
        res.on('data', d => { if (body.length < 65536) body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body).tunnels?.[0]?.public_url || null); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
    if (apiResult) {
      const health = await probePublicUrl(apiResult);
      if (health.ok) return {
        url: apiResult, type: 'ngrok', close: () => {},
        healthCheck: () => probePublicUrl(apiResult)
      };
    }
  } catch {}
  return { error: result.error || 'ngrok failed. Check: ngrok http ' + port };
}

// ─── LOCALTUNNEL ──────────────────────────────────────────────────
async function startLocaltunnel(port) {
  const bin = findBin('lt');
  if (bin) {
    const result = await spawnTunnel([bin, '--port', String(port)], /(https:\/\/[a-zA-Z0-9-]+\.loca\.lt)/, { timeoutMs: 90000 });
    if (result.url) return {
      url: result.url, type: 'localtunnel', close: result.close,
      onExit: result.onExit, isAlive: result.isAlive,
      healthCheck: () => probePublicUrl(result.url)
    };
  }

  const result = await spawnTunnel(['npx', '--yes', 'localtunnel', '--port', String(port)], /(https:\/\/[a-zA-Z0-9-]+\.loca\.lt)/, { timeoutMs: 120000 });
  if (result.url) return {
    url: result.url, type: 'localtunnel', close: result.close,
    onExit: result.onExit, isAlive: result.isAlive,
    healthCheck: () => probePublicUrl(result.url)
  };
  return {
    error: `localtunnel failed.\nTry: npm install -g localtunnel\nThen: lt --port ${port}\nOr check internet connection.`
  };
}

// ─── CLOUDFLARE (cloudflared) ─────────────────────────────────────
async function startCloudflare(port) {
  const n = validPort(port);
  if (!n) return { error: `invalid local port: ${port}` };
  const bin = findBin('cloudflared');
  if (!bin) return {
    error: 'cloudflared not found.\nInstall: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\nOr: choco install cloudflared\nOr: scoop install cloudflared'
  };

  // 127.0.0.1 is deliberate. On some Windows hosts localhost resolves to
  // ::1 first while the application is listening on IPv4 only; that gives the
  // tunnel a healthy process but a dead origin and eventually a 1033/502 page.
  const origin = `http://127.0.0.1:${n}`;
  const result = await spawnTunnel(
    [bin, 'tunnel', '--url', origin, '--no-autoupdate', '--loglevel', 'info'],
    /(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/,
    { timeoutMs: START_TIMEOUT_MS }
  );
  if (!result.url) return { error: result.error || `cloudflared failed. Check: cloudflared tunnel --url ${origin}` };

  // Printing a hostname is not the same as having a connector. Do not expose
  // it to the UI/workflow until a real request reaches the local application.
  const ready = await waitForPublicUrl(result.url, result.isAlive, CLOUDFLARE_READY_TIMEOUT_MS);
  if (!ready.ok) {
    result.close();
    return {
      error: `Cloudflare tunnel did not become reachable: ${ready.error}. ` +
        'The old trycloudflare.com address must not be reused (Error 1033).'
    };
  }

  return {
    url: result.url,
    type: 'cloudflare',
    close: result.close,
    onExit: result.onExit,
    isAlive: result.isAlive,
    healthCheck: () => probePublicUrl(result.url)
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────
async function startTunnel(port, type) {
  switch (type) {
    case 'ngrok': return startNgrok(port);
    case 'localtunnel': return startLocaltunnel(port);
    case 'cloudflare': return startCloudflare(port);
    default: return { error: `Unknown tunnel type: ${type}. Use: ngrok | localtunnel | cloudflare` };
  }
}

module.exports = {
  startTunnel,
  // Exported for the small regression tests and for the shell launcher to
  // share the exact Error 1033 definition.
  probePublicUrl,
  waitForPublicUrl,
  _test: { error1033, validPort }
};
