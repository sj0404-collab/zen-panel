'use strict';
/**
 * Built-in local GGUF runtime for the hub.
 *
 * The optional ../lib/local-ai package is not shipped in this repo. Without
 * this file the hub showed a download button that always failed with
 * "local-ai module not installed". Here: download a listed GGUF from
 * Hugging Face, optionally start llama-server, and chat through it.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const CATALOG = [
  { id: 'qwen2.5-1.5b-instruct-q4', name: 'Qwen2.5 1.5B Q4', sizeMb: 1100, ctx: 32768,
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf' },
  { id: 'qwen2.5-3b-instruct-q4', name: 'Qwen2.5 3B Q4', sizeMb: 2000, ctx: 32768,
    repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF', file: 'qwen2.5-3b-instruct-q4_k_m.gguf' },
  { id: 'llama-3.2-3b-instruct-q4', name: 'Llama 3.2 3B Q4', sizeMb: 2000, ctx: 131072,
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf' },
  { id: 'gemma-2-2b-it-q4', name: 'Gemma 2 2B IT Q4', sizeMb: 1700, ctx: 8192,
    repo: 'bartowski/gemma-2-2b-it-GGUF', file: 'gemma-2-2b-it-Q4_K_M.gguf' }
];

function hfToken() {
  return process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '';
}

function curlBin() {
  if (process.platform === 'win32') {
    const p = 'C:\\Windows\\System32\\curl.exe';
    return fs.existsSync(p) ? p : 'curl';
  }
  return 'curl';
}

class LocalAiManager {
  constructor(opts = {}) {
    this._storageRoot = opts.storageRoot;
    this._logger = opts.logger || console;
    this._serving = null;
    this._child = null;
    this._tasks = new Map();
  }

  _base() {
    const root = typeof this._storageRoot === 'function' ? this._storageRoot() : (this._storageRoot || process.cwd());
    return path.join(root, '.zen-agent');
  }
  root() { return path.join(this._base(), 'models'); }
  runtimeRoot() { return path.join(this._base(), 'llama'); }

  catalog() {
    return CATALOG.map(m => {
      const dest = path.join(this.root(), m.file);
      let size = 0;
      try { if (fs.existsSync(dest)) size = fs.statSync(dest).size; } catch {}
      return { ...m, downloaded: size > 1024 * 1024, bytes: size };
    });
  }
  runtimeCatalog() { return []; }
  listModels() { return this.catalog().filter(m => m.downloaded); }
  listRuntimes() { return this._runtimeBin() ? [{ id: 'llama.cpp', path: this._runtimeBin() }] : []; }
  task(id) { return this._tasks.get(id) || null; }

  publicConfig() {
    return {
      available: true,
      storagePath: this.root(),
      activeEngine: 'llama.cpp',
      selectedModel: this._serving && this._serving.modelId,
      serving: this._serving,
      engines: { 'llama.cpp': { model: (this._serving && this._serving.modelId) || '' } }
    };
  }

  async status() {
    const models = this.listModels();
    return {
      success: true,
      available: true,
      runtimeInstalled: !!this._runtimeBin(),
      modelsDownloaded: models.length,
      serving: this._serving,
      hfTokenConfigured: !!hfToken(),
      storagePath: this.root()
    };
  }

  _runtimeBin() {
    const dir = this.runtimeRoot();
    const names = process.platform === 'win32'
      ? ['llama-server.exe', 'llama-cli.exe']
      : ['llama-server', 'llama-cli'];
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
    try {
      const which = process.platform === 'win32' ? 'where' : 'which';
      const out = execFileSync(which, ['llama-server'], { encoding: 'utf8', timeout: 3000 }).trim().split(/\r?\n/)[0];
      if (out && fs.existsSync(out)) return out;
    } catch {}
    return null;
  }

  _curl(args, timeoutMs) {
    return execFileSync(curlBin(), args, { timeout: timeoutMs || 600000, maxBuffer: 8 * 1024 * 1024 });
  }

  async download(spec) {
    const id = spec && (spec.modelId || spec.id);
    const item = CATALOG.find(m => m.id === id);
    if (!item) return { success: false, error: 'Неизвестная модель: ' + id };
    fs.mkdirSync(this.root(), { recursive: true });
    const dest = path.join(this.root(), item.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
      return { success: true, modelId: item.id, path: dest, already: true };
    }
    const url = `https://huggingface.co/${item.repo}/resolve/main/${item.file}`;
    const args = ['-fL', '--retry', '3', '-C', '-', '-o', dest];
    const tok = hfToken();
    if (tok) args.push('-H', 'Authorization: Bearer ' + tok);
    args.push(url);
    this._logger.log && this._logger.log('[local-ai] downloading ' + url);
    try {
      this._curl(args, 30 * 60 * 1000);
    } catch (e) {
      try { fs.unlinkSync(dest); } catch {}
      return { success: false, error: 'Не удалось скачать ' + item.file + ': ' + (e.message || e) };
    }
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024 * 1024) {
      return { success: false, error: 'Файл скачался пустым. Для закрытых моделей нужен HF_TOKEN.' };
    }
    return { success: true, modelId: item.id, path: dest, bytes: fs.statSync(dest).size };
  }

  async startDownload(spec) { return this.download(spec); }
  async startRuntimeDownload() { return this._ensureRuntime(); }
  async installRuntimeToTermux() { return this._ensureRuntime(); }
  async remove(spec) {
    const id = spec && (spec.modelId || spec.id);
    const item = CATALOG.find(m => m.id === id);
    if (!item) return { success: false, error: 'unknown model' };
    try { fs.unlinkSync(path.join(this.root(), item.file)); } catch {}
    return { success: true };
  }

  async _ensureRuntime() {
    const existing = this._runtimeBin();
    if (existing) return { success: true, path: existing };
    fs.mkdirSync(this.runtimeRoot(), { recursive: true });
    let assets;
    try {
      const raw = this._curl(['-fsSL', 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest'], 30000);
      assets = (JSON.parse(raw.toString('utf8')).assets || []).map(a => a.browser_download_url);
    } catch (e) {
      return { success: false, error: 'Не удалось получить список llama.cpp: ' + (e.message || e) };
    }
    const want = process.platform === 'win32'
      ? assets.find(u => /win.*x64|ubuntu-x64|bin-win/i.test(u) && /llama/i.test(u) && /\.zip$/i.test(u))
      : assets.find(u => /ubuntu-x64|bin-ubuntu|linux-x64/i.test(u) && /\.(tar\.gz|zip)$/i.test(u));
    if (!want) return { success: false, error: 'В релизе llama.cpp нет архива для этой ОС.' };
    const archive = path.join(this.runtimeRoot(), path.basename(want));
    try {
      this._curl(['-fL', '--retry', '3', '-o', archive, want], 10 * 60 * 1000);
    } catch (e) {
      return { success: false, error: 'Не удалось скачать llama.cpp: ' + (e.message || e) };
    }
    try {
      if (/\.zip$/i.test(archive)) execFileSync('unzip', ['-o', archive, '-d', this.runtimeRoot()], { timeout: 60000 });
      else execFileSync('tar', ['-xzf', archive, '-C', this.runtimeRoot()], { timeout: 60000 });
    } catch (e) {
      return { success: false, error: 'Не удалось распаковать llama.cpp: ' + (e.message || e) };
    }
    const found = this._findBin(this.runtimeRoot(), process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
    if (!found) return { success: false, error: 'В архиве нет llama-server.' };
    try { fs.chmodSync(found, 0o755); } catch {}
    const dest = path.join(this.runtimeRoot(), path.basename(found));
    if (found !== dest) {
      try { fs.copyFileSync(found, dest); fs.chmodSync(dest, 0o755); } catch {}
    }
    return { success: true, path: this._runtimeBin() };
  }

  _findBin(dir, name) {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === name) return full;
      }
    }
    return null;
  }

  async start(spec) {
    const id = spec && (spec.modelId || spec.id);
    const item = CATALOG.find(m => m.id === id);
    if (!item) return { success: false, error: 'Неизвестная модель' };
    const modelPath = path.join(this.root(), item.file);
    if (!fs.existsSync(modelPath)) return { success: false, error: 'Сначала скачайте модель.' };
    const runtime = await this._ensureRuntime();
    if (!runtime.success) return runtime;
    await this.stop();
    const port = parseInt(process.env.ZEN_LOCAL_AI_PORT || '8791', 10) || 8791;
    const bin = this._runtimeBin();
    const args = ['-m', modelPath, '--port', String(port), '--host', '127.0.0.1', '-c', String(Math.min(item.ctx, 8192))];
    const log = path.join(this.runtimeRoot(), 'server.log');
    const fd = fs.openSync(log, 'a');
    this._child = spawn(bin, args, { detached: process.platform !== 'win32', stdio: ['ignore', fd, fd] });
    this._child.unref();
    fs.closeSync(fd);
    const up = await this._waitHttp(port, 60);
    if (!up) return { success: false, error: 'llama-server не ответил. Лог: ' + log };
    this._serving = { modelId: item.id, port, path: modelPath };
    return { success: true, modelId: item.id, port };
  }

  async _waitHttp(port, seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const ok = await new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, res => {
          res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  async stop() {
    if (this._child) {
      try { this._child.kill('SIGTERM'); } catch {}
      this._child = null;
    }
    this._serving = null;
    return { success: true };
  }

  async prepare(body) {
    const id = body && (body.modelId || body.id);
    const got = await this.download({ modelId: id });
    if (!got.success) return got;
    const started = await this.start({ modelId: id });
    if (!started.success) {
      return { success: true, modelId: id, path: got.path, port: null, warning: started.error };
    }
    return started;
  }

  configure() { return { success: true }; }
  updateConfig() { return { success: true }; }

  async chat({ messages, model, temperature, max_tokens }) {
    if (!this._serving) return { success: false, error: 'Локальная модель не запущена. Сначала «Скачать и запустить».' };
    const payload = JSON.stringify({
      model: model || this._serving.modelId,
      messages: messages || [],
      temperature: temperature ?? 0.5,
      max_tokens: max_tokens || 2048,
      stream: false
    });
    return await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: this._serving.port, path: '/v1/chat/completions',
        method: 'POST', timeout: 120000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            const text = json.choices?.[0]?.message?.content || '';
            resolve({ success: true, text, model: json.model || this._serving.modelId, usage: json.usage || {} });
          } catch {
            resolve({ success: false, error: 'Локальная модель вернула не JSON: ' + raw.slice(0, 200) });
          }
        });
      });
      req.on('error', e => resolve({ success: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'local timeout' }); });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { LocalAiManager };
