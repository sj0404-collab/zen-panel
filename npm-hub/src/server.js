#!/usr/bin/env node
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const StorageManager = require('./storage/manager');
const ModelManager = require('./models/manager');
const { startTunnel } = require('./tunnel');

const app = express();
const HOME = os.homedir();
const WORK_DIR = path.join(HOME, 'hub-work');
try { fs.mkdirSync(WORK_DIR, { recursive: true }); } catch {}
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

const TOOLS = [
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', pkg: 'opencode-ai', color: '#00d4aa', icon: 'OC' },
  { id: 'ccb', name: 'Claude Code', cmd: 'ccb', pkg: null, color: '#d97706', icon: 'CB' },
  { id: 'koda', name: 'Koda', cmd: 'koda', pkg: null, color: '#8b5cf6', icon: 'KD' },
  { id: 'openclaude', name: 'OpenClaude', cmd: 'openclaude', pkg: null, color: '#06b6d4', icon: 'OC' },
  { id: 'openrouter', name: 'OpenRouter', cmd: 'openrouter', pkg: null, color: '#6366f1', icon: 'OR' },
  { id: 'qwen', name: 'Qwen Code', cmd: 'qwen', pkg: '@qwen-code/qwen-code', color: '#ef4444', icon: 'QW' },
  { id: 'http-server', name: 'HTTP Server', cmd: 'http-server', pkg: 'http-server', color: '#22c55e', icon: 'HS' },
  { id: 'cli-agent', name: 'CLI Agent', cmd: 'agent', pkg: null, color: '#f59e0b', icon: 'CA' },
  { id: 'claude', name: 'Claude Code', cmd: 'claude', pkg: '@anthropic-ai/claude-code', color: '#d97706', icon: 'CC' },
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', pkg: '@google/gemini-cli', color: '#58a6ff', icon: 'GE' },
  { id: 'codex', name: 'Muse', cmd: 'codex', pkg: '@openai/codex', color: '#e6e6e6', icon: 'CX' },
  { id: 'copilot', name: 'Copilot CLI', cmd: 'copilot', pkg: '@github/copilot', color: '#bc8cff', icon: 'CP' },
  { id: 'amp', name: 'Amp', cmd: 'amp', pkg: '@sourcegraph/amp', color: '#f778ba', icon: 'AM' },
  { id: 'codebuff', name: 'Codebuff', cmd: 'codebuff', pkg: 'codebuff', color: '#ffd602', icon: 'CF' },
  { id: 'claude-flow', name: 'Claude Flow', cmd: 'claude-flow', pkg: 'claude-flow', color: '#ff9e64', icon: 'FL' },
  { id: 'elizaos', name: 'ElizaOS', cmd: 'elizaos', pkg: '@elizaos/cli', color: '#7ee787', icon: 'EO' },
  { id: 'how2', name: 'how2', cmd: 'how2', pkg: 'how2', color: '#a5d6ff', icon: 'H2' },
  { id: 'ai-shell', name: 'AI Shell', cmd: 'ais', pkg: 'ai-shell', color: '#ffa657', icon: 'AS' },
  { id: 'auggie', name: 'Auggie', cmd: 'auggie', pkg: '@augmentcode/auggie', color: '#79c0ff', icon: 'AU' },
  { id: 'droid', name: 'Droid', cmd: 'droid', pkg: 'droid', color: '#56d4dd', icon: 'DR' },
  { id: 'mistral', name: 'Mistral CLI', cmd: 'mi', pkg: 'mistral-cli', color: '#ff7b72', icon: 'MI' },
  { id: 'n8n', name: 'n8n', cmd: 'n8n', pkg: 'n8n', color: '#ea4b71', icon: 'N8' },
  { id: 'smithery', name: 'Smithery', cmd: 'smithery', pkg: 'smithery', color: '#d2a8ff', icon: 'SM' },
  { id: 'mcp-inspector', name: 'MCP Inspector', cmd: 'mcp-inspector', pkg: '@modelcontextprotocol/inspector', color: '#8b949e', icon: 'MC' }
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

function getAccessInfo(req) {
  const addr = req.socket.remoteAddress || '';
  const isLocal = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
  return { ip: addr.replace('::ffff:', ''), isLocal, mode: isLocal ? 'local' : 'remote', hostname: os.hostname() };
}

// ─── TOOLS ───
app.get('/api/tools', (req, res) => {
  const tools = TOOLS.map(t => ({ ...t, installed: isInstalled(t.cmd), version: null }));
  for (const t of tools) if (t.installed) t.version = getVersion(t.cmd);
  res.json({ success: true, warming: false, tools });
});

// ─── TOOL INSTALL — one at a time, live log via polling ───
const installs = new Map(); // id -> { status, log, code }
app.post('/api/tools/install', (req, res) => {
  const t = TOOLS.find(x => x.id === (req.body && req.body.id));
  if (!t || !t.pkg) return res.json({ success: false, error: 'у этого инструмента нет npm-пакета' });
  const cur = installs.get(t.id);
  if (cur && cur.status === 'running') return res.json({ success: true, status: 'running' });
  for (const s of installs.values()) {
    if (s.status === 'running') return res.json({ success: false, error: 'уже идёт другая установка — дождись' });
  }
  const st = { status: 'running', log: '', code: null };
  installs.set(t.id, st);
  const push = d => {
    st.log += String(d);
    if (st.log.length > 200000) st.log = st.log.slice(-200000);
  };
  push('$ npm install -g ' + t.pkg + '\n');
  let child;
  try {
    child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '-g', '--no-audit', '--no-fund', t.pkg],
      { shell: process.platform === 'win32' });
  } catch (e) { st.status = 'error'; push('\n✗ ' + e.message + '\n'); return res.json({ success: true, status: 'error' }); }
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', e => { st.status = 'error'; push('\n✗ ' + e.message + '\n'); });
  child.on('close', code => {
    st.code = code;
    st.status = code === 0 ? 'done' : 'error';
    push(code === 0 ? '\n✓ готово\n' : '\n✗ ошибка, код ' + code + '\n');
  });
  res.json({ success: true, status: 'running' });
});
app.get('/api/tools/install-status', (req, res) => {
  const t = TOOLS.find(x => x.id === req.query.id);
  if (!t) return res.json({ success: false, error: 'нет такого инструмента' });
  const st = installs.get(t.id) || { status: 'idle', log: '' };
  const from = Math.max(0, parseInt(req.query.from || '0', 10) || 0);
  res.json({ success: true, status: st.status, log: st.log.slice(from), len: st.log.length, installed: isInstalled(t.cmd) });
});

