// Panel UI: the Zen Panel tabs (minus APK), served by the hub itself.
// The browser holds only ?zt=; the GitHub PAT lives on the server and every
// GitHub call goes through the /gh proxy (see src/gh-proxy.js).
var __zt = null;
try { __zt = new URLSearchParams(location.search).get('zt'); } catch (e) { __zt = null; }
if (__zt && typeof window !== 'undefined' && !window.__ztWrapped) {
  window.__ztWrapped = true;
  const __fetch0 = window.fetch.bind(window);
  window.fetch = function (u, o) {
    if (typeof u === 'string' && (u.indexOf('/gh') === 0 || u.indexOf('/api') === 0)) {
      u += (u.indexOf('?') === -1 ? '?' : '&') + 'zt=' + encodeURIComponent(__zt);
    }
    return __fetch0(u, o);
  };
}
function showBootBanner(text) {
  let b = document.getElementById('boot-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'boot-banner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;' +
      'background:#7a2e2e;color:#fff;font:13px/1.4 sans-serif;padding:10px 12px';
    b.onclick = () => b.remove();
    document.body.prepend(b);
  }
  b.textContent = text;
}

const REPO = 'sj0404-collab/zen-panel';
const $ = id => document.getElementById(id);
const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
function fmtAge(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'только что';
  if (m < 60) return m + ' мин назад';
  return Math.round(m / 60) + ' ч назад';
}
function genZt() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, ''); } catch (e) {}
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
  return s;
}
// Gate tokens of hubs launched from here (per slot). Same key as Zen Panel.
let HUB_TOKENS = {};
try { HUB_TOKENS = JSON.parse(localStorage.getItem('panel_hub_tokens') || '{}'); } catch (e) { HUB_TOKENS = {}; }
function saveHubTokens() { try { localStorage.setItem('panel_hub_tokens', JSON.stringify(HUB_TOKENS)); } catch (e) {} }

async function gh(sub, opts) {
  const o = opts || {};
  const r = await fetch('/gh/' + sub, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  if (r.status === 204) return null;
  const j = await r.json();
  if (!j || j.success !== true) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j.data;
}
async function apiPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!j || j.success !== true) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

const loaded = {};
function switchTab(name) {
  for (const t of ['acc', 'repo', 'act', 'sess']) {
    $('p-' + t).classList.toggle('on', t === name);
    $('t-' + t).classList.toggle('on', t === name);
  }
  if (!loaded[name]) {
    loaded[name] = true;
    ({ acc: renderAccount, repo: renderRepos, act: renderActions, sess: renderSessions })[name]();
  }
}

// ── Аккаунт ──
async function renderAccount() {
  const box = $('p-acc');
  box.innerHTML = '<div class="spin">Читаю аккаунт…</div>';
  try {
    const [u, rl] = await Promise.all([gh('user'), gh('rate_limit').catch(() => null)]);
    const lim = rl && rl.resources && rl.resources.core;
    box.innerHTML = `<div class="card"><div class="row">
        <div style="font-size:20px;font-weight:800">${escHtml(u.login || '?')}</div>
        <span class="badge ok">токен на сервере</span></div>
      <div class="note">${escHtml(u.name || '')} · ${escHtml(u.email || 'email скрыт')}</div>
      <div class="kv"><div class="k">Лимит</div><div>${lim ? `${lim.remaining}/${lim.limit}` : '—'}</div></div>
      <div class="kv"><div class="k">Репо</div><div>${escHtml(String(u.public_repos ?? '—'))} публичных</div></div>
      </div>
      <div class="note">Браузер PAT не видит: все запросы к GitHub идут через сервер.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="card">Не вышло: ${escHtml(e.message)}</div>`;
    showBootBanner('Аккаунт: ' + e.message);
  }
}

