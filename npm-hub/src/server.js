#!/usr/bin/env node
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const StorageManager = require('./storage/manager');
const ModelManager = require('./models/manager');
const { startTunnel } = require('./tunnel');

const app = express();
const HOME = os.homedir();
const safeFilename = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
const mimeForPath = (p) => {
  const ext = (path.extname(p) || '').toLowerCase();
  return ({ '.apk': 'application/vnd.android.package-archive', '.zip': 'application/zip',
    '.tar': 'application/x-tar', '.xz': 'application/x-xz', '.gz': 'application/gzip',
    '.deb': 'application/x-debian-package', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.html': 'text/html',
    '.htm': 'text/html', '.json': 'application/json', '.txt': 'text/plain',
    '.md': 'text/plain', '.log': 'text/plain', '.js': 'application/javascript',
    '.css': 'text/css', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ttf': 'font/ttf', '.otf': 'font/otf',
  })[ext] || 'application/octet-stream';
};
const WORK_DIR = path.join(HOME, 'hub-work');
// Home dirs under ~/.npm-hub: the runner works transparently here and never
// uses the OS /tmp (which the machine may wipe and is invisible to CLI agents).
const DATA_DIR = path.join(HOME, '.npm-hub');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const LOG_DIR = path.join(DATA_DIR, 'logs');
try {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {}
const PORT = process.env.PORT || 8090;
const HOST = '0.0.0.0';
const STATE_FILE = path.join(HOME, '.npm-hub-state.json');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html?|js|css|json)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ─── ROUTES: / → launcher, /d → dashboard, /m → mobile, separate pages ───
function noCache(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}
// Каждая вкладка — отдельная страница. Общий «мост» bridge.js даёт им
// одинаковую верхнюю панель, состояние и helpers.
app.get('/d', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
app.get('/d/*', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
app.get('/files', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'files.html'));
});
app.get('/files/*', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'files.html'));
});
app.get('/linux', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'linux.html'));
});
app.get('/linux/*', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'linux.html'));
});
app.get('/git', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'git.html'));
});
app.get('/git/*', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'git.html'));
});
app.get('/m', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'mobile.html'));
});
app.get('/m/*', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'mobile.html'));
});
// Standalone terminal site: survives a refresh of the dashboard because its
// tabs reconnect to the same server-side tmux sessions and replay the buffer.
// Sessions themselves live on the server, so they run even with no page open.
app.get('/term', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'term.html'));
});
app.get('/term/*', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, '..', 'public', 'term.html'));
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
  const safe = String(cmd).replace(/[;&|`$()]/g, '');
  try {
    require('child_process').execSync(`${isWin ? 'where' : 'which'} ${safe}`, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}
function getVersion(cmd) {
  const safe = String(cmd).replace(/[;&|`$()]/g, '');
  try { return require('child_process').execSync(`${safe} --version`, { stdio: 'pipe', timeout: 5000 }).toString().trim().split('\n')[0]; }
  catch { return null; }
}

// Build version from the repo, survived of shallow clones: date.shortSha.
// Anything goes wrong → falls back to a readable "dev" stamp instead of dying.
let HUB_BUILD = null;
function hubBuildInfo() {
  if (HUB_BUILD) return HUB_BUILD;
  const run = args => {
    try {
      return require('child_process').execSync('git ' + args.join(' '), {
        cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 2500
      }).trim();
    } catch { return ''; }
  };
  const sha = run(['rev-parse', '--short', 'HEAD']);
  const when = run(['log', '-1', '--format=%cI']);
  const day = (when || '').slice(0, 10).replace(/-/g, '.');
  HUB_BUILD = { version: day && sha ? `${day}.${sha}` : 'dev', commit: sha || null, committedAt: when || null };
  return HUB_BUILD;
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
  res.json({ home: HOME, workDir: WORK_DIR, platform: process.platform, ...hubBuildInfo(), ...getAccessInfo(req), state });
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
    const filename = path.basename(req.query.path).replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mimeForPath(filename));
    // Binary-safe read: StorageBase.read() forces utf-8, which corrupts APKs
    // and other binaries. Backends are all local/remote Paths, so stream raw.
    const data = await backend.readBinary(req.query.path);
    if (data === null || data === undefined) { res.end(); return; }
    res.end(data);
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

// ─── AUTO-APPROVE TOGGLE ────────────────────────────────────────────────
// Persisted in STATE_FILE. When enabled, the hub writes /autoon into CLI
// agent sessions that support it (/autooff to disable), so builds run
// without manual confirmation on every tool call.
const AGENT_SUPPORTS_SLASH = new Set(['cli-agent', 'agent']);
app.get('/api/auto-approve', (req, res) => {
  const state = loadState();
  res.json({ success: true, enabled: !!state.autoApprove });
});
app.post('/api/auto-approve', (req, res) => {
  const enabled = !!req.body.enabled;
  const state = loadState();
  state.autoApprove = enabled;
  saveState(state);
  // Send command to every live agent session right now.
  for (const s of sessions.values()) {
    if (s.toolId && AGENT_SUPPORTS_SLASH.has(s.toolId)) {
      const cmd = (enabled ? '/autoon' : '/autooff') + '\r';
      if (s.tmux) tmuxInput(s.id, cmd);
      else if (s.pty) s.pty.write(cmd);
    }
  }
  res.json({ success: true, enabled });
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

// ─── ARCHIVE: tar.xz download ───────────────────────────────────────────
// GET /api/fs/archive?path=/some/dir  → streams <basename>.tar.xz
// Folders are always packed as tar.xz — never renamed to a different ext.
app.get('/api/fs/archive', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'path not found' });
  const stat = fs.statSync(filePath);
  const basename = path.basename(filePath);
  const isDir = stat.isDirectory();
  const name = safeFilename(basename) + '.tar.xz';

  const { spawn } = require('child_process');
  res.setHeader('Content-Type', 'application/x-xz');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.removeHeader('Content-Length');

  const dir = isDir ? path.dirname(filePath) : path.dirname(filePath);
  const target = isDir ? path.basename(filePath) : path.basename(filePath);
  let child;
  try {
    child = spawn('tar', ['-cJf', '-', target], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    return;
  }
  child.stdout.pipe(res);
  child.stderr.on('data', () => {});
  child.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'tar failed' });
  });
  req.on('close', () => { try { child.kill(); } catch {} });
});

// ─── GITHUB SAVE (session-state branch) ───────────────────────────────
// POST /api/gh/save  { path: "/tmp/foo.apk" }
// Saves a file or directory to the session-state branch under artifacts/.
// GitHub Contents API handles single files only: directories are packed to
// <name>-<ts>.tar.xz first, oversized sources become a tar.xz too (the API
// refuses files over 100 MB) — so the branch always receives one binary file.
// Requires GH_TOKEN env or PAT in body.
app.post('/api/gh/save', express.json({ limit: '50mb' }), async (req, res) => {
  const filePath = req.body && req.body.path;
  if (!filePath || !fs.existsSync(filePath)) return res.json({ success: false, error: 'path not found' });
  const token = process.env.GH_TOKEN || (req.body && req.body.token) || '';
  if (!token) return res.json({ success: false, error: 'GH_TOKEN not set; pass token in body or set env' });

  const repo = process.env.GITHUB_REPOSITORY || 'sj0404-collab/zen-panel';
  const branch = 'session-state';
  const stat = fs.statSync(filePath);
  const isDir = stat.isDirectory();
  const basename = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  let uploadFile = filePath;
  let uploadName = basename;

  try {
    if (isDir || stat.size > 90 * 1024 * 1024) {
      const ext = isDir ? 'tar.xz' : (path.extname(filePath) || '.bin');
      const tmp = path.join(TMP_DIR, `gsave-${Date.now()}-${basename.replace(/[^\w.-]/g, '_')}-${stamp}.${ext}`);
      const packaged = isDir
        ? await tarXz(filePath, tmp)
        : await new Promise((resolve) => {
            const gz = tmp.replace(/\.bin$/, '.tar.xz');
            try { resolve(tarXz(filePath, gz)); } catch { resolve(false); }
          });
      if (!packaged) return res.json({ success: false, error: 'не смог упаковать в tar.xz' });
      uploadFile = tmp;
      uploadName = `${basename}-${stamp}.tar.xz`;
    }
    const data = fs.readFileSync(uploadFile);
    if (data.length > 97 * 1024 * 1024) {
      return res.json({ success: false, error: 'этот файл больше лимита GitHub (97 МБ) и как архив тоже. Скачай его кнопкой «на телефон».' });
    }
    const content = data.toString('base64');
    const target = `artifacts/${uploadName}`;
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${target}`;
    // Check if file exists (to get sha for overwrite)
    let sha = '';
    try {
      const existing = await fetch(apiUrl + `?ref=${branch}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
      });
      if (existing.ok) { const j = await existing.json(); sha = j.sha || ''; }
    } catch {}

    const body = { message: `save ${uploadName} (${new Date().toISOString()})`, content, branch };
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
    return res.json({ success: true, url: rawUrl, api_url: apiUrl, packed: isDir || stat.size > 90 * 1024 * 1024 });
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
        const tmp = path.join(TMP_DIR, `zbak-${Date.now()}-${base.replace(/[^\w.-]/g, '_')}.tar.xz`);
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
// Repo discovery (declared BEFORE GIT_ROOT below: the GIT_ROOT IIFE runs at
// module load and calls it - a const declared later is in the temporal dead
// zone there, and the server died at startup with
// "Cannot access 'repoCandidates' before initialization" on any machine
// without GITHUB_WORKSPACE in the environment, i.e. every local run).
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

// This repository root: the runner checkout (workspace/fork) when on Actions,
// otherwise the first repo discovered in the work dir.
const GIT_ROOT = (() => {
  if (process.env.GITHUB_WORKSPACE) {
    const p = path.join(process.env.GITHUB_WORKSPACE, 'fork');
    if (fs.existsSync(path.join(p, '.git'))) return p;
    const cands = (() => { const f = []; const w = dir => { let e; try { e = fs.readdirSync(w, { withFileTypes: true }); } catch { return; } for (const x of e) { if (!x.isDirectory() || x.name === 'node_modules' || x.name === 'actions-runner') continue; if (fs.existsSync(path.join(w, x.name, '.git'))) { f.push(path.join(w, x.name)); return; } } }; w(process.env.GITHUB_WORKSPACE); return f; })();
    if (cands[0]) return cands[0];
  }
  const cands = repoCandidates() || [];
  return cands[0] || WORK_DIR;
})();

