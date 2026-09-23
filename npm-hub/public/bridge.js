/* =========================================================================
 * bridge.js — общий «мост» между страницами хаба.
 * Каждая страница (dashboard / files / linux / git) подключает этот файл: он
 * рисует верхнюю панель (навигация + модель + статусы + туннель), даёт общие
 * helpers (api, escHtml, fmtBytes, модалки, fm-диалоги) и хранит общее
 * состояние (модель, пути, тулзы), которое переживает переход между страницами.
 * ========================================================================= */

const HUB_PAGE = document.body.dataset.page || 'dashboard';
const hubChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('hub-bridge') : null;

// ── Общее состояние, доступное всем страницам ──
let tools = [];
let homeDir = '';
let workDir = '';
let accessMode = 'local';
let storages = [];
let recentPaths = [];
let toolDirs = {};
let models = [];
let selectedModel = 'openrouter/owl-alpha';

// ── Helpers ──
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function formatSize(b) { return fmtBytes(b); }
function fileIcon(n) { const e = n.split('.').pop().toLowerCase(); return {js:'📜',ts:'📜',py:'🐍',rs:'🦀',go:'🔷',html:'🌐',css:'🎨',json:'📋',md:'📝',txt:'📝',jpg:'🖼',png:'🖼',mp3:'🎵',mp4:'🎬',zip:'📦',exe:'⚙',bat:'🖥',sh:'🖥'}[e] || '📄'; }
function dlNow(url, name) {
  try {
    const a = document.createElement('a');
    a.href = url; a.download = name || '';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { fmInfo('Скачать вручную: ' + url); }
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json().catch(() => ({}));
}

// ── Модалки (закрытие + клик по фону) ──
function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('on'); }
function bindModalBgs() {
  document.querySelectorAll('.modal-bg').forEach(bg => {
    if (bg.dataset.bound) return;
    bg.dataset.bound = '1';
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('on'); });
  });
}
document.addEventListener('click', () => {
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
});

// ── FM-диалог: ввод / подтверждение / инфо (общий для всех страниц) ──
let fmOvResolve = null;
function fmCloseModal(val) {
  const ov = document.getElementById('fm-ov');
  if (ov) ov.style.display = 'none';
  if (fmOvResolve) { const r = fmOvResolve; fmOvResolve = null; r(val); }
}
function fmShowModal(title, o) {
  o = o || {};
  return new Promise(resolve => {
    if (fmOvResolve) { resolve(o.input ? null : false); return; }
    let ov = document.getElementById('fm-ov');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'fm-ov';
      ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:20px';
      ov.innerHTML = '<div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:12px;padding:16px;width:100%;max-width:340px">' +
        '<div id="fm-ov-title" style="font-size:14px;font-weight:700;margin-bottom:12px;word-break:break-word"></div>' +
        '<input id="fm-ov-input" style="width:100%;box-sizing:border-box;padding:10px;background:var(--bg0);border:1px solid var(--bdr);border-radius:8px;color:var(--t1);font-size:15px;outline:none;margin-bottom:12px">' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="fm-ov-cancel">Отмена</button>' +
        '<button class="btn btn-p" id="fm-ov-ok">OK</button></div></div>';
      document.body.appendChild(ov);
      document.getElementById('fm-ov-cancel').onclick = () => fmCloseModal('__cancel__');
      document.getElementById('fm-ov-ok').onclick = () => fmCloseModal(document.getElementById('fm-ov-input').value);
      document.getElementById('fm-ov-input').onkeydown = e => { if (e.key === 'Enter') fmCloseModal(e.target.value); };
      ov.onclick = e => { if (e.target === ov) fmCloseModal('__cancel__'); };
    }
    document.getElementById('fm-ov-title').textContent = title;
    const inp = document.getElementById('fm-ov-input');
    inp.style.display = o.input ? 'block' : 'none';
    inp.value = o.input ? (o.def || '') : '';
    document.getElementById('fm-ov-ok').textContent = o.ok || 'OK';
    document.getElementById('fm-ov-cancel').style.display = o.cancel === false ? 'none' : '';
    ov.style.display = 'flex';
    fmOvResolve = v => resolve(v === '__cancel__' ? (o.input ? null : false) : (o.input ? v : true));
    setTimeout(() => { if (o.input) { inp.focus(); inp.select(); } }, 50);
  });
}
function fmAsk(title, def) { return fmShowModal(title, { input: true, def: def || '' }); }
function fmConfirm(title, ok) { return fmShowModal(title, { ok: ok || 'OK' }); }
function fmInfo(text) { return fmShowModal(text, { cancel: false }); }

