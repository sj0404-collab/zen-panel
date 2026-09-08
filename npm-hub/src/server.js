#!/usr/bin/env node
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const StorageManager = require('./storage/manager');
const ModelManager = require('./models/manager');
const { startTunnel } = require('./tunnel');

const app = express();
const HOME = os.homedir();
const PORT = process.env.PORT || 8090;
const HOST = '0.0.0.0';
const STATE_FILE = path.join(HOME, '.npm-hub-state.json');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── ROUTES: / → launcher, /d → desktop, /m → mobile ───
app.get('/d', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'desktop.html'));
});
app.get('/d/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'desktop.html'));
});
app.get('/m', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'mobile.html'));
});
app.get('/m/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'mobile.html'));
});

// ─── CORS — allow all origins (for phone access) ───
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// npx: the npm package to run through `npx -y` when the command is not on
// PATH. A fresh runner has none of these CLIs pre-installed; the fallback
// is what makes every listed tool launchable with zero pre-installs - the
// first launch downloads it into the npm cache, later launches reuse it.
const TOOLS = [
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', npx: 'opencode-ai', color: '#00d4aa', icon: 'OC' },
  { id: 'ccb', name: 'Claude Code', cmd: 'ccb', color: '#d97706', icon: 'CB' },
  { id: 'koda', name: 'Koda', cmd: 'koda', color: '#8b5cf6', icon: 'KD' },
  { id: 'openclaude', name: 'OpenClaude', cmd: 'openclaude', color: '#06b6d4', icon: 'OC' },
  { id: 'openrouter', name: 'OpenRouter', cmd: 'openrouter', color: '#6366f1', icon: 'OR' },
  { id: 'qwen', name: 'Qwen Code', cmd: 'qwen', npx: '@qwen-code/qwen-code', color: '#ef4444', icon: 'QW' },
  { id: 'http-server', name: 'HTTP Server', cmd: 'http-server', npx: 'http-server', color: '#22c55e', icon: 'HS' },
  { id: 'cli-agent', name: 'CLI Agent', cmd: 'agent', color: '#f59e0b', icon: 'CA' },
  { id: 'claude-npm', name: 'Claude CLI', cmd: 'claude', npx: '@anthropic-ai/claude-code', color: '#c26138', icon: 'CC' },
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', npx: '@google/gemini-cli', color: '#1a73e8', icon: 'GE' },
  { id: 'codex', name: 'Codex CLI', cmd: 'codex', npx: '@openai/codex', color: '#10a37f', icon: 'CX' },
  { id: 'crush', name: 'Crush', cmd: 'crush', color: '#e11d48', icon: 'CR' },
  { id: 'copilot', name: 'Copilot CLI', cmd: 'copilot', npx: '@github/copilot', color: '#6e40c9', icon: 'CP' },
  { id: 'aider', name: 'Aider', cmd: 'aider', color: '#fbbf24', icon: 'AD' },
  { id: 'goose', name: 'Goose', cmd: 'goose', color: '#14b8a6', icon: 'GO' }
];

const storage = new StorageManager();
const modelManager = new ModelManager();

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastDirs: {}, pathHistory: [], recentPaths: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function isInstalled(cmd) {
  const isWin = process.platform === 'win32';
  try {
    require('child_process').execSync(`${isWin ? 'where' : 'which'} ${cmd}`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}
function getVersion(cmd) {
  try { return require('child_process').execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000 }).toString().trim().split('\n')[0]; }
  catch { return null; }
}
// What to actually type into the fresh terminal for a tool: the command
// itself when it is on PATH, otherwise `npx -y <package>` when the tool
// declares one. `-y` never prompts, and the npm cache makes the second
// launch instant.
function resolveToolCmd(tool) {
  if (!tool || !tool.cmd || tool.cmd === '_terminal') return null;
  if (isInstalled(tool.cmd)) return tool.cmd;
  if (tool.npx) return `npx -y ${tool.npx}`;
  return tool.cmd;
}

function getAccessInfo(req) {
  const addr = req.socket.remoteAddress || '';
  const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
  return { ip: addr.replace('::ffff:', ''), isLocal, mode: isLocal ? 'local' : 'remote', hostname: os.hostname() };
}

// Tool presence is expensive to probe: two process spawns per tool plus a
// `--version` boot (a whole Node runtime for the JS CLIs) for every hit.
// On Windows that totals past the runner's 3-second health-check budget,
// so every check timed out and a healthy hub was declared dead. Detect
// once in the background, serve the cache instantly, re-sweep every
// 15 minutes so mid-session installs show up.
let toolsCache = TOOLS.map(t => ({ ...t, installed: false, launchable: !!t.npx, version: null }));
let toolsWarming = true;
function refreshTools() {
  try {
    toolsCache = TOOLS.map(t => {
      const installed = isInstalled(t.cmd);
      return { ...t, installed, launchable: installed || !!t.npx, version: installed ? getVersion(t.cmd) : null };
    });
  } catch { /* keep the last good cache */ }
  toolsWarming = false;
}
setImmediate(refreshTools);
setInterval(refreshTools, 15 * 60 * 1000);