const gitRun = (repo, args) => new Promise((resolve) => {
  const out = [];
  const child = spawn('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => out.push(String(d)));
  child.stderr.on('data', () => {});
  child.on('close', () => resolve(out.join('').trimEnd()));
  child.on('error', () => resolve(''));
});

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

// ─── PULSE AUDIO ───
const { exec: _exec } = require('child_process');
const shTail = (file, lines = 3) => new Promise((resolve) => {
  _exec(`tail -n ${lines} ${JSON.stringify(file)} 2>/dev/null | tr '\n' ' '`, { timeout: 4000 }, (err, stdout) => resolve(String(stdout || '').trim().slice(0, 300)));
});
const pulseRun = (cmd) => new Promise((resolve) => {
  _exec(cmd, { timeout: 5000 }, (err, stdout, stderr) => {
    resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() });
  });
});

app.get('/api/pulse/status', async (req, res) => {
  try {
    const st = await pulseRun('pulseaudio --check 2>&1; echo $?');
    const running = st.out.endsWith('0');
    let sinks = [], sources = [];
    if (running) {
      const ls = await pulseRun('pactl list sinks short 2>/dev/null');
      if (ls.ok && ls.out) sinks = ls.out.split('\n').filter(Boolean).map(l => l.split('\t')[1] || l);
      const src = await pulseRun('pactl list sources short 2>/dev/null');
      if (src.ok && src.out) sources = src.out.split('\n').filter(Boolean).map(l => l.split('\t')[1] || l);
    }
    res.json({ running, sinks, sources });
  } catch { res.json({ running: false, sinks: [], sources: [] }); }
});

