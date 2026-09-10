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

// ── tool metadata: local = offline via Ollama/llama.cpp; free = no paid API key needed; keyEnv = env var required for runtime ──
const TOOLS = [
  // ── free / local — работают без ключей или через локальные модели ──
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', pkg: 'opencode-ai', color: '#00d4aa', icon: 'OC', local: true, free: true, keyEnv: null },
  { id: 'aider', name: 'Aider', cmd: 'aider', pkg: null, color: '#79c0ff', icon: 'AD', local: true, free: true, keyEnv: null, hint: 'pip install aider-chat' },
  { id: 'openclaw', name: 'OpenClaw', cmd: 'openclaw', pkg: 'openclaw', color: '#f2c66d', icon: 'CW', local: true, free: true, keyEnv: null },
  { id: 'continue', name: 'Continue CLI', cmd: 'cn', pkg: '@continuedev/cli', color: '#d2a8ff', icon: 'CN', local: true, free: true, keyEnv: null },
  { id: 'aish', name: 'AI Shell (offline)', cmd: 'aish', pkg: '@offline-ai/ai-shell', color: '#a5d6ff', icon: 'AH', local: true, free: true, keyEnv: null },
  { id: 'forge', name: 'Forge Code', cmd: 'forge', pkg: 'forge-code-ai', color: '#ffa657', icon: 'FO', local: true, free: true, keyEnv: null },
  { id: 'utim', name: 'UTIM', cmd: 'utim', pkg: '@emend-ai/utim', color: '#7ee787', icon: 'UT', local: true, free: true, keyEnv: null },
  { id: 'goose', name: 'Goose', cmd: 'goose', pkg: null, color: '#8b5cf6', icon: 'GS', local: true, free: true, keyEnv: null, hint: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash' },
  { id: 'sgpt', name: 'ShellGPT', cmd: 'sgpt', pkg: null, color: '#3fb950', icon: 'SG', local: true, free: true, keyEnv: null, hint: 'pip install shell-gpt' },
  { id: 'llm', name: 'LLM (SimonW)', cmd: 'llm', pkg: null, color: '#f778ba', icon: 'LM', local: true, free: true, keyEnv: null, hint: 'pip install llm' },
  { id: 'openhands', name: 'OpenHands', cmd: 'openhands', pkg: null, color: '#e6a23c', icon: 'OH', local: true, free: true, keyEnv: null, hint: 'uv tool install openhands --python 3.12' },
  { id: 'ollama', name: 'Ollama', cmd: 'ollama', pkg: null, color: '#bc8cff', icon: 'OL', local: true, free: true, keyEnv: null, hint: 'curl -fsSL https://ollama.com/install.sh | sh' },
  { id: 'cli-agent', name: 'CLI Agent', cmd: 'agent', pkg: null, color: '#f59e0b', icon: 'CA', local: true, free: true, keyEnv: null },
  // ── роутер / бесплатные провайдеры ──
  { id: 'omniroute', name: 'OmniRoute', cmd: 'omniroute', pkg: 'omniroute', color: '#ff7b72', icon: 'OM', free: true, keyEnv: 'OPENROUTER_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', cmd: 'openrouter', pkg: null, color: '#6366f1', icon: 'OP', free: true, keyEnv: 'OPENROUTER_API_KEY' },
  // ── бесплатные с бесплатными API-ключами ──
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', pkg: '@google/gemini-cli', color: '#58a6ff', icon: 'GE', free: true, keyEnv: 'GEMINI_API_KEY' },
  { id: 'qwen', name: 'Qwen Code', cmd: 'qwen', pkg: '@qwen-code/qwen-code', color: '#ef4444', icon: 'QW', free: true, keyEnv: 'DASHSCOPE_API_KEY' },
  { id: 'mistral', name: 'Mistral CLI', cmd: 'mi', pkg: 'mistral-cli', color: '#ff7b72', icon: 'MI', free: true, keyEnv: 'MISTRAL_API_KEY' },
  { id: 'ai-shell', name: 'AI Shell', cmd: 'ais', pkg: 'ai-shell', color: '#ffa657', icon: 'AI', free: true, local: true, keyEnv: null },
  { id: 'koda', name: 'Koda', cmd: 'koda', pkg: null, color: '#8b5cf6', icon: 'KO', free: true, local: true, keyEnv: null },
  { id: 'openclaude', name: 'OpenClaude', cmd: 'openclaude', pkg: null, color: '#06b6d4', icon: 'CL', free: true, local: true, keyEnv: null },
  // ── платные API-ключи ──
  { id: 'claude', name: 'Claude Code', cmd: 'claude', pkg: '@anthropic-ai/claude-code', color: '#d97706', icon: 'CC', free: false, keyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'codex', name: 'Muse', cmd: 'codex', pkg: '@openai/codex', color: '#e6e6e6', icon: 'CX', free: false, keyEnv: 'OPENAI_API_KEY' },
  { id: 'copilot', name: 'Copilot CLI', cmd: 'copilot', pkg: '@github/copilot', color: '#bc8cff', icon: 'CP', free: false, keyEnv: 'GITHUB_TOKEN' },
  { id: 'ccb', name: 'Claude Code (Rust)', cmd: 'ccb', pkg: null, color: '#d97706', icon: 'CB', free: false, keyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'cymela', name: 'Cymela', cmd: 'cymela', pkg: 'cymela', color: '#39c5cf', icon: 'CY', free: false, keyEnv: 'OPENROUTER_API_KEY' },
  { id: 'kode', name: 'Kode', cmd: 'kode', pkg: '@shareai-lab/kode', color: '#79c0ff', icon: 'KD', free: false, keyEnv: 'OPENAI_API_KEY' },
  { id: 'claude-flow', name: 'Claude Flow', cmd: 'claude-flow', pkg: 'claude-flow', color: '#ff9e64', icon: 'FL', free: false, keyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'auggie', name: 'Auggie', cmd: 'auggie', pkg: '@augmentcode/auggie', color: '#79c0ff', icon: 'AU', free: false, keyEnv: 'OPENAI_API_KEY' },
  // ── утилиты / инфраструктура ──
  { id: 'amp', name: 'Amp', cmd: 'amp', pkg: '@sourcegraph/amp', color: '#f778ba', icon: 'AM', free: true, keyEnv: null },
  { id: 'codebuff', name: 'Codebuff', cmd: 'codebuff', pkg: 'codebuff', color: '#ffd602', icon: 'CF', free: true, keyEnv: null },
  { id: 'elizaos', name: 'ElizaOS', cmd: 'elizaos', pkg: '@elizaos/cli', color: '#7ee787', icon: 'EO', free: true, keyEnv: null },
  { id: 'how2', name: 'how2', cmd: 'how2', pkg: 'how2', color: '#a5d6ff', icon: 'H2', free: true, keyEnv: null },
  { id: 'droid', name: 'Droid', cmd: 'droid', pkg: 'droid', color: '#56d4dd', icon: 'DR', free: true, keyEnv: null },
  { id: 'n8n', name: 'n8n', cmd: 'n8n', pkg: 'n8n', color: '#ea4b71', icon: 'N8', free: true, keyEnv: null },
  { id: 'smithery', name: 'Smithery', cmd: 'smithery', pkg: 'smithery', color: '#d2a8ff', icon: 'SM', free: true, keyEnv: null },
  { id: 'mcp-inspector', name: 'MCP Inspector', cmd: 'mcp-inspector', pkg: '@modelcontextprotocol/inspector', color: '#8b949e', icon: 'MC', free: true, keyEnv: null },
  { id: 'http-server', name: 'HTTP Server', cmd: 'http-server', pkg: 'http-server', color: '#22c55e', icon: 'HS', free: true, keyEnv: null }
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

// ─── TOOL TEST — проверка «а работает ли оно»: бинарь + нужен ли ключ ───
function hasToolKey(k) {
  if (!k) return true;
  if (process.env[k]) return true;
  if (k === 'OPENROUTER_API_KEY' && modelManager.getKeyForProvider('openrouter')) return true;
  if (k === 'GITHUB_TOKEN' && process.env.GH_TOKEN) return true;
  return false;
}
function probeTool(t) {
  const installed = isInstalled(t.cmd);
  const version = installed ? getVersion(t.cmd) : null;
  const needKey = !!(t.keyEnv && !hasToolKey(t.keyEnv));
  const ok = installed && !!version && !needKey;
  return { id: t.id, name: t.name, success: ok, installed, version, needKey, keyEnv: t.keyEnv || null, free: !!t.free, local: !!t.local };
}
app.get('/api/tools/test', (req, res) => {
  const t = TOOLS.find(x => x.id === req.query.id);
  if (!t) return res.json({ success: false, error: 'нет такого инструмента' });
  res.json(probeTool(t));
});
app.post('/api/tools/test', (req, res) => {
  const t = TOOLS.find(x => x.id === (req.body && req.body.id));
  if (!t) return res.json({ success: false, error: 'нет такого инструмента' });
  res.json(probeTool(t));
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

// Binary-safe upload: raw body (the file bytes) + target in ?path=. This is
// what the phone's SAF file picker and fmUpload() post to. It writes through
// the filesystem, so an APK keeps its bytes (the generic StorageBase backends
// deal in utf-8 text and would mangle a binary).
app.post('/api/fs/upload', express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
  try {
    const filePath = (req.query && req.query.path) || '';
    if (!filePath) return res.json({ success: false, error: 'укажи ?path=...' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
    res.json({ success: true, size: buf.length });
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

// ─── RUNNER: backup / stop / restart ────────────────────────────────────
// Runs inside a GitHub Actions launch, so process.env carries the run's own
// identity (GITHUB_*). Locally (pc-local) those are absent and the endpoints
// answer `actions:false` — the buttons are then disabled in the UI.
const ghApi = async (method, url, token, body) => {
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) { return { status: 0, error: e.message, j: null }; }
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

const runnerEnv = () => {
  const onActions = !!process.env.GITHUB_RUN_ID;
  const wfRef = process.env.GITHUB_WORKFLOW_REF || '';
  const file = (wfRef.match(/\.github\/workflows\/([^@/]+)/) || [])[1] || '';
  return {
    actions: onActions,
    repo: process.env.GITHUB_REPOSITORY || '',
    workflow: process.env.GITHUB_WORKFLOW || '',
    workflowFile: file,
    runId: process.env.GITHUB_RUN_ID || '',
    runNumber: process.env.GITHUB_RUN_NUMBER || '',
    attempt: process.env.GITHUB_RUN_ATTEMPT || '',
    ref: (process.env.GITHUB_REF || 'main').replace(/^refs\/heads\//, ''),
    os: process.env.RUNNER_OS || process.platform,
    workspace: process.env.GITHUB_WORKSPACE || '',
    hostname: os.hostname(),
    home: HOME,
    workDir: WORK_DIR,
    tunnel: (tunnelInfo && tunnelInfo.url) || null,
    uptimeSec: Math.round(process.uptime())
  };
};

// Size of a directory, via du (fast) with a Node fallback.
const dirSize = (p) => new Promise((resolve) => {
  const isWin = process.platform === 'win32';
  const child = isWin
    ? spawn('powershell', ['-NoProfile', '-Command',
        `(Get-ChildItem -LiteralPath '${String(p).replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`],
        { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('du', ['-sb', p], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += String(d); });
  child.on('error', () => resolve(null));
  child.on('close', () => {
    const n = parseInt(out.replace(/\s.*$/, '').replace(/[^\d]/g, ''), 10);
    resolve(Number.isFinite(n) ? n : null);
  });
});

const GITHUB_BASE = (repo) => `https://api.github.com/repos/${repo || process.env.GITHUB_REPOSITORY || 'sj0404-collab/zen-panel'}`;

const runnerToken = () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// Everything the backup may touch — keep it to places the user actually works.
const runnerRoot = (p) => {
  const roots = [WORK_DIR];
  if (process.env.GITHUB_WORKSPACE) roots.push(process.env.GITHUB_WORKSPACE);
  const resolved = path.resolve(String(p || ''));
  return roots.some(r => r && (resolved === r || resolved.startsWith(r + path.sep)));
};

// APKs (a single file, kept a file) and heavy top-level folders (→ tar.xz).
const scanRunnerFiles = async () => {
  const apks = [];
  const folders = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e || e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (depth < 3) walk(full, depth + 1);
        } else if (/\.apk$/i.test(e.name)) {
          const st = fs.statSync(full);
          apks.push({ name: e.name, path: full, size: st.size, isDir: false });
        }
      } catch {}
    }
  };
  walk(WORK_DIR, 0);
  if (process.env.GITHUB_WORKSPACE && process.env.GITHUB_WORKSPACE !== WORK_DIR) walk(process.env.GITHUB_WORKSPACE, 0);
  // Heavy folders in the work dir (hub-work itself first, then its children).
  const sizes = [];
  for (const d of [WORK_DIR, ...(function () {
    const out = [];
    try { for (const e of fs.readdirSync(WORK_DIR, { withFileTypes: true })) if (e.isDirectory()) out.push(path.join(WORK_DIR, e.name)); } catch {}
    return out;
  })()]) {
    if (d === WORK_DIR || !['.git', 'node_modules'].some(x => d.endsWith(path.sep + x) || d.endsWith('/' + x))) {
      const s = await dirSize(d);
      if (s != null && s > 20 * 1024 * 1024) sizes.push({ name: d === WORK_DIR ? 'hub-work' : path.basename(d), path: d, size: s, isDir: true });
    }
  }
  sizes.sort((a, b) => b.size - a.size);
  folders.push(...sizes.slice(0, 12));
  return { apks: apks.slice(0, 30), folders };
};

app.get('/api/runner', async (req, res) => {
  try {
    const env = runnerEnv();
    const scan = env.actions ? await scanRunnerFiles() : { apks: [], folders: [] };
    res.json({ success: true, ...env, ...scan });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// POST /api/runner/backup  { items: [{ path, dest: 'phone'|'branch'|'keep' }] }
//   phone  → client downloads (file → /api/fs/download, dir → /api/fs/archive)
//   branch → pack dirs to <name>-backup-<ts>.tar.xz, files stay as-is, push to
//            the session-state branch under artifacts/ (GitHub Contents API)
//   keep   → leave in place (implicit)
app.post('/api/runner/backup', express.json({ limit: '5mb' }), async (req, res) => {
  const items = (req.body && Array.isArray(req.body.items) ? req.body.items : [])
    .filter(i => i && typeof i.path === 'string');
  if (!items.length) return res.json({ success: true, results: [] });
  const token = runnerToken();
  const repo = process.env.GITHUB_REPOSITORY || '';
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const results = [];
  for (const it of items) {
    const p = it.path;
    const entry = { path: p, ok: false };
    if (!runnerRoot(p)) { entry.error = 'путь вне рабочих папок'; results.push(entry); continue; }
    let st;
    try { st = fs.statSync(p); } catch { entry.error = 'путь не найден'; results.push(entry); continue; }
    const isDir = st.isDirectory();
    const base = path.basename(p) || 'folder';
    entry.isDir = isDir; entry.name = base; entry.size = isDir ? null : st.size;
    const dest = it.dest === 'phone' ? 'phone' : it.dest === 'branch' ? 'branch' : 'keep';
    entry.action = dest;
    if (dest === 'phone' || dest === 'keep') { entry.ok = true; results.push(entry); continue; }
    try {
      let archivePath = p;
      let uploadName = base;
      if (isDir) {
        const tmp = path.join(os.tmpdir(), `zbak-${Date.now()}-${base.replace(/[^\w.-]/g, '_')}.tar.xz`);
        if (!await tarXz(p, tmp)) { entry.error = 'tar не смог упаковать (нет xz?)'; results.push(entry); continue; }
        archivePath = tmp;
        uploadName = `${base}-backup-${stamp}.tar.xz`;
      }
      const buf = fs.readFileSync(archivePath);
      if (buf.length > 90 * 1024 * 1024) {
        entry.error = 'слишком большой для ветки (>90 МБ) — выбери «на телефон»';
        results.push(entry);
        continue;
      }
      if (!token) { entry.error = 'нет GH_TOKEN — вставь gh_token в запуске хаба'; results.push(entry); continue; }
      const target = `artifacts/${uploadName}`;
      let sha = '';
      const existing = await ghApi('GET', `${GITHUB_BASE(repo)}/contents/${target}?ref=session-state`, token);
      if (existing.status === 200 && existing.j && existing.j.sha) sha = existing.j.sha;
      const put = await ghApi('PUT', `${GITHUB_BASE(repo)}/contents/${target}`, token, {
        message: `backup ${uploadName} (${stamp})`,
        content: buf.toString('base64'),
        branch: 'session-state',
        ...(sha ? { sha } : {})
      });
      if (put.status >= 200 && put.status < 300) {
        entry.ok = true;
        entry.size = buf.length;
        entry.url = `https://raw.githubusercontent.com/${repo || 'sj0404-collab/zen-panel'}/session-state/${target}`;
      } else {
        entry.error = `GitHub ${put.status}${put.j && put.j.message ? ' ' + put.j.message : ''}`;
      }
    } catch (e) { entry.error = e.message; }
    results.push(entry);
  }
  res.json({ success: true, results });
});

// Pack a path into a .tar.xz (falls back to .tar.gz) — returns the ext, or null.
const tarXz = (p, out) => new Promise((resolve) => {
  const dir = path.dirname(p);
  const target = path.basename(p);
  let child;
  try {
    child = spawn('tar', ['-cJf', out, target], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return resolve(false); }
  child.stderr.on('data', () => {});
  child.on('error', () => resolve(false));
  child.on('close', (code) => {
    if (code === 0) return resolve(true);
    const gz = out.replace(/\.tar\.xz$/, '.tar.gz');
    let gc;
    try { gc = spawn('tar', ['-czf', gz, target], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve(false); }
    gc.stderr.on('data', () => {});
    gc.on('error', () => resolve(false));
    gc.on('close', (c) => {
      if (c === 0) {
        try { fs.renameSync(gz, out); return resolve(true); } catch { return resolve(false); }
      }
      resolve(false);
    });
  });
});

app.post('/api/runner/stop', async (req, res) => {
  const env = runnerEnv();
  if (!env.actions || !env.runId) return res.json({ success: false, actions: false, error: 'не на Actions-раннере' });
  const token = runnerToken();
  if (!token) return res.json({ success: false, error: 'нет токена для остановки' });
  const r = await ghApi('POST', `${GITHUB_BASE(env.repo)}/actions/runs/${env.runId}/cancel`, token);
  res.json({ success: r.status === 202 || r.status === 409, status: r.status, runId: env.runId, repo: env.repo });
});

app.post('/api/runner/restart', async (req, res) => {
  const env = runnerEnv();
  if (!env.actions || !env.runId) return res.json({ success: false, actions: false, error: 'не на Actions-раннере' });
  if (!env.workflowFile) return res.json({ success: false, error: 'неизвестен workflow-файл' });
  const token = runnerToken();
  if (!token) return res.json({ success: false, error: 'нет токена для перезапуска' });
  // A fresh dispatch with the inputs we know (os + gh_token). The old run is
  // cancelled in the background — GitHub can take minutes to actually kill it.
  const dispatch = await ghApi(
    'POST', `${GITHUB_BASE(env.repo)}/actions/workflows/${env.workflowFile}/dispatches`, token,
    { ref: env.ref, inputs: { os: process.platform === 'win32' ? 'windows' : 'linux', gh_token: token } });
  let cancelOld = false;
  if (dispatch.status >= 200 && dispatch.status < 300) {
    const c = await ghApi('POST', `${GITHUB_BASE(env.repo)}/actions/runs/${env.runId}/cancel`, token);
    cancelOld = c.status === 202 || c.status === 409;
  }
  res.json({ success: dispatch.status >= 200 && dispatch.status < 300, status: dispatch.status, mode: 'dispatch', workflow: env.workflowFile, ref: env.ref, repo: env.repo, cancelOld });
});

// ─── GIT: status / diff / log for a local repo ─────────────────────────
const gitRun = (repo, args) => new Promise((resolve) => {
  const out = [];
  const child = spawn('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => out.push(String(d)));
  child.stderr.on('data', () => {});
  child.on('close', () => resolve(out.join('').trimEnd()));
  child.on('error', () => resolve(''));
});

const repoCandidates = () => {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || found.length) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'actions-runner') continue;
      if (fs.existsSync(path.join(dir, e.name, '.git'))) {
        found.push(path.join(dir, e.name));
        return;
      }
      if (depth < 3) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(WORK_DIR, 1);
  return found;
};

const resolveRepo = async (p) => {
  if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    if (fs.existsSync(path.join(p, '.git'))) return p;
    return null;
  }
  const cands = repoCandidates();
  return cands[0] || null;
};

app.get('/api/git/repos', (req, res) => {
  try {
    const repos = repoCandidates();
    res.json({ success: true, repos });
  } catch { res.json({ success: true, repos: [] }); }
});

app.get('/api/git/status', async (req, res) => {
  try {
    const repo = await resolveRepo(req.query.path);
    if (!repo) return res.json({ success: false, error: 'репозиторий не найден: нужна папка с .git' });
    const [branch, porcelain, branchLine, lastCommit] = await Promise.all([
      gitRun(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
      gitRun(repo, ['status', '--porcelain=v1']),
      gitRun(repo, ['status', '-sb']),
      gitRun(repo, ['log', '-1', '--format=%h %s (%ar)'])
    ]);
    const ahead = +(branchLine.match(/ahead (\d+)/) || [])[1] || 0;
    const behind = +(branchLine.match(/behind (\d+)/) || [])[1] || 0;
    const files = porcelain ? porcelain.split('\n').filter(Boolean).map(l => ({ code: l.slice(0, 2), path: l.slice(3) })) : [];
    res.json({ success: true, repo, branch, ahead, behind, lastCommit: lastCommit || null, files, dirty: files.length > 0 });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/git/diff', async (req, res) => {
  try {
    const repo = await resolveRepo(req.query.path);
    if (!repo) return res.json({ success: false, error: 'репозиторий не найден: нужна папка с .git' });
    const [unstaged, staged] = await Promise.all([gitRun(repo, ['diff']), gitRun(repo, ['diff', '--cached'])]);
    const diff = (staged ? '─── СТЕЙДЖЕД ───\n' + staged + '\n\n' : '') + unstaged;
    res.json({ success: true, repo, diff: diff.trim() || '' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/git/log', async (req, res) => {
  try {
    const repo = await resolveRepo(req.query.path);
    if (!repo) return res.json({ success: false, error: 'репозиторий не найден: нужна папка с .git' });
    const n = Math.min(50, parseInt(req.query.n || '20', 10) || 20);
    const log = await gitRun(repo, ['log', '-' + n, '--oneline', '--decorate']);
    res.json({ success: true, repo, log });
  } catch (e) { res.json({ success: false, error: e.message }); }
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
      case 'ping': { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }
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
