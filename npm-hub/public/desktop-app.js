let tools = [], homeDir = '', workDir = '', accessMode = 'local';
let tabs = [], activeTab = null, zoomLevel = 100;
let fmCurrentPath = '', fmSelected = null, fmBackend = 'local';
let recentPaths = [], toolDirs = {};
let storages = [];
let models = [], selectedModel = 'openrouter/owl-alpha';
const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;

document.addEventListener('DOMContentLoaded', init);

// Mobile: refit terminal on orientation change / resize
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (activeTab) activeTab.fitAddon?.fit();
    tabs.forEach(t => t.fitAddon?.fit());
  }, 300);
});
window.addEventListener('resize', () => {
  if (activeTab) activeTab.fitAddon?.fit();
});

// Мгновенный переподъём вкладок после фонизации / потери сети.
function kickReconnect() {
  tabs.forEach(t => {
    if (t.manualClose || !t.connect) return;
    const s = t.ws;
    if (s && s.readyState === WebSocket.OPEN) {
      // Looks open but silent for too long → it is dead on the far side
      // (tunnel flap while the tab was hidden). Force it closed so onclose
      // reconnects immediately instead of waiting for the next keepalive.
      if (t.lastPong && Date.now() - t.lastPong > 60000) { t.retry = 0; try { s.close(); } catch {} }
      return;
    }
    if (s && s.readyState === WebSocket.CONNECTING) return; // connect watchdog aborts stale attempts
    if (t.reconnectTimer) { clearTimeout(t.reconnectTimer); t.reconnectTimer = null; }
    t.lastPong = 0; t.retry = 0;
    try { t.connect(); } catch (e) { /* ignore */ }
  });
}
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kickReconnect(); });
window.addEventListener('focus', () => setTimeout(kickReconnect, 250));
window.addEventListener('online', kickReconnect);

async function init() {
  const [toolsR, infoR, histR, storR, modelsR, netR, tunnelR] = await Promise.all([
    fetch('/api/tools').then(r => r.json()),
    fetch('/api/info').then(r => r.json()),
    fetch('/api/path-history').then(r => r.json()),
    fetch('/api/storages').then(r => r.json()),
    fetch('/api/models').then(r => r.json()),
    fetch('/api/networks').then(r => r.json()),
    fetch('/api/tunnel').then(r => r.json())
  ]);
  if (toolsR.success) tools = toolsR.tools;
  if (infoR.home) homeDir = infoR.home;
  if (infoR.workDir) workDir = infoR.workDir;
  if (infoR.state?.lastDirs) toolDirs = infoR.state.lastDirs;
  const verEl = document.getElementById('hub-ver');
  if (verEl) verEl.textContent = infoR.version || '';
  if (histR.success) recentPaths = histR.recentPaths || [];
  if (storR.success) storages = storR.storages || [];
  if (modelsR.success) {
    models = modelsR.models || [];
    selectedModel = modelsR.selected || 'openrouter/owl-alpha';
    updateModelButton();
  }
  if (infoR.mode) {
    accessMode = infoR.mode;
    document.getElementById('access-mode').textContent = infoR.mode === 'local' ? 'LOCAL' : 'REMOTE';
    document.getElementById('access-mode').className = 'access-badge ' + (infoR.mode === 'local' ? 'access-local' : 'access-remote');
    document.getElementById('access-ip').textContent = infoR.ip || '';
  }

  // Networks — show all IPs for phone access
  if (netR.success && netR.ips && netR.ips.length > 0) {
    const ipEl = document.getElementById('access-ip');
    const ips = netR.ips.map(i => i.address).join(' | ');
    ipEl.textContent = ips;
    ipEl.title = netR.ips.map(i => `${i.name}: ${i.address}`).join('\n');
    window.__networkIPs = netR.ips;
  }

  // Tunnel info (already fetched in Promise.all)
  if (tunnelR.success && tunnelR.url) {
    const tLink = document.getElementById('tunnel-link');
    const tUrl = document.getElementById('tunnel-url');
    tLink.href = tunnelR.url;
    tLink.textContent = `🌐 ${tunnelR.type}`;
    tLink.style.display = '';
    tUrl.textContent = tunnelR.url;
    tUrl.style.display = '';
    window.__tunnelUrl = tunnelR.url;
  }
  await restoreServerSessions();
  renderDashboard(); renderSidebar();
  setTimeout(() => { initFM(); fmBrowse(workDir || homeDir); }, 300);
}

function updateModelButton() {
  const m = models.find(m => m.id === selectedModel);
  document.getElementById('model-name').textContent = m ? m.name : selectedModel;
}