// ─── INFO ───
app.get('/api/info', (req, res) => {
  const state = loadState();
  res.json({ home: HOME, workDir: WORK_DIR, platform: process.platform, ...getAccessInfo(req), state });
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

app.post('/api/fs/upload', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  try {
    const backend = storage.get(req.body.backend || 'local');
    const filePath = req.body.path;
    await backend.write(filePath, req.body.toString());
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
  res.json({ success: true, model: modelManager.getSelectedModel(), apiKey: modelManager.getApiKey() });
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

// ─── ARCHIVE: tar.xz / tar.gz download ────────────────────────────────
// GET /api/fs/archive?path=/some/dir  → streams <basename>.tar.xz
// Falls back to .tar.gz when the system tar has no xz support.
app.get('/api/fs/archive', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'path not found' });
  const stat = fs.statSync(filePath);
  const basename = path.basename(filePath);
  const isDir = stat.isDirectory();

  const { spawn } = require('child_process');
  const tryXz = (resolve) => {
    const ext = 'tar.xz';
    const contentType = 'application/x-xz';
    const name = basename + '.' + ext;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', '0');          // streaming, unknown size
    res.removeHeader('Content-Length');             // remove the misleading 0

    let child;
    const dir = isDir ? path.dirname(filePath) : path.dirname(filePath);
    const target = isDir ? path.basename(filePath) : path.basename(filePath);
    try {
      child = spawn('tar', ['-cJf', '-', target], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve(false); return; }
    child.stdout.pipe(res);
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(true));
    req.on('close', () => { try { child.kill(); } catch {} });
  };

  const tryGz = (resolve) => {
    const ext = 'tar.gz';
    const contentType = 'application/gzip';
    const name = basename + '.' + ext;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    const dir = isDir ? path.dirname(filePath) : path.dirname(filePath);
    const target = isDir ? path.basename(filePath) : path.basename(filePath);
    let child;
    try {
      child = spawn('tar', ['-czf', '-', target], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve(false); return; }
    child.stdout.pipe(res);
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(true));
    req.on('close', () => { try { child.kill(); } catch {} });
  };

  new Promise(tryXz).then(ok => { if (!ok) new Promise(tryGz); });
});

// ─── GITHUB SAVE (session-state branch) ───────────────────────────────
// POST /api/gh/save  { path: "/tmp/foo.apk" }
// Saves the file to the session-state branch under artifacts/<filename>
// using the GitHub Contents API. Requires GH_TOKEN env or PAT in body.
app.post('/api/gh/save', express.json({ limit: '10mb' }), async (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath || !fs.existsSync(filePath)) return res.json({ success: false, error: 'path not found' });
  const token = process.env.GH_TOKEN || (req.body && req.body.token) || '';
  if (!token) return res.json({ success: false, error: 'GH_TOKEN not set; pass token in body or set env' });

  const repo = process.env.GITHUB_REPOSITORY || 'sj0404-collab/zen-panel';
  const branch = 'session-state';
  const basename = path.basename(filePath);
  const target = `artifacts/${basename}`;
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${target}`;

  try {
    const data = fs.readFileSync(filePath);
    const content = data.toString('base64');
    // Check if file exists (to get sha for overwrite)
    let sha = '';
    try {
      const existing = await fetch(apiUrl + `?ref=${branch}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      });
      if (existing.ok) { const j = await existing.json(); sha = j.sha || ''; }
    } catch {}

    const body = { message: `save ${basename} (${new Date().toISOString()})`, content, branch };
    if (sha) body.sha = sha;

    const result = await fetch(apiUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!result.ok) {
      const errText = await result.text().catch(() => '');
      return res.json({ success: false, error: `GitHub API ${result.status}: ${errText.slice(0, 200)}` });
    }

    const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${target}`;
    return res.json({ success: true, url: rawUrl, api_url: apiUrl });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// GET /api/gh/artifacts — list files in artifacts/ on session-state branch
app.get('/api/gh/artifacts', async (req, res) => {
  const token = process.env.GH_TOKEN || '';
  if (!token) return res.json({ success: true, files: [] });
  const repo = process.env.GITHUB_REPOSITORY || 'sj0404-collab/zen-panel';
  const branch = 'session-state';
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/contents/artifacts?ref=${branch}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!r.ok) return res.json({ success: true, files: [] });
    const items = await r.json();
    const files = (Array.isArray(items) ? items : []).map(i => ({
      name: i.name, size: i.size, url: i.download_url, sha: i.sha
    }));
    return res.json({ success: true, files });
  } catch { return res.json({ success: true, files: [] }); }
});

// ─── WEBSOCKET / PTY ───
// Sessions survive a dropped connection: losing the phone does NOT kill the
// terminal. The PTY keeps running in the background, its output is buffered,
// and any client that returns with the same sessionId resumes the live
// terminal instead of starting a new one. Sessions end only when the process
// exits on its own, the user sends `kill`, or the runner itself stops.
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sessions = new Map(); // sessionId -> { id, pty, cwd, toolId, clients:Set, output, resumed }

const ptySend = (session, message) => {
  const payload = JSON.stringify(message);
  for (const client of [...session.clients]) {
    if (client.readyState === 1) client.send(payload); else session.clients.delete(client);
  }
};

const attachPtyClient = (session, ws) => {
  session.clients.add(ws);
  ws.send(JSON.stringify({ type: 'opened', id: session.id, resumed: session.resumed }));
  if (session.output) ws.send(JSON.stringify({ type: 'output', id: session.id, data: session.output, replay: true }));
};

const detachPtyClient = (session, ws) => {
  if (!session) return;
  session.clients.delete(ws);
};

wss.on('connection', (ws) => {
  let session = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'open': {
        const id = msg.sessionId || ('term_' + Date.now());
        const existing = sessions.get(id);
        if (existing) {
          session = existing;
          session.resumed = true;
          attachPtyClient(session, ws);
          return;
        }
        const tool = TOOLS.find(t => t.id === msg.toolId);
        const isWin = process.platform === 'win32';
        const shell = isWin ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
        let cwd = msg.cwd || HOME;
        try { if (!fs.statSync(cwd).isDirectory()) cwd = HOME; } catch { cwd = HOME; }

        try {
          const p = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: msg.cols || 120,
            rows: msg.rows || 30,
            cwd: cwd,
            env: { ...process.env, TERM: 'xterm-256color', OPENROUTER_API_KEY: modelManager.getKeyForProvider('openrouter'), MODEL: modelManager.getSelectedModel(), OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' }
          });
          session = { id, pty: p, cwd, toolId: tool ? tool.id : null, clients: new Set(), output: '', resumed: false };
          sessions.set(id, session);

          const cdCmd = isWin ? `cd /d "${cwd}"` : `cd "${cwd}"`;
          p.write(cdCmd + '\r');
          if (tool && tool.cmd && tool.cmd !== '_terminal') {
            setTimeout(() => { p.write(tool.cmd + '\r'); }, 200);
          }

          p.onData((data) => {
            session.output = (session.output + data).slice(-262144);
            ptySend(session, { type: 'output', id: session.id, data });
          });
          p.onExit(({ exitCode }) => {
            ptySend(session, { type: 'exit', id: session.id, code: exitCode });
            sessions.delete(session.id);
          });
          attachPtyClient(session, ws);
        } catch (err) { ws.send(JSON.stringify({ type: 'error', error: err.message })); }
        return;
      }
      case 'input': { if (session) session.pty.write(msg.data); return; }
      case 'resize': { if (session && msg.cols && msg.rows) session.pty.resize(msg.cols, msg.rows); return; }
      case 'kill': {
        if (!session) return;
        if (process.platform === 'win32') {
          session.pty.write('\x03');
        } else {
          session.pty.kill(msg.signal || 'SIGINT');
        }
        return;
      }
      case 'close': { detachPtyClient(session, ws); return; }
    }
  });
  ws.on('close', () => detachPtyClient(session, ws));
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

  try { require('child_process').exec(`start http://localhost:${actualPort}`); } catch {}
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
  sessions.forEach(s => { try { s.pty.kill(); } catch {} });
  if (tunnelInfo && tunnelInfo.close) tunnelInfo.close();
  server.close();
  process.exit(0);
});