app.post('/api/pulse/start', async (req, res) => {
  try {
    await pulseRun('pulseaudio --start --disallow-exit --exit-idle-time=-1 2>&1');
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/pulse/stop', async (req, res) => {
  try {
    await pulseRun('pulseaudio --kill 2>&1');
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/pulse/volume', express.json(), async (req, res) => {
  try {
    const vol = Math.max(0, Math.min(100, parseInt(req.body.volume || 80, 10)));
    await pulseRun(`pactl set-sink-volume @DEFAULT_SINK@ ${vol}% 2>&1`);
    res.json({ ok: true, volume: vol });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/pulse/mute', async (req, res) => {
  try {
    await pulseRun('pactl set-sink-mute @DEFAULT_SINK@ toggle 2>&1');
    const st = await pulseRun('pactl get-sink-mute @DEFAULT_SINK@ 2>/dev/null');
    res.json({ ok: true, muted: st.out.includes('yes') });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/pulse/sinks', async (req, res) => {
  try {
    const ls = await pulseRun('pactl list sinks 2>/dev/null');
    const sinks = [];
    if (ls.ok && ls.out) {
      const blocks = ls.out.split('\n\n');
      for (const block of blocks) {
        const nameMatch = block.match(/Name:\s+(.+)/);
        const descMatch = block.match(/Description:\s+(.+)/);
        const volMatch = block.match(/Volume:\s+.+?(\d+)%/);
        const muteMatch = block.match(/Mute:\s+(yes|no)/);
        if (nameMatch) {
          sinks.push({
            name: nameMatch[1].trim(),
            description: descMatch ? descMatch[1].trim() : '',
            volume: volMatch ? parseInt(volMatch[1]) : 0,
            muted: muteMatch ? muteMatch[1] === 'yes' : false
          });
        }
      }
    }
    res.json({ success: true, sinks });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─── WEBSOCKET / PTY ───
// Sessions survive a dropped connection: losing the phone does NOT kill the
// terminal. The PTY keeps running in the background, its output is buffered,
// and any client that returns with the same sessionId resumes the live
// terminal instead of starting a new one. Sessions end only when the process
// exits on its own, the user sends `kill`, or the runner itself stops.
//
// On Linux/macOS sessions run inside a detached `tmux` server. tmux outlives
// this node process, so a restart of the hub does NOT reset running sessions:
// their output keeps streaming into a log file, and clients reconnecting with
// the same sessionId pick up exactly where they left off. On Windows (no tmux)
// we fall back to node-pty sessions that live inside this process.
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
// Paths owned by their own upgrade handlers below (cloud phone VNC + the
// always-on desktop). Handling the same socket twice makes ws throw
// «server.handleUpgrade() was called more than once» — and that crash took the
// whole hub down, so the list is shared and every handler is guarded.
const WS_CLAIMED = new Set(['/ws/vnc', '/ws/desktop', '/novnc/ws/desktop', '/websockify', '/novnc/websockify']);
server.on('upgrade', (req, socket, head) => {
  // Route the single 'upgrade' event: /ws → PTY, others → their own blocks.
  let pathname = '';
  try { pathname = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname; }
  catch { return; }
  if (WS_CLAIMED.has(pathname.replace(/\/+$/, ''))) return;
  try {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch (e) {
    console.log('  ⚠ ws upgrade: ' + e.message);
    try { socket.destroy(); } catch {}
  }
});
const sessions = new Map(); // sessionId -> { id, pty?, tmux?, cwd, toolId, clients:Set, output, resumed, offset, logPath, poller? }

const TMUX_PREFIX = 'npmhub-';
const PTY_DIR = path.join(TMP_DIR, 'pty');
try { fs.mkdirSync(PTY_DIR, { recursive: true }); } catch {}

const tmuxHas = (() => {
  try { require('child_process').execSync('which tmux', { stdio: 'ignore', timeout: 3000 }); return true; }
  catch { return false; }
})();

const safeSessionName = id => TMUX_PREFIX + String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
const sessionLogPath = id => path.join(PTY_DIR, safeSessionName(id) + '.log');
const sessionMetaPath = id => path.join(PTY_DIR, safeSessionName(id) + '.meta.json');

// A tiny `.json` sidecar per session remembers display info (name/color/icon,
// cwd) so a hub restart can bring back a nice tab for every surviving tmux
// session instead of a nameless shell.
const writeSessionMeta = (session) => {
  try {
    fs.writeFileSync(sessionMetaPath(session.id), JSON.stringify({
      id: session.id, cwd: session.cwd, toolId: session.toolId,
      toolName: session.toolName || 'Terminal', color: session.color || '#58a6ff',
      icon: session.icon || '>_', created: session.created || Date.now()
    }));
  } catch {}
};
const deleteSessionMeta = (id) => { try { fs.unlinkSync(sessionMetaPath(id)); } catch {} };
const readSessionMeta = (id) => {
  try { return JSON.parse(fs.readFileSync(sessionMetaPath(id), 'utf8')); }
  catch { return null; }
};

const tmuxRun = (args, timeout, input) => {
  try { return require('child_process').spawnSync('tmux', args, { stdio: 'pipe', timeout: timeout || 5000, encoding: 'utf8', input }); }
  catch { return { status: 1, stdout: '', stderr: '' }; }
};

const tmuxSessionAlive = id => tmuxRun(['has-session', '-t', safeSessionName(id)], 2000).status === 0;

const tmuxReadLog = (session) => {
  try {
    const size = fs.statSync(session.logPath).size;
    if (size > session.offset) {
      const fd = fs.openSync(session.logPath, 'r');
      const buf = Buffer.alloc(size - session.offset);
      fs.readSync(fd, buf, 0, buf.length, session.offset);
      fs.closeSync(fd);
      session.offset = size;
      const data = buf.toString('utf8');
      session.output = (session.output + data).slice(-262144);
      ptySend(session, { type: 'output', id: session.id, data });
    }
    return true;
  } catch { return false; }
};

const tmuxStartPoller = (session) => {
  if (session.poller) return;
  session.poller = setInterval(() => {
    if (session.clients.size === 0) return; // nothing to stream to, tmux keeps logging
    const alive = tmuxSessionAlive(session.id);
    tmuxReadLog(session);
    if (!alive) {
      tmuxReadLog(session); // flush whatever was logged last
      clearInterval(session.poller);
      session.poller = null;
      ptySend(session, { type: 'exit', id: session.id, code: 0 });
      try { fs.unlinkSync(session.logPath); } catch {}
      deleteSessionMeta(session.id);
      sessions.delete(session.id);
    }
  }, 120);
};

const ensureTmuxPipe = (session) => {
  const cmd = `cat >> ${JSON.stringify(session.logPath)}`;
  tmuxRun(['pipe-pane', '-t', safeSessionName(session.id), cmd], 3000);
  tmuxStartPoller(session);
};

const stopTmuxPollers = () => {
  sessions.forEach(s => { if (s.poller) { clearInterval(s.poller); s.poller = null; } });
};

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

// Reconnect path: a hub restart (or server swap) does not kill tmux sessions.
// Rebuild the in-memory record from the surviving tmux session + its log file.
const reviveTmuxSession = (id) => {
  if (!tmuxSessionAlive(id)) return null;
  const logPath = sessionLogPath(id);
  const offset = (() => { try { return fs.statSync(logPath).size; } catch { return 0; } })();
  const meta = readSessionMeta(id) || {};
  const session = { id, tmux: true, cwd: meta.cwd || null, toolId: meta.toolId || null, toolName: meta.toolName, color: meta.color, icon: meta.icon, created: meta.created || Date.now(), clients: new Set(), output: '', resumed: true, offset: 0, logPath, poller: null };
  sessions.set(id, session);
  ensureTmuxPipe(session);
  if (offset > 0) { // replay everything tmux already had
    try {
      const got = fs.readFileSync(logPath, 'utf8');
      session.output = got.slice(-262144);
      session.offset = offset;
    } catch {}
  }
  return session;
};

const createTmuxSession = (id, opts, ws) => {
  const name = safeSessionName(id);
  const logPath = sessionLogPath(id);
  try { fs.unlinkSync(logPath); } catch {}
  const r = tmuxRun(['new-session', '-d', '-s', name, '-x', String(opts.cols || 120), '-y', String(opts.rows || 30), '-c', opts.cwd], 8000);
  if (r.status !== 0) { ws.send(JSON.stringify({ type: 'error', error: (r.stderr || 'tmux failed').trim() })); return null; }
  const session = { id, tmux: true, cwd: opts.cwd, toolId: opts.toolId, toolName: opts.toolName, color: opts.color, icon: opts.icon, created: Date.now(), clients: new Set(), output: '', resumed: false, offset: 0, logPath, poller: null };
  sessions.set(id, session);
  writeSessionMeta(session);
  ensureTmuxPipe(session);
  const shell = process.env.SHELL || '/bin/bash';
  tmuxRun(['send-keys', '-t', name, `export TERM=xterm-256color; cd ${JSON.stringify(opts.cwd)}`, 'Enter'], 3000);
  if (opts.toolCmd) tmuxRun(['send-keys', '-t', name, opts.toolCmd, 'Enter'], 3000);
  // Auto-approve: after the agent starts, send /autoon if the setting is on.
  if (opts.toolCmd && AGENT_SUPPORTS_SLASH.has(opts.toolId)) {
    try { if (loadState().autoApprove) tmuxRun(['send-keys', '-t', name, '/autoon', 'Enter'], 3000); } catch {}
  }
  return session;
};

// Feed client keystrokes into the tmux pane byte-for-byte. Using load-buffer +
// paste-buffer keeps arbitrary UTF-8/escape bytes intact (paste-buffer sends
// them as terminal input, Enter/newline included).
const tmuxInput = (id, data) => {
  const name = safeSessionName(id);
  const bufName = 'npmhub_io_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const r = tmuxRun(['load-buffer', '-b', bufName, '-'], 3000, data);
  if (r.status !== 0) return;
  tmuxRun(['paste-buffer', '-b', bufName, '-t', name, '-d'], 3000);
};

// Reschedule all tmux pollers to only run while a client is attached, so idle
// sessions do not busy-poll forever while still logging via pipe-pane.
const tmuxWake = (session) => { if (session.tmux && session.clients.size > 0) tmuxStartPoller(session); };

wss.on('connection', (ws) => {
  let session = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'open': {
        const id = msg.sessionId || ('term_' + Date.now());
        const existing = sessions.get(id);
        if (existing && (!existing.tmux || tmuxSessionAlive(id))) {
          session = existing;
          session.resumed = true;
          attachPtyClient(session, ws);
          tmuxWake(session);
          return;
        }
        if (existing) {
          try { fs.unlinkSync(existing.logPath); } catch {}
          deleteSessionMeta(id);
          sessions.delete(id); // tmux session died while we were detached
        }
        // A session may exist in tmux but not in our (possibly restarted) memory.
        if (tmuxHas) {
          const revived = reviveTmuxSession(id);
          if (revived) {
            session = revived;
            attachPtyClient(session, ws);
            tmuxWake(session);
            return;
          }
        }
        const tool = TOOLS.find(t => t.id === msg.toolId);
        const isWin = process.platform === 'win32';
        const shell = isWin ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
        let cwd = msg.cwd || HOME;
        try { if (!fs.statSync(cwd).isDirectory()) cwd = HOME; } catch { cwd = HOME; }

        const metaColor = tool ? tool.color : '#58a6ff';
        const metaIcon = tool ? tool.icon : '>_';
        const metaName = tool ? tool.name : 'Terminal';

        try {
          if (tmuxHas && !isWin) {
            // ❗ tmux requires a login shell name (argv[0]) to start bash as an
            // interactive shell; new-session already does that. Nothing more needed.
            session = createTmuxSession(id, { cwd, cols: msg.cols, rows: msg.rows, toolId: tool ? tool.id : null, toolName: metaName, color: metaColor, icon: metaIcon, toolCmd: tool && tool.cmd !== '_terminal' ? tool.cmd : null }, ws);
          } else {
            const p = pty.spawn(shell, [], {
              name: 'xterm-256color',
              cols: msg.cols || 120,
              rows: msg.rows || 30,
              cwd: cwd,
              env: { ...process.env, TERM: 'xterm-256color', OPENROUTER_API_KEY: modelManager.getKeyForProvider('openrouter'), MODEL: modelManager.getSelectedModel(), OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' }
            });
            session = { id, pty: p, cwd, toolId: tool ? tool.id : null, toolName: metaName, color: metaColor, icon: metaIcon, created: Date.now(), clients: new Set(), output: '', resumed: false };
            sessions.set(id, session);
            writeSessionMeta(session);

            const cdCmd = isWin ? `cd /d "${cwd}"` : `cd "${cwd}"`;
            p.write(cdCmd + '\r');
            if (tool && tool.cmd && tool.cmd !== '_terminal') {
              setTimeout(() => { p.write(tool.cmd + '\r'); }, 200);
              // Auto-approve: if the setting is on, send /autoon after the agent is ready.
              if (AGENT_SUPPORTS_SLASH.has(tool.id)) {
                try { if (loadState().autoApprove) setTimeout(() => { p.write('/autoon\r'); }, 1000); } catch {}
              }
            }

            p.onData((data) => {
              session.output = (session.output + data).slice(-262144);
              ptySend(session, { type: 'output', id: session.id, data });
            });
            p.onExit(({ exitCode }) => {
              ptySend(session, { type: 'exit', id: session.id, code: exitCode });
              deleteSessionMeta(session.id);
              sessions.delete(session.id);
            });
          }
          if (session) attachPtyClient(session, ws);
        } catch (err) { ws.send(JSON.stringify({ type: 'error', error: err.message })); }
        return;
      }
      case 'input': {
        if (!session) return;
        if (session.tmux) { tmuxInput(session.id, msg.data); return; }
        session.pty.write(msg.data);
        return;
      }
      case 'resize': {
        if (!session || !msg.cols || !msg.rows) return;
        if (session.tmux) { tmuxRun(['resize-window', '-t', safeSessionName(session.id), '-x', String(msg.cols), '-y', String(msg.rows)], 3000); return; }
        session.pty.resize(msg.cols, msg.rows);
        return;
      }
      case 'ping': { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); return; }
      case 'kill': {
        if (!session) return;
        if (session.tmux) {
          const target = session;
          try { tmuxRun(['send-keys', '-t', safeSessionName(target.id), 'C-c'], 2000); } catch {}
          setTimeout(() => {
            tmuxRun(['kill-session', '-t', safeSessionName(target.id)], 2000);
            try { fs.unlinkSync(target.logPath); } catch {}
            deleteSessionMeta(target.id);
            sessions.delete(target.id);
          }, 400);
          session = null;
          return;
        }
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
  ws.on('close', () => {
    if (session && session.clients) {
      detachPtyClient(session, ws);
      // Halt tmux polling while unattached; pipe-pane keeps writing the log.
      if (session.tmux && session.clients.size === 0 && session.poller) {
        clearInterval(session.poller);
        session.poller = null;
      }
    }
  });
});

// ─── GET /api/sessions — живые серверные сессии ───
// Используется standalone терминалом (/term): показывает, что можно
// подхватить после перезагрузки страницы или с другого устройства.
app.get('/api/sessions', (req, res) => {
  const list = [];
  const push = (s) => list.push({
    id: s.id, cwd: s.cwd || null, toolId: s.toolId || null,
    toolName: s.toolName || 'Terminal', color: s.color || '#58a6ff',
    icon: s.icon || '>_', resumed: !!s.resumed, tmux: !!s.tmux,
    clients: s.clients ? s.clients.size : 0, created: s.created || 0
  });
  for (const s of sessions.values()) push(s);
  // Sessions that survived a hub restart still exist as tmux sessions — list
  // them too, reviving their in-memory record so a reconnect replays output.
  if (tmuxHas) {
    try {
      const r = require('child_process').execSync('tmux list-sessions', { stdio: 'pipe', timeout: 3000, encoding: 'utf8' });
      const seen = new Set(sessions.keys());
      for (const line of r.split('\n')) {
        const name = (line.split(':')[0] || '').trim();
        if (!name.startsWith(TMUX_PREFIX)) continue;
        const id = name.slice(TMUX_PREFIX.length);
        if (seen.has(id)) continue;
        const revived = reviveTmuxSession(id);
        if (revived) push(revived);
      }
    } catch {}
  }
  list.sort((a, b) => (b.created || 0) - (a.created || 0));
  res.json({ success: true, sessions: list });
});

// Manual update from GitHub: pull main, then exit so the workflow keep-alive
// loop restarts the hub on the new code. tmux sessions and the tunnel live
// outside this process, so they survive the restart untouched.
const gitQ = (args) => new Promise((resolve) => {
  const out = [];
  const child = spawn('git', args, { cwd: GIT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  child.stdout.on('data', d => out.push(String(d)));
  child.stderr.on('data', () => {});
  child.on('close', (code) => resolve({ code, out: out.join('').trimEnd() }));
  child.on('error', () => resolve({ code: -1, out: '' }));
});

const GIT_BRANCH = (process.env.GITHUB_REF || '').replace(/^refs\/heads\//, '') || 'main';

app.get('/api/update', async (req, res) => {
  const { code, out } = await gitQ(['fetch', 'origin', GIT_BRANCH]);
  if (code !== 0) return res.json({ success: false, error: 'fetch не удался: git exited ' + code + ' — ' + out.slice(0, 300) });
  const head = (await gitQ(['rev-parse', 'HEAD'])).out;
  const remote = (await gitQ(['rev-parse', `origin/${GIT_BRANCH}`])).out;
  const behindN = (await gitQ(['rev-list', '--count', `${head}..origin/${GIT_BRANCH}`])).out || '0';
  const localSha = (await gitQ(['rev-parse', '--short', 'HEAD'])).out;
  const remoteSha = (await gitQ(['rev-parse', '--short', `origin/${GIT_BRANCH}`])).out;
  res.json({
    success: true, branch: GIT_BRANCH,
    current: localSha, latest: remoteSha, same: head === remote,
    behind: parseInt(behindN, 10) || 0,
    version: hubBuildInfo().version || ''
  });
});

app.post('/api/update', async (req, res) => {
  const check = await gitQ(['fetch', 'origin', GIT_BRANCH]);
  if (check.code !== 0) return res.json({ success: false, error: 'fetch не удался: ' + check.out.slice(0, 300) });
  const head = (await gitQ(['rev-parse', 'HEAD'])).out;
  const remote = (await gitQ(['rev-parse', `origin/${GIT_BRANCH}`])).out;
  const behindN = parseInt((await gitQ(['rev-list', '--count', `${head}..origin/${GIT_BRANCH}`])).out, 10) || 0;
  if (head === remote) {
    return res.json({ success: true, updated: false, behind: 0, message: 'уже на последней версии' });
  }
  // Accept local uncommitted changes rather than nuking them: -X theirs keeps
  // our work while still pulling the upstream snapshot. If that is impossible
  // (merge conflict), fall back to a hard reset — a runner checkout is
  // disposable anyway.
  const pull = await gitQ(['pull', '--no-edit', '--no-rebase', '--strategy-option', 'theirs', 'origin', GIT_BRANCH]);
  if (pull.code !== 0) {
    const junk = await gitQ(['reset', '--hard', `origin/${GIT_BRANCH}`]);
    if (junk.code !== 0) return res.json({ success: false, error: 'pull и reset не удались: ' + pull.out.slice(0, 300) });
  }
  const newSha = (await gitQ(['rev-parse', '--short', 'HEAD'])).out;
  console.log(`[updater] pulled ${head.slice(0, 7)}..${newSha} (${behindN} commits); restarting hub`);
  res.json({ success: true, updated: true, behind: behindN, current: newSha, restarting: true });
  // Breathe so the response reaches the browser, then exit: the workflow
  // keep-alive loop notices the dead process and relaunches it on this code.
  setTimeout(() => { try { server.close(); } catch (e) {} process.exit(0); }, 400);
});

// ─── CLOUD PHONE (Android emulator + VNC) ───
// The phone runs on its OWN runner (android-cloud-phone repo, cloud-phone.yml
// workflow, dedicated self-hosted runner labelled `emulator`). That runner
// installs everything itself on every start (install_deps.sh), boots the
// Android emulator and serves noVNC on a cloudflared tunnel. The hub only:
//   - dispatches the workflow (start/stop) via the GitHub API,
//   - reads the live URL from the android-cloud-phone `session-state` branch
//     (session-phone.json) so the panel knows what to open.
// A local fallback (`PHONE_REPO=` empty or control.sh present) still works for
// a phone sharing the hub's own runner.
const PHONE_DIR = path.join(__dirname, '..', 'public', 'novnc');
const PHONE_ROOT = process.env.PHONE_ROOT || path.join(HOME, 'android-cloud-phone');
const PHONE_VNC_PORT = 5900;
const PHONE_ADB_PORT = 5555;
const PHONE_NO_VNC_PORT = 6080;
const PHONE_CTL = process.env.PHONE_CTL || path.join(PHONE_ROOT, 'scripts', 'control.sh');
const PHONE_REPO = (process.env.PHONE_REPO || 'sj0404-collab/android-cloud-phone').trim();
const PHONE_WF = 'cloud-phone.yml';
const phoneToken = () => runnerToken();

app.use('/phone', express.static(PHONE_DIR, { fallthrough: false }));
app.get('/phone', (req, res) => res.redirect('/phone/vnc.html'));
app.get('/phone/', (req, res) => res.redirect('/phone/vnc.html'));

const remotePhoneAvailable = () => Boolean(PHONE_REPO && phoneToken());

// Raw GitHub dispatch — POST /repos/{repo}/actions/workflows/{wf}/dispatches.
const dispatchPhone = (command, browserUrl) => new Promise(async (resolve) => {
  const token = phoneToken();
  if (!remotePhoneAvailable()) return resolve({ ok: false, out: 'нет GH_TOKEN / PHONE_REPO для remote-телефона' });
  try {
    const inputs = { command, runner: process.env.PHONE_RUNNER || 'emulator' };
    if (browserUrl) inputs.browser_url = browserUrl;
    const url = `${GITHUB_BASE(PHONE_REPO)}/actions/workflows/${PHONE_WF}/dispatches`;
    const r = await ghApi('POST', url, token, {
      ref: 'main',
      inputs
    });
    if (r.status >= 200 && r.status < 300) return resolve({ ok: true, out: `workflow ${command} dispatched` });
    resolve({ ok: false, out: `dispatch ${command} failed (${r.status}): ${JSON.stringify(r.j || r.error || '')}` });
  } catch (e) { resolve({ ok: false, out: String(e.message || e) }); }
});

const dispatchPhoneBrowser = (url) => dispatchPhone('start', url);

// Read session-phone.json from the android-cloud-phone session-state branch.
const phoneRemoteStatus = async () => {
  const token = phoneToken();
  if (!token) return { url: null, raw: null };
  try {
    const url = `${GITHUB_BASE(PHONE_REPO)}/contents/session-phone.json?ref=session-state`;
    const r = await ghApi('GET', url, token);
    if (r.status !== 200 || !r.j || !r.j.content) return { url: null, raw: null };
    let text = '';
    try { text = Buffer.from(r.j.content, 'base64').toString('utf8'); } catch { return { url: null, raw: null }; }
    const d = JSON.parse(text);
    const live = d && d.state !== 'ended';
    return {
      url: live ? (d.url || d.rawUrl || null) : null,
      raw: d
    };
  } catch { return { url: null, raw: null }; }
};

const phoneLocalStatus = async () => {
  const [vnc, adb, ctl] = await Promise.all([
    phonePortOpen(PHONE_VNC_PORT),
    phonePortOpen(PHONE_ADB_PORT),
    phoneCtrl('status', 8000).catch(e => ({ ok: false, out: String(e.message || e) }))
  ]);
  return { vnc, adb, control: ctl };
};

const phoneCtrl = (sub, timeoutMs = 90000) => new Promise((resolve) => {
  try {
    const p = spawn('bash', [PHONE_CTL, sub], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('error', e => { clearTimeout(timer); resolve({ ok: false, out: String(e.message || e) }); });
    p.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
  } catch (e) { resolve({ ok: false, out: String(e.message || e) }); }
});

const phonePortOpen = (port, timeoutMs = 1200) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  const t = setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, timeoutMs);
  s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
  s.on('error', () => { clearTimeout(t); resolve(false); });
});

const phoneStatus = async () => {
  if (remotePhoneAvailable()) {
    const s = await phoneRemoteStatus();
    // Tunnel first, raw runner URL second, local /phone fallback last.
    const url = s.url;
    return {
      running: Boolean(url || s.raw && s.raw.state === 'live'),
      remote: true, url,
      raw: s.raw,
      noVncPort: PHONE_NO_VNC_PORT,
      adb: Boolean(s.raw && s.raw.adbPort),
      control: { ok: true, out: s.raw && s.raw.state === 'live' ? 'remote: live' : 'remote: idle' }
    };
  }
  const s = await phoneLocalStatus();
  return {
    running: s.vnc, adb: s.adb,
    remote: false, url: null,
    noVncPort: PHONE_NO_VNC_PORT,
    control: s.control
  };
};

app.get('/api/phone/status', async (req, res) => {
  try { res.json(await phoneStatus()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/phone/start', async (req, res) => {
  try {
    if (remotePhoneAvailable()) {
      const r = await dispatchPhone('start');
      return res.json({ ok: r.ok, message: r.out, remote: true });
    }
    const r = await phoneCtrl('start');
    res.json({ ok: r.ok, message: r.out, remote: false });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/phone/stop', async (req, res) => {
  try {
    if (remotePhoneAvailable()) {
      const r = await dispatchPhone('stop');
      return res.json({ ok: r.ok, message: r.out, remote: true });
    }
    const r = await phoneCtrl('stop');
    res.json({ ok: r.ok, message: r.out, remote: false });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Open a URL in the emulator's browser (Kiwi Chrome / default browser via
// the VIEW intent). The page itself is shown through the same noVNC iframe
// (/phone/vnc.html), so the UI just switches tabs to the phone view.
const PHONE_ADB = () => {
  const sdk = process.env.ANDROID_SDK_ROOT || '/usr/local/lib/android/sdk';
  return path.join(sdk, 'platform-tools', 'adb');
};

const phoneAdb = (args, timeoutMs = 15000) => new Promise((resolve) => {
  const adb = PHONE_ADB();
  if (!fs.existsSync(adb)) return resolve({ ok: false, out: 'adb not found: ' + adb });
  try {
    const p = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('error', e => { clearTimeout(timer); resolve({ ok: false, out: String(e.message || e) }); });
    p.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
  } catch (e) { resolve({ ok: false, out: String(e.message || e) }); }
});

const phoneEnsureBrowser = async () => {
  // Modern emulator images ship Browser (AOSP). Kiwi is optional; whatever
  // handles the VIEW intent is fine — we only need it to open a URL.
  await phoneAdb(['shell', 'getprop', 'sys.boot_completed']).catch(() => {});
};

app.post('/api/phone/browser', async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!url || !/^https?:\/\/\S+$/i.test(url)) {
      return res.status(400).json({ ok: false, error: 'bad url: ' + url });
    }
    if (remotePhoneAvailable()) {
      // Phone lives on another runner: hand the URL to that runner, which
      // opens it in the emulator browser after boot (cloud-phone.yml).
      const st = await phoneRemoteStatus();
      if (!(st.raw && st.raw.state === 'live')) {
        return res.json({ ok: false, info: 'телефон не запущен — сначала «▶ Старт»' });
      }
      const r = await dispatchPhoneBrowser(url);
      return res.json({ ok: r.ok, message: r.out, remote: true, url });
    }
    await phoneEnsureBrowser();
    const r = await phoneAdb([
      'shell', 'am', 'start',
      '-a', 'android.intent.action.VIEW',
      '-d', url
    ]);
    res.json({ ok: r.ok, message: r.out || 'opened: ' + url });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── LINUX DESKTOP VNC (parallel runner) ───
// The hub.yml `vnc` job runs a headless Linux desktop (openbox + xterm + Mesa)
// on a second runner and publishes its noVNC address to session-vnc.json on the
// session-state branch of this repo. The hub only reads that file and hands the
// address to the panel's «Linux screen» button — same pattern as the phone.
const VNC_REPO = (process.env.VNC_REPO || process.env.GITHUB_REPOSITORY || 'sj0404-collab/zen-panel').trim();

const vncRemoteStatus = async () => {
  const token = runnerToken();
  if (!token) return { url: null, raw: null };
  try {
    const url = `${GITHUB_BASE(VNC_REPO)}/contents/session-vnc.json?ref=session-state`;
    const r = await ghApi('GET', url, token);
    if (r.status !== 200 || !r.j || !r.j.content) return { url: null, raw: null };
    let text = '';
    try { text = Buffer.from(r.j.content, 'base64').toString('utf8'); } catch { return { url: null, raw: null }; }
    const d = JSON.parse(text);
    const url2 = d && d.state !== 'ended' ? (d.url || d.novncUrl || null) : null;
    return { url: url2, raw: d };
  } catch { return { url: null, raw: null }; }
};

const vncStatus = async () => {
  // Local screen first: the hub's OWN runner is the desktop that the panel's
  // 'Go · 🖥' actually paints into (DISPLAY=:99 on this machine), it lives on
  // the hub origin (no iframe/tunnel games) and vnc-keepalive heals it. The
  // URL the `vnc` job published is only a fallback - it may belong to another
  // runner of the same cluster, where nothing the hub launches can be seen.
  let local = { url: null, ready: false };
  try { if (vncKeeper) local = await vncKeeper.localStatus(); } catch {}
  if (local.url) {
    return { running: true, url: local.url, remote: false, source: 'local', raw: null, keepalive: vncKeeper ? vncKeeper.status() : null };
  }
  // Свой экран ещё поднимается (ставятся пакеты / стартует x11vnc) — чужой
  // раннер в это время показывать нельзя: наш «Go · 🖥» рисует только на этом
  // раннере, и пользователь видел ровно это — «запущен · другой раннер» +
  // чёрный экран. Ждём свой; удалённый берём только как последнюю надежду.
  if (local.pending) {
    return {
      running: false, url: null, remote: false, source: 'local-pending', raw: null,
      pending: true, installing: local.installing || [],
      keepalive: vncKeeper ? vncKeeper.status() : null
    };
  }
  const s = await vncRemoteStatus();
  const url = s.url;
  return {
    running: Boolean(url || s.raw && s.raw.state === 'live'),
    url,
    remote: true,
    source: url ? 'remote' : 'none',
    raw: s.raw,
    local: local,
    keepalive: vncKeeper ? vncKeeper.status() : null
  };
};

// Diagnostics + manual repair of the always-on desktop (see src/vnc-keepalive.js)
app.get('/api/vnc/keepalive', async (req, res) => {
  try {
    const st = vncKeeper ? vncKeeper.status() : { enabled: false, note: 'keepalive не подключён' };
    const local = vncKeeper ? await vncKeeper.localStatus() : { url: null };
    res.json({ ok: true, keepalive: st, local });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/vnc/keepalive', async (req, res) => {
  if (!vncKeeper) return res.json({ ok: false, error: 'keepalive не подключён' });
  const action = (req.body && req.body.action) || 'repair';
  try {
    const ok = action === 'rebuild' ? await vncKeeper.ensureNow() : await vncKeeper.repair('запрос панели');
    res.json({ ok: true, action, done: ok, keepalive: vncKeeper.status() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/vnc/status', async (req, res) => {
  try { res.json(await vncStatus()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// If the desktop is live, mirror its noVNC page behind the hub's own origin so
// the panel can embed it in an iframe even through the hub's tunnel.
app.get('/desktop-vnc', async (req, res) => {
  try {
    const s = await vncStatus();
    if (!s.url) return res.status(404).send('VNC desktop is not running');
    res.redirect(s.url);
  } catch (e) { res.status(500).send(String(e.message || e)); }
});

// WebSocket VNC proxy: /ws/vnc  →  tcp://127.0.0.1:5900
// noVNC connects to  ws(s)://<hub-host>:<hub-port>/ws/vnc  over the hub's own
// origin (works through the hub tunnel too, WS is same-origin relative).
// eslint-disable-next-line no-unused-vars
// WebSocket VNC proxy: /ws/vnc  →  tcp://127.0.0.1:5900
// One ws server per http server would fight over the 'upgrade' event, so
// use noServer:true + our own upgrade listener for the VNC path.
const vncWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch { return; }
  if (u.pathname !== '/ws/vnc') return; // let the main /ws WSS handle it
  try {
  vncWss.handleUpgrade(req, socket, head, (ws) => {
    const tcp = net.connect(PHONE_VNC_PORT, '127.0.0.1');
    const destroy = () => { try { tcp.destroy(); } catch {} try { ws.terminate(); } catch {} };
    tcp.on('error', () => destroy());
    tcp.on('data', (d) => { if (ws.readyState === 1) ws.send(d, { binary: true }); });
    ws.on('message', (d) => { try { tcp.write(d); } catch {} });
    ws.on('close', () => destroy());
    ws.on('error', () => destroy());
    vncWss.emit('connection', ws, req);
  });
  } catch (e) {
    console.log('  ⚠ phone-vnc upgrade: ' + e.message);
    try { socket.destroy(); } catch {}
  }
});

// ─── LINUX DESKTOP: run apps on the VNC desktop ───
// POST /api/linux/run  { action: 'browser'|'phone'|'terminal', url? }
// Launches apps inside the Linux VNC desktop (DISPLAY=:99) so the user sees
// them through the noVNC iframe — no HTML site iframes needed.
app.post('/api/linux/run', express.json(), async (req, res) => {
  const { action, url } = req.body || {};
  const display = process.env.VNC_DISPLAY || ':99';
  // Дисплей не обязан быть :99 — socket проверяем по номеру из VNC_DISPLAY
  const dispNum = display.replace(/^:/, '');
  const hasXvfb = fs.existsSync(`/tmp/.X11-unix/X${dispNum}`);
  if (!hasXvfb) return res.json({ ok: false, error: 'Linux VNC desktop не запущен на этом раннере (нет X11 display)' });

  // ВАЖНО: DISPLAY нужно именно ЭКСПОРТИРОВАТЬ. Раньше строка собиралась как
  // `DISPLAY=:99 <команда>`, и переменная попадала только в первое присваивание
  // (BROWSER_BIN=...), а сам chromium запускался уже без DISPLAY → «Missing X
  // server or $DISPLAY» в логе и ни одного окна: так и выглядел сломанный
  // «Go · 🖥».
  const runOnDisplay = (cmd, timeoutMs = 8000) => new Promise((resolve) => {
    try {
      const p = _exec(`export DISPLAY=${display}; ${cmd}`, { timeout: timeoutMs }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || '').trim() });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });

  try {
    switch (action) {
      case 'browser': {
        if (!url) return res.json({ ok: false, error: 'url required' });
        const escaped = String(url).replace(/'/g, "'\\''");
        const vertical = req.body.vertical || req.body.orient==='vertical' || /youtube.*shorts|m\.youtube|vertical/i.test(url);
        const isYoutube = /youtube\.com|youtu\.be/i.test(url);
        // PulseAudio со звуком: проверяем и стартуем если упал
        try {
          const chk = await pulseRun('pulseaudio --check 2>&1; echo $?');
          if (!chk.out || !chk.out.trim().endsWith('0')) {
            await pulseRun('pulseaudio --start --disallow-exit --exit-idle-time=-1 2>&1');
            await pulseRun('pactl set-sink-volume @DEFAULT_SINK@ 90% 2>/dev/null || true');
            console.log('  🔊 PulseAudio auto-started for browser');
          }
        } catch {}
        // Вертикальный ютуб: узкое окно 412×915 (как Pixel), горизонтальный 1280×720
        const winSize = vertical ? '412,915' : '1280,720';
        // С телефона окно открываем размером с экран телефона и в левом верхнем
        // углу стола: телефон показывает стол крупно (1:1), поэтому такое окно
        // занимает у него весь экран — «рабочий стол» = браузер, а не полоска.
        const mobile = !!(req.body.mobile || req.body.window === 'phone');
        const mobileWin = '420,900';
        // Профиль браузера — в домашней папке, а НЕ в /tmp: YouTube на
        // датацентровом IP показывает «Sign in to confirm you're not a bot»,
        // и после входа сессия должна переживать перезапуск хаба (в /tmp её
        // снесло бы первым же обновлением). На своём раннере ~ сохраняется.
        const profileRoot = path.join(DATA_DIR, 'chrome-profile');
        try { fs.mkdirSync(profileRoot, { recursive: true }); } catch {}
        const userData = vertical ? path.join(profileRoot, 'vertical') : profileRoot;
        // Хром с поддержкой звука и автоплея
        // Флаги под headless-VNC: без них Chromium считает окно на Xvfb
        // «перекрытым/фоновым» и душит рендер и медиа — видео в YouTube просто
        // не идёт, а картинка обновляется рывками. Список --disable-features
        // слит в один: второй флаг перекрывает первый.
        const chromeFlags = `--no-sandbox --test-type --disable-gpu --autoplay-policy=no-user-gesture-required`
          + ` --disable-features=PreloadMediaEngagementData,AutoplayIgnoreWebAudio,CalculateNativeWinOcclusion,MediaEngagementBypassAutoplayPolicies`
          + ` --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`
          + ` --use-fake-ui-for-media-stream`
          + ` --enable-accelerated-video-decode --disable-frame-rate-limit`
          + ` --window-size=${mobile ? mobileWin : winSize} --window-position=${mobile ? '0,0' : '20,20'} --user-data-dir=${userData} --no-first-run --disable-infobars --disable-dev-shm-usage`;
        // Мобильный user-agent для вертикального ютуба (чтобы открылся m.youtube.com/shorts)
        const uaFlag = (vertical && isYoutube) ? `--user-agent='Mozilla/5.0 (Linux; Android 10; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'` : '';
        // Бинарь ищем на месте: на раннере может быть chromium, chromium-browser,
        // google-chrome или google-chrome-stable — раньше здесь был жёстко
        // забит chromium-browser, и «Go · 🖥» молча не открывал ничего.
        const binPick = `BROWSER_BIN=$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable || true); if [ -z "$BROWSER_BIN" ]; then exit 3; fi`;
        // Браузер пишет свой вывод в лог: без него «не открылось» невозможно
        // объяснить, а именно так и выглядел сломанный «Go · 🖥».
        const blog = path.join(LOG_DIR, 'browser.log');
        const launch = (extraFlags) => runOnDisplay(
          `${binPick}; setsid nohup "$BROWSER_BIN" ${chromeFlags} ${extraFlags} '${escaped}' >>${JSON.stringify(blog)} 2>&1 & sleep 3; `
          + `pgrep -f "$(basename "$BROWSER_BIN")" | head -1`, 12000);
        let r = await launch(uaFlag);
        let started = Boolean(r.out && /^\d+$/m.test(r.out));
        if (!started) { r = await launch(''); started = Boolean(r.out && /^\d+$/m.test(r.out)); }
        if (!started) {
          r = await runOnDisplay(`(command -v firefox >/dev/null 2>&1 && setsid nohup firefox '${escaped}' >/dev/null 2>&1 &) || (setsid nohup xdg-open '${escaped}' >/dev/null 2>&1 &); sleep 3; pgrep -f firefox | head -1`, 12000);
          started = Boolean(r.out && /^\d+$/m.test(r.out));
        }
        if (!started) {
          const tail = await shTail(blog, 3);
          return res.json({ ok: false, error: 'браузер не запустился (' + (r.err || 'нет процесса').slice(0, 120) + '): ' + tail });
        }
        // Громкость на макс и снять mute чтобы ютуб был слышен
        try { await pulseRun('pactl set-sink-mute @DEFAULT_SINK@ 0 2>/dev/null || true'); await pulseRun('pactl set-sink-volume @DEFAULT_SINK@ 90% 2>/dev/null || true'); } catch {}
        return res.json({ ok: true, message: `Браузер запущен${vertical?' (вертикально)':''}: ${url} — звук вкл.`, vertical, winSize });
      }
      case 'phone': {
        // Try to start Android emulator on the local display
        const sdk = process.env.ANDROID_SDK_ROOT || '/usr/local/lib/android/sdk';
        const emulator = path.join(sdk, 'emulator', 'emulator');
        const avd = process.env.ANDROID_AVD || 'pixel_7_api34';
        if (fs.existsSync(emulator)) {
          await runOnDisplay(`${emulator} -avd ${avd} -no-window -no-audio &`, 3000);
          return res.json({ ok: true, message: `Эмулятор ${avd} запускается...` });
        }
        // Fallback: try the cloud-phone workflow dispatch
        if (remotePhoneAvailable()) {
          const r = await dispatchPhone('start');
          return res.json({ ok: r.ok, message: r.out, remote: true });
        }
        return res.json({ ok: false, error: 'Android SDK не найден на этом раннере' });
      }
      case 'terminal': {
        await runOnDisplay(`xterm -geometry 120x30+100+100 &`, 3000);
        return res.json({ ok: true, message: 'Терминал открыт на рабочем столе' });
      }
      case 'files': {
        await runOnDisplay(`(pcmanfm || nautilus || xdg-open ~/hub-work) &`, 3000);
        return res.json({ ok: true, message: 'Файловый менеджер открыт' });
      }
      default:
        return res.json({ ok: false, error: 'unknown action: ' + action });
    }
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── OCR + SCREENSHOT для TTS/чтения в фоне ───
const ocrRun = (cmd) => new Promise((resolve)=>{
  const {_exec} = require('child_process');
  _exec(cmd, {timeout: 15000}, (err, stdout, stderr)=>{
    resolve({ok: !err, out: (stdout||'').trim(), err: (stderr||'').trim()});
  });
});
app.post('/api/ocr', express.json(), async (req,res)=>{
  const display = process.env.VNC_DISPLAY || ':99';
  const hasX = require('fs').existsSync('/tmp/.X11-unix/X99') || require('fs').existsSync('/tmp/.X11-lock');
  if(!hasX) return res.json({ok:false, error:'VNC desktop не запущен'});
  const tmpPng = '/tmp/ocr_'+Date.now()+'.png';
  try{
    // 1) Скриншот
    let cap = await ocrRun(`DISPLAY=${display} import -window root ${tmpPng} 2>&1`);
    if(!require('fs').existsSync(tmpPng)){
      cap = await ocrRun(`DISPLAY=${display} scrot ${tmpPng} 2>&1`);
    }
    if(!require('fs').existsSync(tmpPng)){
      cap = await ocrRun(`DISPLAY=${display} xwd -root -silent -out /tmp/ocr.xwd 2>&1 && convert /tmp/ocr.xwd ${tmpPng} 2>&1`);
    }
    if(!require('fs').existsSync(tmpPng)) return res.json({ok:false, error:'Не удалось сделать скриншот: '+cap.err});
    // 2) OCR
    let ocr = await ocrRun(`tesseract ${tmpPng} stdout -l rus+eng --psm 6 2>&1`);
    if(!ocr.ok || !ocr.out || ocr.out.includes('Error')){
      ocr = await ocrRun(`tesseract ${tmpPng} stdout -l eng --psm 6 2>&1`);
    }
    // Если tesseract не установлен
    if(ocr.out.includes('not found') || ocr.out.includes('command not found')){
      return res.json({ok:false, error:'tesseract не установлен на раннере. Установи: sudo apt-get install -y tesseract-ocr tesseract-ocr-rus imagemagick scrot'});
    }
    const text = ocr.out.trim().slice(0,6000);
    try{ require('fs').unlinkSync(tmpPng); }catch{}
    try{ require('fs').unlinkSync('/tmp/ocr.xwd'); }catch{}
    if(!text) return res.json({ok:false, error:'OCR не нашёл текст'});
    res.json({ok:true, text});
  }catch(e){
    res.json({ok:false, error:e.message});
  }
});
app.get('/api/screenshot', async (req,res)=>{
  const display = process.env.VNC_DISPLAY || ':99';
  const tmpPng = '/tmp/shot_'+Date.now()+'.png';
  try{
    let cap = await ocrRun(`DISPLAY=${display} import -window root ${tmpPng} 2>&1`);
    if(!require('fs').existsSync(tmpPng)) cap = await ocrRun(`DISPLAY=${display} scrot ${tmpPng} 2>&1`);
    if(!require('fs').existsSync(tmpPng)) return res.status(404).send('no screenshot');
    res.sendFile(tmpPng, ()=>{ try{require('fs').unlinkSync(tmpPng);}catch{} });
  }catch(e){ res.status(500).send(e.message); }
});

// ─── GITHUB: browse repos, contents, commits, workflows, builds ───
// All endpoints use GH_TOKEN to call the GitHub REST API directly.
// Provides full repo browsing for the linked GitHub account.
const ghHeaders = () => ({
  Authorization: `Bearer ${runnerToken()}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'zen-panel-hub',
  'X-GitHub-Api-Version': '2022-11-28'
});

// GET /api/gh/repos — all repos for the authenticated user
app.get('/api/gh/repos', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.json({ success: true, repos: [] });
  try {
    const page = parseInt(req.query.page || '1', 10);
    const perPage = Math.min(100, parseInt(req.query.per_page || '50', 10));
    const r = await fetch(
      `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      { headers: ghHeaders() }
    );
    if (!r.ok) return res.json({ success: false, error: `GitHub API ${r.status}` });
    const repos = await r.json();
    res.json({
      success: true,
      repos: repos.map(r => ({
        full_name: r.full_name,
        private: !!r.private,
        description: r.description || '',
        default_branch: r.default_branch,
        updated_at: r.updated_at,
        pushed_at: r.pushed_at,
        language: r.language,
        html_url: r.html_url,
        stargazers_count: r.stargazers_count,
        forks_count: r.forks_count,
        open_issues_count: r.open_issues_count,
        size: r.size,
        topics: r.topics || []
      })),
      page, perPage
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Manifests describe a repo's workspace so CLI agents know exactly where to
// work (clone, tmp, branch) and are told to never touch the OS /tmp.
const manifestFor = (fullName, repoDir, targetDir, tmpDir, ref) => `# Репозиторий: ${fullName}

Рабочая папка этого репозитория на раннере. Всё лежит на виду —
никакие файлы не прячутся в системном /tmp.

- **Клон (работай здесь):** ${targetDir}
- **Ветка:** ${ref || 'main'}
- **Только твои временные файлы (сборки, кеши, артефакты):** ${tmpDir}
- **Манифест:** ${path.join(repoDir, 'MANIFEST.md')}

## Правила для CLI-агентов
1. НИКОГДА не создавай файлы в /tmp или os.tmpdir() — это не твоя папка.
2. Временные файлы создавай ТОЛЬКО в ${tmpDir}.
3. Исходники и изменения делай в ${targetDir}; пуши в git оттуда.
4. GitHub-токен доступен в переменной окружения $GH_TOKEN — никогда не выводи
   и не логируй его значение.
5. Готовые сборки/артефакты клади в ${tmpDir} — их видно вкладкой «Файлы».
`;
const writeRepoManifest = (fullName, repoDir, targetDir, tmpDir, ref) => {
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'MANIFEST.md'), manifestFor(fullName, repoDir, targetDir, tmpDir, ref));
  } catch {}
};

// POST /api/gh/clone — clone a repo into hub-work using the linked GH_TOKEN
app.post('/api/gh/clone', express.json(), async (req, res) => {
  const token = runnerToken();
  if (!token) return res.json({ success: false, error: 'нет GH_TOKEN — привяжи токен в настройках' });
  const { full_name, branch } = req.body;
  if (!full_name || !full_name.includes('/')) return res.json({ success: false, error: 'укажи full_name (user/repo)' });
  const repoName = full_name.split('/')[1];
  const repoDir = path.join(WORK_DIR, repoName);
  const targetDir = path.join(repoDir, 'code');
  const tmpDir = path.join(repoDir, 'tmp');
  writeRepoManifest(full_name, repoDir, targetDir, tmpDir, branch || 'main');
  const cleanUrl = `https://github.com/${full_name}.git`;
  // Auth via credential helper that reads GH_TOKEN from env at call time —
  // the token value is NEVER written to .git/config, only the clean URL is.
  const gitAuth = ['-c', 'credential.username=x-access-token',
    '-c', 'credential.helper=!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'];
  // Already cloned?
  if (fs.existsSync(path.join(targetDir, '.git'))) {
    // Pull latest (the helper was saved by the first clone, runs with env GH_TOKEN)
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('git', ['pull'], { cwd: targetDir, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', d => { out += String(d); });
        child.stderr.on('data', d => { out += String(d); });
        child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(out)));
        child.on('error', reject);
      });
      return res.json({ success: true, path: targetDir, pulled: true });
    } catch (e) {
      return res.json({ success: true, path: targetDir, pulled: false, pullError: e.message });
    }
  }
  const ref = branch || 'main';
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('git', [...gitAuth, 'clone', '--depth', '1', '-b', ref, cleanUrl, targetDir], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      child.stdout.on('data', d => { out += String(d); });
      child.stderr.on('data', d => { out += String(d); });
      child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(out)));
      child.on('error', reject);
    });
    // Verify .git exists
    const gitDir = path.join(targetDir, '.git');
    if (!fs.existsSync(gitDir)) {
      return res.json({ success: false, error: 'clone прошёл, но .git не найден — возможно shallow clone не удался' });
    }
    // Sanity: make sure the token isn't in the remote URL (it never should be)
    try {
      const cfg = fs.readFileSync(path.join(targetDir, '.git', 'config'), 'utf8');
      const originUrl = (cfg.match(/\[remote "origin"\][\s\S]*?url = (.*)/) || [])[1];
      if (originUrl && originUrl.includes('@github.com')) {
        await new Promise((resolve) => {
          const child = spawn('git', ['remote', 'set-url', 'origin', cleanUrl], { cwd: targetDir });
          child.on('close', () => resolve());
        });
      }
    } catch {}
    // Persist the credential helper in the repo config so every later git call
    // (opencode's pull/push included) authenticates from $GH_TOKEN in the env —
    // the helper string references the env var, never the token value.
    await new Promise((resolve) => {
      const child = spawn('git', ['config', 'credential.helper', '!f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f'], { cwd: targetDir });
      child.on('close', () => resolve());
    });
    res.json({ success: true, path: targetDir });
  } catch (e) {
    // Fallback: try without --depth and -b (maybe default branch isn't 'main')
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('git', [...gitAuth, 'clone', cleanUrl, targetDir], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        child.stdout.on('data', d => { out += String(d); });
        child.stderr.on('data', d => { out += String(d); });
        child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(out)));
        child.on('error', reject);
      });
      const gitDir = path.join(targetDir, '.git');
      if (!fs.existsSync(gitDir)) {
        return res.json({ success: false, error: 'clone прошёл, но .git не найден' });
      }
      res.json({ success: true, path: targetDir });
    } catch (e2) {
      res.json({ success: false, error: 'clone не удался: ' + (e2.message || e.message) });
    }
  }
});

// GET /api/gh/token-status — check if a GitHub token is available
app.get('/api/gh/token-status', (req, res) => {
  const token = runnerToken();
  res.json({ success: true, hasToken: !!token, masked: token ? token.slice(0, 6) + '...' + token.slice(-4) : '' });
});

// DELETE /api/gh/delete-repo — delete a repo from the linked account
app.post('/api/gh/delete-repo', express.json(), async (req, res) => {
  const token = runnerToken();
  if (!token) return res.json({ success: false, error: 'нет GH_TOKEN' });
  const { full_name } = req.body;
  if (!full_name || !full_name.includes('/')) return res.json({ success: false, error: 'укажи full_name' });
  try {
    const r = await fetch(`https://api.github.com/repos/${full_name}`, {
      method: 'DELETE',
      headers: ghHeaders()
    });
    if (r.status === 204) return res.json({ success: true });
    const txt = await r.text().catch(() => '');
    res.json({ success: false, error: `GitHub ${r.status}: ${txt.slice(0, 200)}` });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// DELETE /api/gh/delete-file — delete a file in a repo
app.post('/api/gh/delete-file', express.json(), async (req, res) => {
  const token = runnerToken();
  if (!token) return res.json({ success: false, error: 'нет GH_TOKEN' });
  const { full_name, path: filePath, message, branch } = req.body;
  if (!full_name || !filePath) return res.json({ success: false, error: 'укажи full_name и path' });
  try {
    // Get file sha first
    const getUrl = `https://api.github.com/repos/${full_name}/contents/${encodeURI(filePath)}${branch ? '?ref=' + encodeURIComponent(branch) : ''}`;
    const getR = await fetch(getUrl, { headers: ghHeaders() });
    if (!getR.ok) return res.json({ success: false, error: `файл не найден: GitHub ${getR.status}` });
    const fileData = await getR.json();
    const sha = fileData.sha;
    // Delete
    const delUrl = `https://api.github.com/repos/${full_name}/contents/${encodeURI(filePath)}`;
    const body = { message: message || `delete ${filePath}`, sha, branch: branch || undefined };
    const delR = await fetch(delUrl, {
      method: 'DELETE',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (delR.ok || delR.status === 204) return res.json({ success: true });
    const txt = await delR.text().catch(() => '');
    res.json({ success: false, error: `GitHub ${delR.status}: ${txt.slice(0, 200)}` });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// GET /api/gh/download-repo?full_name=user/repo&ref=main — download repo as zip
app.get('/api/gh/download-repo', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'нет GH_TOKEN' });
  const fullName = req.query.full_name;
  const ref = req.query.ref || '';
  if (!fullName) return res.status(400).json({ error: 'укажи full_name' });
  try {
    const url = `https://api.github.com/repos/${fullName}/zipball${ref ? '?ref=' + encodeURIComponent(ref) : ''}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'zen-panel-hub' },
      redirect: 'manual'
    });
    // Follow redirect manually to get the actual download
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const r2 = await fetch(r.headers.get('location'), {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'zen-panel-hub' }
      });
      if (r2.ok) {
        const ct = r2.headers.get('content-type') || 'application/zip';
        const cd = r2.headers.get('content-disposition') || `attachment; filename="${fullName.split('/').pop()}.zip"`;
        res.setHeader('Content-Type', ct);
        res.setHeader('Content-Disposition', cd);
        const buf = Buffer.from(await r2.arrayBuffer());
        res.end(buf);
        return;
      }
    }
    if (r.ok) {
      const ct = r.headers.get('content-type') || 'application/zip';
      const cd = r.headers.get('content-disposition') || `attachment; filename="${fullName.split('/').pop()}.zip"`;
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', cd);
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
      return;
    }
    res.status(r.status).json({ error: `GitHub ${r.status}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/download-release-asset — download a specific release asset or source archive
// ?full_name=user/repo&tag=v1.0&asset_id=123  or  ?full_name=user/repo&tag=v1.0&asset_name=app.apk
// If no asset_id/name → downloads source tarball
app.get('/api/gh/download-release-asset', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'нет GH_TOKEN' });
  const { full_name, tag, asset_id, asset_name } = req.query;
  if (!full_name || !tag) return res.status(400).json({ error: 'укажи full_name и tag' });
  try {
    // If asset_id or asset_name given → find and download the asset
    if (asset_id || asset_name) {
      const relsR = await fetch(`https://api.github.com/repos/${full_name}/releases/tags/${encodeURIComponent(tag)}`, { headers: ghHeaders() });
      if (!relsR.ok) return res.status(relsR.status).json({ error: `релиз не найден: ${relsR.status}` });
      const rel = await relsR.json();
      let asset = null;
      if (asset_id) asset = (rel.assets || []).find(a => String(a.id) === String(asset_id));
      else if (asset_name) asset = (rel.assets || []).find(a => a.name === asset_name);
      if (!asset) return res.status(404).json({ error: 'asset не найден' });
      // Download asset
      const dlR = await fetch(asset.url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream', 'User-Agent': 'zen-panel-hub' },
        redirect: 'manual'
      });
      if (dlR.status >= 300 && dlR.status < 400 && dlR.headers.get('location')) {
        const r2 = await fetch(dlR.headers.get('location'), { headers: { 'User-Agent': 'zen-panel-hub' } });
        if (r2.ok) {
          res.setHeader('Content-Type', r2.headers.get('content-type') || 'application/octet-stream');
          res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`);
          const buf = Buffer.from(await r2.arrayBuffer());
          res.end(buf);
          return;
        }
      }
      if (dlR.ok) {
        res.setHeader('Content-Type', dlR.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`);
        const buf = Buffer.from(await dlR.arrayBuffer());
        res.end(buf);
        return;
      }
      return res.status(dlR.status).json({ error: `GitHub ${dlR.status}` });
    }
    // No asset specified → download source tarball
    const url = `https://api.github.com/repos/${full_name}/tarball/${encodeURIComponent(tag)}`;
    const r = await fetch(url, {
      headers: { ...ghHeaders(), Accept: 'application/vnd.github+json' },
      redirect: 'manual'
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const r2 = await fetch(r.headers.get('location'), { headers: { 'User-Agent': 'zen-panel-hub' } });
      if (r2.ok) {
        res.setHeader('Content-Type', r2.headers.get('content-type') || 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${full_name.split('/').pop()}-${tag}.tar.gz"`);
        const buf = Buffer.from(await r2.arrayBuffer());
        res.end(buf);
        return;
      }
    }
    if (r.ok) {
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${full_name.split('/').pop()}-${tag}.tar.gz"`);
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
      return;
    }
    res.status(r.status).json({ error: `GitHub ${r.status}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/download-file — download any file from a repo by path+ref
// ?full_name=user/repo&path=src/main.js&ref=main
app.get('/api/gh/download-file', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'нет GH_TOKEN' });
  const { full_name, path: filePath, ref } = req.query;
  if (!full_name || !filePath) return res.status(400).json({ error: 'укажи full_name и path' });
  try {
    const q = `?ref=${encodeURIComponent(ref || 'main')}`;
    const r = await fetch(`https://api.github.com/repos/${full_name}/contents/${encodeURI(filePath)}${q}`, {
      headers: { ...ghHeaders(), Accept: 'application/vnd.github.raw' },
      redirect: 'manual'
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const r2 = await fetch(r.headers.get('location'), { headers: { 'User-Agent': 'zen-panel-hub' } });
      if (r2.ok) {
        const fname = filePath.split('/').pop();
        res.setHeader('Content-Type', r2.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        const buf = Buffer.from(await r2.arrayBuffer());
        res.end(buf);
        return;
      }
    }
    if (r.ok) {
      const fname = filePath.split('/').pop();
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
      return;
    }
    res.status(r.status).json({ error: `GitHub ${r.status}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo — repo info
app.get('/api/gh/repos/:owner/:repo', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo } = req.params;
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers: ghHeaders() }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const d = await r.json();
    res.json({
      full_name: d.full_name, private: d.private, description: d.description,
      default_branch: d.default_branch, html_url: d.html_url,
      pushed_at: d.pushed_at, language: d.language,
      stargazers_count: d.stargazers_count, forks_count: d.forks_count,
      open_issues_count: d.open_issues_count, size: d.size,
      topics: d.topics || [], license: d.license && d.license.spdx_id
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo/contents?path=&ref= — browse file tree
app.get('/api/gh/repos/:owner/:repo/contents', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo } = req.params;
    const p = req.query.path || '';
    const ref = req.query.ref || '';
    const q = `?ref=${encodeURIComponent(ref)}`;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(p)}${ref ? q : ''}`;
    const r = await fetch(url, { headers: ghHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    const items = Array.isArray(data) ? data : [data];
    res.json({
      items: items.map(it => ({
        name: it.name, path: it.path, type: it.type,
        size: it.size, sha: it.sha, download_url: it.download_url
      })),
      path: p, repo: `${owner}/${repo}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo/commits — list recent commits
app.get('/api/gh/repos/:owner/:repo/commits', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo } = req.params;
    const perPage = Math.min(100, parseInt(req.query.per_page || '20', 10));
    const path = req.query.path || '';
    let url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=${perPage}`;
    if (path) url += `&path=${encodeURIComponent(path)}`;
    const r = await fetch(url, { headers: ghHeaders() });
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json({
      commits: (Array.isArray(data) ? data : []).map(c => ({
        sha: c.sha && c.sha.slice(0, 7),
        message: (c.commit && c.commit.message || '').split('\n')[0],
        author: c.commit && c.commit.author && c.commit.author.name,
        date: c.commit && c.commit.author && c.commit.author.date,
        html_url: c.html_url
      })),
      repo: `${owner}/${repo}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo/branches — list branches
app.get('/api/gh/repos/:owner/:repo/branches', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo } = req.params;
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=50`,
      { headers: ghHeaders() }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json({
      branches: data.map(b => ({ name: b.name, sha: b.commit && b.commit.sha })),
      repo: `${owner}/${repo}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo/workflows — list workflows
app.get('/api/gh/repos/:owner/:repo/workflows', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo } = req.params;
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows?per_page=30`,
      { headers: ghHeaders() }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json({
      workflows: (data.workflows || []).map(w => ({
        id: w.id, name: w.name, path: w.path, state: w.state,
        updated_at: w.updated_at, html_url: w.html_url
      })),
      repo: `${owner}/${repo}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo/runs — list recent workflow runs
app.get('/api/gh/repos/:owner/:repo/runs', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo } = req.params;
    const perPage = Math.min(100, parseInt(req.query.per_page || '20', 10));
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`,
      { headers: ghHeaders() }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json({
      runs: (data.workflow_runs || []).map(r => ({
        id: r.id, name: r.name, status: r.status, conclusion: r.conclusion,
        html_url: r.html_url, created_at: r.created_at,
        run_number: r.run_number, head_branch: r.head_branch
      })),
      repo: `${owner}/${repo}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo/runs/:runId/artifacts — list artifacts for a run
app.get('/api/gh/repos/:owner/:repo/runs/:runId/artifacts', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo, runId } = req.params;
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
      { headers: ghHeaders() }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json({
      artifacts: (data.artifacts || []).map(a => ({
        id: a.id, name: a.name, size_in_bytes: a.size_in_bytes,
        created_at: a.created_at, expired: a.expired,
        archive_download_url: a.archive_download_url
      })),
      repo: `${owner}/${repo}`, runId
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo/artifacts/:id/download — download artifact
// Proxies the GitHub artifact download URL through the hub server so the
// user's device can download the build artifact without CORS issues.
app.get('/api/gh/repos/:owner/:repo/artifacts/:id/download', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo, id } = req.params;
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${id}/zip`,
      { headers: ghHeaders(), redirect: 'follow' }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="artifact-${id}.zip"`);
    const buffer = await r.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/gh/repos/:owner/:repo/releases — list releases
app.get('/api/gh/repos/:owner/:repo/releases', async (req, res) => {
  const token = runnerToken();
  if (!token) return res.status(401).json({ error: 'no GH_TOKEN' });
  try {
    const { owner, repo } = req.params;
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`,
      { headers: ghHeaders() }
    );
    if (!r.ok) return res.status(r.status).json({ error: await r.text() });
    const data = await r.json();
    res.json({
      releases: (Array.isArray(data) ? data : []).map(rel => ({
        tag_name: rel.tag_name, name: rel.name, created_at: rel.created_at,
        html_url: rel.html_url, draft: rel.draft, prerelease: rel.prerelease,
        assets: (rel.assets || []).map(a => ({
          name: a.name, size: a.size, browser_download_url: a.browser_download_url,
          content_type: a.content_type
        }))
      })),
      repo: `${owner}/${repo}`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TUNNEL STATE ───
let tunnelInfo = null; // { url, type, close }

// ─── START ───
// One attempt at a time: each listen() call stacks its own 'listening'
// callback on the shared server object, so a failed attempt left its callback
// attached and the successful retry fired BOTH onReady(oldPort) and
// onReady(newPort) - measured: double startup banner, and in --tunnel mode
// that would open two tunnels. Remove the previous attempt's listeners before
// retrying.
function tryListen(port, onReady) {
  const ready = () => onReady(port, server);
  const onError = (err) => {
    if (err.code === 'EADDRINUSE') {
      const next = Number(port) + 1;
      console.log(`  ⚠ Port ${port} is busy, trying ${next}...`);
      server.removeListener('listening', ready);
      server.removeListener('error', onError);
      tryListen(next, onReady);
    } else {
      console.error(`  ❌ Server error: ${err.message}`);
      process.exit(1);
    }
  };
  server.once('listening', ready);
  server.on('error', onError);
  server.listen(port, HOST);
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

  // Keep a readable copy of the opencode chat history in ~/.local/share/
  // opencode/history/ (a stable dir outside /tmp, which the OS may clean at
  // any moment) — run once at startup, then daily while the hub lives.
  // PUBLISH=1 + GH_TOKEN pushes a bundle to the session-state branch too.
  const backupHistory = (first) => {
    const { spawn } = require('child_process');
    const script = path.join(__dirname, '..', '..', 'tools', 'backup-chat-history.sh');
    if (!fs.existsSync(script)) return;
    const child = spawn('bash', [script], {
      env: { ...process.env, PUBLISH: '1' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    child.on('error', () => {});
    if (first) console.log('  💾 Chat-history backup scheduled (daily).');
  };
  backupHistory(true);
  setInterval(() => backupHistory(false), 24 * 60 * 60 * 1000);
}

// ─── ALWAYS-ON DESKTOP ───
// The screen must be there before anyone asks for it: vnc-keepalive starts the
// Xvfb/openbox/x11vnc/websockify stack on THIS runner, proxies it under
// /novnc + /ws/desktop, paints the wallpaper/shortcuts and repairs it every
// 15 s. Started before the listener so the proxy is registered on `server`.
let vncKeeper = null;
try {
  vncKeeper = require('./vnc-keepalive').start({
    repoRoot: GIT_ROOT,
    app,
    server,
    port: PORT,
    log: (m) => console.log('  🖥 ' + m)
  });
  console.log('  🖥 Always-on desktop: ' + JSON.stringify(vncKeeper.status().note));
} catch (e) {
  console.log('  🖥 vnc-keepalive не запустился: ' + e.message);
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

// ─── PULSE AUDIO AUTO-START ───
(async () => {
  try {
    const check = await pulseRun('pulseaudio --check 2>&1; echo $?');
    if (!check.out.endsWith('0')) {
      console.log('  🔊 Starting PulseAudio daemon...');
      await pulseRun('pulseaudio --start --disallow-exit --exit-idle-time=-1 2>&1');
      console.log('  🔊 PulseAudio started');
    } else {
      console.log('  🔊 PulseAudio already running');
      await pulseRun('pactl set-exit-idle-time -1 2>/dev/null');
    }
    // Create virtual sinks for hub tabs (cloud phone, browser, etc.) — only
    // if not present yet, so repeated hub restarts don't stack duplicate sinks.
    const sinks = ['cloud_phone', 'browser_youtube'];
    for (const name of sinks) {
      await pulseRun(`pactl load-module module-null-sink sink_name=${name} sink_properties=device.description="Hub-${name}" 2>/dev/null || true`);
    }
    // Load loopback so any audio on these sinks is audible
    await pulseRun('pactl load-module module-loopback source=cloud_phone.monitor 2>/dev/null || true');
    await pulseRun('pactl load-module module-loopback source=browser_youtube.monitor 2>/dev/null || true');
    console.log('  🔊 Virtual audio sinks ready: cloud_phone, browser_youtube');
  } catch {}
})();

process.on('SIGINT', () => {
  stopTmuxPollers();
  sessions.forEach(s => { if (s.pty) { try { s.pty.kill(); } catch {} } });
  if (tunnelInfo && tunnelInfo.close) tunnelInfo.close();
  server.close();
  process.exit(0);
});