// Manual update from GitHub. Every fix gets a new commit on main; the hub
// numbers itself <date>.<sha>, so the build shown in the topbar is exactly
// the code that runs. Checking for a newer commit and applying it here keeps
// working even when the tunnel re-publishes something unexpected.
async function hubUpdate() {
  const btn = document.getElementById('hub-update-btn');
  const badge = document.getElementById('hub-update-badge');
  const busy = t => { if (btn) btn.textContent = t; };
  busy('…');
  let check;
  try { check = await fetch('/api/update').then(r => r.json()); }
  catch (e) { check = { success: false, error: e.message }; }
  if (!check.success) {
    busy('🔄');
    fmInfo('Обновление: ' + (check.error || 'не удалось проверить'));
    return;
  }
  if (check.same) {
    busy('🔄');
    fmInfo(`Актуальная версия (${check.version}), обновлений нет.`);
    return;
  }
  fmInfo(`Новая версия: ${check.current} → ${check.latest} (+${check.behind} коммит.) — обновляю…`);
  try {
    const apply = await fetch('/api/update', { method: 'POST' }).then(r => r.json());
    if (!apply.success) {
      busy('🔄');
      fmInfo('Обновление: ' + (apply.error || 'не удалось применить'));
      return;
    }
    busy('♻');
    fmInfo('Обновление применено, хаб перезапускается…');
    // The server exits after responding, then the workflow keep-alive
    // relaunches it on the new code. Wait until /api/info reports a new
    // build before refreshing the page.
    let tries = 0;
    const poll = async () => {
      tries++;
      try {
        const r = await fetch('/api/info').then(r => r.json());
        if (r.version && r.version !== check.version) {
          busy('🔄');
          location.reload();
          return;
        }
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

function toggleModelMenu(e) {
  e.stopPropagation();
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  const menu = document.getElementById('model-menu');
  if (!menu) return;
  menu.innerHTML = `
    <div style="padding:8px 10px;border-bottom:1px solid var(--bdr)">
      <div style="font-size:10px;color:var(--t3);margin-bottom:4px">Модель</div>
      <input type="text" id="model-search" placeholder="Поиск..." style="width:100%;padding:5px 8px;background:var(--bg0);border:1px solid var(--bdr);border-radius:4px;color:var(--t1);font-size:11px;outline:none" oninput="filterModels(this.value)">
    </div>
    <div id="model-list" style="max-height:300px;overflow-y:auto">
      ${renderModelList(models)}
    </div>
    <div style="padding:6px 10px;border-top:1px solid var(--bdr)">
      <button class="btn" onclick="showApiKeyModal()" style="width:100%;font-size:10px">🔑 API Key</button>
    </div>
  `;
  menu.classList.add('on');
}

function renderModelList(list) {
  return list.map(m => `
    <div class="apply-item" onclick="selectModel('${m.id}')" style="flex-direction:column;align-items:flex-start;gap:2px">
      <div style="display:flex;align-items:center;gap:6px;width:100%">
        <span style="font-size:11px;flex:1">${m.name}</span>
        ${m.free ? '<span style="font-size:8px;color:var(--ok);background:rgba(63,185,80,.15);padding:1px 5px;border-radius:4px">FREE</span>' : '<span style="font-size:8px;color:var(--warn);background:rgba(210,153,34,.15);padding:1px 5px;border-radius:4px">PAID</span>'}
        ${m.id === selectedModel ? '<span style="font-size:9px;color:var(--acc)">✓</span>' : ''}
      </div>
      <div style="font-size:9px;color:var(--t3);width:100%">${m.desc} • ${(m.ctx/1000).toFixed(0)}K ctx</div>
    </div>
  `).join('');
}

function filterModels(q) {
  const filtered = models.filter(m => m.name.toLowerCase().includes(q.toLowerCase()) || m.id.toLowerCase().includes(q.toLowerCase()));
  document.getElementById('model-list').innerHTML = renderModelList(filtered);
}

async function selectModel(modelId) {
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  await fetch('/api/models/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId }) });
  selectedModel = modelId;
  updateModelButton();
}

function showApiKeyModal() {
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  document.getElementById('modal-apikey').classList.add('on');
}

async function saveApiKey() {
  const key = document.getElementById('apikey-input').value.trim();
  if (!key) return;
  await fetch('/api/models/apikey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }) });
  closeModal('modal-apikey');
}

// Close model menu on outside click
document.addEventListener('click', () => { document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on')); });

function showPage(p) {
  document.querySelectorAll('.page,.term-page').forEach(e => e.classList.remove('on'));
  document.getElementById('p-' + p).classList.add('on');
  document.querySelectorAll('.tb').forEach(b => {
    const t = b.textContent.toLowerCase();
    b.classList.toggle('on', (p === 'dashboard' && t === 'dashboard') || (p === 'terminal' && t === 'терминал') || (p === 'files' && t === 'файлы'));
  });
  if (p === 'terminal') {
    if (activeTab) setTimeout(() => activeTab.fitAddon?.fit(), 50);
  }
  if (p === 'files') initFM();
  if (p === 'git') loadGit();
  if (p === 'linux') linuxAutoConnect();
}

showPage('files');
// восстанавливаем адрес облачного телефона и держим его актуальным
(function(){ try { cpRestoreLastUrl(); } catch {} })();

// ===== GIT VIEW =====
let gitPathRef = '';
async function loadGit() {
  const pathEl = document.getElementById('git-path');
  if (gitPathRef && !pathEl.value) pathEl.value = gitPathRef;
  const q = pathEl.value.trim();
  const [st, df, lg, repos] = await Promise.all([
    fetch('/api/git/status' + (q ? '?path=' + encodeURIComponent(q) : '')).then(r => r.json()),
    fetch('/api/git/diff' + (q ? '?path=' + encodeURIComponent(q) : '')).then(r => r.json()),
    fetch('/api/git/log' + (q ? '?path=' + encodeURIComponent(q) : '')).then(r => r.json()),
    fetch('/api/git/repos').then(r => r.json())
  ]);
  if (!pathEl.value && repos && repos.repos && repos.repos[0]) pathEl.value = repos.repos[0];
  const repoEl = document.getElementById('git-repo');
  const stEl = document.getElementById('git-status');
  const dfEl = document.getElementById('git-diff');
  const lgEl = document.getElementById('git-log');
  if (!st.success) {
    if (stEl) stEl.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(st.error || 'нет данных') + '</div>';
    if (lgEl) lgEl.textContent = '';
    if (dfEl) dfEl.textContent = '';
    return;
  }
  gitPathRef = st.repo;
  if (repoEl) repoEl.textContent = st.repo + ' · ' + st.branch + (st.ahead ? ' · ' + st.ahead + ' ahead' : '') + (st.behind ? ' · ' + st.behind + ' behind' : '');
  if (stEl) stEl.innerHTML =
    (st.lastCommit ? '<div style="font-size:11px;color:var(--t2);margin-bottom:6px">' + escHtml(st.lastCommit) + '</div>' : '') +
    (st.files.length
      ? st.files.map(f => '<div class="git-file"><span class="git-code">' + escHtml(f.code) + '</span><span>' + escHtml(f.path) + '</span></div>').join('')
      : '<div style="color:var(--ok);font-size:12px">✓ Рабочее дерево чистое</div>');
  if (dfEl) dfEl.textContent = df.diff ? df.diff : '(нет изменений)';
  if (lgEl) lgEl.textContent = lg.log ? lg.log : '(нет коммитов)';
}

function renderDashboard() {
  const inst = tools.filter(t => t.installed);
  const m = models.find(m => m.id === selectedModel);
  document.getElementById('stats').innerHTML = `
    <div class="st"><div class="st-v" style="color:var(--acc)">${tools.length}</div><div class="st-l">Всего</div></div>
    <div class="st"><div class="st-v" style="color:var(--ok)">${inst.length}</div><div class="st-l">Установлено</div></div>
    <div class="st"><div class="st-v" style="color:var(--pur)">${tabs.length}</div><div class="st-l">Сессий</div></div>
    <div class="st"><div class="st-v" style="color:var(--warn)">${m ? m.name : selectedModel}</div><div class="st-l">Модель</div></div>`;

  const dirStash = {};
  document.querySelectorAll('.card-dir').forEach(el => { dirStash[el.id] = el.value; });
  const focusId = document.activeElement && document.activeElement.id;
  document.getElementById('grid').innerHTML = tools.map(t => {
    const dir = toolDirs[t.id] || homeDir;
    const badges = (t.local ? '<span class="mini-badge" style="border-color:var(--ok);color:var(--ok)">LOCAL</span>' : '')
      + (t.free ? '<span class="mini-badge" style="border-color:#7ee787;color:#7ee787">FREE</span>' : '')
      + (t.keyEnv ? '<span class="mini-badge" style="border-color:var(--warn);color:var(--warn)" title="нужен ключ: ' + escHtml(t.keyEnv) + '">🔑 KEY</span>' : '');
    return `<div class="card">
      <div class="card-h">
        <div class="card-ico" style="background:${t.color}18;color:${t.color}">${t.icon}</div>
        <div><div class="card-n">${t.name}</div><div class="card-v">${t.version || '—'}</div></div>
        <span class="tag ${t.installed ? 'tag-on' : 'tag-off'}" style="margin-left:auto">${t.installed ? 'OK' : '—'}</span>
      </div>
      <div class="card-badges">${badges || ''}</div>
      <div class="card-foot">
        <input type="text" id="cdir-${t.id}" class="card-dir" value="${escHtml(dir)}" placeholder="путь к папке..."
          onclick="event.stopPropagation()" onfocus="this.select()">
        ${t.installed ? `<div style="position:relative;display:flex;gap:4px;align-items:center">
          <button class="btn btn-sm" onclick="testTool('${t.id}')" title="проверить: бинарь + ключ">🧪</button>
          <button class="btn btn-sm btn-p" onclick="toggleApplyMenu(event,'${t.id}')">▶</button>
          <div class="apply-menu" id="amenu-${t.id}"></div>
        </div>` : (t.pkg ? `<button class="btn btn-sm btn-ok" onclick="installTool('${t.id}')">⬇ Скачать</button>`
          : (t.hint ? `<button class="btn btn-sm" onclick="copyInstall('${escAttr(t.hint)}')" title="${escAttr(t.hint)}">📋</button>`
          : `<button class="btn btn-sm" disabled style="opacity:.4">▶</button>`))}
      </div>
      <div id="tres-${t.id}" class="test-res"></div>
    </div>`;
  }).join('');
  for (const [id, v] of Object.entries(dirStash)) { const el = document.getElementById(id); if (el) el.value = v; }
  if (focusId) { const f = document.getElementById(focusId); if (f && f.focus) f.focus(); }
  runnerRender();
}

// ===== RUNNER CARD — сохранение / выключение / перезапуск ранера =====
let RUNNER = null;        // last /api/runner answer
let RUNNER_BUSY = false;  // stop/restart in flight
function fmtBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function dlNow(url, name) {
  try {
    const a = document.createElement('a');
    a.href = url; a.download = name || '';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { fmInfo('Скачать вручную: ' + url); }
}
function runnerRender() {
  const el = document.getElementById('runner-card');
  if (!el) return;
  const onActs = !!(RUNNER && RUNNER.success && RUNNER.actions);
  const env = RUNNER && RUNNER.success ? RUNNER : null;
  const info = env ? `<b>${escHtml(env.repo || '?')}</b> #${escHtml(env.runNumber || '')} · ${escHtml(env.os || '')} · ${escHtml(env.workflowFile || env.workflow || '')}`
    + (env.hostname ? ' · ' + escHtml(env.hostname) : '')
    + (env.workDir ? '<br>' + escHtml(env.workDir) : '')
    + (env.tunnel ? '<br>🌐 ' + escHtml(env.tunnel) : '')
    : 'Запуск вне GitHub Actions (PC-local) — кнопки управления активны только на Actions-раннере.';
  el.innerHTML = `<div class="runner-box">
    <div class="runner-h">🎛 Раннер <span class="runner-dot${onActs ? ' on' : ''}"></span></div>
    <div class="runner-line">${info}</div>
    <div class="runner-btns">
      <button class="btn btn-sm" onclick="runnerScan()">🔍 Файлы</button>
      <button class="btn btn-sm btn-ok" onclick="runnerSave()" id="runner-save" disabled>💾 Сохранить</button>
      <button class="btn btn-sm btn-ok" onclick="runnerRestart()" id="runner-restart"${onActs ? '' : ' disabled'}>⟲ Перезапуск</button>
      <button class="btn btn-sm btn-er" onclick="runnerStop()" id="runner-stop"${onActs ? '' : ' disabled'}>⏻ Выключить</button>
    </div>
    <div id="runner-scan"></div>
    <div id="runner-res"></div>
  </div>`;
  if (RUNNER_BUSY) {
    const s = document.getElementById('runner-scan');
    if (s) s.innerHTML = '<div class="runner-busy">работаю…</div>';
  }
}
async function runnerScan() {
  const w = document.getElementById('runner-scan');
  if (w) w.innerHTML = '<div class="runner-busy">сканирую…</div>';
  let r = null;
  try { r = await fetch('/api/runner').then(x => x.json()); } catch (e) { r = { success: false, error: e.message }; }
  RUNNER = r;
  runnerRender();
  if (!r.success) { if (w) w.innerHTML = '<div class="runner-err">' + escHtml(r.error || 'нет ответа') + '</div>'; return; }
  const items = [];
  (r.apks || []).forEach(a => items.push({ kind: 'apk', name: a.name, path: a.path, size: a.size, isDir: false }));
  (r.folders || []).forEach(f => items.push({ kind: 'folder', name: f.name, path: f.path, size: f.size, isDir: true }));
  const saveBtn = document.getElementById('runner-save');
  if (!items.length) {
    if (w) w.innerHTML = '<div class="runner-err">Ничего не нашлось в ~/hub-work. Положи файлы туда вкладкой «Файлы» (⬆), потом сканируй снова.</div>';
    if (saveBtn) saveBtn.disabled = true;
    return;
  }
  if (w) w.innerHTML = `<div class="runner-list">` + items.map((it) => `
    <div class="runner-item">
      <div>${it.kind === 'apk' ? '📦' : '📁'}</div>
      <div class="runner-name" title="${escAttr(it.path)}">${escHtml(it.name)}<span class="runner-meta">${fmtBytes(it.size)} · ${it.kind === 'apk' ? 'APK' : 'папка'}</span></div>
      <select class="runner-dest" data-path="${escAttr(it.path)}" data-dir="${it.isDir ? '1' : ''}">
        <option value="phone"${it.kind === 'apk' ? ' selected' : ''}>на телефон</option>
        <option value="branch"${it.kind === 'folder' ? ' selected' : ''}>в ветку (tar.xz)</option>
        <option value="keep">оставить</option>
        <option value="skip">пропустить</option>
      </select>
    </div>`).join('') + `</div>`;
  if (saveBtn) saveBtn.disabled = false;
}
async function runnerSave() {
  const saveBtn = document.getElementById('runner-save');
  if (saveBtn && saveBtn.disabled) return;
  const items = [], dl = [];
  document.querySelectorAll('.runner-dest').forEach(sel => {
    const dest = sel.value;
    if (dest === 'skip') return;
    items.push({ path: sel.dataset.path, dest });
    if (dest === 'phone') {
      const nm = String(sel.dataset.path).split(/[/\\]/).pop();
      dl.push({ path: sel.dataset.path, name: nm + (sel.dataset.dir ? '.tar.xz' : ''), isDir: !!sel.dataset.dir });
    }
  });
  if (!items.length) return;
  if (saveBtn) saveBtn.disabled = true;
  let r = await HubOffline.post('/api/runner/backup', { items }, 'отправить в ветку');
  const out = document.getElementById('runner-res');
  if (r.queued) {
    if (out) out.innerHTML = '<div class="runner-res">⏳ Нет связи — отправка в ветку в очереди, уйдёт автоматически, когда связь вернётся.</div>';
    if (saveBtn) saveBtn.disabled = false;
    return;
  }
  if (!r.success) {
    if (out) out.innerHTML = '<div class="runner-err">' + escHtml(r.error || 'ошибка') + '</div>';
    if (saveBtn) saveBtn.disabled = false;
    return;
  }
  const lines = (r.results || []).map(x => {
    if (x.ok && x.action === 'branch') return '✓ <b>' + escHtml(x.name || '') + '</b> → <a href="' + escAttr(x.url || '#') + '" target="_blank" rel="noreferrer">в ветке</a>';
    if (x.ok && x.action === 'phone') return '⬇ <b>' + escHtml(x.name || '') + '</b> — скачивается…';
    if (x.ok && x.action === 'keep') return '○ <b>' + escHtml(x.name || '') + '</b> — остался на ранере';
    return '✗ ' + escHtml(x.name || '') + ': ' + escHtml(x.error || '?');
  });
  if (out) { out.innerHTML = '<div class="runner-res">' + lines.join('<br>') + '</div>'; setTimeout(() => { out.innerHTML = ''; }, 25000); }
  dl.forEach(d => dlNow(d.isDir ? '/api/fs/archive?path=' + encodeURIComponent(d.path) : '/api/fs/download?path=' + encodeURIComponent(d.path), d.name));
  if (saveBtn) saveBtn.disabled = false;
  runnerScan();
}
function runnerVisible() { return !!(RUNNER && RUNNER.success && RUNNER.actions && !RUNNER_BUSY); }
async function runnerStop() {
  if (!runnerVisible()) { fmInfo('Кнопки активны только на Actions-раннере.'); return; }
  if (!(await fmConfirm('Выключить ранер? Всё, что не сохранили, пропадёт при его смерти. Сначала «💾 Сохранить».', 'Выключить'))) return;
  RUNNER_BUSY = true; runnerRender();
  const r = await fetch('/api/runner/stop', { method: 'POST' }).then(x => x.json()).catch(e => ({ success: false, error: e.message }));
  RUNNER_BUSY = false; runnerRender();
  const out = document.getElementById('runner-res');
  if (out) out.innerHTML = r.success
    ? '<div class="runner-res">⏻ Остановка принята — ранер сворачивается ~минуту.</div>'
    : '<div class="runner-err">' + escHtml(r.error || 'не вышло') + '</div>';
}
async function runnerRestart() {
  if (!runnerVisible()) { fmInfo('Кнопки активны только на Actions-раннере.'); return; }
  if (!(await fmConfirm('Перезапустить ранер? Подстрахуй файлы «💾 Сохранить» — свежий раннер подхватит их из ветки.', 'Перезапустить'))) return;
  RUNNER_BUSY = true; runnerRender();
  const r = await fetch('/api/runner/restart', { method: 'POST' }).then(x => x.json()).catch(e => ({ success: false, error: e.message }));
  RUNNER_BUSY = false; runnerRender();
  const out = document.getElementById('runner-res');
  if (out) out.innerHTML = r.success
    ? '<div class="runner-res">⟲ Перезапуск принят: новый ранер поднимается, старый гасится.</div>'
    : '<div class="runner-err">' + escHtml(r.error || 'не вышло') + '</div>';
}

function toggleApplyMenu(e, toolId) {
  e.stopPropagation();
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  const menu = document.getElementById('amenu-' + toolId);
  if (!menu) return;
  const dir = document.getElementById('cdir-' + toolId)?.value?.trim() || homeDir;
  menu.innerHTML = tools.filter(t => t.installed).map(t => `
    <div class="apply-item" onclick="event.stopPropagation();openFromCard('${toolId}','${escAttr(dir)}','${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color};width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:800">${t.icon}</div>
      <span>${t.name}</span>
    </div>
  `).join('') + `<div class="apply-item" onclick="event.stopPropagation();openFromCard('${toolId}','${escAttr(dir)}','_terminal')">
      <div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:800">&gt;_</div>
      <span>Terminal</span>
    </div>`;
  menu.classList.add('on');
}

async function openFromCard(fromToolId, dir, launchToolId) {
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  toolDirs[fromToolId] = dir;
  await fetch('/api/last-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId: fromToolId, dir }) });
  await fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: dir }) });
  if (!recentPaths.includes(dir)) recentPaths.unshift(dir);
  showPage('terminal');
  createTerm(launchToolId, dir);
}

document.addEventListener('click', () => { document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on')); });

function showDirPicker(e, toolId) {
  e.stopPropagation();
  document.querySelectorAll('.path-dropdown').forEach(d => d.classList.remove('on'));
  const dd = document.getElementById('ddir-' + toolId);
  if (!dd) return;
  const paths = recentPaths.slice(0, 15);
  dd.innerHTML = paths.map(p => {
    const short = (homeDir ? p.replace(homeDir, '~') : p).replace(/\\/g, '/');
    return `<div class="path-dd-item" onclick="event.stopPropagation();setToolDir('${toolId}','${escAttr(p)}')">${short}</div>`;
  }).join('') || '<div class="path-dd-item" style="color:var(--t3)">Нет путей</div>';
  dd.classList.add('on');
}

function setToolDir(toolId, dir) {
  toolDirs[toolId] = dir;
  document.querySelectorAll('.path-dropdown').forEach(d => d.classList.remove('on'));
  fetch('/api/last-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, dir }) });
  renderDashboard();
  renderSidebar();
}

async function launchTool(toolId) {
  const input = document.getElementById('cdir-' + toolId);
  const dir = input ? input.value.trim() : (toolDirs[toolId] || homeDir);
  toolDirs[toolId] = dir;
  await fetch('/api/last-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, dir }) });
  await fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: dir }) });
  if (!recentPaths.includes(dir)) recentPaths.unshift(dir);
  showPage('terminal');
  createTerm(toolId, dir);
}

function openTerminal(dir) {
  const d = dir || toolDirs['_terminal'] || homeDir;
  toolDirs['_terminal'] = d;
  showPage('terminal');
  createTerm('_terminal', d, true);
}

// Отдельный сайт терминала (/term): вкладки переживают перезагрузку панели,
// потому что подключаются к тем же серверным tmux-сессиям и повторяют вывод.
function openStandaloneTerminal(toolId, dir) {
  const d = dir || toolDirs[toolId || '_terminal'] || homeDir;
  const p = new URLSearchParams();
  if (toolId) p.set('tool', toolId);
  if (d) p.set('dir', d);
  const q = p.toString();
  window.open(location.origin + '/term' + (q ? '?' + q : ''), '_blank');
  return false;
}

function renderSidebar() {
  document.getElementById('tool-list').innerHTML = tools.filter(t => t.installed).map(t => {
    const dir = toolDirs[t.id] || homeDir;
    const short = (homeDir ? dir.replace(homeDir, '~') : dir).split('\\').pop();
    return `<div class="sb-i" onclick="launchTool('${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color}">${t.icon}</div>
      <div style="overflow:hidden;flex:1"><div>${t.name}</div><div style="font-size:8px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${short}</div></div>
    </div>`;
  }).join('');

  document.getElementById('term-list').innerHTML = tabs.map(t => `
    <div class="sb-i ${activeTab?.id === t.id ? 'on' : ''}" onclick="switchTab('${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color}">${t.icon}</div>
      <div style="overflow:hidden;flex:1"><div>${t.toolName}</div><div style="font-size:8px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.dirShort}</div></div>
      <span class="term-close" onclick="event.stopPropagation();closeTab('${t.id}')" title="Закрыть">✕</span>
    </div>`).join('');
}

// ======== SESSIONS ========
// Reattach the browser UI to tmux sessions that survived a hub restart.
async function restoreServerSessions() {
  try {
    const r = await fetch('/api/sessions');
    const d = await r.json();
    if (!d.success || !Array.isArray(d.sessions)) return;
    const known = new Set(tabs.map(t => t.id));
    for (const s of d.sessions) {
      if (!s || !s.id || known.has(String(s.id))) continue;
      known.add(String(s.id));
      await createTerm(s.toolId || '_terminal', s.cwd || homeDir, !s.toolId || s.toolId === '_terminal', s);
    }
    renderTabs(); renderSidebar();
  } catch {}
}
function showNewTermModal() {
  document.getElementById('newterm-grid').innerHTML = `
    <div class="newterm-tool" onclick="openStandaloneTerminal()">
      <div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:9px">&gt;_</div>
      <div><div style="font-size:12px;font-weight:500">Terminal</div><div style="font-size:9px;color:var(--t3)">Пустой терминал (отдельная вкладка, переживает обновление)</div></div>
    </div>
  ` + tools.filter(t => t.installed).map(t => `
    <div class="newterm-tool" onclick="createTerm('${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color};width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:9px">${t.icon}</div>
      <div><div style="font-size:12px;font-weight:500">${t.name}</div></div>
    </div>`).join('');

  const rp = document.getElementById('recent-paths');
  rp.innerHTML = recentPaths.length ? '<div style="font-size:9px;color:var(--t3);margin-bottom:4px">Недавние:</div>' +
    recentPaths.slice(0, 8).map(p => {
      const short = (homeDir ? p.replace(homeDir, '~') : p).replace(/\\/g, '/');
      return `<div class="path-dd-item" onclick="document.getElementById('newterm-cwd').value='${escAttr(p)}'" style="padding:3px 6px;font-size:10px;font-family:monospace;cursor:pointer;color:var(--t2);border-bottom:1px solid var(--bdr)">${short}</div>`;
    }).join('') : '';
  document.getElementById('modal-newterm').classList.add('on');
}

function closeModal(id) { document.getElementById(id).classList.remove('on'); }

document.querySelectorAll('.modal-bg').forEach(bg => {
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('on'); });
});

// ===== TERMINAL SCROLLBAR (слайдер) =====
function attachTermScroll(id, panel) {
  const termEl = document.getElementById('term-' + id);
  const vp = termEl.querySelector('.xterm-viewport');
  const track = panel.querySelector('.term-scroll');
  const thumb = panel.querySelector('.term-scroll-thumb');
  if (!vp || !track || !thumb) return null;

  const upd = () => {
    const max = vp.scrollHeight - vp.clientHeight;
    if (max <= 2) { thumb.style.display = 'none'; return; }
    thumb.style.display = 'block';
    const trackH = track.clientHeight;
    const th = Math.max(24, trackH * (vp.clientHeight / vp.scrollHeight));
    const pos = trackH <= th ? 0 : (vp.scrollTop / max) * (trackH - th);
    thumb.style.height = th + 'px';
    thumb.style.transform = 'translateY(' + pos + 'px)';
  };
  vp.addEventListener('scroll', upd);
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(upd); ro.observe(track); }
  const resizeHandler = upd;
  window.addEventListener('resize', resizeHandler);

  let dragging = false, startY = 0, startTop = 0;
  const toTop = (e) => {
    const max = vp.scrollHeight - vp.clientHeight;
    if (max <= 0) return;
    const trackH = track.clientHeight;
    const th = Math.max(24, trackH * (vp.clientHeight / vp.scrollHeight));
    const ratio = trackH - th;
    const dy = e.clientY - startY;
    const ratioPos = ratio > 0 ? (startTop / max) * ratio + dy : 0;
    vp.scrollTop = ratio > 0 ? Math.max(0, Math.min(1, ratioPos / ratio)) * max : 0;
    e.preventDefault();
  };
  thumb.addEventListener('pointerdown', (e) => {
    dragging = true; startY = e.clientY; startTop = vp.scrollTop;
    try { thumb.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  thumb.addEventListener('pointermove', (e) => { if (dragging) toTop(e); });
  const endDrag = () => { dragging = false; };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);
  track.addEventListener('pointerdown', (e) => {
    if (e.target === thumb) return;
    const max = vp.scrollHeight - vp.clientHeight;
    if (max <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = (e.clientY - rect.top - 14) / rect.height;
    vp.scrollTop = max * Math.max(0, Math.min(1, ratio));
    e.preventDefault();
  });

  upd();
  return { upd, destroy() { if (ro) ro.disconnect(); window.removeEventListener('resize', resizeHandler); } };
}

// ===== ТЕРМИНАЛ НА ПАЛЬЦЕ =====
// Раньше: ЛЮБОЕ удержание дольше 600 мс копировало текст (а без выделения —
// последние 200 строк буфера, то есть «весь экран»), а тап дольше 500 мс не
// возвращал фокус — клавиатура не открывалась. Жалоба: «каждый тап бесконечно
// копирует весь текст при запуске клавиатуры, когда я хочу печатать».
// Теперь: тап — печатать (клавиатура), удержание — выделить слово под пальцем,
// тянуть — расширить выделение по строкам, ⧉ — скопировать.
function termCellAt(term, x, y) {
  try {
    const screen = term.element && term.element.querySelector('.xterm-screen');
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const col = Math.floor((x - r.left) / (r.width / term.cols));
    const rowInView = Math.floor((y - r.top) / (r.height / term.rows));
    if (col < 0 || rowInView < 0 || col >= term.cols || rowInView >= term.rows) return null;
    const row = (term.buffer.active.viewportY || 0) + rowInView;
    return { col, row };
  } catch { return null; }
}

// Выделяем слово под пальцем; если там пустота — всю непустую строку.
function termSelectWordAt(term, x, y) {
  const cell = termCellAt(term, x, y);
  if (!cell) return false;
  try {
    const line = term.buffer.active.getLine(cell.row);
    if (!line) return false;
    const text = line.translateToString(true);
    const isWord = (ch) => !!ch && !/\s/.test(ch);
    let s = Math.min(cell.col, Math.max(0, text.length - 1));
    let e = s;
    if (isWord(text[s])) {
      while (s > 0 && isWord(text[s - 1])) s--;
      while (e < text.length - 1 && isWord(text[e + 1])) e++;
    } else {
      const trimmed = text.trim();
      if (!trimmed) return false;
      s = text.indexOf(trimmed);
      e = s + trimmed.length - 1;
    }
    term.select(s, cell.row, e - s + 1);
    return true;
  } catch { return false; }
}

function setupTermTouch(termEl, term) {
  if (!isTouch) return null;
  let startY = 0, startX = 0, startT = 0;
  let scrolled = false, selecting = false, anchorRow = 0, holdTimer = null;
  const onStart = (e) => {
    const t = e.touches[0];
    startY = t.clientY; startX = t.clientX; startT = Date.now();
    scrolled = false; selecting = false;
    clearTimeout(holdTimer);
    // Клавиатуру НЕ прячем: тап по терминалу должен её открывать (печатать),
    // а не закрывать.
    holdTimer = setTimeout(() => {
      if (scrolled) return;
      const cell = termCellAt(term, startX, startY);
      if (!cell) return;
      selecting = true;
      anchorRow = cell.row;
      try { if (navigator.vibrate) navigator.vibrate(20); } catch {}
      if (termSelectWordAt(term, startX, startY)) {
        fmInfo('выделено — тяни, чтобы расширить, затем ⧉ чтобы скопировать');
      }
    }, 550);
  };
  const onMove = (e) => {
    const t = e.touches[0];
    if (selecting) {
      // Тянем выделение по строкам.
      const cell = termCellAt(term, t.clientX, t.clientY);
      if (cell && typeof term.selectLines === 'function') {
        try { term.selectLines(Math.min(anchorRow, cell.row), Math.max(anchorRow, cell.row)); } catch {}
      }
      e.preventDefault();
      return;
    }
    if (Math.abs(t.clientY - startY) > 8 || Math.abs(t.clientX - startX) > 8) {
      scrolled = true;
      clearTimeout(holdTimer);
      // Прокрутка с открытой клавиатурой неудобна — прячем её только здесь.
      try { if (term.textarea === document.activeElement) term.blur(); } catch {}
    }
  };
  const onEnd = (e) => {
    clearTimeout(holdTimer);
    if (selecting) {
      selecting = false;
      const sel = (term.getSelection() || '').trim();
      fmInfo(sel ? ('выделено ' + sel.length + ' симв. — ⧉ чтобы скопировать') : 'ничего не выделено');
      return;
    }
    if (!scrolled && Date.now() - startT < 550) {
      // Тап = печатать: открываем клавиатуру и снимаем старое выделение.
      try { term.clearSelection(); } catch {}
      term.focus();
    }
  };
  // Долгий тап браузера (контекстное меню) — тоже выделяем, а не копируем молча.
  const onContext = (e) => { e.preventDefault(); termSelectWordAt(term, e.clientX, e.clientY); return false; };
  termEl.addEventListener('touchstart', onStart, { passive: true });
  termEl.addEventListener('touchmove', onMove, { passive: false });
  termEl.addEventListener('touchend', onEnd, { passive: false });
  termEl.addEventListener('contextmenu', onContext);
  return { destroy() { clearTimeout(holdTimer); termEl.removeEventListener('touchstart', onStart); termEl.removeEventListener('touchmove', onMove); termEl.removeEventListener('touchend', onEnd); termEl.removeEventListener('contextmenu', onContext); } };
}

async function createTerm(toolId, cwdOverride, plainTerminal, resumeSession) {
  closeModal('modal-newterm');
  const resume = resumeSession && resumeSession.id ? resumeSession : null;
  const effectiveToolId = resume ? (resume.toolId || '_terminal') : toolId;
  const tool = tools.find(t => t.id === effectiveToolId);
  const isPlain = resume ? (!tool || effectiveToolId === '_terminal') : (plainTerminal || toolId === '_terminal' || !tool);

  const id = resume ? String(resume.id) : ('term_' + Date.now());
  const cwdInput = document.getElementById('newterm-cwd')?.value?.trim();
  const cwd = (resume && resume.cwd) || cwdOverride || cwdInput || toolDirs[effectiveToolId] || homeDir;

  if (effectiveToolId && !isPlain) {
    toolDirs[effectiveToolId] = cwd;
    await fetch('/api/last-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, dir: cwd }) });
  }
  if (!recentPaths.includes(cwd)) {
    recentPaths.unshift(cwd);
    fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: cwd }) });
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  const term = new Terminal({
    theme: { background: '#0a0e14', foreground: '#e6edf3', cursor: '#58a6ff', cursorAccent: '#0a0e14', selectionBackground: '#264f78', black: '#0a0e14', red: '#f85149', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#e6edf3', brightBlack: '#484f58', brightRed: '#f85149', brightGreen: '#3fb950', brightYellow: '#d29922', brightBlue: '#58a6ff', brightMagenta: '#bc8cff', brightCyan: '#56d4dd', brightWhite: '#ffffff' },
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
    fontSize: Math.round(14 * zoomLevel / 100),
    lineHeight: 1.2, cursorBlink: true, scrollback: 999999
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  const dirShort = (homeDir ? cwd.replace(homeDir, '~') : cwd).split('\\').pop();
  const displayName = (resume && resume.toolName) || (isPlain ? 'Terminal' : tool.name);
  const color = (resume && resume.color) || (isPlain ? '#58a6ff' : tool.color);
  const icon = (resume && resume.icon) || (isPlain ? '>_' : tool.icon);
  const panel = document.createElement('div');
  panel.className = 'term-panel';
  panel.id = 'panel-' + id;
  panel.innerHTML = `<div class="term-header"><div class="term-header-title"><div style="width:8px;height:8px;border-radius:50%;background:${color}"></div>${displayName}</div><div class="term-info">${dirShort}</div><button class="btn btn-sm" onclick="closeTab('${id}')">✕</button></div><div class="term-wrap"><div class="term" id="term-${id}"></div><div class="term-scroll" id="tscroll-${id}"><div class="term-scroll-thumb" id="tthumb-${id}"></div></div></div>`;
  document.getElementById('term-container').appendChild(panel);
  term.open(document.getElementById('term-' + id));
  await new Promise(r => setTimeout(r, 30));
  fitAddon.fit();

  const td = { id, toolId: effectiveToolId, toolName: displayName, color, icon,
    toolColor: color, toolIcon: icon, dirShort,
    repoPath: (resume && resume.repoPath) || null, repoName: (resume && resume.repoName) || null,
    repoRemote: (resume && resume.repoRemote) || null, repoBranch: (resume && resume.repoBranch) || null,
    repoHead: (resume && resume.repoHead) || null, repoDirty: !!(resume && resume.repoDirty),
    repoStatus: (resume && resume.repoStatus) || '', emulator: (resume && resume.emulator) || null,
    phoneRunner: (resume && resume.phoneRunner) || null, ws: null, term, fitAddon, el: panel,
    manualClose: false, scroll: null, lastPong: 0, reconnectTimer: null, connectTimer: null,
    retry: 0, disconnected: false, keepAlive: null, resizeObs: null, touchHandler: null, connect: () => {} };
  tabs.push(td);
  td.scroll = attachTermScroll(id, panel);
  td.touchHandler = setupTermTouch(document.getElementById('term-' + id), term);

  const connect = () => {
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    td.ws = socket;
    // Watchdog: a connection attempt that lingers in CONNECTING (stalled,
    // half-open tunnel) would otherwise hang the tab forever — no open, no
    // close. Force it closed so the reconnect path takes over.
    if (td.connectTimer) { clearTimeout(td.connectTimer); td.connectTimer = null; }
    td.connectTimer = setTimeout(() => {
      if (td.ws === socket && socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(); } catch {}
      }
    }, 8000);

    socket.onopen = () => {
      if (td.connectTimer) { clearTimeout(td.connectTimer); td.connectTimer = null; }
      td.lastPong = Date.now();
      td.retry = 0;
      td.disconnected = false;
      socket.send(JSON.stringify({ type: 'open', toolId: isPlain ? '_terminal' : effectiveToolId, sessionId: id, cwd,
        repoPath: (resume && resume.repoPath) || null, emulator: (resume && resume.emulator) || null,
        phoneRunner: (resume && resume.phoneRunner) || null, cols: term.cols, rows: term.rows }));
      if (!isTouch) term.focus();
    };
    socket.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'pong') { td.lastPong = Date.now(); return; }
      if (m.type === 'output') term.write(m.data);
      if (m.type === 'exit') term.write(`\r\n\x1b[33m[Exited ${m.code}]\x1b[0m\r\n`);
      if (m.type === 'error') term.write(`\r\n\x1b[31m[Error: ${m.error}]\x1b[0m\r\n`);
    };
    socket.onclose = () => {
      if (td.manualClose) return;
      if (td.ws !== socket) return; // superseded by a newer socket; it owns reconnection
      if (td.connectTimer) { clearTimeout(td.connectTimer); td.connectTimer = null; }
      if (td.reconnectTimer) { clearTimeout(td.reconnectTimer); td.reconnectTimer = null; }
      if (!td.disconnected) {
        term.write('\r\n\x1b[33m[Disconnected — reconnecting...]\x1b[0m\r\n');
        td.disconnected = true;
      }
      // Exponential backoff with jitter: fast while the server is flapping,
      // gentle during a long outage, and reset to instant on the next open.
      const delay = Math.min(3000 * Math.pow(2, td.retry), 30000) + Math.round(Math.random() * 400);
      td.retry = Math.min(td.retry + 1, 6);
      td.reconnectTimer = setTimeout(connect, delay);
    };
    return socket;
  };
  td.connect = connect;
  connect();

  // Keepalive: ping/pong + forced close when the socket goes stale (>60s).
  // Pings only fire while the page is visible: in the background Chrome
  // throttles timers and the radio, so a ping that cannot be answered would
  // just fabricate a "dead socket". kickReconnect() re-checks on wake-up.
  td.keepAlive = setInterval(() => {
    if (document.hidden) return;
    if (td.manualClose || !td.ws) return;
    if (td.ws.readyState === WebSocket.OPEN) {
      if (Date.now() - td.lastPong > 60000) td.ws.close();
      else td.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 15000);

  term.onData((d) => { if (td.ws && td.ws.readyState === 1) td.ws.send(JSON.stringify({ type: 'input', data: d })); });
  term.onResize(({ cols, rows }) => { if (td.ws && td.ws.readyState === 1) td.ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  // The socket was opened above; do not open a second connection for one tab.
  td.resizeObs = new ResizeObserver(() => { if (activeTab?.id === id) fitAddon.fit(); });
  td.resizeObs.observe(panel);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.onclick = () => switchTab(id);
  tabEl.innerHTML = `<div class="tab-dot" style="background:${color}"></div><span>${displayName}</span><span class="tab-x" onclick="event.stopPropagation();closeTab('${id}')">×</span>`;
  document.getElementById('tabs').appendChild(tabEl);
  td.tabEl = tabEl;

  showPage('terminal');
  switchTab(id);
  renderSidebar();
}

function switchTab(id) {
  activeTab = tabs.find(t => t.id === id);
  if (!activeTab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  activeTab.tabEl?.classList.add('on');
  document.querySelectorAll('.term-panel').forEach(p => p.classList.remove('on'));
  activeTab.el.classList.add('on');
  renderSidebar();
  setTimeout(() => {
    activeTab.fitAddon?.fit();
    if (!isTouch) activeTab.term?.focus();
    activeTab.scroll?.upd?.();
  }, 50);
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  tab.manualClose = true;
  // Closing a tab must end the server-side session, not just detach: a leftover
  // tmux session is re-attached on the next page load (/api/sessions), so closed
  // tabs came back and kept piling up. 'kill' terminates it for good.
  try { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ type: 'kill' })); } catch {}
  // HTTP fallback: the tab may be mid-reconnect, when a WS frame cannot be sent.
  try { fetch('/api/sessions/' + encodeURIComponent(id) + '/kill', { method: 'POST' }).catch(() => {}); } catch {}
  if (tab.keepAlive) clearInterval(tab.keepAlive);
  if (tab.resizeObs) tab.resizeObs.disconnect();
  if (tab.scroll?.destroy) tab.scroll.destroy();
  if (tab.touchHandler?.destroy) tab.touchHandler.destroy();
  tab.ws?.close(); tab.term?.dispose(); tab.el?.remove(); tab.tabEl?.remove();
  tabs.splice(idx, 1);
  if (activeTab?.id === id) { activeTab = tabs[Math.min(idx, tabs.length - 1)] || null; activeTab ? switchTab(activeTab.id) : showPage('dashboard'); }
  renderSidebar();
}

function zoomTerm(dir) {
  if (dir === 0) zoomLevel = 100; else zoomLevel = Math.max(50, Math.min(300, zoomLevel + dir * 10));
  document.getElementById('zoom-label').textContent = zoomLevel + '%';
  if (activeTab) { activeTab.term.options.fontSize = Math.round(14 * zoomLevel / 100); setTimeout(() => activeTab.fitAddon?.fit(), 10); }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}
document.addEventListener('fullscreenchange', () => { setTimeout(() => { if (activeTab) activeTab.fitAddon?.fit(); }, 100); });

function killTerm() {
  if (!activeTab || !activeTab.ws) return;
  if (activeTab.ws.readyState === WebSocket.OPEN) {
    activeTab.ws.send(JSON.stringify({ type: 'kill', signal: 'SIGINT' }));
    activeTab.term?.focus();
  }
}

function sendEscape() {
  if (!activeTab || !activeTab.ws) return;
  if (activeTab.ws.readyState === WebSocket.OPEN) {
    activeTab.ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
    activeTab.term?.focus();
  }
}

async function pasteClipboard() {
  if (!activeTab || !activeTab.ws) return;
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        if (activeTab.ws.readyState === WebSocket.OPEN) {
          activeTab.ws.send(JSON.stringify({ type: 'input', data: text }));
          activeTab.term?.focus();
        }
        return;
      }
    }
  } catch {}
  const text = await clipBox('Вставь текст (Ctrl+V), затем «Вставить»:', '', 'Вставить');
  if (text && activeTab.ws.readyState === WebSocket.OPEN) {
    activeTab.ws.send(JSON.stringify({ type: 'input', data: text }));
    activeTab.term?.focus();
  }
}

let clipResolve = null;
function clipClose(val) {
  const ov = document.getElementById('clip-ov');
  if (ov) ov.style.display = 'none';
  if (clipResolve) { const r = clipResolve; clipResolve = null; r(val); }
}
function clipBox(title, value, okText) {
  return new Promise(resolve => {
    if (clipResolve) { resolve(null); return; }
    let ov = document.getElementById('clip-ov');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'clip-ov';
      ov.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.75);display:flex;flex-direction:column;padding:14px;gap:10px';
      ov.innerHTML = '<b id="clip-title" style="font-size:14px"></b>' +
        '<textarea id="clip-text" style="flex:1;overflow-y:auto;background:#0a0a0f;border:1px solid var(--bdr);border-radius:10px;padding:10px;color:var(--t1);font:12px/1.5 monospace;-webkit-overflow-scrolling:touch"></textarea>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="clip-cancel">Отмена</button>' +
        '<button class="btn btn-p" id="clip-ok">OK</button></div>';
      document.body.appendChild(ov);
      document.getElementById('clip-cancel').onclick = () => clipClose(null);
      document.getElementById('clip-ok').onclick = () => clipClose(document.getElementById('clip-text').value);
    }
    document.getElementById('clip-title').textContent = title;
    const ta = document.getElementById('clip-text');
    ta.value = value || '';
    document.getElementById('clip-ok').textContent = okText || 'OK';
    ov.style.display = 'flex';
    clipResolve = v => resolve(v);
    setTimeout(() => { ta.focus(); ta.select(); }, 50);
  });
}
async function copySelection() {
  const term = activeTab && activeTab.term;
  if (!term) return;
  let txt = '';
  try { txt = (term.getSelection() || '').trim(); } catch {}
  if (!txt) {
    // Раньше здесь молча копировались последние 200 строк буфера — из-за этого
    // «любой тап копировал весь текст». Теперь объясняем, как выделить.
    fmInfo('Сначала выдели текст: удерживай палец на строке и тяни, потом ⧉');
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(txt);
      fmInfo('Скопировано');
      return;
    }
  } catch {}
  await clipBox('Скопируй текст (долгий тап → Копировать):', txt, 'Готово');
}