// ─── TOOLS ───
app.get('/api/tools', (req, res) => {
  res.json({ success: true, warming: toolsWarming, tools: toolsCache });
});

// ─── INFO ───
app.get('/api/info', (req, res) => {
  const state = loadState();
  res.json({ home: HOME, platform: process.platform, ...getAccessInfo(req), state });
});

// ─── NETWORKS — all IPs for phone access ───
app.get('/api/networks', (req, res) => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const [name, iface] of Object.entries(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) {
        ips.push({ name, address: cfg.address, url: `http://${cfg.address}:${PORT}` });
      }
    }
  }
  res.json({ success: true, ips, port: +process.env.PORT || PORT, hostname: os.hostname() });
});

// ─── STORAGE ───
app.get('/api/storages', (req, res) => {
  res.json({ success: true, storages: storage.listAll() });
});

app.post('/api/storages/add', (req, res) => {
  storage.addStorage(req.body).then(r => res.json(r)).catch(e => res.json({ success: false, error: e.message }));
});

app.post('/api/storages/remove', (req, res) => {
  storage.removeStorage(req.body.id).then(r => res.json(r)).catch(e => res.json({ success: false, error: e.message }));
});

// ─── DEVICES ───
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await storage.discoverDevices();
    res.json({ success: true, devices });
  } catch (e) {
    res.json({ success: false, error: e.message, devices: [] });
  }
});

// ─── ADB ───
app.post('/api/adb/connect', (req, res) => {
  const { host, port } = req.body;
  const AdbStorage = require('./storage/adb');
  AdbStorage.connectTcp(host, port).then(r => res.json(r)).catch(e => res.json({ success: false, error: e.message }));
});

app.post('/api/adb/disconnect', (req, res) => {
  const AdbStorage = require('./storage/adb');
  AdbStorage.disconnect(req.body.deviceId).then(r => res.json(r)).catch(e => res.json({ success: false, error: e.message }));
});

app.get('/api/adb/info', (req, res) => {
  const deviceId = req.query.device;
  const AdbStorage = require('./storage/adb');
  const adb = new AdbStorage(deviceId);
  adb.getInfo().then(info => res.json({ success: true, info })).catch(e => res.json({ success: false, error: e.message }));
});

// ─── DRIVES ───
app.get('/api/drives', (req, res) => {
  const isWin = process.platform === 'win32';
  if (isWin) {
    try { const drives = require('child_process').execSync('wmic logicaldisk get name', { timeout: 3000 }).toString().trim().split('\n').slice(1).map(l => l.trim()).filter(l => l); res.json({ success: true, drives: drives.map(d => d + '\\') }); } catch { res.json({ success: true, drives: ['C:\\'] }); }
  } else {
    res.json({ success: true, drives: ['/'] });
  }
});

