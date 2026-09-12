#!/usr/bin/env node
/**
 * Tunnel manager — ngrok / localtunnel / cloudflare
 * Usage: startTunnel(port, 'ngrok'|'localtunnel'|'cloudflare')
 * Returns: { url: string, close: fn } or { error: string }
 */
const { execSync, spawn } = require('child_process');
const http = require('http');

const IS_WIN = process.platform === 'win32';
const path = require('path');
const fs = require('fs');

// ─── NGROK TOKEN ───
const NGROK_TOKEN_FILE = path.join(require('os').homedir(), '.npm-hub-ngrok-token');

function loadNgrokToken() {
  try {
    if (fs.existsSync(NGROK_TOKEN_FILE)) {
      return fs.readFileSync(NGROK_TOKEN_FILE, 'utf8').trim();
    }
  } catch {}
  return null;
}

function saveNgrokToken(token) {
  try {
    fs.writeFileSync(NGROK_TOKEN_FILE, token, { mode: 0o600 });
    return true;
  } catch { return false; }
}

function findBin(name) {
  try {
    execSync(`${IS_WIN ? 'where' : 'which'} ${name}`, { stdio: 'ignore', timeout: 3000 });
    return name;
  } catch { return null; }
}

function spawnTunnel(args, urlRegex, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(args[0], args.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: IS_WIN,
      ...opts
    });
    let url = null;
    let resolved = false;
    let output = '';

    const done = (u) => {
      if (!resolved) {
        resolved = true;
        resolve({ url: u, close: () => { try { proc.kill(); } catch {} } });
      }
    };
    const fail = (e) => {
      if (!resolved) {
        resolved = true;
        resolve({ error: e });
      }
    };

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      const m = text.match(urlRegex);
      if (m && !url) { url = m[1]; done(url); }
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      const m = text.match(urlRegex);
      if (m && !url) { url = m[1]; done(url); }
    });
    proc.on('error', (e) => fail(`spawn error: ${e.message}`));
    proc.on('exit', (code) => {
      if (!resolved) {
        // Check output one more time
        const m = output.match(urlRegex);
        if (m) { url = m[1]; return done(url); }
        fail(`exited code ${code}`);
      }
    });
  });
}

// ─── NGROK ───
async function startNgrok(port) {
  const bin = findBin('ngrok');
  if (!bin) return { error: 'ngrok not found.\nInstall: https://ngrok.com/download\nOr: choco install ngrok\nOr: scoop install ngrok' };

  // Build args with optional token
  const ngrokToken = process.env.NGROK_AUTHTOKEN || loadNgrokToken();
  const ngrokArgs = ngrokToken
    ? [bin, 'http', String(port), '--log=stdout', `--authtoken=${ngrokToken}`]
    : [bin, 'http', String(port), '--log=stdout'];

  const result = await spawnTunnel(
    ngrokArgs,
    /url=(https:\/\/[^\s]+)/
  );

  if (result.url) {
    return { url: result.url, type: 'ngrok', close: result.close };
  }

  // Fallback: query ngrok API
  try {
    const apiUrl = 'http://127.0.0.1:4040/api/tunnels';
    const apiResult = await new Promise((resolve) => {
      const req = http.get(apiUrl, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            const u = j.tunnels?.[0]?.public_url;
            resolve(u);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
    if (apiResult) return { url: apiResult, type: 'ngrok', close: () => {} };
  } catch {}

  return { error: result.error || 'ngrok failed. Check: ngrok http ' + port };
}

// ─── LOCALTUNNEL ───
async function startLocaltunnel(port) {
  // Try global install first, then npx
  const bin = findBin('lt');

  if (bin) {
    const result = await spawnTunnel(
      [bin, '--port', String(port)],
      /(https:\/\/[a-zA-Z0-9\-]+\.loca\.lt)/
    );
    if (result.url) return { url: result.url, type: 'localtunnel', close: result.close };
  }

  // Try npx
  const result = await spawnTunnel(
    ['npx', '--yes', 'localtunnel', '--port', String(port)],
    /(https:\/\/[a-zA-Z0-9\-]+\.loca\.lt)/
  );

  if (result.url) return { url: result.url, type: 'localtunnel', close: result.close };

  return {
    error: `localtunnel failed.\nTry: npm install -g localtunnel\nThen: lt --port ${port}\nOr check internet connection.`
  };
}

// ─── CLOUDFLARE (cloudflared) ───
async function startCloudflare(port) {
  const bin = findBin('cloudflared');
  if (!bin) return {
    error: 'cloudflared not found.\nInstall: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\nOr: choco install cloudflared\nOr: scoop install cloudflared'
  };

  const result = await spawnTunnel(
    [bin, 'tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    /(https:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com)/
  );

  if (result.url) return { url: result.url, type: 'cloudflare', close: result.close };

  return { error: result.error || 'cloudflared failed. Check: cloudflared tunnel --url http://localhost:' + port };
}

// ─── MAIN ───
async function startTunnel(port, type) {
  switch (type) {
    case 'ngrok': return startNgrok(port);
    case 'localtunnel': return startLocaltunnel(port);
    case 'cloudflare': return startCloudflare(port);
    default: return { error: `Unknown tunnel type: ${type}. Use: ngrok | localtunnel | cloudflare` };
  }
}

module.exports = { startTunnel };