function restartTerm() {
  if (!activeTab) return;
  const toolId = activeTab.toolId;
  const cwd = toolDirs[toolId] || homeDir;
  closeTab(activeTab.id);
  setTimeout(() => createTerm(toolId, cwd), 100);
}

// ======== FILE MANAGER ========
async function initFM() {
  const r = await fetch('/api/devices').then(r => r.json());
  if (!r.success) return;
  document.getElementById('devices-list').innerHTML = r.devices.map(d => {
    const click = d.type === 'adb' ? `fmBrowseAdb('${d.id}')` : `fmSwitchBackend('${d.type}','${escAttr(d.id)}')`;
    const sub = d.free ? ` — ${formatSize(d.free)} free` : '';
    return `<div class="sb-i" onclick="${click}"><span style="font-size:15px">${d.icon}</span><div style="overflow:hidden"><div style="font-size:11px">${d.name}</div><div style="font-size:8px;color:var(--t3)">${d.type}${sub}</div></div></div>`;
  }).join('');

  // Storage backends
  document.getElementById('storages-list').innerHTML = storages.map(s => {
    return `<div class="sb-i" onclick="fmSwitchBackend('${s.id}','/')"><span style="font-size:15px">${s.icon}</span><div style="overflow:hidden"><div style="font-size:11px">${s.name}</div></div></div>`;
  }).join('');

  if (!fmCurrentPath) fmBrowse(homeDir);
}

function fmSwitchBackend(backend, startPath) {
  fmBackend = backend;
  fmBrowse(startPath || (backend === 'local' ? homeDir : '/'));
}

async function fmBrowse(p) {
  const r = await fetch("/api/browse?backend=" + fmBackend + "&path=" + encodeURIComponent(p)).then(r => r.json());
  if (!r.success) return;
  fmCurrentPath = r.path;
  const pathEl = document.getElementById("fm-path");
  if (pathEl) pathEl.value = fmBackend === "local" ? "" : "[" + fmBackend + "] " + r.path;
  const list = document.getElementById("fm-list");
  const infoEl = document.getElementById("fm-info");
  if (!list || !infoEl) return;
  list.innerHTML = '<div style="padding:20px;color:var(--t3);text-align:center">Загрузка…</div>';
  const fragment = document.createDocumentFragment();
  if (r.parent && r.parent !== r.path) {
    const div = document.createElement("div");
    div.className = "fm-item";
    div.onclick = function() { fmBrowse(r.parent); };
    div.innerHTML = '<span class="fm-ico">📁</span><span class="fm-name">..</span><span class="fm-size"></span>';
    fragment.appendChild(div);
  }
  const items = r.items || [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const div = document.createElement("div");
    div.className = "fm-item";
    div.dataset.path = escHtml(item.path);
    div.dataset.name = escHtml(item.name);
    div.dataset.isdir = item.isDir ? "1" : "0";
    div.onclick = function() { fmTap(this); };
    const iconSpan = document.createElement("span");
    iconSpan.className = "fm-ico";
    iconSpan.textContent = item.isDir ? "📁" : fileIcon(item.name);
    const nameSpan = document.createElement("span");
    nameSpan.className = "fm-name";
    nameSpan.textContent = escHtml(item.name);
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "fm-size";
    sizeSpan.textContent = item.isDir ? "" : formatSize(item.size);
    div.appendChild(iconSpan);
    div.appendChild(nameSpan);
    div.appendChild(sizeSpan);
    fragment.appendChild(div);
  }
  list.innerHTML = "";
  list.appendChild(fragment);
  if (infoEl) infoEl.textContent = items.length + " элементов | " + fmBackend;
}

function fmTap(el) {
  const p = el.dataset.path;
  if (el.dataset.isdir === '1' && fmSelected === p) {
    if (fmBackend.indexOf('adb:') === 0) fmBrowseAdbPath(fmBackend.slice(4), p);
    else fmBrowse(p);
    return;
  }
  document.querySelectorAll('#fm-list .fm-item').forEach(e => e.classList.remove('fm-sel'));
  el.classList.add('fm-sel');
  fmSelected = p;
}
function fmSelect(el) { fmTap(el); }

function fmGoUp() {
  const p = fmCurrentPath.split(/[/\\]/);
  p.pop();
  fmBrowse(p.join('/') || '/');
}

function fmGoHome() { fmBackend = 'local'; fmBrowse(homeDir || '/'); }
function fmRefresh() { fmBrowse(fmCurrentPath); }

function toggleFileSel(all) {
  const items = document.querySelectorAll('#fm-list .fm-item');
  if (!items.length) return;
  if (all) {
    const allSel = [...items].every(e => e.classList.contains('fm-sel'));
    items.forEach(e => {
      if (allSel) { e.classList.remove('fm-sel'); }
      else { e.classList.add('fm-sel'); e.dataset.path && (fmSelected = e.dataset.path); }
    });
    if (allSel) fmSelected = null;
  } else {
    const last = items[items.length - 1];
    if (last) { last.classList.add('fm-sel'); fmSelected = last.dataset.path; }
  }
}

function fmDownloadMulti() {
  const sel = [...document.querySelectorAll('#fm-list .fm-item.fm-sel')];
  if (!sel.length && !fmSelected) return;
  const items = sel.length ? sel : (fmSelected ? [{ dataset: { path: fmSelected } }] : []);
  items.forEach(el => {
    const p = el.dataset.path;
    if (p) dlNow('/api/fs/download?backend=' + fmBackend + '&path=' + encodeURIComponent(p), String(p).split(/[/\\]/).pop());
  });
}

function fmDownloadSingle() {
  if (!fmSelected) return;
  const name = String(fmSelected).split(/[/\\]/).pop();
  dlNow('/api/fs/download?backend=' + fmBackend + '&path=' + encodeURIComponent(fmSelected), name);
}

function toggleFmMenu(e) {
  e.stopPropagation();
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  const menu = document.getElementById('fm-apply-menu');
  if (!menu) return;
  const dir = fmCurrentPath || homeDir;
  menu.innerHTML = tools.filter(t => t.installed).map(t => `
    <div class="apply-item" onclick="event.stopPropagation();fmOpenIn('${escAttr(dir)}','${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color};width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:800">${t.icon}</div>
      <span>${t.name}</span>
    </div>
  `).join('') + `<div class="apply-item" onclick="event.stopPropagation();fmOpenIn('${escAttr(dir)}','_terminal')">
      <div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:18px;height:18px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:800">&gt;_</div>
      <span>Terminal</span>
    </div>`;
  menu.classList.add('on');
}

async function fmOpenIn(dir, toolId) {
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  await fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: dir }) });
  if (!recentPaths.includes(dir)) recentPaths.unshift(dir);
  showPage('terminal');
  createTerm(toolId, dir);
}

