#!/usr/bin/env node
// Server-side GitHub client for the panel UI.
//
// Professional split: the browser holds only the gate token (?zt=, enforced
// by the hub gate in server.js); the GitHub PAT lives here, in GH_TOKEN, and
// never transits to the browser. One polite client with a shared ETag cache
// instead of every phone burning quota with its own polls.
//
// Pure-ish by design: fetchImpl is injected so tests run without network.
const GH = 'https://api.github.com';
const etags = new Map(); // GET key -> { etag, body }

function serverToken() { return process.env.GH_TOKEN || ''; }
function resetCache() { etags.clear(); }

const RE_NAME = /^[A-Za-z0-9_.-]+$/;
function cleanRepo(owner, repo) {
  if (!RE_NAME.test(owner || '') || !RE_NAME.test(repo || '')) return null;
  return `${owner}/${repo}`;
}

// Method + path allowlist. Anything else is rejected before touching GitHub.
function allow(method, parts) {
  const p = parts.join('/');
  if (method === 'GET' && p === 'user') return 'user';
  if (method === 'GET' && p === 'user/repos') return 'user/repos';
  if (method === 'GET' && p === 'rate_limit') return 'rate_limit';
  let m;
  if ((m = /^repos\/([^/]+)\/([^/]+)\/actions\/runs$/.exec(p)) && method === 'GET') {
    const r = cleanRepo(m[1], m[2]);
    return r && `repos/${r}/actions/runs`;
  }
  if ((m = /^repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(p)) && method === 'GET') {
    const r = cleanRepo(m[1], m[2]);
    return r && `repos/${r}/actions/runs/${m[3]}/jobs`;
  }
  if ((m = /^repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/.exec(p)) && method === 'POST') {
    const r = cleanRepo(m[1], m[2]);
    if (!r || !/^[\w.-]+\.yml$/.test(m[3])) return null;
    return `repos/${r}/actions/workflows/${m[3]}/dispatches`;
  }
  if ((m = /^repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/cancel$/.exec(p)) && method === 'POST') {
    const r = cleanRepo(m[1], m[2]);
    return r && `repos/${r}/actions/runs/${m[3]}/cancel`;
  }
  if ((m = /^repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(p)) && method === 'GET') {
    const r = cleanRepo(m[1], m[2]);
    const file = m[3];
    if (!r || file.includes('..') || /[\\]/.test(file)) return null;
    return `repos/${r}/contents/${file}`;
  }
  return null;
}

function errMessage(status) {
  if (status === 401) return '401: серверный GitHub-токен недействителен.';
  if (status === 403) return '403: нет прав или лимит GitHub.';
  if (status === 429) return '429: GitHub притормозил сервер — подождите минуту.';
  if (status === 404) return '404: нет такого.';
  return 'HTTP ' + status;
}

// GET query allowlist per endpoint family (everything else is dropped).
function cleanQuery(path, query) {
  const q = query || {};
  const out = {};
  const pick = (...keys) => { for (const k of keys) if (q[k] !== undefined) out[k] = String(q[k]).slice(0, 64); };
  if (path === 'user/repos') pick('per_page', 'sort', 'type');
  else if (path.endsWith('/actions/runs')) pick('per_page');
  else if (path.includes('/contents/')) pick('ref');
  return out;
}

async function request(method, sub, { query, body, fetchImpl } = {}) {
  const token = serverToken();
  if (!token) {
    const e = new Error('501: на сервере нет GH_TOKEN — перезапустите хаб с токеном.');
    e.status = 501;
    throw e;
  }
  const parts = String(sub || '').split('/').filter(Boolean);
  const target = allow(method, parts);
  if (!target) {
    const e = new Error('400: запрос не разрешён.');
    e.status = 400;
    throw e;
  }
  const fetchFn = fetchImpl || fetch;
  const qs = new URLSearchParams(cleanQuery(target, query)).toString();
  const url = GH + '/' + target + (qs ? '?' + qs : '');
  const headers = { Accept: 'application/vnd.github+json', Authorization: 'token ' + token };
  const key = method === 'GET' ? url : null;
  const slot = key && etags.get(key);
  if (slot && slot.etag) headers['If-None-Match'] = slot.etag;
  let payload = body;
  // Dynasty rule: a hub run launched through the proxy inherits the server
  // token, so the browser never sees it and the next run still proxies.
  if (method === 'POST' && target.endsWith('/hub.yml/dispatches') && payload && typeof payload === 'object') {
    payload = { ...payload, inputs: { ...(payload.inputs || {}), gh_token: token } };
  }
  const r = await fetchFn(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (r.status === 304 && slot) return { status: 200, body: slot.body, cached: true };
  if (r.status === 204) return { status: 204, body: null };
  if (!r.ok) {
    const e = new Error(errMessage(r.status));
    e.status = r.status;
    throw e;
  }
  const data = await r.json();
  try {
    const et = r.headers && r.headers.get && r.headers.get('etag');
    if (key && et) etags.set(key, { etag: et, body: data });
  } catch (e) { /* cache is best-effort */ }
  return { status: r.status, body: data, cached: false };
}

module.exports = { request, allow, cleanQuery, errMessage, serverToken, resetCache };
