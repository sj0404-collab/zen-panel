'use strict';
/**
 * Cloud persistence for things the 6-hour CI runner cannot keep between runs:
 *   - chat sessions / settings            (ZEN_CLOUD_SYNC=1)
 *   - downloaded local models / installs  (ZEN_CLOUD_MODELS=1)
 *
 * Why: the panel and agent run on an ephemeral Linux/Windows runner that is
 * destroyed after ~6h. Anything written to the local disk (sessions file, a
 * downloaded GGUF, an npm install) is gone on the next run. This module mirrors
 * that state to GitHub and restores it at startup.
 *
 * Design:
 *   - Sessions  -> a small JSON committed to `zen-data/sessions.json` on a
 *                  dedicated branch (default `zen-data`), NOT main, so it never
 *                  re-triggers the main workflows.
 *   - Models    -> large binaries stored as GitHub **Release** assets (the
 *                  /contents API caps out ~100MB and bloats the repo); keyed by
 *                  a hash of the blob so reuse is verified.
 *
 * Both are off by default and only activate when the env flag is set, so local
 * / self-contained use (no token) is unaffected. The GITHUB_TOKEN already
 * present on the runner is used; a PAT can be supplied via ZEN_CLOUD_TOKEN.
 */
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function env(name, fb = '') { const v = (process.env[name] || '').trim(); return v || fb; }
function enabled(which) { return env(which) === '1'; }
function token() { return env('ZEN_CLOUD_TOKEN', env('GITHUB_TOKEN', env('GH_TOKEN'))); }
function repo() { return env('ZEN_CLOUD_REPO', env('GITHUB_REPOSITORY')); }
function ownerRepo(repoFull) {
  const r = String(repoFull || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').split('/');
  return r.length >= 2 ? { owner: r[0], repo: r[1] } : null;
}
function branch() { return env('ZEN_CLOUD_BRANCH', 'zen-data'); }
function sessionsRepoPath() { return env('ZEN_CLOUD_SESSIONS_PATH', 'zen-data/sessions.json'); }

function request(method, url, body, headers = {}) {
  const tok = token();
  if (!tok) return Promise.reject(new Error('Нет GitHub-токена для облачного стора (ZEN_CLOUD_TOKEN или GITHUB_TOKEN).'));
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + tok,
    'User-Agent': 'zen-panel-cloud-store',
    'X-GitHub-Api-Version': '2022-11-28',
    ...headers
  };
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h, timeout: 25000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = raw;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        const msg = (data && (data.message || data.error)) || raw.slice(0, 200) || ('HTTP ' + res.statusCode);
        reject(new Error(msg));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Cloud store timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Sessions ──────────────────────────────────────────────────────────────
function sessionApiPath() {
  const { owner, repo: r } = ownerRepo(repo());
  if (!owner || !r) throw new Error('Укажи ZEN_CLOUD_REPO или GITHUB_REPOSITORY как owner/repo.');
  return `/repos/${owner}/${r}/contents/${encodeURI(sessionsRepoPath())}?ref=${encodeURIComponent(branch())}`;
}
async function restoreSessions() {
  if (!enabled('ZEN_CLOUD_SYNC')) return null;
  try {
    const data = await request('GET', 'https://api.github.com' + sessionApiPath());
    if (!data || !data.content) return null;
    const json = Buffer.from(String(data.content).replace(/\n/g, ''), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) { console.log('[cloud-store] restoreSessions: ' + e.message); return null; }
}
async function ensureBranch() {
  const { owner, repo: r } = ownerRepo(repo());
  try {
    await request('GET', `https://api.github.com/repos/${owner}/${r}/branches/${encodeURIComponent(branch())}`);
    return true;
  } catch {}
  // Create from the default branch HEAD so a fresh runner can always push.
  try {
    const rep = await request('GET', `https://api.github.com/repos/${owner}/${r}`);
    const base = rep.default_branch || 'main';
    const ref = await request('GET', `https://api.github.com/repos/${owner}/${r}/git/ref/heads/${encodeURIComponent(base)}`);
    const sha = ref && ref.object && ref.object.sha;
    if (!sha) return false;
    await request('POST', `https://api.github.com/repos/${owner}/${r}/git/refs`, { ref: 'refs/heads/' + branch(), sha });
    return true;
  } catch (e) { console.log('[cloud-store] ensureBranch: ' + e.message); return false; }
}
async function backupSessions(payload) {
  if (!enabled('ZEN_CLOUD_SYNC')) return;
  const content = Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64');
  await ensureBranch();
  const pathBase = `https://api.github.com/repos/${ownerRepo(repo()).owner}/${ownerRepo(repo()).repo}/contents/${encodeURI(sessionsRepoPath())}`;
  let sha = null;
  try { const cur = await request('GET', pathBase + '?ref=' + encodeURIComponent(branch())); if (cur && cur.sha) sha = cur.sha; } catch {}
  const body = { message: 'zen-panel: sessions backup ' + new Date().toISOString(), content, branch: branch() };
  if (sha) body.sha = sha;
  try { await request('PUT', pathBase, body); console.log('[cloud-store] sessions backed up to ' + branch()); }
  catch (e) { console.log('[cloud-store] backupSessions: ' + e.message); }
}

// ── Model / install blob cache (GitHub Release assets) ────────────────────
function sha256Of(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function releaseTag() { return env('ZEN_CLOUD_MODELS_RELEASE', 'zen-model-cache'); }
async function latestReleaseId() {
  const { owner, repo: r } = ownerRepo(repo());
  try {
    const rel = await request('GET', `https://api.github.com/repos/${owner}/${r}/releases/tags/${encodeURIComponent(releaseTag())}`);
    return rel && rel.id;
  } catch {}
  try {
    const rel = await request('POST', `https://api.github.com/repos/${owner}/${r}/releases`, { tag_name: releaseTag(), name: 'Zen model cache', draft: false, prerelease: true, generate_release_notes: false });
    return rel && rel.id;
  } catch (e) { console.log('[cloud-store] create release: ' + e.message); return null; }
}
async function putBlob(filePath, label) {
  if (!enabled('ZEN_CLOUD_MODELS')) return null;
  const buf = fs.readFileSync(filePath);
  const hash = sha256Of(buf);
  const id = await latestReleaseId();
  if (!id) return null;
  const name = (label || path.basename(filePath)).replace(/[^A-Za-z0-9._-]/g, '_') + '.' + hash.slice(0, 12) + '.cache';
  try {
    await request('POST', `https://api.github.com/repos/${ownerRepo(repo()).owner}/${ownerRepo(repo()).repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, buf, { 'Content-Type': 'application/octet-stream' });
    return name;
  } catch (e) { console.log('[cloud-store] putBlob: ' + e.message); return null; }
}
async function getBlob(name, destPath) {
  if (!enabled('ZEN_CLOUD_MODELS')) return false;
  const { owner, repo: r } = ownerRepo(repo());
  try {
    const rel = await request('GET', `https://api.github.com/repos/${owner}/${r}/releases/tags/${encodeURIComponent(releaseTag())}`);
    const asset = (rel && rel.assets || []).find(a => a.name === name);
    if (!asset || !asset.browser_download_url) return false;
    // Asset download needs the same URL form; use https request to a public download URL.
    const buf = await binaryGet(asset.url);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return true;
  } catch (e) { console.log('[cloud-store] getBlob: ' + e.message); return false; }
}
function binaryGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { Accept: 'application/octet-stream', 'User-Agent': 'zen-panel-cloud-store', Authorization: 'Bearer ' + token() } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(Buffer.concat(chunks));
        reject(new Error('HTTP ' + res.statusCode));
      });
    }).on('error', reject);
  });
}

module.exports = { restoreSessions, backupSessions, putBlob, getBlob, enabled };