// ── Верхняя панель: логотип, навигация, модель, статусы ──
function renderTopbar() {
  const tb = document.getElementById('topbar');
  if (!tb) return;
  const nav = [
    ['d', 'Dashboard'],
    ['term', 'Терминал'],
    ['files', 'Файлы'],
    ['linux', '🖥 Экран'],
    ['git', '🐙 Git']
  ].map(([p, label]) =>
    `<a class="tb ${HUB_PAGE === p ? 'on' : ''}" href="/${p === 'd' ? 'd' : p}">${label}</a>`
  ).join('');
  tb.innerHTML = `
    <div class="logo">◆ NPM Hub <span id="hub-ver" class="hub-ver"></span></div>
    <div class="topbar-nav">${nav}</div>
    <div class="topbar-right">
      <button class="btn btn-sm" onclick="hubUpdate()" id="hub-update-btn" title="Проверить обновления на GitHub">🔄<span id="hub-update-badge" class="update-badge" style="display:none"></span></button>
      <span id="sess-clock" class="sess-clock" title="Сессия раннера: сколько уже прошло из лимита (джоба убивается на 6-м часу без предупреждения)">…</span>
      <span class="access-badge" id="access-mode"></span>
      <a id="web-login-link" class="tunnel-url" href="${location.href || '/d'}" target="_blank" rel="noopener" onclick="webLoginClick(event)">Войти через веб</a>
      <span id="access-ip" style="font-size:10px;color:var(--t3)"></span>
      <a id="tunnel-link" class="tunnel-badge" style="display:none" target="_blank" rel="noopener">🌐 Public</a>
      <span id="tunnel-url" class="tunnel-url" style="display:none" onclick="copyTunnelUrl()"></span>
    </div>`;
}

function copyTunnelUrl() {
  if (window.__tunnelUrl) {
    navigator.clipboard.writeText(window.__tunnelUrl).then(() => {
      const el = document.getElementById('tunnel-url');
      const orig = el.textContent;
      el.textContent = '✓ Скопировано!';
      setTimeout(() => { el.textContent = orig; }, 1500);
    });
  } else {
    const el = document.getElementById('tunnel-url');
    if (el) el.textContent = 'нет туннеля';
  }
}

// ── Runner session clock ──
// The GitHub Actions job that hosts this hub is killed at six hours without
// warning, so «how much has passed / how much is left» decides whether to start
// something long or wrap up. Elapsed only when the workflow passed no limit;
// amber under 30 minutes, red under 10.
function fmtClockMs(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return h ? h + 'ч ' + m + 'м' : m + 'м';
}
async function sessionClock() {
  const el = document.getElementById('sess-clock');
  if (!el) return;
  let j;
  try { j = await fetch('/api/info').then(r => r.json()); } catch (e) { return; }
  const ses = j.session;
  if (!ses) { el.style.display = 'none'; return; }
  el.style.display = '';
  if (!ses.limitMs) {
    el.textContent = '🕒 ' + fmtClockMs(ses.elapsedMs);
    el.className = 'sess-clock';
    return;
  }
  const hours = Math.round(ses.limitMs / 3600000);
  el.textContent = '🕒 ' + fmtClockMs(ses.elapsedMs) + ' / ' + hours + 'ч · осталось ' + fmtClockMs(ses.remainingMs);
  const min = ses.remainingMs / 60000;
  el.className = 'sess-clock ' + (min < 10 ? 'bad' : (min < 30 ? 'warn' : ''));
}

