/* =========================================================================
 * dashboard-app.js — страница Dashboard.
 * Грид инструментов + карточка ранера + установка. Терминал живёт на
 * отдельной странице /term: любой запуск открывает её с tool&dir.
 * Общее состояние и топбар — в bridge.js.
 * ========================================================================= */

let RUNNER = null;
let RUNNER_BUSY = false;
let serverSessions = [];

async function pageInit() {
  try {
    const r = await (await fetch('/api/tools')).json();
    if (r.success) tools = r.tools;
  } catch (e) {}
  renderDashboard();
  renderSidebar();
  await refreshSessions(true);
}

function renderDashboard() {
  const inst = tools.filter(t => t.installed);
  const m = models.find(m => m.id === selectedModel);
  const statsEl = document.getElementById('stats');
  if (statsEl) statsEl.innerHTML = `
    <div class="st"><div class="st-v" style="color:var(--acc)">${tools.length}</div><div class="st-l">Всего</div></div>
    <div class="st"><div class="st-v" style="color:var(--ok)">${inst.length}</div><div class="st-l">Установлено</div></div>
    <div class="st"><div class="st-v" style="color:var(--pur)">${serverSessions.length}</div><div class="st-l">Сессий</div></div>
    <div class="st"><div class="st-v" style="color:var(--warn);font-size:15px;padding-top:8px">${m ? m.name : selectedModel}</div><div class="st-l">Модель</div></div>`;

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

// ===== RUNNER CARD =====
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
  let r = null;
  try {
    r = await fetch('/api/runner/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).then(x => x.json());
  } catch (e) { r = { success: false, error: e.message }; }
  const out = document.getElementById('runner-res');
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

// ===== ЗАПУСК =====
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

async function rememberDir(toolId, dir) {
  toolDirs[toolId] = dir;
  try {
    await fetch('/api/last-dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId, dir }) });
    await fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: dir }) });
  } catch (e) {}
  if (!recentPaths.includes(dir)) recentPaths.unshift(dir);
}

async function openFromCard(fromToolId, dir, launchToolId) {
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  await rememberDir(fromToolId, dir);
  openTermPage(launchToolId, dir);
}

async function launchTool(toolId) {
  const input = document.getElementById('cdir-' + toolId);
  const dir = input ? input.value.trim() : (toolDirs[toolId] || homeDir);
  await rememberDir(toolId, dir);
  openTermPage(toolId, dir);
}

function openTerminal(dir) { openTermPage('_terminal', dir); }

function renderSidebar() {
  document.getElementById('tool-list').innerHTML = tools.filter(t => t.installed).map(t => {
    const dir = toolDirs[t.id] || homeDir;
    const short = (homeDir ? dir.replace(homeDir, '~') : dir).split('\\').pop();
    return `<div class="sb-i" onclick="launchTool('${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color}">${t.icon}</div>
      <div style="overflow:hidden;flex:1"><div>${t.name}</div><div style="font-size:8px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${short}</div></div>
    </div>`;
  }).join('');

  // Сессии живут на сервере (/api/sessions) — они переживают перезагрузку панели.
  document.getElementById('term-list').innerHTML = serverSessions.map(s => `
    <div class="sb-i" onclick="location.href='/term'" title="Открыть терминал и подхватить сессию">
      <div class="sb-ico" style="background:${s.color}18;color:${s.color}">${s.icon}</div>
      <div style="overflow:hidden;flex:1"><div>${s.toolName}</div><div style="font-size:8px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.cwd || '~'}</div></div>
      <span class="run-dot"></span>
    </div>`).join('') + (serverSessions.length ? '' : '<div style="font-size:10px;color:var(--t3);padding:4px 8px">Нет активных сессий</div>');
}

let sessTimer = null;
async function refreshSessions(immediate) {
  try {
    const r = await fetch('/api/sessions').then(r => r.json());
    if (r.success) {
      serverSessions = r.sessions || [];
      if (document.getElementById('term-list')) renderSidebar();
    }
  } catch (e) {}
  if (immediate) {
    if (sessTimer) clearInterval(sessTimer);
    sessTimer = setInterval(() => refreshSessions(false), 5000);
  }
}

// ===== НОВАЯ СЕССИЯ =====
function showNewTermModal() {
  document.getElementById('newterm-grid').innerHTML = `
    <div class="newterm-tool" onclick="openStandaloneTerminal()">
      <div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:9px">&gt;_</div>
      <div><div style="font-size:12px;font-weight:500">Terminal</div><div style="font-size:9px;color:var(--t3)">Пустой терминал (отдельная страница, переживает обновление)</div></div>
    </div>
  ` + tools.filter(t => t.installed).map(t => `
    <div class="newterm-tool" onclick="newtermLaunch('${t.id}')">
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

function newtermLaunch(toolId) {
  const cwd = document.getElementById('newterm-cwd').value.trim() || toolDirs[toolId] || homeDir;
  closeModal('modal-newterm');
  openTermPage(toolId, cwd);
}

// ===== BROWSE (выбор папки для новой сессии) =====
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

// ===== УСТАНОВКА =====
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
    if (r.tools) {
      tools = r.tools;
      if (hubChannel) hubChannel.postMessage({ type: 'tools', tools });
      renderDashboard();
      renderSidebar();
    }
  } catch (e) {}
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