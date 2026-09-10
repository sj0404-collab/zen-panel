let tools = [], homeDir = '', workDir = '', accessMode = 'local';
let tabs = [], activeTab = null, zoomLevel = 100;
let fmCurrentPath = '', fmSelected = null, fmBackend = 'local';
let recentPaths = [], toolDirs = {};
let storages = [];
let models = [], selectedModel = 'openrouter/owl-alpha';

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
  renderDashboard(); renderSidebar();
  setTimeout(() => { initFM(); fmBrowse(workDir || homeDir); }, 300);
}

function updateModelButton() {
  const m = models.find(m => m.id === selectedModel);
  document.getElementById('model-name').textContent = m ? m.name : selectedModel;
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
}

showPage('files');

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
    return `<div class="card">
      <div class="card-h">
        <div class="card-ico" style="background:${t.color}18;color:${t.color}">${t.icon}</div>
        <div><div class="card-n">${t.name}</div><div class="card-v">${t.version || '—'}</div></div>
        <span class="tag ${t.installed ? 'tag-on' : 'tag-off'}" style="margin-left:auto">${t.installed ? 'OK' : '—'}</span>
      </div>
      <div class="card-foot">
        <input type="text" id="cdir-${t.id}" class="card-dir" value="${escHtml(dir)}" placeholder="путь к папке..."
          onclick="event.stopPropagation()" onfocus="this.select()">
        ${t.installed ? `<div style="position:relative">
          <button class="btn btn-sm btn-p" onclick="toggleApplyMenu(event,'${t.id}')">▶</button>
          <div class="apply-menu" id="amenu-${t.id}"></div>
        </div>` : (t.pkg ? `<button class="btn btn-sm btn-ok" onclick="installTool('${t.id}')">⬇ Скачать</button>`
          : `<button class="btn btn-sm" disabled style="opacity:.4">▶</button>`)}
      </div>
    </div>`;
  }).join('');
  for (const [id, v] of Object.entries(dirStash)) { const el = document.getElementById(id); if (el) el.value = v; }
  if (focusId) { const f = document.getElementById(focusId); if (f && f.focus) f.focus(); }
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
    </div>`).join('');
}

// ======== SESSIONS ========
function showNewTermModal() {
  document.getElementById('newterm-grid').innerHTML = `
    <div class="newterm-tool" onclick="openTerminal()">
      <div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:26px;height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:9px">&gt;_</div>
      <div><div style="font-size:12px;font-weight:500">Terminal</div><div style="font-size:9px;color:var(--t3)">Пустой терминал</div></div>
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