function webLoginClick(e) {
  if (window.navigator.userAgent.indexOf('NpmHub/') !== -1 && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
    e.preventDefault();
    window.open(location.href, '_blank');
  }
}

// ── Обновление с GitHub ──
function renderUpdateBadge(check) {
  const badge = document.getElementById('hub-update-badge');
  const btn = document.getElementById('hub-update-btn');
  if (!badge) return;
  if (check && check.success && !check.same) {
    badge.textContent = '+' + (check.behind || '');
    badge.style.display = '';
    if (btn) btn.title = `Доступно обновление: сейчас ${check.current}, доступно ${check.latest}`;
  } else {
    badge.style.display = 'none';
    if (btn) btn.title = 'Проверить обновления на GitHub';
  }
}
async function checkUpdateBadge() {
  try {
    const check = await fetch('/api/update').then(r => r.json());
    renderUpdateBadge(check);
  } catch (e) {}
}
async function hubUpdate() {
  const btn = document.getElementById('hub-update-btn');
  const busy = t => { if (btn) btn.textContent = t; };
  busy('…');
  let check;
  try { check = await fetch('/api/update').then(r => r.json()); }
  catch (e) { check = { success: false, error: e.message }; }
  if (!check.success) {
    busy('🔄');
    renderUpdateBadge(check);
    fmInfo('Обновление: ' + (check.error || 'не удалось проверить'));
    return;
  }
  if (check.same) {
    busy('🔄');
    renderUpdateBadge(check);
    fmInfo(`Актуальная версия (${check.version}), обновлений нет.`);
    return;
  }
  renderUpdateBadge(check);
  const want = `На GitHub есть новая версия: сейчас ${check.current}, доступно ${check.latest} (+${check.behind} коммит.)\n\nОбновить сейчас? Терминалы и туннель переживут рестарт.`;
  if (!confirm(want)) { busy('🔄'); return; }
  try {
    const apply = await fetch('/api/update', { method: 'POST' }).then(r => r.json());
    if (!apply.success) {
      busy('🔄');
      fmInfo('Обновление: ' + (apply.error || 'не удалось применить'));
      return;
    }
    busy('♻');
    const badgeEl = document.getElementById('hub-update-badge');
    if (badgeEl) badgeEl.style.display = 'none';
    fmInfo('Обновление применено, хаб перезапускается…');
    let tries = 0;
    const poll = async () => {
      tries++;
      try {
        const r = await fetch('/api/info').then(r => r.json());
        if (r.version && r.version !== check.version) { busy('🔄'); location.reload(); return; }
        if (tries > 60) { busy('🔄'); location.reload(); return; }
      } catch (e) {}
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 1200);
  } catch (e) {
    busy('🔄');
    fmInfo('Обновление: ошибка — ' + e.message);
  }
}

// ── Запуск терминала на отдельной странице /term ──
function openTermPage(toolId, dir) {
  const d = dir || toolDirs[toolId || '_terminal'] || homeDir;
  const p = new URLSearchParams();
  if (toolId) p.set('tool', toolId);
  if (d) p.set('dir', d);
  const q = p.toString();
  location.href = '/term' + (q ? '?' + q : '');
  return false;
}
function openStandaloneTerminal() { return openTermPage('_terminal'); }