async function fmBrowseAdbPath(device, path) {
  fmBackend = `adb:${device}`;
  fmCurrentPath = path;
  document.getElementById('fm-path').value = `[ADB] ${path}`;
  const r = await fetch(`/api/browse?backend=adb:${device}&path=${encodeURIComponent(path)}`).then(r => r.json());
  if (!r.success) return;
  const list = document.getElementById('fm-list');
  let html = '';
  if (path !== '/') { const parent = path.split('/').slice(0, -1).join('/') || '/'; html += `<div class="fm-item" onclick="fmBrowseAdbPath('${device}','${parent}')"><span class="fm-ico">📁</span><span class="fm-name">..</span><span class="fm-size"></span></div>`; }
  html += r.items.map(i => `<div class="fm-item" data-path="${escHtml(i.path)}" data-isdir="${i.isDir ? '1' : '0'}" onclick="fmTap(this)"><span class="fm-ico">${i.isDir ? '📁' : '📄'}</span><span class="fm-name">${escHtml(i.name)}</span><span class="fm-size"></span></div>`).join('');
  list.innerHTML = html;
  document.getElementById('fm-info').textContent = `📱 ${r.items.length} элементов`;
}
function fmBrowseAdb(device) { fmBrowseAdbPath(device, '/sdcard'); }

// ─── ADD STORAGE MODAL ───
function showAddStorageModal() {
  document.getElementById('modal-addstorage').classList.add('on');
}

function setStorageType(type) {
  document.querySelectorAll('.storage-type-btn').forEach(b => b.classList.toggle('on', b.dataset.type === type));
  const forms = ['form-ftp', 'form-gdrive', 'form-github', 'form-http', 'form-webdav', 'form-adb'];
  forms.forEach(f => { const el = document.getElementById(f); if (el) el.style.display = 'none'; });
  const formId = `form-${type}`;
  const form = document.getElementById(formId);
  if (form) form.style.display = 'block';
}

async function saveStorage() {
  const activeBtn = document.querySelector('.storage-type-btn.on');
  if (!activeBtn) { fmInfo('Выберите тип'); return; }
  const type = activeBtn.dataset.type;
  let config = { storageType: type };

  if (type === 'ftp') {
    config.host = document.getElementById('ftp-host').value;
    config.port = parseInt(document.getElementById('ftp-port').value || '21');
    config.user = document.getElementById('ftp-user').value;
    config.pass = document.getElementById('ftp-pass').value;
    config.name = document.getElementById('ftp-name').value || `FTP: ${config.host}`;
  } else if (type === 'gdrive') {
    config.accessToken = document.getElementById('gdrive-token').value;
    config.name = document.getElementById('gdrive-name').value || 'Google Drive';
  } else if (type === 'github') {
    const repoUrl = document.getElementById('github-repo').value;
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) { fmInfo('Неверный URL репозитория'); return; }
    config.owner = match[1];
    config.repo = match[2].replace('.git', '');
    config.token = document.getElementById('github-token').value;
    config.branch = document.getElementById('github-branch').value || 'main';
    config.name = `GitHub: ${config.owner}/${config.repo}`;
  } else if (type === 'http') {
    config.url = document.getElementById('http-url').value;
    config.name = document.getElementById('http-name').value || `HTTP: ${config.url}`;
  } else if (type === 'webdav') {
    config.url = document.getElementById('webdav-url').value;
    config.user = document.getElementById('webdav-user').value;
    config.pass = document.getElementById('webdav-pass').value;
    config.name = document.getElementById('webdav-name').value || `WebDAV: ${config.url}`;
  } else if (type === 'adb') {
    const host = document.getElementById('adb-host').value;
    const port = document.getElementById('adb-port').value || '5555';
    await fetch('/api/adb/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, port }) });
    closeModal('modal-addstorage');
    initFM();
    return;
  }

  const r = await fetch('/api/storages/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }).then(r => r.json());
  if (r.success) {
    closeModal('modal-addstorage');
    storages.push({ id: r.id, name: config.name, icon: { ftp: '📂', gdrive: '☁️', github: '🐙', http: '🌐', webdav: '📁' }[type] || '📁' });
    initFM();
  } else {
    fmInfo('Ошибка: ' + r.error);
  }
}

// ─── FM FILE OPERATIONS ───
// ===== FM-МОДАЛКА — ввод имени / подтверждение / инфо (вместо системных диалогов) =====
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


async function fmMkdir() {
  const name = await fmAsk('Имя папки:');
  if (!name) return;
  const p = fmCurrentPath + '/' + name;
  await HubOffline.post('/api/fs/mkdir', { backend: fmBackend, path: p }, 'создать папку');
  fmRefresh();
}

async function fmCreateFile() {
  const name = await fmAsk('Имя файла:');
  if (!name) return;
  await HubOffline.post('/api/fs/write', { backend: fmBackend, path: fmCurrentPath + '/' + name, content: '' }, 'создать файл');
  fmRefresh();
}

async function fmDelete() {
  if (!fmSelected) return;
  const nm = fmSelected.split(/[/\\]/).pop();
  if (!(await fmConfirm('Удалить «' + nm + '»?', 'Удалить'))) return;
  await fetch('/api/fs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: fmBackend, path: fmSelected }) });
  fmRefresh();
}

async function fmRename() {
  if (!fmSelected) return;
  const newName = await fmAsk('Новое имя:', fmSelected.split(/[/\\]/).pop());
  if (!newName) return;
  const dir = fmCurrentPath;
  const newPath = dir + '/' + newName;
  await fetch('/api/fs/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: fmBackend, oldPath: fmSelected, newPath }) });
  fmRefresh();
}

function fmDownload() {
  if (!fmSelected) return;
  window.open(`/api/fs/download?backend=${fmBackend}&path=${encodeURIComponent(fmSelected)}`);
}

function fmArchive() {
  if (!fmSelected) return;
  window.open(`/api/fs/archive?path=${encodeURIComponent(fmSelected)}`);
}

async function fmSaveGithub() {
  if (!fmSelected) return;
  const name = fmSelected.split(/[/\\]/).pop();
  const isDirSel = document.querySelector('#fm-list .fm-item.fm-sel[data-isdir="1"]') != null;
  const what = isDirSel ? ('папку «' + name + '»') : ('файл «' + name + '»');
  const note = isDirSel ? '\nПапка будет упакована в tar.xz (GitHub хранит только файлы).' : '';
  if (!(await fmConfirm('Сохранить ' + what + ' в GitHub (session-state, artifacts/)?' + note, 'Сохранить'))) return;
  const r = await HubOffline.post('/api/gh/save', { path: fmSelected }, 'сохранить в GitHub');
  if (r.queued) await fmInfo('Нет связи — сохранение в очереди, уйдёт автоматически, когда связь вернётся.');
  else if (r.success) await fmInfo((r.packed ? 'Упаковано и сохранено: ' : 'Сохранено: ') + r.url);
  else await fmInfo('Ошибка: ' + (r.error || 'unknown'));
}

// Множественный выбор файлов (все виды, картинки — тоже) и целых папок —
// через нативный пикер или drag & drop мышью. Slots любые — каждый файл
// уходит сырым телом в /api/fs/upload, родительские папки сервер создаёт сам.
async function uploadFiles(files, relPaths) {
  files = (files || []).filter(f => f && typeof f.size === 'number');
  if (!files.length) return;
  const info = document.getElementById('fm-info');
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const rel = (relPaths && relPaths[i]) || f.name;
    const target = fmCurrentPath + '/' + String(rel).replace(/^\/+/, '');
    try {
      const r = await fetch('/api/fs/upload?path=' + encodeURIComponent(target), {
        method: 'POST', body: f
      });
      const j = await r.json().catch(() => ({}));
      if (j && j.success) ok++;
    } catch (e) { /* keep going — остальные файлы загружаем */ }
    if (info && files.length > 8 && i % 5 === 0) info.textContent = 'загружаю… ' + (i + 1) + '/' + files.length;
  }
  if (info) info.textContent = 'Загружено ' + ok + ' из ' + files.length + (ok === files.length ? '' : ' (ошибки — файлы сломаны или слишком большие)');
  fmRefresh();
}

function pickFiles(multiple) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = !!multiple;
  input.onchange = () => uploadFiles([...input.files]);
  input.click();
}

function fmUpload() {
  const info = document.getElementById('fm-info');
  if (info) info.textContent = 'Открываю пикер…';
  pickFiles(true); // синхронный click: браузер требует жест пользователя
}

function fmUploadFolder() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.webkitdirectory = true; // выбор папки мышью целиком
  input.onchange = () => {
    const files = [...input.files];
    uploadFiles(files, files.map(f => f.webkitRelativePath || f.name));
  };
  input.click();
}

function setupDropZone() {
  const zone = document.getElementById('fm-list');
  if (!zone || zone.dataset.dz) return;
  zone.dataset.dz = '1';
  const paint = on => {
    zone.style.borderColor = on ? 'var(--acc)' : '';
    zone.style.background = on ? 'rgba(88,166,255,.08)' : '';
  };
  zone.addEventListener('dragover', e => { e.preventDefault(); paint(true); });
  zone.addEventListener('dragleave', () => paint(false));
  zone.addEventListener('drop', e => {
    e.preventDefault(); paint(false);
    const files = [];
    const reads = [];
    const walk = (entry, out, base) => {
      if (!entry) return;
      if (entry.isFile) {
        reads.push(new Promise(res => entry.file(f => { files.push({ f, base }); res(); })));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        reads.push(new Promise(res => {
          const todo = [];
          const more = () => reader.readEntries(chunk => {
            if (!chunk || !chunk.length) { res(); return; }
            chunk.forEach(c => walk(c, out, (base ? base + c.name + '/' : c.name + '/')));
            more();
          }, () => res());
          more();
        }));
      }
    };
    const items = [...(e.dataTransfer && e.dataTransfer.items || [])];
    if (!items.length) {
      // Старые браузеры / plain files без entries.
      [...(e.dataTransfer && e.dataTransfer.files || [])].forEach(f => files.push({ f, base: '' }));
    } else {
      items.forEach(item => {
        if (item.kind === 'file') walk(item.webkitGetAsEntry && item.webkitGetAsEntry(), null, '');
      });
    }
    Promise.all(reads).then(() => {
      const fl = files.map(o => o.f);
      uploadFiles(fl, files.map(o => (o.base || '') + o.f.name));
    });
  });
}
document.addEventListener('DOMContentLoaded', () => setTimeout(setupDropZone, 300));

// ─── HELPERS ───
function formatSize(b) { if (!b) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(1) + ' GB'; }
function fileIcon(n) { const e = n.split('.').pop().toLowerCase(); return {js:'📜',ts:'📜',py:'🐍',rs:'🦀',go:'🔷',html:'🌐',css:'🎨',json:'📋',md:'📝',txt:'📝',jpg:'🖼',png:'🖼',mp3:'🎵',mp4:'🎬',zip:'📦',exe:'⚙',bat:'🖥',sh:'🖥'}[e] || '📄'; }
async function openBrowser() {
  closeModal('modal-newterm');
  document.getElementById('modal-browser').classList.add('on');
  const drivesR = await fetch('/api/drives').then(r => r.json());
  if (drivesR.success) {
    document.getElementById('browser-drives').innerHTML = drivesR.drives.map(d =>
      `<button class="drive-btn" onclick="browseTo('${d}')">${d}</button>`
    ).join('');
  }
  browseTo(homeDir || '/');
}

async function browseTo(p) {
  const r = await fetch(`/api/browse?backend=local&path=${encodeURIComponent(p)}`).then(r => r.json());
  if (!r.success) return;
  document.getElementById('browser-path').value = r.path;
  const list = document.getElementById('browser-list');
  let html = '';
  if (r.parent && r.parent !== r.path) html += `<div class="fm-item" onclick="browseTo('${escAttr(r.parent)}')"><span class="fm-ico">📁</span><span class="fm-name">..</span></div>`;
  html += r.items.filter(i => i.isDir).map(i => `<div class="fm-item" data-path="${escHtml(i.path)}" onclick="browserTap(this)"><span class="fm-ico">📁</span><span class="fm-name">${escHtml(i.name)}</span></div>`).join('');
  list.innerHTML = html || '<div style="padding:20px;color:var(--t3);text-align:center">Пусто</div>';
}

function browserTap(el) {
  if (el.classList.contains('fm-sel')) { browseTo(el.dataset.path); return; }
  document.querySelectorAll('#browser-list .fm-item').forEach(e => e.classList.remove('fm-sel'));
  el.classList.add('fm-sel');
}