// ─── BROWSE (universal) ───
app.get('/api/browse', async (req, res) => {
  const backendId = req.query.backend || 'local';
  const dirPath = req.query.path || HOME;
  try {
    const backend = storage.get(backendId);
    const result = await backend.list(dirPath);
    res.json({ success: true, ...result, backend: backendId });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── FILE OPERATIONS (universal) ───
app.post('/api/fs/mkdir', async (req, res) => {
  try {
    const backend = storage.get(req.body.backend || 'local');
    await backend.mkdir(req.body.path);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/fs/delete', async (req, res) => {
  try {
    const backend = storage.get(req.body.backend || 'local');
    await backend.delete(req.body.path);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/fs/rename', async (req, res) => {
  try {
    const backend = storage.get(req.body.backend || 'local');
    await backend.rename(req.body.oldPath, req.body.newPath);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/fs/read', async (req, res) => {
  try {
    const backend = storage.get(req.body.backend || 'local');
    const content = await backend.read(req.body.path);
    res.json({ success: true, content });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/fs/write', async (req, res) => {
  try {
    const backend = storage.get(req.body.backend || 'local');
    await backend.write(req.body.path, req.body.content);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/fs/download', async (req, res) => {
  try {
    const backend = storage.get(req.query.backend || 'local');
    const content = await backend.read(req.query.path);
    const filename = path.basename(req.query.path);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fs/upload', async (req, res) => {
  try {
    const backend = storage.get(req.body.backend || 'local');
    await backend.write(req.body.path, req.body.content || '');
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── MODELS ───
app.get('/api/models', (req, res) => {
  const freeOnly = req.query.freeOnly === 'true';
  const models = modelManager.getAllModels(freeOnly);
  res.json({ success: true, models, selected: modelManager.getSelectedModel(), provider: modelManager.getSelectedProvider() });
});

app.get('/api/providers', (req, res) => {
  res.json({ success: true, providers: modelManager.getProviders() });
});

app.get('/api/models/full', (req, res) => {
  const models = modelManager.getModelsFull();
  const providers = modelManager.getProviders();
  res.json({ success: true, models, providers, selected: modelManager.getSelectedModel(), provider: modelManager.getSelectedProvider() });
});

app.post('/api/models/select', (req, res) => {
  const { modelId, providerId } = req.body;
  modelManager.selectModel(modelId, providerId);
  res.json({ success: true, selected: modelId, provider: providerId });
});

app.post('/api/models/key', (req, res) => {
  const { env, key } = req.body;
  modelManager.setKey(env, key);
  res.json({ success: true });
});

// Alias: /api/models/apikey — sets OPENROUTER_API_KEY
app.post('/api/models/apikey', (req, res) => {
  const { apiKey } = req.body;
  if (apiKey) modelManager.setKey('OPENROUTER_API_KEY', apiKey);
  res.json({ success: true });
});

app.post('/api/models/freeonly', (req, res) => {
  const { freeOnly } = req.body;
  modelManager.setFreeOnly(freeOnly);
  res.json({ success: true });
});

app.get('/api/models/current', (req, res) => {
  res.json({ success: true, model: modelManager.getSelectedModel(), apiKey: modelManager.getApiKeyMasked() });
});

app.post('/api/models/refresh', async (req, res) => {
  try { const r = await modelManager.refreshLive(); res.json({ success: true, ...r }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/models/test', async (req, res) => {
  try { const r = await modelManager.testModel(req.body.modelId, req.body.providerId); res.json({ success: true, ...r }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/health', async (req, res) => {
  try {
    const providers = await modelManager.health();
    const mem = process.memoryUsage();
    res.json({ success: true, providers, self: { uptime: Math.round(process.uptime()), rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), sessions: ptys.size, node: process.version, platform: process.platform } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── PATH HISTORY ───
app.post('/api/path-history', (req, res) => {
  const { p } = req.body;
  const state = loadState();
  if (!state.recentPaths) state.recentPaths = [];
  state.recentPaths = state.recentPaths.filter(x => x !== p);
  state.recentPaths.unshift(p);
  if (state.recentPaths.length > 50) state.recentPaths = state.recentPaths.slice(0, 50);
  saveState(state);
  res.json({ success: true, recentPaths: state.recentPaths });
});

app.get('/api/path-history', (req, res) => {
  const state = loadState();
  res.json({ success: true, recentPaths: state.recentPaths || [] });
});

app.post('/api/last-dir', (req, res) => {
  const { toolId, dir } = req.body;
  const state = loadState();
  if (!state.lastDirs) state.lastDirs = {};
  state.lastDirs[toolId] = dir;
  saveState(state);
  res.json({ success: true });
});

app.get('/api/last-dir/:toolId', (req, res) => {
  const state = loadState();
  res.json({ success: true, dir: state.lastDirs?.[req.params.toolId] || HOME });
});

// ─── NGROK TOKEN ───
const NGROK_TOKEN_FILE = path.join(HOME, '.npm-hub-ngrok-token');

app.get('/api/ngrok-token', (req, res) => {
  try {
    const token = fs.existsSync(NGROK_TOKEN_FILE) ? fs.readFileSync(NGROK_TOKEN_FILE, 'utf8').trim() : '';
    res.json({ success: true, token: token ? token.slice(0, 8) + '...' + token.slice(-4) : '' });
  } catch { res.json({ success: true, token: '' }); }
});

app.post('/api/ngrok-token', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.json({ success: false, error: 'No token' });
  try {
    fs.writeFileSync(NGROK_TOKEN_FILE, token.trim(), { mode: 0o600 });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── WEBSOCKET / PTY ───
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const ptys = new Map();

wss.on('connection', (ws) => {
  let currentPty = null;
  let currentId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'open': {
        const tool = TOOLS.find(t => t.id === msg.toolId);
        const isWin = process.platform === 'win32';
        const shell = isWin ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
        const cwd = msg.cwd || HOME;

        try {
          // The hub's own PORT must not leak into terminals: servers honor
          // it (http-server binds $PORT), and the hub already owns that
          // port - the tool would die with EADDRINUSE on the hub itself.
          const { PORT: _hubPort, ...ptyEnv } = process.env;
          ptyEnv.TERM = 'xterm-256color';
          ptyEnv.OPENROUTER_API_KEY = modelManager.getKeyForProvider('openrouter');
          ptyEnv.MODEL = modelManager.getSelectedModel();
          ptyEnv.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
          const p = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: msg.cols || 120,
            rows: msg.rows || 30,
            cwd: cwd,
            env: ptyEnv,
          });
          currentId = msg.sessionId || ('term_' + Date.now());
          currentPty = p;
          ptys.set(currentId, p);

          const cdCmd = isWin ? `cd /d "${cwd}"` : `cd "${cwd}"`;
          p.write(cdCmd + '\r');
          const launch = tool ? resolveToolCmd(tool) : null;
          if (launch) {
            setTimeout(() => { p.write(launch + '\r'); }, 200);
          }

          p.onData((data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', id: currentId, data })); });
          p.onExit(({ exitCode }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', id: currentId, code: exitCode })); ptys.delete(currentId); });
          ws.send(JSON.stringify({ type: 'opened', id: currentId }));
        } catch (err) { ws.send(JSON.stringify({ type: 'error', error: err.message })); }
        break;
      }
      case 'input': { if (currentPty) currentPty.write(msg.data); break; }
      case 'resize': { if (currentPty && msg.cols && msg.rows) currentPty.resize(msg.cols, msg.rows); break; }
      case 'kill': {
        if (!currentPty) break;
        if (process.platform === 'win32') {
          currentPty.write('\x03');
        } else {
          currentPty.kill(msg.signal || 'SIGINT');
        }
        break;
      }
      case 'close': { if (currentPty) { currentPty.kill(); ptys.delete(currentId); currentPty = null; } break; }
    }
  });
  ws.on('close', () => { if (currentPty) { currentPty.kill(); ptys.delete(currentId); } });
});

// ─── TUNNEL STATE ───
let tunnelInfo = null; // { url, type, close }

// ─── START ───
function tryListen(port, onReady) {
  const srv = server.listen(port, HOST, () => onReady(port, srv));
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  ⚠ Port ${port} is busy, trying ${port + 1}...`);
      tryListen(port + 1, onReady);
    } else {
      console.error(`  ❌ Server error: ${err.message}`);
      process.exit(1);
    }
  });
}

function onReady(actualPort) {
  // Update PORT global for all routes/display
  process.env.PORT = actualPort;

  const nets = os.networkInterfaces();
  const allIPs = [];
  for (const [name, iface] of Object.entries(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) {
        allIPs.push({ name, ip: cfg.address });
      }
    }
  }
  console.log(`\n  ◆ NPM Hub running on port ${actualPort}:`);
  console.log(`    Local:   http://localhost:${actualPort}`);
  if (allIPs.length > 0) {
    console.log(`    Network:`);
    for (const { name, ip } of allIPs) {
      console.log(`      ${ip}:${actualPort}  (${name})`);
    }
  }

  // Tunnel mode
  const tunnelType = process.argv.find(a => a.startsWith('--tunnel='))?.split('=')[1]
    || (process.argv.includes('--tunnel') ? process.argv[process.argv.indexOf('--tunnel') + 1] : null);

  if (tunnelType) {
    console.log(`\n  🔗 Starting ${tunnelType} tunnel...`);
    startTunnel(actualPort, tunnelType).then((result) => {
      if (result.url) {
        tunnelInfo = { url: result.url, type: result.type, close: result.close };
        console.log(`  🌐 Public:  ${result.url}`);
        console.log(`  📋 Type:    ${result.type}\n`);
      } else {
        console.log(`  ❌ Tunnel error: ${result.error}\n`);
      }
    });
  } else {
    console.log('');
  }

  if (process.platform === 'win32') { try { require('child_process').exec(`start http://localhost:${actualPort}`); } catch {} }

  // Live catalogues: refresh on start, then every 30 minutes.
  modelManager.refreshLive()
    .then(r => console.log('  Live models:', Object.entries(r.added).map(([k, v]) => `${k}+${v}`).join(', ') || 'cached', Object.keys(r.errors).length ? `(errors: ${Object.keys(r.errors).join(',')})` : ''))
    .catch(() => {});
  setInterval(() => { modelManager.refreshLive().catch(() => {}); }, 30 * 60 * 1000);
}

tryListen(PORT, onReady);

// ─── TUNNEL API ───
app.get('/api/tunnel', (req, res) => {
  if (tunnelInfo && tunnelInfo.url) {
    res.json({ success: true, url: tunnelInfo.url, type: tunnelInfo.type });
  } else {
    res.json({ success: false, url: null, type: null });
  }
});

process.on('SIGINT', () => {
  ptys.forEach(p => p.kill());
  if (tunnelInfo && tunnelInfo.close) tunnelInfo.close();
  server.close();
  process.exit(0);
});