// ── Инициализация моста: общие данные + верхняя панель ──
async function bridgeInit() {
  renderTopbar();
  bindModalBgs();
  const [infoR, histR, storR, modelsR, netR, tunnelR] = await Promise.all([
    fetch('/api/info').then(r => r.json()).catch(() => ({})),
    fetch('/api/path-history').then(r => r.json()).catch(() => ({})),
    fetch('/api/storages').then(r => r.json()).catch(() => ({})),
    fetch('/api/models').then(r => r.json()).catch(() => ({})),
    fetch('/api/networks').then(r => r.json()).catch(() => ({})),
    fetch('/api/tunnel').then(r => r.json()).catch(() => ({}))
  ]);
  if (infoR.home) homeDir = infoR.home;
  if (infoR.workDir) workDir = infoR.workDir;
  if (infoR.state && infoR.state.lastDirs) toolDirs = infoR.state.lastDirs;
  const verEl = document.getElementById('hub-ver');
  if (verEl) verEl.textContent = infoR.version || '';
  if (histR.success) recentPaths = histR.recentPaths || [];
  if (storR.success) storages = storR.storages || [];
  if (modelsR.success) {
    models = modelsR.models || [];
    selectedModel = modelsR.selected || 'openrouter/owl-alpha';
  }
  if (infoR.mode) {
    accessMode = infoR.mode;
    const am = document.getElementById('access-mode');
    if (am) {
      am.textContent = infoR.mode === 'local' ? 'LOCAL' : 'REMOTE';
      am.className = 'access-badge ' + (infoR.mode === 'local' ? 'access-local' : 'access-remote');
    }
    const aip = document.getElementById('access-ip');
    if (aip) aip.textContent = infoR.ip || '';
  }
  if (netR.success && netR.ips && netR.ips.length > 0) {
    const ipEl = document.getElementById('access-ip');
    if (ipEl) {
      const ips = netR.ips.map(i => i.address).join(' | ');
      ipEl.textContent = ips;
      ipEl.title = netR.ips.map(i => `${i.name}: ${i.address}`).join('\n');
    }
    window.__networkIPs = netR.ips;
  }
  // Local DNS alias (HOST_ALIAS): when the admin set one on /etc/hosts, offer
  // it as the address to use — the phone/copy link below prefers it over the
  // per-interface LAN IPs, and it stays valid even if the DHCP lease changes.
  if (netR.alias && netR.alias.url) window.__hubAlias = netR.alias.url;
  else if (infoR.alias && infoR.alias.url) window.__hubAlias = infoR.alias.url;
  if (tunnelR.success && tunnelR.url) {
    const tLink = document.getElementById('tunnel-link');
    const tUrl = document.getElementById('tunnel-url');
    if (tLink) {
      tLink.href = tunnelR.url;
      tLink.textContent = `🌐 ${tunnelR.type || 'Public'}`;
      tLink.style.display = '';
      window.__tunnelUrl = tunnelR.url;
    }
    if (tUrl) {
      tUrl.textContent = tunnelR.url;
      tUrl.style.display = '';
    }
  }
  if (hubChannel) hubChannel.onmessage = e => {
    if (e.data && e.data.type === 'tools') {
      tools = e.data.tools || [];
    }
  };
  checkUpdateBadge();
  sessionClock();
  setInterval(sessionClock, 30000);
  if (typeof pageInit === 'function') pageInit();
  if (typeof bootstrapPage === 'function') bootstrapPage();
}

// ── AUDIO KEEP-ALIVE: держим аудио активным в iframe (VNC/веб), пока страница жива ──
function _ensureAudioCtx() {
  let c = window.__hubAudio;
  if (c && (c.ctx.state === 'running')) return c;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return c;
    if (!c || !c.ctx) {
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      c = { ctx, osc };
      window.__hubAudio = c;
    }
    if (c.ctx.state === 'suspended') c.ctx.resume();
  } catch (e) {}
  return c;
}
function _resumeAudio() {
  try {
    const c = _ensureAudioCtx();
    if (c && c.ctx && c.ctx.state === 'suspended') c.ctx.resume();
  } catch {}
}
['click', 'touchstart', 'keydown', 'mousedown'].forEach(evt => {
  document.addEventListener(evt, () => {
    _resumeAudio();
    document.querySelectorAll('iframe').forEach(f => {
      try { f.contentWindow.postMessage({ type: 'audio-resume' }, '*'); } catch {}
    });
  }, { passive: true });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) _resumeAudio();
});

// ── Старт ──
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bridgeInit);
else bridgeInit();