function selectBrowserPath() {
  const sel = document.querySelector('#browser-list .fm-sel');
  if (sel) document.getElementById('newterm-cwd').value = sel.dataset.path;
  closeModal('modal-browser');
  document.getElementById('modal-newterm').classList.add('on');
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

function copyTunnelUrl() {
  if (window.__tunnelUrl) {
    navigator.clipboard.writeText(window.__tunnelUrl).then(() => {
      const el = document.getElementById('tunnel-url');
      const orig = el.textContent;
      el.textContent = '✓ Скопировано!';
      setTimeout(() => { el.textContent = orig; }, 1500);
    });
  }
}

// ─── MODELS FULL PAGE ───
let modelsFullData = null;

async function loadModelsFull() {
  const r = await fetch('/api/models/full').then(r => r.json());
  if (!r.success) return;
  modelsFullData = r;
  renderModelsFullProviders(r.providers);
  renderModelsFullList(r.models);
  document.getElementById('models-full-info').textContent = `${r.models.length} моделей | ${r.providers.length} провайдеров`;
}

function renderModelsFullProviders(providers) {
  const el = document.getElementById('models-full-tools');
  el.innerHTML = providers.map(p => `
    <div class="tool-config-card" style="cursor:pointer" onclick="filterByProvider('${p.id}')">
      <div class="tc-name">${p.icon} ${p.name}</div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
        <span style="font-size:10px;color:var(--t2)">${p.modelCount} моделей</span>
        ${p.free ? '<span style="font-size:8px;color:var(--ok);background:rgba(63,185,80,.15);padding:1px 5px;border-radius:4px">FREE</span>' : ''}
        ${p.configured ? '<span style="font-size:8px;color:var(--ok)">✓</span>' : '<span style="font-size:8px;color:var(--err)">⚠️</span>'}
      </div>
      ${p.key && p.key !== '(free)' ? `<div class="tc-key">🔑 ${p.key.slice(0,16)}...${p.key.slice(-4)}</div>` : ''}
    </div>
  `).join('');
}

function renderModelsFullList(models) {
  const el = document.getElementById('models-full-list');
  el.innerHTML = models.map(m => `
    <div class="model-card ${m.selected ? 'selected' : ''}">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-size:12px">${m.providerIcon}</span>
        <div class="model-name">${m.name}</div>
        ${m.selected ? '<span style="font-size:8px;color:var(--ok);background:rgba(63,185,80,.15);padding:1px 5px;border-radius:4px">✓ ACTIVE</span>' : ''}
        ${m.free ? '<span style="font-size:8px;color:var(--ok);background:rgba(63,185,80,.15);padding:1px 5px;border-radius:4px">FREE</span>' : ''}
        ${m.reasoning ? '<span style="font-size:8px;color:var(--pur);background:rgba(188,140,255,.15);padding:1px 5px;border-radius:4px">REASONING</span>' : ''}
      </div>
      <div class="model-id">${m.id}</div>
      <div style="font-size:9px;color:var(--t3);margin-top:2px">${m.providerName} • ${(m.ctx/1000).toFixed(0)}K in / ${(m.out/1000).toFixed(0)}K out</div>
      <div style="margin-top:6px;display:flex;gap:4px">
        <button class="btn btn-sm btn-ok" onclick="selectModelFull('${escAttr(m.id)}','${m.providerId}')">▶ Выбрать</button>
        ${m.key && m.key !== '(free)' ? `<span style="font-size:8px;color:var(--t3);display:flex;align-items:center">🔑 ${m.key.slice(0,10)}...</span>` : ''}
      </div>
    </div>
  `).join('');
}

let providerFilter = null;
function filterByProvider(providerId) {
  providerFilter = providerFilter === providerId ? null : providerId;
  const models = providerFilter
    ? modelsFullData.models.filter(m => m.providerId === providerFilter)
    : modelsFullData.models;
  renderModelsFullList(models);
}

async function selectModelFull(modelId, providerId) {
  await fetch('/api/models/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId, providerId }) });
  selectedModel = modelId;
  updateModelButton();
  loadModelsFull();
}

async function syncAllModels() {
  if (!modelsFullData) return;
  await selectModelFull(modelsFullData.selected, modelsFullData.provider);
  await fmInfo('Модель синхронизирована ко всем инструментам!');
}

function showApiKeyModal() {
  document.getElementById('modal-apikey').classList.add('on');
}

async function saveApiKey() {
  const key = document.getElementById('apikey-input').value.trim();
  if (!key) return;
  await fetch('/api/models/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: 'OPENROUTER_API_KEY', key }) });
  closeModal('modal-apikey');
  loadModelsFull();
}

// Load models-full when page is shown
const origShowPage = showPage;
showPage = function(p) {
  origShowPage(p);
  if (p === 'models-full') loadModelsFull();
};

// ===== TOOL INSTALL — кнопка «Скачать» + живой лог =====
let instPoll = null;
async function installTool(id) {
  const tool = tools.find(t => t.id === id);
  if (!tool || !tool.pkg) return;
  let ov = document.getElementById('install-ov');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'install-ov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);display:flex;flex-direction:column;padding:14px;gap:10px';
    ov.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><b id="install-title" style="flex:1;font-size:15px"></b>' +
      '<button class="btn btn-sm" id="install-x">✕</button></div>' +
      '<pre id="install-log" style="flex:1;overflow-y:auto;background:#0a0a0f;border:1px solid var(--bdr);border-radius:10px;padding:10px;font:11px/1.5 monospace;white-space:pre-wrap;word-break:break-all;margin:0;-webkit-overflow-scrolling:touch"></pre>' +
      '<div id="install-status" style="font-size:13px;color:var(--t2)"></div>';
    document.body.appendChild(ov);
    document.getElementById('install-x').onclick = closeInstall;
  }
  document.getElementById('install-title').textContent = '\u2B07 ' + tool.name;
  const log = document.getElementById('install-log');
  const sel = document.getElementById('install-status');
  log.textContent = ''; sel.textContent = 'запуск…'; ov.style.display = 'flex';
  if (instPoll) clearInterval(instPoll);
  let from = 0;
  try {
    const r = await (await fetch('/api/tools/install', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })).json();
    if (!r.success) { sel.textContent = '\u2717 ' + (r.error || 'не вышло'); return; }
  } catch { sel.textContent = '\u2717 нет связи'; return; }
  const tick = async () => {
    try {
      const s = await (await fetch('/api/tools/install-status?id=' + encodeURIComponent(id) + '&from=' + from)).json();
      if (!s.success) { if (instPoll) clearInterval(instPoll); sel.textContent = '\u2717 ' + (s.error || ''); return; }
      if (s.len < from) { from = 0; log.textContent = ''; }
      if (s.log) { log.textContent += s.log; from = s.len; log.scrollTop = log.scrollHeight; }
      if (s.status === 'done') {
        if (instPoll) clearInterval(instPoll);
        sel.textContent = s.installed ? '\u2713 установлено — можно запускать' : '\u2713 готово, но команда не на PATH';
        await refreshTools();
      } else if (s.status === 'error') {
        if (instPoll) clearInterval(instPoll);
        sel.textContent = '\u2717 ошибка установки — смотри лог';
      } else sel.textContent = 'качаю…';
    } catch { sel.textContent = '…'; }
  };
  await tick();
  instPoll = setInterval(tick, 1000);
}
function closeInstall() {
  if (instPoll) clearInterval(instPoll);
  instPoll = null;
  const ov = document.getElementById('install-ov');
  if (ov) ov.style.display = 'none';
}
async function refreshTools() {
  try {
    const r = await (await fetch('/api/tools')).json();
    if (r.tools) { tools = r.tools; renderDashboard(); }
  } catch {}
}
async function testTool(id) {
  const el = document.getElementById('tres-' + id);
  if (el) el.textContent = '⏳ тест…';
  let r;
  try {
    r = await (await fetch('/api/tools/test', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })).json();
  } catch { if (el) el.textContent = '✗ нет связи'; return; }
  if (!el) return;
  if (r.installed === false) { el.textContent = '✗ не установлен'; return; }
  const parts = [];
  if (r.version) parts.push('✓ работает · ' + r.version);
  if (r.needKey) parts.push('⚠ нужен ключ ' + r.keyEnv);
  el.textContent = parts.join(' · ') || '✗ нет ответа';
}
async function copyInstall(cmd) {
  try { await navigator.clipboard.writeText(cmd); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = cmd; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

// ===== HOTKEYS: Ctrl+P — новый терминал, Ctrl+X — закрыть вкладку =====
document.addEventListener('keydown', (e) => {
  const termPage = document.getElementById('p-terminal');
  if (!e.ctrlKey || !termPage || !termPage.classList.contains('on')) return;
  const el = document.activeElement;
  const inInput = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.classList.contains('xterm-helper-textarea');
  if (inInput) return;
  if (e.code === 'KeyP') { e.preventDefault(); showNewTermModal(); }
  else if (e.code === 'KeyX') { e.preventDefault(); if (activeTab) closeTab(activeTab.id); }
});

// ===== CLOUD PHONE =====
// Последний адрес облачного телефона: писался, но не восстанавливался —
// после перезагрузки панели поле оставалось пустым.
let cpLastUrl = '';
function cpRestoreLastUrl() {
  try {
    const last = localStorage.getItem('cp.lastUrl');
    if (!last) return;
    cpLastUrl = last;
    const el = document.getElementById('cp-url-desktop') || document.getElementById('cp-url');
    if (el && !el.value) el.value = last;
  } catch {}
}

function emulatorDefaultInputId(prefix) { return prefix ? 'emulator-default-desktop' : 'emulator-default'; }
async function loadEmulatorDefault(prefix) {
  try {
    const r = await fetch('/api/emulator/default');
    const d = await r.json();
    const el = document.getElementById(emulatorDefaultInputId(prefix));
    if (el && d.emulator) el.value = d.emulator;
  } catch {}
}
async function saveEmulatorDefault(prefix) {
  const el = document.getElementById(emulatorDefaultInputId(prefix));
  const emulator = String((el && el.value) || '').trim();
  if (!emulator) return;
  try {
    const r = await fetch('/api/emulator/default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emulator }) });
    const d = await r.json();
    if (d.emulator && el) el.value = d.emulator;
    const note = document.getElementById('linux-note-desktop');
    if (note) { note.textContent = 'AVD: ' + (d.emulator || d.error || 'ошибка'); setTimeout(() => { if (note.textContent.startsWith('AVD:')) note.textContent = ''; }, 3000); }
  } catch {}
}

function cloudPhoneUrl(suffix) {
  const proto = location.protocol === 'https:' ? 'https' : 'http';
  return proto + '://' + location.host + '/phone/' + (suffix || 'vnc.html');
}
function cloudPhoneWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return proto + '://' + location.pathname.replace(/[^/]*$/, '') + 'ws/vnc';
}
function phoneMsg(msg) {
  const el = document.getElementById('cp-status-desktop');
  if (el) { el.textContent = msg; el.className = 'tag tag-off'; }
}
async function cloudPhoneStatus(prefix) {
  const pfx = prefix || '';
  const el = document.getElementById('cp-status-desktop');
  const btn = document.getElementById('cp-start-desktop');
  try {
    if (el) el.className = 'tag';
    if (el) el.textContent = 'проверка…';
    const r = await fetch('/api/phone/status');
    const d = await r.json();
    const ok = d.running && d.adb;
    if (el) {
      el.textContent = ok ? '● телефон запущен' : '○ телефон выключен';
      el.className = 'tag ' + (ok ? 'tag-on' : 'tag-off');
    }
    if (btn) btn.textContent = d.running ? '→ Подключить' : '▶ Старт';
    return d;
  } catch (e) {
    if (el) { el.textContent = '? ошибка'; el.className = 'tag tag-off'; }
    return { running: false };
  }
}
async function cloudPhoneStart(prefix) {
  const pfx = prefix || '';
  const d = await cloudPhoneStatus(pfx);
  const btn = document.getElementById('cp-start-desktop');
  if (d.running && d.adb) { cloudPhoneConnect(pfx); return; }
  if (btn) { btn.textContent = '▶ Запуск…'; btn.disabled = true; }
  try {
    const r = await fetch('/api/phone/start', { method: 'POST' });
    const j = await r.json();
    if (btn) { btn.disabled = false; btn.textContent = '▶ Старт'; }
    if (j.ok) {
      const poll = setInterval(async () => {
        const s = await cloudPhoneStatus(pfx);
        if (s.running) { clearInterval(poll); cloudPhoneConnect(pfx); }
      }, 4000);
    } else {
      phoneMsg('Не удалось запустить телефон:\n' + (j.message || j.error || ''));
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Старт'; }
    phoneMsg('Ошибка запуска: ' + e.message);
  }
}
async function cloudPhoneStop(prefix) {
  const pfx = prefix || '';
  try {
    await fetch('/api/phone/stop', { method: 'POST' });
    const frame = document.getElementById('cp-frame-desktop');
    if (frame) { frame.src = 'about:blank'; frame.style.display = 'none'; }
    const ph = document.getElementById('cp-placeholder-desktop');
    if (ph) ph.style.display = 'flex';
    cloudPhoneStatus(pfx);
  } catch (e) { phoneMsg('Ошибка: ' + e.message); }
}
function cloudPhoneConnect(prefix) {
  const pfx = prefix || '';
  const frame = document.getElementById('cp-frame-desktop');
  if (!frame) return;
  const ph = document.getElementById('cp-placeholder-desktop');
  // Remote mode: the phone lives on its own runner and exposes a tunnel URL
  // (full noVNC page). Local fallback: serve the bundled noVNC through the
  // hub's /ws/vnc proxy.
  cloudPhoneStatus(pfx).then(d => {
    const url = d.url
      ? d.url
      : cloudPhoneUrl() + '?autoconnect=1&path=ws/vnc&reconnect=1&reconnect_delay=3000';
    frame.src = url;
    frame.style.display = 'block';
    if (ph) ph.style.display = 'none';
  });
}
async function phoneBrowserOpen(url, prefix) {
  const pfx = prefix || '';
  const urlEl = document.getElementById('cp-url-desktop');
  const val = String(url || (urlEl && urlEl.value) || '').trim();
  if (!val) return;
  if (!/^https?:\/\//i.test(val)) val = 'https://' + val;
  if (urlEl) urlEl.value = val;
  try { localStorage.setItem('cp.lastUrl', val); } catch {}
  cpLastUrl = val;
  const d = await cloudPhoneStatus(pfx);
  if (!d.running) {
    phoneMsg('Телефон не запущен. Нажмите «▶ Старт».');
    return;
  }
  cloudPhoneConnect(pfx);
  try {
    const r = await fetch('/api/phone/browser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: val })
    });
    const j = await r.json();
    if (!j.ok) console.warn('phone browser:', j.error || j.message);
  } catch (e) { console.warn('phone browser failed:', e.message); }
}
function cloudPhoneFullscreen(prefix) {
  const pfx = prefix || '';
  const frame = document.getElementById('cp-frame-desktop');
  if (frame && frame.requestFullscreen) frame.requestFullscreen();
  else if (frame && frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
}
// Screen tab: auto-connect as soon as the Linux desktop answers, and keep
// polling until it is up (its job starts it on the very first run).
if (document.getElementById('p-linux')) { loadEmulatorDefault('desktop'); linuxAutoConnect(); }

// ===== LINUX DESKTOP (VNC) =====

let browserHistDesk=[], browserIdxDesk=-1;
// Вкладку Chrome убрали (она дублировала «Экран»): любая ссылка открывается
// прямо на удалённом рабочем столе.
function hubBrowserGo(url){
  if(!url) return;
  url=url.trim(); if(!/^https?:\/\//i.test(url)) url='https://'+url;
  const inp=document.getElementById('browser-url-desktop');
  if(inp) inp.value=url;
  try{localStorage.setItem('hub_browser_last',url);}catch{}
  const isYt=/youtube|youtu\.be/i.test(url);
  linuxRunBrowser(url, isYt);
  fmInfo('🌐 '+url+' → открываю на экране');
  showPage('linux');
}

function browserOpenDesktop(url, vertical){
  if(!url) url=document.getElementById('browser-url-desktop')?.value||'';
  if(!url) return;
  url=url.trim(); if(!/^https?:\/\//i.test(url)) url='https://'+url;
  linuxRunBrowser(url, !!vertical);
  showPage('linux'); setTimeout(()=>linuxConnect(),800);
}

// ===== TTS desktop (общий с mobile) =====
let ttsVoicesD=[], ttsQueueD=[], ttsIdxD=0, ttsSpeakingD=false, ttsPausedD=false;
function ttsInitDesk(){
  try{
    const load=()=>{
      ttsVoicesD=speechSynthesis.getVoices()||[];
      const sel=document.getElementById('tts-voice-desk');
      if(sel) sel.innerHTML=ttsVoicesD.map((v,i)=>`<option value="${i}">${v.name} (${v.lang})</option>`).join('');
    };
    load();
    if(speechSynthesis.onvoiceschanged!==undefined) speechSynthesis.onvoiceschanged=load;
  }catch{}
}
setTimeout(ttsInitDesk,600);
function ttsToggleDesk(){
  const sel=document.getElementById('tts-voice-desk');
  const voice=sel?sel.value:0;
  // Используем те же функции что в mobile, но с desk id
  const s=document.getElementById('tts-voice'); if(s) s.value=voice;
  // Вызываем общий ttsToggle если есть
  if(typeof ttsToggle==='function') ttsToggle();
  else {
    // fallback simple
    let txt='';
    try{ const f=document.getElementById('browser-frame-desk'); if(f&&f.contentDocument) txt=f.contentDocument.body.innerText.slice(0,8000); }catch{}
    if(!txt) txt=document.getElementById('browser-url-desk')?.value||'';
    if(txt){ const u=new SpeechSynthesisUtterance(txt.slice(0,2000)); if(ttsVoicesD[voice]) u.voice=ttsVoicesD[voice]; speechSynthesis.speak(u); }
  }
}
function ttsStopDesk(){ if(typeof ttsStop==='function') ttsStop(); else speechSynthesis.cancel(); }
function ttsSetRateDesk(v){ const el=document.getElementById('tts-rate-label-desk'); if(el) el.textContent=v+'×'; if(typeof ttsSetRate==='function') ttsSetRate(v); }
function ocrCaptureDesk(){
  if(typeof ocrCapture==='function') ocrCapture();
  else fmInfo('OCR: распознавание доступно в мобильной панели');
}
function browserAgentHintDesk(url){
  if(!url) return;
  const hint=document.getElementById('browser-agent-hint-desk');
  const a=document.getElementById('browser-agent-url-desk');
  if(!hint||!a) return;
  a.textContent=url; a.href=url; hint.style.display='flex';
}
window.openInHubBrowser=(url)=>{ browserAgentHintDesk(url); hubBrowserGo(url); };
async function pulseToggleMuteDesk(){
  try{ const r=await fetch('/api/pulse/mute',{method:'POST'}); const d=await r.json(); }catch{}
}

// ===== TTS + OCR + Автоскролл + Фон =====
let ttsVoices=[], ttsQueue=[], ttsIdx=0, ttsSpeaking=false, ttsPaused=false, ttsScrollTimer=null, ttsRate=1;
function ttsInit(){
  try{
    const loadVoices=()=>{
      ttsVoices=speechSynthesis.getVoices()||[];
      const sel=document.getElementById('tts-voice');
      if(sel){
        sel.innerHTML=ttsVoices.map((v,i)=>`<option value="${i}" ${v.default?'selected':''}>${v.name} (${v.lang})</option>`).join('');
        if(!sel.value && ttsVoices.length) sel.value=0;
      }
      const selDesk=document.getElementById('tts-voice-desk');
      if(selDesk) selDesk.innerHTML=sel?sel.innerHTML:'';
    };
    loadVoices();
    if(speechSynthesis.onvoiceschanged!==undefined) speechSynthesis.onvoiceschanged=loadVoices;
  }catch{}
}
setTimeout(ttsInit, 500);
function ttsSetRate(v){ ttsRate=parseFloat(v)||1; const l=document.getElementById('tts-rate-label'); if(l) l.textContent=v+'×'; const ld=document.getElementById('tts-rate-label-desk'); if(ld) ld.textContent=v+'×'; }
function ttsSetRateDesk(v){ ttsSetRate(v); }
function getPageText(){
  // Пытаемся взять текст из iframe если тот же origin, иначе просим OCR
  try{
    const frame=document.getElementById('browser-frame');
    if(frame && frame.contentDocument){
      const body=frame.contentDocument.body;
      if(body){
        let txt=body.innerText||body.textContent||'';
        txt=txt.trim().slice(0,12000);
        if(txt.length>30) return txt;
      }
    }
  }catch{}
  // Fallback: текст из placeholder или URL
  const url=document.getElementById('browser-url-main')?.value||'';
  return 'Страница: '+url+' . Текст не доступен напрямую из-за защиты сайта. Нажми 👁️ OCR чтобы распознать скриншот.';
}
function ttsSpeakChunk(text){
  if(!text) return;
  const u=new SpeechSynthesisUtterance(text);
  const sel=document.getElementById('tts-voice');
  if(sel && ttsVoices[sel.value]) u.voice=ttsVoices[sel.value];
  u.rate=ttsRate; u.lang=(u.voice&&u.voice.lang)||'ru-RU';
  u.onstart=()=>{
    const st=document.getElementById('tts-status'); if(st) st.textContent='🔊 читаю...';
    const btn=document.getElementById('tts-play-btn'); if(btn) btn.textContent='⏸ Пауза';
  };
  u.onend=()=>{
    ttsIdx++;
    if(ttsIdx < ttsQueue.length && ttsSpeaking && !ttsPaused){
      // Автоскролл
      if(document.getElementById('tts-autoscroll')?.checked){
        try{
          const frame=document.getElementById('browser-frame');
          if(frame && frame.contentWindow) frame.contentWindow.scrollBy(0,180);
          else window.scrollBy(0,180);
        }catch{}
        // Скролл VNC iframe тоже
        const vnc=document.getElementById('linux-frame');
        if(vnc && vnc.contentWindow) try{vnc.contentWindow.scrollBy(0,180);}catch{}
      }
      ttsSpeakChunk(ttsQueue[ttsIdx]);
    } else {
      ttsSpeaking=false; ttsPaused=false;
      const st=document.getElementById('tts-status'); if(st) st.textContent='готов';
      const btn=document.getElementById('tts-play-btn'); if(btn) btn.textContent='▶ Читать';
      if(ttsScrollTimer){ clearInterval(ttsScrollTimer); ttsScrollTimer=null; }
    }
  };
  u.onerror=()=>{ ttsIdx++; if(ttsIdx<ttsQueue.length) ttsSpeakChunk(ttsQueue[ttsIdx]); };
  speechSynthesis.speak(u);
}
function ttsToggle(){
  const bg=document.getElementById('tts-bg')?.checked;
  if(ttsSpeaking && !ttsPaused){
    speechSynthesis.pause(); ttsPaused=true;
    const st=document.getElementById('tts-status'); if(st) st.textContent='⏸ пауза';
    const btn=document.getElementById('tts-play-btn'); if(btn) btn.textContent='▶ Продолжить';
    return;
  }
  if(ttsPaused){
    speechSynthesis.resume(); ttsPaused=false;
    const st=document.getElementById('tts-status'); if(st) st.textContent='🔊 читаю...';
    const btn=document.getElementById('tts-play-btn'); if(btn) btn.textContent='⏸ Пауза';
    return;
  }
  // Старт нового чтения
  const raw=getPageText();
  // Режем на предложения по 180 символов для автопрокрутки
  ttsQueue=raw.split(/(?<=[.!?。！？])\s+/).reduce((acc,s)=>{
    if(s.length<180) acc.push(s);
    else for(let i=0;i<s.length;i+=180) acc.push(s.slice(i,i+180));
    return acc;
  },[]).filter(Boolean).slice(0,80);
  if(!ttsQueue.length) ttsQueue=[raw.slice(0,800)];
  ttsIdx=0; ttsSpeaking=true; ttsPaused=false;
  // Держим в фоне: не даём браузеру уснуть
  if(bg){
    try{
      if(navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(()=>{});
    }catch{}
    document.addEventListener('visibilitychange', ttsVisHandler);
  }
  // Автоскролл таймер 4с
  if(document.getElementById('tts-autoscroll')?.checked){
    ttsScrollTimer=setInterval(()=>{
      if(!ttsSpeaking||ttsPaused) return;
      try{
        const frame=document.getElementById('browser-frame');
        if(frame && frame.contentWindow) frame.contentWindow.scrollBy(0,120);
      }catch{}
    }, 4000);
  }
  ttsSpeakChunk(ttsQueue[ttsIdx]);
}
function ttsVisHandler(){
  // В фоне продолжаем читать
  if(document.visibilityState==='visible'){
    if(ttsSpeaking && !ttsPaused) speechSynthesis.resume();
  } else {
    if(document.getElementById('tts-bg')?.checked && ttsSpeaking && !ttsPaused){
      // Не паузим, держим аудио
      try{ speechSynthesis.resume(); }catch{}
    }
  }
}
function ttsPause(){ if(ttsSpeaking && !ttsPaused){ speechSynthesis.pause(); ttsPaused=true; const st=document.getElementById('tts-status'); if(st) st.textContent='⏸ пауза'; } }
function ttsStop(){
  try{ speechSynthesis.cancel(); }catch{}
  ttsSpeaking=false; ttsPaused=false; ttsQueue=[]; ttsIdx=0;
  if(ttsScrollTimer){ clearInterval(ttsScrollTimer); ttsScrollTimer=null; }
  document.removeEventListener('visibilitychange', ttsVisHandler);
  const st=document.getElementById('tts-status'); if(st) st.textContent='остановлено';
  const btn=document.getElementById('tts-play-btn'); if(btn) btn.textContent='▶ Читать';
}
function ttsToggleDesk(){ // для десктопа вызываем тот же ttsToggle
  // Синхронизируем select
  const v=document.getElementById('tts-voice-desk')?.value;
  if(v!==undefined) { const s=document.getElementById('tts-voice'); if(s) s.value=v; }
  ttsToggle();
}
function ttsStopDesk(){ ttsStop(); }
function ttsSetRateDesk(v){ ttsSetRate(v); }
async function ocrCapture(){
  const st=document.getElementById('tts-status'); if(st) st.textContent='👁️ OCR...';
  try{
    // Сначала пробуем взять текст напрямую
    let txt=getPageText();
    if(txt && !txt.includes('Текст не доступен')){
      if(st) st.textContent='OK (текст)';
      ttsQueue=[txt.slice(0,3000)]; ttsIdx=0;
      ttsToggle();
      fmInfo('Читаю распознанное: '+txt.slice(0,80)+'…');
      return;
    }
    // Иначе скриншот VNC + tesseract на сервере
    const r=await fetch('/api/ocr', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({})});
    const d=await r.json();
    if(d.ok && d.text){
      txt=d.text; 
      if(st) st.textContent='OCR готово: '+d.text.slice(0,30)+'...';
      // Кладём в буфер и предлагаем читать
      ttsQueue=[txt.slice(0,4000)];
      ttsIdx=0; ttsSpeaking=false; ttsToggle();
      fmInfo('OCR: читаю распознанное ('+txt.length+' символов)');
    } else {
      if(st) st.textContent='OCR: '+ (d.error||'нет текста');
      fmInfo('OCR не нашёл текст: '+(d.error||'попробуй другую страницу'));
    }
  }catch(e){
    if(st) st.textContent='OCR ошибка';
    fmInfo('OCR ошибка: '+e.message);
  }
}
function ocrCaptureDesk(){ ocrCapture(); }
// ===== LINUX DESKTOP (VNC) — всегда включён (сервер: src/vnc-keepalive.js) =====
let linuxLastUrl = '';
let linuxRetries = 0, linuxRepairAsked = 0, linuxPollTimer = null;
const LINUX_PROFILES = {
  smooth:   { quality: 3, compression: 7, label: '⚡ плавно' },
  balanced: { quality: 6, compression: 2, label: '⚡ баланс' },
  sharp:    { quality: 9, compression: 0, label: '⚡ чётко' }
};
let linuxPerf = (() => { try { return localStorage.getItem('hub_perf') || 'smooth'; } catch { return 'smooth'; } })();
function linuxPerfToggle() {
  const order = ['smooth', 'balanced', 'sharp'];
  linuxPerf = order[(order.indexOf(linuxPerf) + 1) % order.length];
  try { localStorage.setItem('hub_perf', linuxPerf); } catch {}
  const fr = document.getElementById('linux-frame-desktop');
  if (fr) fr.dataset.src = '';
  linuxConnect('desktop');
  linuxSetNote('картинка: ' + (LINUX_PROFILES[linuxPerf] || {}).label);
  setTimeout(() => linuxSetNote(''), 4000);
}
function linuxSetNote(text) {
  const n = document.getElementById('linux-note-desktop');
  if (n) n.textContent = text || '';
}
async function linuxStatus(prefix) {
  const pfx = prefix || '';
  const el = document.getElementById(pfx ? 'linux-status-desktop' : 'linux-status');
  try {
    const r = await fetch('/api/vnc/status');
    const d = await r.json();
    const ok = d.running && d.url;
    if (el) {
      const where = d.source === 'local' ? 'этот экран' : d.source === 'remote' ? 'другой раннер' : '';
      el.textContent = ok ? '● запущен' + (where ? ' · ' + where : '')
        : (d.installing && d.installing.length ? '⧗ ставлю ' + d.installing.join(', ') : '○ поднимается…');
      el.className = 'tag ' + (ok ? 'tag-on' : 'tag-off');
    }
    if (d.keepalive && typeof d.keepalive.note === 'string' && d.keepalive.note
        && !d.keepalive.note.startsWith('running')) linuxSetNote(d.keepalive.note.slice(0, 90));
    return d;
  } catch (e) {
    if (el) { el.textContent = '? нет связи с хабом'; el.className = 'tag tag-off'; }
    return { running: false, url: null };
  }
}
function linuxQuery(u) {
  if (u) {
    // keepalive already returns autoconnect=true; still apply the selected
    // quality/compression profile to that URL so video is not sent at the
    // heavier noVNC defaults.
    if (!/[?&]autoconnect=/.test(u)) {
      u += (u.includes('?') ? '&' : '?') + 'autoconnect=true&reconnect=true&reconnect_delay=2000&resize=scale';
    }
    if (!/[?&]quality=/.test(u)) {
      const p = LINUX_PROFILES[linuxPerf] || LINUX_PROFILES.smooth;
      u += `&quality=${p.quality}&compression=${p.compression}`;
    }
  }
  return u;
}
async function linuxConnect(prefix) {
  const pfx = prefix || '';
  const fr = document.getElementById(pfx ? 'linux-frame-desktop' : 'linux-frame');
  const ph = document.getElementById(pfx ? 'linux-placeholder-desktop' : 'linux-placeholder');
  const d = await linuxStatus(pfx);
  if (!d.url) {
    linuxRetries++;
    if (fr) fr.style.display = 'none';
    if (ph) ph.style.display = 'flex';
    linuxSetNote('поднимаю экран на этом раннере: попытка ' + linuxRetries + '…');
    if (linuxRetries >= 6 && Date.now() - linuxRepairAsked > 60000) {
      linuxRepairAsked = Date.now();
      try { await fetch('/api/vnc/keepalive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'repair' }) }); } catch {}
      linuxSetNote('хаб пересобирает рабочий стол…');
    }
    clearTimeout(linuxPollTimer);
    linuxPollTimer = setTimeout(() => { try { linuxConnect(pfx); } catch {} }, 5000);
    return;
  }
  const u = linuxQuery(d.url);
  linuxLastUrl = d.url;
  linuxRetries = 0;
  if (fr) {
    if (fr.dataset.src !== u) { fr.dataset.src = u; fr.src = u; }
    fr.style.display = 'block';
    fr.allow = 'fullscreen; clipboard-read; clipboard-write';
    linuxPatchFrame(fr);
    setTimeout(() => linuxApplyZoom(fr), 3000);
  }
  if (ph) ph.style.display = 'none';
  linuxSetNote('');
}
// Совместимость: те же вызовы, что и раньше.
async function linuxAutoConnect(force) {
  if (force) { linuxRetries = 0; }
  return linuxConnect('desktop');
}
async function linuxFullscreen(prefix) {
  const page = document.getElementById('p-linux');
  if (!page) return;
  const want = !page.classList.contains('linux-full');
  page.classList.toggle('linux-full', want);
  try {
    if (want) { if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); }
    else if (document.exitFullscreen && document.fullscreenElement) await document.exitFullscreen();
  } catch (e) {}
  try { fmInfo && fmInfo(want ? '⛶ На весь экран (Esc — выход)' : '⛶ Обычный размер'); } catch {}
}
document.addEventListener('fullscreenchange', () => {
  const page = document.getElementById('p-linux');
  if (page && !document.fullscreenElement) page.classList.remove('linux-full');
  linuxRefit();
});
window.addEventListener('resize', () => { clearTimeout(window.__linuxRefitT); window.__linuxRefitT = setTimeout(linuxRefit, 300); });
function linuxRefit() {
  const fr = document.getElementById('linux-frame-desktop');
  try {
    if (fr && fr.contentDocument) {
      fr.contentDocument.defaultView.dispatchEvent(new Event('resize'));
      if (fr.contentDocument.__hub) fr.contentDocument.__hub.scale(linuxZoomMode);
    }
  } catch {}
}
function linuxKeyboard(prefix) {
  const fr = document.getElementById(prefix ? 'linux-frame-desktop' : 'linux-frame');
  let ok = false;
  try { ok = fr && fr.contentDocument && fr.contentDocument.__hub ? fr.contentDocument.__hub.kbd() : false; } catch {}
  linuxSetNote(ok ? '⌨ клавиатура переключена' : 'клавиатура: экран ещё грузится…');
  setTimeout(() => linuxSetNote(''), 4000);
}
let linuxZoomMode = (() => { try { return localStorage.getItem('hub_zoom') || 'fit'; } catch { return 'fit'; } })();
function linuxZoomToggle(prefix) {
  linuxZoomMode = linuxZoomMode === 'fit' ? 'clip' : 'fit';
  try { localStorage.setItem('hub_zoom', linuxZoomMode); } catch {}
  const fr = document.getElementById(prefix ? 'linux-frame-desktop' : 'linux-frame');
  try { if (fr && fr.contentDocument && fr.contentDocument.__hub) fr.contentDocument.__hub.scale(linuxZoomMode); } catch {}
  const btn = document.getElementById(prefix ? 'linux-zoom-btn-desktop' : 'linux-zoom-btn');
  if (btn) btn.textContent = linuxZoomMode === 'fit' ? '🔍' : '🔎';
  linuxSetNote(linuxZoomMode === 'fit' ? 'вписано в экран' : '1:1 — панорамирование пальцем/мышью');
  setTimeout(() => linuxSetNote(''), 4000);
}
async function linuxReload() {
  // Полный перезапуск сессии noVNC: сбрасываем dataset.src, иначе connect
  // решит, что URL не изменился, и ничего не перезагрузит.
  const fr = document.getElementById('linux-frame-desktop');
  if (fr) { fr.dataset.src = ''; fr.src = ''; fr.style.display = 'block'; }
  linuxRetries = 0;
  await linuxConnect('desktop');
}
async function linuxRepair(prefix) {
  linuxSetNote('починка экрана…');
  linuxRetries = 0; linuxRepairAsked = Date.now();
  try { await fetch('/api/vnc/keepalive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'repair' }) }); } catch {}
  setTimeout(() => { try { linuxConnect(prefix || 'desktop'); } catch {} }, 3000);
}

// noVNC живёт в iframe на нашем же домене, поэтому можем его подправить:
//  * прячем его кнопку fullscreen — на iPhone iframe в fullscreen не умеет, и
//    клик по ней показывал красную ошибку «Fullscreen is not supported»;
//  * прячем саму эту ошибку, если она всё же появилась (у нас есть свой ⛶,
//    который разворачивает страницу целиком и работает в любом браузере).
function linuxPatchFrame(fr) {
  if (!fr) return;
  const inject = () => {
    try {
      const doc = fr.contentDocument;
      if (!doc || doc.__hubPatched) return;
      // Кнопка fullscreen самого noVNC бесполезна и ругалась ошибкой; его
      // клавиатуру и масштаб, наоборот, вытаскиваем наружу через __hub.
      doc.__hubPatched = true;
      const st = doc.createElement('style');
      st.textContent = [
        '#noVNC_fullscreen_button{display:none!important}',
        '#noVNC_control_bar,#noVNC_control_bar_handle{display:none!important}',
        // Курсор-точка рисуется по центру касания — без неё непонятно, куда
        // именно попадёт клик. Оставляем её всегда видимой.
        '#noVNC_connect_dlg{display:none!important}'
      ].join('');
      doc.head.appendChild(st);

      // Касание = клик в точке касания + перенос курсора: показываем точку
      // (noVNC рисует её только при включённой настройке show_dot).
      try {
        const dot = doc.getElementById('noVNC_setting_show_dot');
        if (dot && !dot.checked) { dot.checked = true; dot.dispatchEvent(new Event('change', { bubbles: true })); }
      } catch {}

      doc.__hub = {
        // Клавиатура ТЕЛЕФОНА: noVNC по нажатию своей кнопки фокусирует
        // скрытый input, от него приходят события мягкой клавиатуры.
        kbd(show) {
          const btn = doc.getElementById('noVNC_keyboard_button');
          const inp = doc.getElementById('noVNC_keyboardinput');
          if (btn) { btn.click(); return true; }
          if (inp) { (show === false ? inp.blur() : inp.focus()); return true; }
          return false;
        },
        // Масштаб: 'fit' — вписать в экран, 'clip' — 1:1 с панорамированием.
        scale(mode) {
          const sel = doc.getElementById('noVNC_setting_resize');
          const clip = doc.getElementById('noVNC_setting_view_clip');
          const fire = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));
          if (sel) { sel.value = mode === 'clip' ? 'off' : 'scale'; fire(sel); }
          if (clip) { clip.checked = mode === 'clip'; fire(clip); }
          return Boolean(sel);
        },
        // ── Виртуальная мышь ────────────────────────────────────────────────
        // Работает через тот же RFB, что и обычное управление: координаты в
        // CSS-пикселях канвы, как их ждёт rfb._sendMouse(). Палец по сенсору
        // НЕ должен попадать в кадр — иначе ноVNC отправит свой клик, поэтому
        // сенсор, кнопки и стрелки живут в родительской странице, а сюда
        // приходят только готовые команды.
        mouse: {
          rf() { const w = doc.defaultView; return (w && w.__rfb) || null; },
          canvas() { return doc.querySelector('canvas'); },
          dot() {
            let d = doc.getElementById('hub-vmouse-dot');
            if (!d) {
              d = doc.createElement('div');
              d.id = 'hub-vmouse-dot';
              d.style.cssText = 'position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;'
                + 'background:rgba(88,166,255,.35);border:2px solid #58a6ff;box-shadow:0 0 8px rgba(0,0,0,.7);'
                + 'pointer-events:none;z-index:2147483000;display:none';
              doc.body.appendChild(d);
            }
            return d;
          },
          pos() {
            if (!this._p) {
              const c = this.canvas();
              this._p = { x: Math.round((c ? c.clientWidth : 0) / 2), y: Math.round((c ? c.clientHeight : 0) / 2) };
            }
            return this._p;
          },
          _clamp() {
            const c = this.canvas(), p = this.pos();
            if (c) {
              p.x = Math.max(0, Math.min(Math.max(0, c.clientWidth - 1), p.x));
              p.y = Math.max(0, Math.min(Math.max(0, c.clientHeight - 1), p.y));
            }
            return p;
          },
          _draw() {
            const c = this.canvas(), d = this.dot(), p = this.pos();
            if (!c || !d) return;
            const r = c.getBoundingClientRect();
            d.style.display = 'block';
            d.style.left = (r.left + p.x) + 'px';
            d.style.top = (r.top + p.y) + 'px';
          },
          // Стол больше экрана телефона (режим «крупно», 1:1): когда курсор
          // подходит к краю видимого куска, картинка подъезжает за ним — иначе
          // мышью достать до угла стола невозможно.
          _follow() {
            const r = this.rf(), c = this.canvas();
            if (!r || !c) return;
            const d = r._display;
            if (!d || !d.clipViewport || !d._viewportLoc) return;
            const s = d.scale || 1;
            if (!s) return;
            const vw = (c.clientWidth || 0) / s, vh = (c.clientHeight || 0) / s;
            if (!vw || !vh) return;
            const p = this.pos();
            const dx = p.x / s + d._viewportLoc.x, dy = p.y / s + d._viewportLoc.y;
            const m = 28 / s;                       // начинаем подъезжать за 28 css-px до края
            let mx = 0, my = 0;
            if (dx < d._viewportLoc.x + m) mx = dx - (d._viewportLoc.x + m);
            else if (dx > d._viewportLoc.x + vw - m) mx = dx - (d._viewportLoc.x + vw - m);
            if (dy < d._viewportLoc.y + m) my = dy - (d._viewportLoc.y + m);
            else if (dy > d._viewportLoc.y + vh - m) my = dy - (d._viewportLoc.y + vh - m);
            if (mx || my) { try { d.viewportChangePos(Math.round(mx), Math.round(my)); } catch {} }
          },
          _send(mask) {
            const r = this.rf(), p = this.pos();
            if (!r) return false;
            try { r._sendMouse(p.x, p.y, mask | 0); return true; } catch { return false; }
          },
          // сдвиг курсора (dx, dy в CSS-пикселях стола), mask — зажатые кнопки
          move(dx, dy, mask) {
            const p = this.pos();
            p.x += dx; p.y += dy;
            this._clamp(); this._follow(); this._draw();
            this._send(mask | 0);
            return { x: p.x, y: p.y };
          },
          // перевести курсор в точку кадра (панорама/поворот экрана)
          to(x, y, mask) { const p = this.pos(); p.x = x; p.y = y; this._clamp(); this._draw(); this._send(mask | 0); return { x: p.x, y: p.y }; },
          button(mask, down) { return this._send(down ? (mask | 0) : 0); },
          click(mask) { this.button(mask, true); setTimeout(() => { try { this.button(mask, false); } catch {} }, 70); return true; },
          // колесо: 8 — вверх, 16 — вниз, 32 — влево, 64 — вправо
          wheel(mask) { if (!this._send(mask | 0)) return false; this._send(0); return true; },
          center() { this._p = null; this._clamp(); this._draw(); return this.pos(); },
          state() { const p = this.pos(); return { x: p.x, y: p.y, dot: !!doc.getElementById('hub-vmouse-dot') }; }
        },
        info() {
          const sel = doc.getElementById('noVNC_setting_resize');
          const cv = doc.querySelector('canvas');
          return { resize: sel && sel.value, canvas: cv ? cv.width + 'x' + cv.height : null };
        }
      };

      const kill = () => {
        const s = doc.getElementById('noVNC_status');
        if (!s) return;
        if (/fullscreen|полный экран/i.test(s.textContent || '')) {
          s.style.display = 'none';
          s.textContent = '';
        }
      };
      kill();
      try { new MutationObserver(kill).observe(doc.body, { childList: true, subtree: true, characterData: true }); } catch {}
    } catch (e) { /* другой домен — просто ничего не делаем */ }
  };
  if (fr.contentDocument && fr.contentDocument.readyState === 'complete') inject();
  fr.addEventListener('load', inject, { once: false });
}

// Применяем масштаб после (пере)загрузки кадра: noVNC читает свои настройки
// из cookie при старте, поэтому просим нужный режим ещё раз.
function linuxApplyZoom(fr) {
  try { if (fr && fr.contentDocument && fr.contentDocument.__hub) fr.contentDocument.__hub.scale(linuxZoomMode); } catch {}
}

// Всегда включён: коннект при загрузке и keepalive без перезагрузки iframe.
setTimeout(() => { try { linuxConnect('desktop'); } catch {} }, 600);
setInterval(() => {
  const fr = document.getElementById('linux-frame-desktop');
  if (!fr || !fr.dataset.src || fr.style.display === 'none') { try { linuxConnect('desktop'); } catch {} }
}, 15000);

// ===== ВИРТУАЛЬНАЯ МЫШЬ =====
// Раньше «мышью» служил сам палец по картинке экрана: он закрывает то место,
// куда целишься, промах уходил в пустоту, а прокрутки не было вовсе. Теперь
// мышь отдельная и как настоящая: слева СЕНСОР (тянешь — курсор едет, тап —
// клик, два тапа — двойной клик), справа две кнопки (ЛКМ/ПКМ, их можно
// зажать и перетаскивать) и колесо стрелками (▲▼ вверх/вниз, ◀▶ влево/вправо).
let linuxMouseOn = false;
let vMouseWheelTimer = null;
const VMOUSE_SENS = 1.8;            // палец прошёл 10 px — курсор 18 px стола
const vMouseHeld = { 1: false, 4: false };
const VMOUSE_WHEEL_MASK = { up: 8, down: 16, left: 32, right: 64 };

// Доступ к мыши внутри кадра noVNC (кадр наш, поэтому contentDocument открыт).
function vMouseFrame() {
  const fr = document.getElementById('linux-frame-desktop');
  try { return (fr && fr.contentDocument && fr.contentDocument.__hub) || null; } catch { return null; }
}
function vMouseApi() {
  const h = vMouseFrame();
  return (h && h.mouse) || null;
}
function vMouseReady() { return !!vMouseApi(); }
function vMouseHeldMask() { return (vMouseHeld[1] ? 1 : 0) | (vMouseHeld[4] ? 4 : 0); }

function vMouseMove(dx, dy) {
  const m = vMouseApi();
  if (!m) return false;
  try { m.move(dx, dy, vMouseHeldMask()); return true; } catch { return false; }
}
function vMouseClick(mask) {
  const m = vMouseApi();
  if (!m) return false;
  try { m.click(mask || 1); linuxSetNote('🖱 клик'); return true; } catch { return false; }
}
function vMouseDown(mask) {
  vMouseHeld[mask] = true;
  const m = vMouseApi();
  try { if (m) m.button(mask, true); } catch {}
  const b = document.getElementById(mask === 4 ? 'lm-right' : 'lm-left');
  if (b) b.classList.add('on');
  linuxSetNote(mask === 4 ? '🖱 правая кнопка зажата — тяни по сенсору' : '🖱 левая зажата — тяни, чтобы перетащить');
}
function vMouseUp(mask) {
  if (!vMouseHeld[mask]) return;
  vMouseHeld[mask] = false;
  const m = vMouseApi();
  try { if (m) m.button(mask, false); } catch {}
  const b = document.getElementById(mask === 4 ? 'lm-right' : 'lm-left');
  if (b) b.classList.remove('on');
  linuxSetNote('');
}
function vMouseWheelStart(dir) {
  vMouseWheelStop();
  const fire = () => {
    const m = vMouseApi();
    try { if (m) m.wheel(VMOUSE_WHEEL_MASK[dir]); } catch {}
  };
  fire();
  // Держишь стрелку — колесо крутится дальше само (≈7 щелчков в секунду).
  vMouseWheelTimer = setInterval(fire, 140);
  const b = document.querySelector('.lm-arr[data-dir="' + dir + '"]');
  if (b) b.classList.add('on');
}
function vMouseWheelStop() {
  if (vMouseWheelTimer) { clearInterval(vMouseWheelTimer); vMouseWheelTimer = null; }
  document.querySelectorAll('.lm-arr.on').forEach((b) => b.classList.remove('on'));
}

// Показать/скрыть мышь. Состояние помним: если мышь нужна, она нужна всегда.
function linuxMouseToggle(force) {
  const el = document.getElementById('linux-mouse');
  const btn = document.getElementById('linux-mouse-btn');
  linuxMouseOn = force === undefined ? !linuxMouseOn : !!force;
  if (el) el.hidden = !linuxMouseOn;
  if (btn) btn.classList.toggle('on', linuxMouseOn);
  try { localStorage.setItem('hub_vmouse', linuxMouseOn ? '1' : '0'); } catch {}
  if (linuxMouseOn) {
    if (!vMouseReady()) linuxSetNote('🖱 мышь включится, как только экран догрузится');
    else linuxSetNote('🖱 сенсор — курсор, ЛКМ/ПКМ — кнопки, стрелки — колесо');
    // курсор ставим в середину экрана, иначе он появляется «из ниоткуда»
    const m = vMouseApi();
    try { if (m) m.center(); } catch {}
    if (!el) return;
  } else {
    vMouseWheelStop();
    vMouseUp(1); vMouseUp(4);
  }
}

// Сенсор: тянешь палец — курсор едет; тап — клик; два тапа — двойной клик.
function vMouseInitPad() {
  const pad = document.getElementById('lm-pad');
  if (!pad || pad.__wired) return;
  pad.__wired = true;
  let drag = null, lastTap = 0;
  const pt = (e) => {
    const t = (e.touches && e.touches[0]) || e;
    return { x: t.clientX || 0, y: t.clientY || 0 };
  };
  const down = (e) => {
    const p = pt(e);
    drag = { x: p.x, y: p.y, t: Date.now(), moved: 0 };
    pad.classList.add('active');
    try { if (e.pointerId !== undefined) pad.setPointerCapture(e.pointerId); } catch {}
    try { e.preventDefault(); } catch {}
  };
  const move = (e) => {
    if (!drag) return;
    const p = pt(e);
    const dx = p.x - drag.x, dy = p.y - drag.y;
    drag.x = p.x; drag.y = p.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    try { e.preventDefault(); } catch {}
    if (!dx && !dy) return;
    vMouseMove(dx * VMOUSE_SENS, dy * VMOUSE_SENS);
  };
  const up = (e) => {
    if (!drag) return;
    const wasTap = drag.moved < 10 && Date.now() - drag.t < 320;
    drag = null;
    pad.classList.remove('active');
    try { e.preventDefault(); } catch {}
    if (!wasTap) return;
    const now = Date.now();
    const dbl = now - lastTap < 320;
    lastTap = now;
    vMouseClick(1);
    if (dbl) setTimeout(() => { vMouseClick(1); }, 30);   // двойной клик
  };
  pad.addEventListener('pointerdown', down);
  pad.addEventListener('pointermove', move);
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  pad.addEventListener('pointerleave', (e) => { if (drag) up(e); });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  // На старых WebView Pointer Events могут не прийти — дублируем тач-событиями.
  if (!window.PointerEvent) {
    pad.addEventListener('touchstart', (e) => { const t = e.touches[0]; down({ clientX: t.clientX, clientY: t.clientY }); }, { passive: false });
    pad.addEventListener('touchmove', (e) => { const t = e.touches[0]; move({ clientX: t.clientX, clientY: t.clientY, preventDefault() {} }); }, { passive: false });
    pad.addEventListener('touchend', (e) => up(e));
  }
}

// Колесо и кнопки не должны «залипать», если палец ушёл с панели.
function vMouseInitGuards() {
  if (window.__vmouseGuards) return;
  window.__vmouseGuards = true;
  ['pointerup', 'pointercancel', 'touchend'].forEach((ev) => window.addEventListener(ev, () => {
    vMouseWheelStop();
    vMouseUp(1); vMouseUp(4);
  }, { passive: true }));
  // Клавиатура телефона открыта — сенсор не должен ловить её тапы.
  window.addEventListener('blur', () => { vMouseWheelStop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) vMouseWheelStop(); });
}

function vMouseRestore() {
  let want = false;
  try { want = localStorage.getItem('hub_vmouse') === '1'; } catch {}
  vMouseInitPad();
  vMouseInitGuards();
  if (want) linuxMouseToggle(true);
}
try { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vMouseRestore); else vMouseRestore(); } catch {}

// ===== BROWSER (Chrome / YouTube) =====
function browserGo(url, prefix) {
  const pfx = prefix || '';
  const frame = document.getElementById(pfx ? 'browser-frame-desktop' : 'browser-frame');
  const urlEl = document.getElementById(pfx ? 'browser-url-desktop' : 'browser-url');
  frame.src = url;
  urlEl.value = url;
}

// ===== PULSE AUDIO =====
async function pulseStatus() {
  const el = document.getElementById('pulse-status');
  if (!el) return;
  try {
    const r = await fetch('/api/pulse/status');
    const d = await r.json();
    el.textContent = d.running ? ((window.RemoteAudio && RemoteAudio.live()) ? '🔊 видео' : '🔊 звук') : '🔇 нет звука';
    el.className = 'tag ' + (d.running ? 'tag-on' : 'tag-off');
    const devEl = document.getElementById('pulse-devices');
    if (devEl) {
      if (d.sinks && d.sinks.length) {
        devEl.innerHTML = '<b>Sinks:</b><br>' + d.sinks.map(s => '• ' + s).join('<br>') +
          (d.sources && d.sources.length ? '<br><b>Sources:</b><br>' + d.sources.map(s => '• ' + s).join('<br>') : '');
      } else {
        devEl.textContent = 'Нет данных. Нажмите Start.';
      }
    }
  } catch(e) {
    el.textContent = 'error';
    el.className = 'tag tag-off';
  }
}
async function pulseStart() {
  if (!document.getElementById('pulse-status')) return;
  await fetch('/api/pulse/start', {method:'POST'});
  setTimeout(pulseStatus, 500);
}
async function pulseStop() {
  if (!document.getElementById('pulse-status')) return;
  await fetch('/api/pulse/stop', {method:'POST'});
  setTimeout(pulseStatus, 500);
}
async function pulseMute() {
  const el = document.getElementById('pulse-status');
  if (!el) return;
  const r = await fetch('/api/pulse/mute', {method:'POST'});
  const d = await r.json();
  if (d.ok) {
    el.textContent = d.muted ? 'muted' : 'running';
    el.className = 'tag ' + (d.muted ? 'tag-off' : 'tag-on');
  }
}
async function pulseSetVol(val) {
  const lbl = document.getElementById('pulse-vol-label');
  if (!lbl) return;
  lbl.textContent = val + '%';
  await fetch('/api/pulse/volume', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({volume:parseInt(val)})});
}

// ===== LINUX DESKTOP: launch browser on VNC =====
async function linuxRunBrowser(url, vertical) {
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  // This function is normally called by a tap on Go/YouTube; start the local
  // audio receiver before the fetch so mobile autoplay rules allow playback.
  try { remoteAudioStart(); } catch {}
  try {
    const r = await fetch('/api/linux/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'browser', url, vertical: !!vertical })
    });
    const d = await r.json();
    if (!d.ok) console.warn('linuxRunBrowser:', d.error);
  } catch (e) { console.warn('linuxRunBrowser failed:', e.message); }
}

// ===== GITHUB REPO BROWSER =====
let ghRepos = [];
let ghCurrentRepo = null;
let ghCurrentPath = '';
let ghCurrentBranch = '';

async function ghLoadRepos() {
  const grid = document.getElementById('gh-repos-grid');
  if (!grid) return;
  grid.innerHTML = '<div style="color:var(--t3);font-size:12px;grid-column:1/-1">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos?per_page=50');
    const d = await r.json();
    if (!d.success) { grid.innerHTML = '<div style="color:var(--err);font-size:12px;grid-column:1/-1">' + escHtml(d.error || 'ошибка') + '</div>'; return; }
    ghRepos = d.repos || [];
    document.getElementById('gh-repos-count').textContent = ghRepos.length + ' репозиториев';
    grid.innerHTML = ghRepos.map(r => `
      <div class="card" style="cursor:pointer;padding:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;cursor:pointer" onclick="ghOpenRepo('${escAttr(r.full_name)}')">
          <span style="font-size:14px">${r.private ? '🔒' : '📂'}</span>
          <span style="font-size:13px;font-weight:600;color:var(--acc)">${escHtml(r.full_name)}</span>
        </div>
        <div style="font-size:11px;color:var(--t2);margin-bottom:4px;min-height:28px;cursor:pointer" onclick="ghOpenRepo('${escAttr(r.full_name)}')">${escHtml(r.description || '(нет описания)')}</div>
        <div style="display:flex;gap:8px;font-size:10px;color:var(--t3);cursor:pointer" onclick="ghOpenRepo('${escAttr(r.full_name)}')">
          ${r.language ? '<span>' + escHtml(r.language) + '</span>' : ''}
          ${r.stargazers_count ? '<span>⭐ ' + r.stargazers_count + '</span>' : ''}
          <span>🌿 ${escHtml(r.default_branch)}</span>
          <span>${r.updated_at ? new Date(r.updated_at).toLocaleDateString('ru') : ''}</span>
        </div>
        <div class="gh-repo-actions" onclick="event.stopPropagation()">
          <button class="btn btn-sm gh-repo-btn-open" onclick="ghOpenInRepo('${escAttr(r.full_name)}','${escAttr(r.default_branch)}')" title="Клонировать и открыть в CLI-агенте">▶ Открыть в</button>
          <button class="btn btn-sm gh-repo-btn-dl" onclick="ghDownloadRepo('${escAttr(r.full_name)}')" title="Скачать zip-архив репозитория">📥 Скачать</button>
          <button class="btn btn-sm" onclick="ghDownloadReleaseModal('${escAttr(r.full_name)}')" title="Скачать файл из релиза по тегу">📦 Релиз</button>
          <button class="btn btn-sm gh-repo-btn-del" onclick="ghDeleteRepoModal('${escAttr(r.full_name)}')" title="Удалить репозиторий">🗑</button>
        </div>
                <span style="margin-left:auto;display:flex;gap:4px">
            <button class="btn btn-sm btn-p" style="font-size:10px;padding:4px 6px" onclick="event.stopPropagation(); ghQuickClone(r.full_name)" title="Клонировать и открыть в агенте">📂</button>
            <button class="btn btn-sm" style="font-size:10px;padding:4px 6px" onclick="event.stopPropagation(); browserOpenDesktop('https://github.com/'+r.full_name)" title="В браузере">🌐</button>
          </span>
        </div>
      </div>
    `).join('');
  } catch (e) { grid.innerHTML = '<div style="color:var(--err);font-size:12px;grid-column:1/-1">' + escHtml(e.message) + '</div>'; }
}

async function ghOpenRepo(fullName) {
  ghCurrentRepo = fullName;
  ghCurrentPath = '';
  ghCurrentBranch = '';
  const section = document.getElementById('gh-repos-section');
  if (section) section.style.display = 'none';
  const detail = document.getElementById('gh-repo-detail');
  detail.style.display = 'block';
  document.getElementById('gh-repo-name').textContent = fullName;
  // Load repo info + contents
  try {
    const r = await fetch('/api/gh/repos/' + fullName);
    const d = await r.json();
    document.getElementById('gh-repo-desc').textContent = d.description || '';
    document.getElementById('gh-repo-name').innerHTML = escHtml(fullName) + (d.language ? ' <span style="font-size:11px;color:var(--t3);font-weight:400">' + escHtml(d.language) + '</span>' : '');
  } catch {}
  ghShowTab('contents', document.querySelector('.gh-tab'));
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ghBackToList() {
  const section = document.getElementById('gh-repos-section');
  if (section) section.style.display = '';
  document.getElementById('gh-repo-detail').style.display = 'none';
  if (ghCurrentRepo) {
    const el = document.querySelector('#gh-repos-section');
    if (el) el.scrollIntoView({ block: 'start' });
  }
  ghCurrentRepo = null;
}
function ghOpenOnGithub(vertical){
  if(!ghCurrentRepo){ if(typeof fmInfo==='function') fmInfo('Сначала выбери репозиторий'); return; }
  const url='https://github.com/'+ghCurrentRepo;
  if(typeof browserOpenDesktop==='function') browserOpenDesktop(url, !!vertical);
  else if(typeof hubBrowserGo==='function') hubBrowserGo(url);
  else window.open(url,'_blank');
}
function toggleGhAgentMenu(e){
  if(e) e.stopPropagation();
  document.querySelectorAll('.apply-menu').forEach(m=>m.classList.remove('on'));
  const menu=document.getElementById('gh-agent-menu');
  if(!menu) return;
  if(!ghCurrentRepo){ if(typeof fmInfo==='function') fmInfo('Сначала выбери репозиторий'); return; }
  const inst=(typeof tools!=='undefined'?tools:[]).filter(t=>t.installed);
  menu.innerHTML=`<div class="apply-menu-title">Открыть ${escHtml(ghCurrentRepo)} в</div>`+
    inst.map(t=>`<div class="apply-item" onclick="event.stopPropagation();ghCloneAndOpen('${escAttr(t.id)}')"><div class="sb-ico" style="background:${t.color}18;color:${t.color};width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800">${t.icon}</div><span>${escHtml(t.name)}</span></div>`).join('')+
    `<div class="apply-item" onclick="event.stopPropagation();ghCloneAndOpen('_terminal')"><div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800">&gt;_</div><span>Terminal</span></div>`;
  menu.classList.add('on');
  // Закрыть по клику вне
  setTimeout(()=>{ const h=(ev)=>{ if(!menu.contains(ev.target)){ menu.classList.remove('on'); document.removeEventListener('click',h); } }; document.addEventListener('click',h); }, 50);
}
async function ghCloneAndOpen(toolId){
  document.querySelectorAll('.apply-menu').forEach(m=>m.classList.remove('on'));
  if(!ghCurrentRepo) return;
  if(typeof fmInfo==='function') fmInfo('⏳ Клонирую '+ghCurrentRepo+'...');
  try{
    const r=await fetch('/api/gh/clone',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:ghCurrentRepo})}).then(x=>x.json());
    if(!r.success){ if(typeof fmInfo==='function') fmInfo('❌ Ошибка клона: '+(r.error||'')); return; }
    const dir=r.path;
    if(typeof fmInfo==='function') fmInfo('✅ Готово: '+dir);
    // Открыть как в Файлах: ▶ — в любом агенте
    if(typeof createTerm==='function'){
      if(typeof showPage==='function') showPage('terminal');
      createTerm(toolId, dir);
    } else {
      if(typeof fmOpenIn==='function') fmOpenIn(dir, toolId);
    }
  }catch(e){ if(typeof fmInfo==='function') fmInfo('❌ '+e.message); }
}
async function ghQuickClone(full_name){
  ghCurrentRepo=full_name;
  // Для списка — сразу Terminal (быстро), а выбор — через деталку
  // Но показываем то же меню рядом с кнопкой
  const fakeEvent={stopPropagation:()=>{}, target:document.getElementById('gh-agent-menu')};
  // Если много инструментов — покажем меню, иначе сразу клон
  const inst=(typeof tools!=='undefined'?tools:[]).filter(t=>t.installed);
  if(inst.length>1){
    // Откроем меню в шапке деталки, но сначала покажем деталку? проще — сразу клон в терминал
    if(typeof fmInfo==='function') fmInfo('⏳ Клонирую '+full_name+' в Terminal...');
    try{
      const r=await fetch('/api/gh/clone',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name})}).then(x=>x.json());
      if(!r.success){ if(typeof fmInfo==='function') fmInfo('❌ '+(r.error||'')); return; }
      if(typeof showPage==='function') showPage('terminal');
      if(typeof createTerm==='function') createTerm('_terminal', r.path);
    }catch(e){ if(typeof fmInfo==='function') fmInfo('❌ '+e.message); }
  } else {
    ghCloneAndOpen(inst[0]?.id||'_terminal');
  }
}