// ── Репо ──
async function renderRepos() {
  const box = $('p-repo');
  box.innerHTML = '<div class="spin">Читаю репозитории…</div>';
  try {
    const repos = await gh('user/repos?per_page=100&sort=updated');
    box.innerHTML = `<div class="row" style="margin-bottom:10px">
        <div class="note">${repos.length} репо</div>
        <button class="ghost small" onclick="loaded.repo=false;switchTab('repo')">↻</button></div>` +
      repos.map(r => `<div class="card"><div class="row">
        <div style="font-weight:700">${escHtml(r.full_name)}</div>
        ${r.private ? '<span class="badge">PRIVATE</span>' : ''}
        ${r.permissions && r.permissions.push ? '<span class="badge ok">push</span>' : '<span class="badge">read</span>'}
        </div>
        <div class="note">${escHtml(r.language || '')} · ★ ${r.stargazers_count} · ${escHtml('обн. ' + fmtAge(r.updated_at))}</div>
        <div class="row" style="margin-top:8px">
          <button class="small" onclick="repoOpen('${escAttr(r.full_name)}','${escAttr(r.default_branch || 'main')}',this)">Открыть в хабе</button>
        </div></div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="card">Не вышло: ${escHtml(e.message)}</div>`;
  }
}
async function repoOpen(full, branch, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Клонирую…'; }
  try {
    // No token from the browser: the server clones with its own GH_TOKEN.
    const r = await apiPost('/api/git/clone', { repo: full, branch });
    alert(`Готово: ${r.path || full}${r.existed ? ' (уже было)' : ''}\n\nТерминал с этой папкой — во вкладке хаба /m.`);
    if (btn) { btn.textContent = 'Открыто ✓'; }
  } catch (e) {
    alert('Не вышло: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Открыть в хабе'; }
  }
}

// ── Actions ──
async function renderActions() {
  const box = $('p-act');
  box.innerHTML = '<div class="spin">Читаю раны…</div>';
  try {
    const d = await gh(`repos/${REPO}/actions/runs?per_page=20`);
    const runs = d.workflow_runs || [];
    box.innerHTML = `<div class="row" style="margin-bottom:10px">
        <button class="ghost small" onclick="loaded.act=false;switchTab('act')">↻ Обновить</button></div>` +
      (runs.map(r => {
        const live = r.status !== 'completed';
        const badge = live ? '<span class="badge run">' + escHtml(r.status) + '</span>'
          : (r.conclusion === 'success' ? '<span class="badge ok">success</span>' : `<span class="badge bad">${escHtml(r.conclusion || '?')}</span>`);
        return `<div class="card"><div class="row">
          <div style="font-weight:700">${escHtml(r.name)}</div>
          <span class="note">#${r.run_number}</span>${badge}</div>
          <div class="note">${escHtml(fmtAge(r.created_at))}</div>
          ${live ? `<div class="row" style="margin-top:8px">
            <button class="small warn" onclick="cancelRun(${r.id},this)">Выключить</button></div>` : ''}</div>`;
      }).join('') || '<div class="card">Ранов нет.</div>');
  } catch (e) {
    box.innerHTML = `<div class="card">Не вышло: ${escHtml(e.message)}</div>`;
  }
}
async function cancelRun(id, btn) {
  if (!confirm('Остановить ран #' + id + '?')) return;
  if (btn) btn.disabled = true;
  try {
    await gh(`repos/${REPO}/actions/runs/${id}/cancel`, { method: 'POST', body: {} });
    loaded.act = false; switchTab('act');
  } catch (e) {
    alert('Не вышло: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

// ── Сессии (только хаб) ──
function parseSessionFile(f) {
  const raw = decodeURIComponent(escape(atob((f.content || '').replace(/\n/g, ''))));
  return JSON.parse(raw);
}
async function readSlot(slot) {
  try {
    const f = await gh(`repos/${REPO}/contents/session-${slot}.json?ref=session-state`);
    if (!f) return null;
    const s = parseSessionFile(f);
    const age = (Date.now() - new Date(s.startedAt).getTime()) / 60000;
    if (s.state === 'ended' || age > 361) return null;
    s._age = Math.round(age); s._slot = slot;
    return s;
  } catch (e) { return null; }
}
function hubOpenUrl(base, zt) {
  return String(base || '').replace(/\/+$/, '') + '/m?zt=' + encodeURIComponent(zt);
}
function openSession(slot, base) {
  let zt = HUB_TOKENS[slot] || '';
  if (!zt) {
    zt = (prompt('Токен хаба (?zt=…) для ' + slot + ':', '') || '').trim();
    if (!zt) return;
    HUB_TOKENS[slot] = zt; saveHubTokens();
  }
  location.href = hubOpenUrl(base, zt);
}
// NOTE: no gh_token here — the proxy injects the server token (dynasty).
function buildDispatchInputs(zt, runner) {
  const inputs = { os: 'linux', label: 'hub-panel', token: zt };
  if (runner) inputs.runner_linux = runner;
  return inputs;
}
async function dispatchHub(where) {
  const log = $('sess-log');
  const say = m => { if (log) log.innerHTML += escHtml(m) + '<br>'; };
  let runner = '';
  if (where === 'pc') {
    runner = ($('pc-runner') && $('pc-runner').value || '').trim();
    if (!runner) { alert('Укажите метку своего раннера (например self-hosted).'); return; }
    try { localStorage.setItem('hub_pc_runner', runner); } catch (e) {}
  }
  const zt = genZt();
  const inputs = buildDispatchInputs(zt, runner);
  say('Отправляю запуск…');
  try {
    await gh(`repos/${REPO}/actions/workflows/hub.yml/dispatches`, { method: 'POST', body: { ref: 'main', inputs } });
    say('Ран принят. Жду адрес…');
    const since = Date.now();
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const s = await readSlot('hub-linux');
      const born = s && s.startedAt ? new Date(s.startedAt).getTime() : 0;
      if (s && s.state === 'live' && born > since - 180000 && (s.hubUrl || s.url)) {
        HUB_TOKENS['hub-linux'] = zt; saveHubTokens();
        say('Хаб жив. Открываю…');
        location.href = hubOpenUrl(s.hubUrl || s.url, zt);
        return;
      }
      if (i % 6 === 5) say(`Жду… ${Math.round((i + 1) / 12)} мин`);
    }
    say('Таймаут: хаб не сообщил адрес за 12 минут.');
  } catch (e) {
    say('Не вышло: ' + e.message);
  }
}
async function renderSessions() {
  const box = $('p-sess');
  box.innerHTML = '<div class="spin">Читаю сессии…</div>';
  let pcRunner = '';
  try { pcRunner = localStorage.getItem('hub_pc_runner') || ''; } catch (e) {}
  const slots = await Promise.all(['hub-linux', 'hub-windows', 'hub'].map(readSlot));
  const live = slots.filter(Boolean);
  const selfUrl = location.origin;
  box.innerHTML = `<div class="card"><div class="row">
      <div style="font-weight:800">Этот сервер</div><span class="badge ok">live</span></div>
      <div class="mono">${escHtml(selfUrl)}</div>
      <div class="row" style="margin-top:8px">
        <a href="/m${escHtml(location.search)}"><button class="small">Открыть хаб (/m)</button></a>
      </div></div>
    <div class="card"><div style="font-weight:700;margin-bottom:8px">Запустить хаб</div>
      <div class="row">
        <button class="small" onclick="dispatchHub('runner')">☁ Раннер</button>
        <button class="small ghost" onclick="dispatchHub('pc')">🖥 ПК</button>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="pc-runner" placeholder="Метка своего раннера (для 🖥 ПК)" value="${escAttr(pcRunner)}"
               autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false">
      </div>
      <div class="note" id="sess-log" style="margin-top:8px"></div></div>
    ${live.map(s => `<div class="card"><div class="row">
        <div style="font-weight:700">${escHtml(s.kind || s._slot)}</div>
        <span class="badge ok">live</span><span class="note">${escHtml(s._age + ' мин')}</span></div>
      <div class="mono">${escHtml(s.hubUrl || s.url || '')}</div>
      <div class="row" style="margin-top:8px">
        <button class="small" onclick="openSession('${escAttr(s._slot)}','${escAttr(s.hubUrl || s.url || '')}')">Открыть</button>
        ${HUB_TOKENS[s._slot] ? '<span class="badge ok">токен есть</span>' : '<span class="badge">чужой токен</span>'}
      </div></div>`).join('') || '<div class="card">Других живых хабов нет.</div>'}`;
}

document.addEventListener('DOMContentLoaded', () => {
  if (!__zt) showBootBanner('НЕТ ?zt= в адресе — API закрыто. Откройте ссылку с токеном.');
  try { $('srv-note').textContent = location.host; } catch (e) {}
  switchTab('sess');
});