async function createTerm(toolId, cwdOverride, plainTerminal) {
  closeModal('modal-newterm');
  const tool = tools.find(t => t.id === toolId);
  const isPlain = plainTerminal || toolId === '_terminal' || !tool;

  const id = 'term_' + Date.now();
  const cwdInput = document.getElementById('newterm-cwd')?.value?.trim();
  const cwd = cwdOverride || cwdInput || toolDirs[toolId] || homeDir;

  if (toolId && !isPlain) {
    toolDirs[toolId] = cwd;
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
  const displayName = isPlain ? 'Terminal' : tool.name;
  const color = isPlain ? '#58a6ff' : tool.color;
  const icon = isPlain ? '>_' : tool.icon;
  const panel = document.createElement('div');
  panel.className = 'term-panel';
  panel.id = 'panel-' + id;
  panel.innerHTML = `<div class="term-header"><div class="term-header-title"><div style="width:8px;height:8px;border-radius:50%;background:${color}"></div>${displayName}</div><div class="term-info">${dirShort}</div><button class="btn btn-sm" onclick="closeTab('${id}')">✕</button></div><div class="term" id="term-${id}"></div>`;
  document.getElementById('term-container').appendChild(panel);
  term.open(document.getElementById('term-' + id));
  await new Promise(r => setTimeout(r, 30));
  fitAddon.fit();

  const td = { id, toolId, toolName: displayName, color, icon, dirShort, ws: null, term, fitAddon, el: panel, manualClose: false };
  tabs.push(td);

  const connect = () => {
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    td.ws = socket;

    socket.onopen = () => { socket.send(JSON.stringify({ type: 'open', toolId: isPlain ? '_terminal' : toolId, sessionId: id, cwd, cols: term.cols, rows: term.rows })); term.focus(); };
    socket.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.type === 'output') term.write(m.data); if (m.type === 'exit') term.write(`\r\n\x1b[33m[Exited ${m.code}]\x1b[0m\r\n`); if (m.type === 'error') term.write(`\r\n\x1b[31m[Error: ${m.error}]\x1b[0m\r\n`); };
    socket.onclose = () => {
      if (td.manualClose) return;
      term.write('\r\n\x1b[33m[Disconnected — reconnecting...]\x1b[0m\r\n');
      setTimeout(connect, 3000);
    };
    return socket;
  };

  term.onData((d) => { if (td.ws && td.ws.readyState === 1) td.ws.send(JSON.stringify({ type: 'input', data: d })); });
  term.onResize(({ cols, rows }) => { if (td.ws && td.ws.readyState === 1) td.ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  connect();
  new ResizeObserver(() => { if (activeTab?.id === id) fitAddon.fit(); }).observe(panel);

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
  setTimeout(() => { activeTab.fitAddon?.fit(); activeTab.term?.focus(); }, 50);
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  tab.manualClose = true;
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
  try { txt = term.getSelection() || ''; } catch {}
  if (!txt) {
    try {
      const buf = term.buffer.active;
      const from = Math.max(0, buf.length - 200);
      const lines = [];
      for (let y = from; y < buf.length; y++) lines.push(buf.getLine(y).translateToString(true));
      txt = lines.join('\n').replace(/\s+$/, '');
    } catch {}
  }
  if (!txt) { fmInfo('Нечего копировать'); return; }
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
  const r = await fetch(`/api/browse?backend=${fmBackend}&path=${encodeURIComponent(p)}`).then(r => r.json());
  if (!r.success) return;
  fmCurrentPath = r.path;
  document.getElementById('fm-path').value = `${fmBackend === 'local' ? '' : '[' + fmBackend + '] '}${r.path}`;
  const list = document.getElementById('fm-list');
  let html = '';
  if (r.parent && r.parent !== r.path) html += `<div class="fm-item" onclick="fmBrowse('${escAttr(r.parent)}')"><span class="fm-ico">📁</span><span class="fm-name">..</span><span class="fm-size"></span></div>`;
  html += r.items.map(i => `<div class="fm-item" data-path="${escHtml(i.path)}" data-name="${escHtml(i.name)}" data-isdir="${i.isDir ? '1' : '0'}" onclick="fmTap(this)"><span class="fm-ico">${i.isDir ? '📁' : fileIcon(i.name)}</span><span class="fm-name">${escHtml(i.name)}</span><span class="fm-size">${i.isDir ? '' : formatSize(i.size)}</span></div>`).join('');
  list.innerHTML = html || '<div style="padding:20px;color:var(--t3);text-align:center">Пусто</div>';
  document.getElementById('fm-info').textContent = `${r.items.length} элементов | ${fmBackend}:${r.path}`;
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
  await fetch('/api/fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: fmBackend, path: p }) });
  fmRefresh();
}

async function fmCreateFile() {
  const name = await fmAsk('Имя файла:');
  if (!name) return;
  await fetch('/api/fs/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: fmBackend, path: fmCurrentPath + '/' + name, content: '' }) });
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

async function fmUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    for (const file of input.files) {
      const content = await file.text();
      const path = fmCurrentPath + '/' + file.name;
      await fetch('/api/fs/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: content,
        // Pass path via query since body is binary
      });
      // Re-upload with JSON metadata
      await fetch('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: fmBackend, path, content })
      });
    }
    fmRefresh();
  };
  input.click();
}

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
function escAttr(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

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