function ghShowTab(tab, btn) {
  document.querySelectorAll('.gh-tab').forEach(b => b.classList.remove('on'));
  if (btn) btn.classList.add('on');
  ['contents','branches','commits','workflows','runs','releases'].forEach(t => {
    const el = document.getElementById('gh-repo-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  if (!ghCurrentRepo) return;
  if (tab === 'contents') ghLoadContents();
  if (tab === 'branches') ghLoadBranches();
  if (tab === 'commits') ghLoadCommits();
  if (tab === 'workflows') ghLoadWorkflows();
  if (tab === 'runs') ghLoadRuns();
  if (tab === 'releases') ghLoadReleases();
}

async function ghLoadContents(path) {
  if (path !== undefined) ghCurrentPath = path;
  const el = document.getElementById('gh-repo-contents');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    // Get default branch if not set
    if (!ghCurrentBranch) {
      const repoInfo = await fetch('/api/gh/repos/' + ghCurrentRepo).then(r => r.json());
      ghCurrentBranch = repoInfo.default_branch || 'main';
    }
    let url = '/api/gh/repos/' + ghCurrentRepo + '/contents';
    if (ghCurrentPath) url += '?path=' + encodeURIComponent(ghCurrentPath);
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    const items = d.items || [];
    // Breadcrumb
    let breadcrumb = '<div style="margin-bottom:8px;font-size:12px"><span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents(\'\')">📁 корень</span>';
    if (ghCurrentPath) {
      const parts = ghCurrentPath.split('/');
      parts.forEach((p, i) => {
        const pth = parts.slice(0, i + 1).join('/');
        breadcrumb += ' / <span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents(\'' + escAttr(pth) + '\')">' + escHtml(p) + '</span>';
      });
    }
    breadcrumb += '</div>';
    // Sort: dirs first, then files
    items.sort((a, b) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1));
    el.innerHTML = breadcrumb + items.map(it => {
      const icon = it.type === 'dir' ? '📁' : fileIcon(it.name);
      const click = it.type === 'dir' ? `ghLoadContents('${escAttr(it.path)}')` : `ghViewFile('${escAttr(it.path)}','${escAttr(it.sha)}')`;
      return `<div class="gh-file-row" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px;border:1px solid transparent;transition:all .1s" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''" onclick="${click}">
        <span>${icon}</span>
        <span style="flex:1;color:var(--t1)">${escHtml(it.name)}</span>
        <span style="font-size:10px;color:var(--t3)">${it.size ? formatSize(it.size) : ''}</span>
        ${it.type !== 'dir' ? `<div class="gh-file-actions" onclick="event.stopPropagation()">
          <button class="btn btn-sm" onclick="ghDownloadFile('${escAttr(ghCurrentRepo)}','${escAttr(it.path)}','${escAttr(ghCurrentBranch || 'main')}')" title="Скачать файл">📥</button>
          <button class="btn btn-sm gh-repo-btn-del" onclick="ghDeleteFile('${escAttr(ghCurrentRepo)}','${escAttr(it.name)}','${escAttr(it.path)}','${escAttr(it.sha || '')}')" title="Удалить файл">🗑</button>
        </div>` : ''}
      </div>`;
    }).join('');
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghViewFile(path, sha) {
  const el = document.getElementById('gh-repo-contents');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка файла...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/contents?path=' + encodeURIComponent(path));
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    // Decode base64 content if present
    let content = d.download_url ? '(ссылка на скачивание)' : '';
    if (d.download_url) {
      const fr = await fetch(d.download_url);
      content = await fr.text().catch(() => '(не удалось загрузить)');
    }
    el.innerHTML = `
      <div style="margin-bottom:8px;font-size:12px">
        <span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents('${escAttr(ghCurrentPath)}')">← Назад</span>
        <span style="margin-left:8px;font-weight:600">${escHtml(path)}</span>
        <span style="margin-left:8px;font-size:10px;color:var(--t3)">${formatSize(d.size || 0)}</span>
      </div>
      <pre style="background:var(--bg0);border:1px solid var(--bdr);border-radius:8px;padding:12px;font-size:11px;font-family:monospace;color:var(--t1);overflow:auto;max-height:500px;white-space:pre-wrap">${escHtml(content)}</pre>`;
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadBranches() {
  const el = document.getElementById('gh-repo-branches');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/branches');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.branches || []).map(b => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:12px;border:1px solid var(--bdr);margin-bottom:4px">
        <span>🌿</span>
        <span style="color:var(--acc)">${escHtml(b.name)}</span>
        <span style="font-size:10px;color:var(--t3);margin-left:auto;font-family:monospace">${b.sha || ''}</span>
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет веток</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadCommits() {
  const el = document.getElementById('gh-repo-commits');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/commits?per_page=30');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.commits || []).map(c => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:6px;font-size:12px;border:1px solid var(--bdr);margin-bottom:4px">
        <span style="font-family:monospace;font-size:11px;color:var(--pur);min-width:50px">${escHtml(c.sha || '')}</span>
        <div style="flex:1">
          <div style="color:var(--t1)">${escHtml(c.message || '')}</div>
          <div style="font-size:10px;color:var(--t3);margin-top:2px">${escHtml(c.author || '')} · ${c.date ? new Date(c.date).toLocaleString('ru') : ''}</div>
        </div>
        ${c.html_url ? '<a href="' + escAttr(c.html_url) + '" target="_blank" style="font-size:10px;color:var(--acc);text-decoration:none;flex-shrink:0">↗</a>' : ''}
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет коммитов</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadWorkflows() {
  const el = document.getElementById('gh-repo-workflows');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/workflows');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.workflows || []).map(w => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;font-size:12px;border:1px solid var(--bdr);margin-bottom:6px">
        <span style="font-size:16px">${w.state === 'active' ? '🟢' : '⚪'}</span>
        <div style="flex:1">
          <div style="color:var(--t1);font-weight:500">${escHtml(w.name)}</div>
          <div style="font-size:10px;color:var(--t3)">${escHtml(w.path)}</div>
        </div>
        <span class="tag ${w.state === 'active' ? 'tag-on' : 'tag-off'}">${escHtml(w.state)}</span>
        ${w.html_url ? '<a href="' + escAttr(w.html_url) + '" target="_blank" style="font-size:10px;color:var(--acc);text-decoration:none">↗</a>' : ''}
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет workflow</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadRuns() {
  const el = document.getElementById('gh-repo-runs');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/runs?per_page=20');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.runs || []).map(run => {
      const icon = run.conclusion === 'success' ? '✅' : run.conclusion === 'failure' ? '❌' : run.status === 'in_progress' ? '🔄' : '⏳';
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;font-size:12px;border:1px solid var(--bdr);margin-bottom:6px">
        <span style="font-size:16px">${icon}</span>
        <div style="flex:1">
          <div style="color:var(--t1);font-weight:500">${escHtml(run.name)} #${run.run_number}</div>
          <div style="font-size:10px;color:var(--t3)">🌿 ${escHtml(run.head_branch || '')} · ${run.created_at ? new Date(run.created_at).toLocaleString('ru') : ''}</div>
        </div>
        <span class="tag ${run.conclusion === 'success' ? 'tag-on' : run.conclusion === 'failure' ? 'tag-off' : ''}">${escHtml(run.status)}${run.conclusion ? ' → ' + run.conclusion : ''}</span>
        ${run.html_url ? '<a href="' + escAttr(run.html_url) + '" target="_blank" style="font-size:10px;color:var(--acc);text-decoration:none">↗</a>' : ''}
        <button class="btn btn-sm" onclick="ghLoadArtifacts('${run.id}',this.parentElement)" title="Артефакты сборки">📦</button>
      </div>`;
    }).join('') || '<div style="color:var(--t3);font-size:12px">Нет сборок</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghLoadArtifacts(runId, container) {
  if (!ghCurrentRepo) return;
  const existing = container.querySelector('.gh-artifacts');
  if (existing) { existing.remove(); return; }
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/runs/' + runId + '/artifacts');
    const d = await r.json();
    const div = document.createElement('div');
    div.className = 'gh-artifacts';
    div.style.cssText = 'padding:6px 8px;margin-top:4px;background:var(--bg3);border-radius:6px;font-size:11px';
    if (d.artifacts && d.artifacts.length) {
      div.innerHTML = d.artifacts.map(a => `
        <div style="display:flex;align-items:center;gap:6px;padding:3px 0">
          <span>📄 ${escHtml(a.name)}</span>
          <span style="color:var(--t3)">${formatSize(a.size_in_bytes)}</span>
          <a href="/api/gh/repos/${escAttr(ghCurrentRepo)}/artifacts/${a.id}/download" class="btn btn-sm" style="margin-left:auto;text-decoration:none;font-size:10px" download>📥 Скачать</a>
        </div>
      `).join('');
    } else {
      div.innerHTML = '<div style="color:var(--t3)">Нет артефактов</div>';
    }
    container.appendChild(div);
  } catch {}
}

async function ghLoadReleases() {
  const el = document.getElementById('gh-repo-releases');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/releases');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    el.innerHTML = (d.releases || []).map(rel => `
      <div style="padding:10px;border-radius:8px;border:1px solid var(--bdr);margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:14px">📦</span>
          <span style="font-size:13px;font-weight:600;color:var(--t1)">${escHtml(rel.name || rel.tag_name)}</span>
          <span class="tag tag-on">${escHtml(rel.tag_name)}</span>
          ${rel.draft ? '<span class="tag tag-off">draft</span>' : ''}
          ${rel.prerelease ? '<span class="tag" style="color:var(--warn);background:rgba(210,153,34,.12)">pre-release</span>' : ''}
        </div>
        <div style="font-size:10px;color:var(--t3);margin-bottom:6px">${rel.created_at ? new Date(rel.created_at).toLocaleString('ru') : ''}</div>
        ${(rel.assets || []).map(a => `
          <div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px">
            <span>📄 ${escHtml(a.name)}</span>
            <span style="color:var(--t3)">${formatSize(a.size)}</span>
            <a href="${escAttr(a.browser_download_url)}" class="btn btn-sm" style="margin-left:auto;text-decoration:none;font-size:10px" download>📥 Скачать</a>
          </div>
        `).join('')}
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет релизов</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

// ===== GITHUB REPO: CLONE + OPEN IN AGENT =====
let ghCloneFullName = '';
let ghCloneBranch = '';

async function ghOpenInRepo(fullName, defaultBranch) {
  ghCloneFullName = fullName;
  ghCloneBranch = defaultBranch || 'main';
  const btn = document.getElementById('clone-title');
  const info = document.getElementById('clone-repo-info');
  const dirInput = document.getElementById('clone-dir');
  const branchInput = document.getElementById('clone-branch');
  const status = document.getElementById('clone-status');
  const agents = document.getElementById('clone-agents');
  btn.textContent = '▶ Открыть репозиторий';
  info.textContent = fullName;
  dirInput.value = fullName.split('/')[1];
  branchInput.value = ghCloneBranch;
  status.textContent = '';
  // Load auto-approve state from the hub so the checkbox matches reality.
  try {
    const rr = await fetch('/api/auto-approve'); const dd = await rr.json();
    document.getElementById('clone-auto-approve').checked = !!dd.enabled;
  } catch {}
  // Show available agents (installed CLI tools)
  const installed = tools.filter(t => t.installed);
  const cells = installed.map(t => `
    <div class="newterm-tool" onclick="cloneAndOpen('${escAttr(fullName)}','${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color};width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:9px">${t.icon}</div>
      <div><div style="font-size:12px;font-weight:500">${t.name}</div></div>
    </div>`).join('');
  agents.innerHTML = cells + (installed.length ? '' : '<div style="color:var(--t3);font-size:11px;grid-column:1/-1">Нет установленных CLI-агентов. Сначала установи инструмент на вкладке Dashboard.</div>');
  document.getElementById('modal-clone').classList.add('on');
}

async function cloneAndOpen(fullName, toolId) {
  const branch = document.getElementById('clone-branch').value.trim() || 'main';
  const status = document.getElementById('clone-status');
  status.textContent = 'Клонирую ' + fullName + ' (' + branch + ')...';
  status.style.color = 'var(--warn)';
  try {
    const r = await fetch('/api/gh/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: fullName, branch })
    });
    const d = await r.json();
    if (!d.success) {
      status.textContent = '✗ ' + (d.error || 'не удалось клонировать');
      status.style.color = 'var(--err)';
      return;
    }
    status.textContent = '✓ Клонировано в ' + d.path + (d.pulled ? ' (обновлено)' : '');
    status.style.color = 'var(--ok)';
    // Persist and push the auto-approve toggle to the hub before the agent starts.
    const autoOn = document.getElementById('clone-auto-approve').checked;
    fetch('/api/auto-approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: autoOn }) }).catch(() => {});
    // Register path in history + last-dir
    await fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: d.path }) });
    if (!recentPaths.includes(d.path)) recentPaths.unshift(d.path);
    toolDirs[toolId] = d.path;
    await fetch('/api/last-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, dir: d.path }) });
    setTimeout(() => {
      closeModal('modal-clone');
      showPage('terminal');
      createTerm(toolId, d.path);
    }, 800);
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.style.color = 'var(--err)';
  }
}

// ===== GITHUB REPO: DOWNLOAD ZIP =====
function ghDownloadRepo(fullName) {
  dlNow('/api/gh/download-repo?full_name=' + encodeURIComponent(fullName), fullName.split('/')[1] + '.zip');
}

// ===== GITHUB REPO: DELETE =====
let ghDeleteFullName = '';
function ghDeleteRepoModal(fullName) {
  ghDeleteFullName = fullName;
  document.getElementById('delrepo-info').textContent = 'Вы уверены, что хотите удалить ' + fullName + '?';
  document.getElementById('delrepo-confirm').value = '';
  document.getElementById('delrepo-confirm').oninput = function() {
    document.getElementById('delrepo-btn').disabled = this.value.trim() !== fullName;
  };
  document.getElementById('delrepo-btn').disabled = true;
  document.getElementById('modal-delrepo').classList.add('on');
}

async function confirmDeleteRepo() {
  const btn = document.getElementById('delrepo-btn');
  btn.disabled = true;
  btn.textContent = 'Удаляю...';
  try {
    const r = await fetch('/api/gh/delete-repo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: ghDeleteFullName })
    });
    const d = await r.json();
    if (d.success) {
      closeModal('modal-delrepo');
      await fmInfo('Репозиторий ' + ghDeleteFullName + ' удалён.');
      ghLoadRepos();
    } else {
      await fmInfo('Ошибка: ' + (d.error || 'не удалось удалить'));
      btn.textContent = 'Удалить навсегда';
      btn.disabled = false;
    }
  } catch (e) {
    await fmInfo('Ошибка: ' + e.message);
    btn.textContent = 'Удалить навсегда';
    btn.disabled = false;
  }
}

// ===== GITHUB REPO: DELETE FILE =====
async function ghDeleteFile(fullName, fileName, filePath, sha) {
  if (!(await fmConfirm('Удалить файл «' + fileName + '» из ' + fullName + '?', 'Удалить'))) return;
  try {
    const r = await fetch('/api/gh/delete-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: fullName, path: filePath, branch: ghCurrentBranch || 'main' })
    });
    const d = await r.json();
    if (d.success) {
      await fmInfo('Файл удалён.');
      ghLoadContents();
    } else {
      await fmInfo('Ошибка: ' + (d.error || 'не удалось удалить'));
    }
  } catch (e) {
    await fmInfo('Ошибка: ' + e.message);
  }
}

// ===== GITHUB REPO: DOWNLOAD FILE =====
function ghDownloadFile(fullName, filePath, branch) {
  const ref = branch || ghCurrentBranch || 'main';
  dlNow('/api/gh/download-file?full_name=' + encodeURIComponent(fullName) + '&path=' + encodeURIComponent(filePath) + '&ref=' + encodeURIComponent(ref), filePath.split('/').pop());
}

// ===== GITHUB REPO: DOWNLOAD RELEASE ASSET =====
let ghReleaseRepo = '';
async function ghDownloadReleaseModal(fullName) {
  ghReleaseRepo = fullName;
  const list = document.getElementById('release-dl-list');
  list.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка релизов...</div>';
  document.getElementById('modal-release-dl').classList.add('on');
  try {
    const r = await fetch('/api/gh/repos/' + fullName + '/releases?per_page=10');
    const d = await r.json();
    if (d.releases && d.releases.length) {
      list.innerHTML = d.releases.map(rel => `
        <div style="padding:8px;border:1px solid var(--bdr);border-radius:8px;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-size:13px;font-weight:600;color:var(--t1)">${escHtml(rel.name || rel.tag_name)}</span>
            <span class="tag tag-on" style="font-size:9px">${escHtml(rel.tag_name)}</span>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
            <a class="btn btn-sm btn-ok" style="text-decoration:none" href="/api/gh/download-release-asset?full_name=${encodeURIComponent(fullName)}&tag=${encodeURIComponent(rel.tag_name)}" download title="Исходники (tar.gz)">📦 Исходники</a>
            ${(rel.assets || []).map(a => `
              <a class="btn btn-sm" style="text-decoration:none" href="/api/gh/download-release-asset?full_name=${encodeURIComponent(fullName)}&tag=${encodeURIComponent(rel.tag_name)}&asset_id=${a.id}" download title="${escAttr(a.name)}">${escHtml(a.name)} (${formatSize(a.size)})</a>
            `).join('')}
          </div>
        </div>
      `).join('') || '<div style="color:var(--t3);font-size:12px">Релизов нет</div>';
    } else {
      list.innerHTML = '<div style="color:var(--t3);font-size:12px">Релизов нет</div>';
    }
  } catch (e) {
    list.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>';
  }
}
// ===== REMOTE VIDEO AUDIO =====
// The PCM/Opus stream from /ws/audio is decoded and scheduled by remote-audio.js
// (shared with the mobile client). These wrappers keep the old call sites and
// the "🔊" status line working.
function remoteAudioStart() {
  try { return window.RemoteAudio ? window.RemoteAudio.start() : null; } catch { return null; }
}
function remoteAudioStop() {
  try { window.RemoteAudio && window.RemoteAudio.stop(); } catch {}
}
function remoteAudioToggle() {
  try { window.RemoteAudio && window.RemoteAudio.toggle(); } catch {}
}

// ===== AUDIO KEEP-ALIVE (background playback) =====
let _audioCtx = null;
let _silentOsc = null;

function _ensureAudioCtx() {
  if (_audioCtx) return _audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _audioCtx = new AC();
    _silentOsc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    gain.gain.value = 0;
    _silentOsc.connect(gain);
    gain.connect(_audioCtx.destination);
    _silentOsc.start();
    return _audioCtx;
  } catch { return null; }
}

function _resumeAudio() {
  try {
    if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
  } catch {}
}

['click','touchstart','keydown','mousedown'].forEach(evt => {
  document.addEventListener(evt, () => {
    _ensureAudioCtx();
    _resumeAudio();
    // A user gesture unlocks the phone speaker; the PCM stream then carries
    // audio from the video playing in remote Chromium.
    try { if (typeof remoteAudioStart === 'function') remoteAudioStart(); } catch {}
    document.querySelectorAll('iframe').forEach(f => {
      try { f.contentWindow.postMessage({type:'audio-resume'}, '*'); } catch {}
    });
  }, { passive: true });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    _resumeAudio();
    if (typeof tabs !== 'undefined') {
      tabs.forEach(t => {
        if (t.socket && t.socket.readyState > 1 && !t.manualClose) {
          if (t.reconnectTimer) { clearTimeout(t.reconnectTimer); t.reconnectTimer = null; }
        }
      });
    }
  }
});

setInterval(() => {
  // In the background the audio WebSocket already keeps the tunnel warm; an
  // extra HTTP poll only wakes the radio (battery). Ping only while visible.
  if (document.hidden) return;
  fetch('/api/pulse/status').catch(() => {});
}, 30000);
