let tools = [], homeDir = '', workDir = '', accessMode = 'local';
let tabs = [], activeTab = null, zoomLevel = 100;
let fmCurrentPath = '', fmSelected = null, fmBackend = 'local';
let recentPaths = [], toolDirs = {};
let storages = [];
let models = [], selectedModel = 'openrouter/owl-alpha';
const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;

document.addEventListener('DOMContentLoaded', init);

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
    if (t.manualClose) return;
    const s = t.socket;
    if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) return;
    if (t.reconnectTimer) { clearTimeout(t.reconnectTimer); t.reconnectTimer = null; }
    if (t.connect) { t.lastPong = 0; try { t.connect(); } catch (e) { /* ignore */ } }
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
  }
  if (netR.success && netR.ips && netR.ips.length > 0) {
    const ipEl = document.getElementById('access-ip');
    const ips = netR.ips.map(i => i.address).join(' | ');
    if (ipEl) ipEl.textContent = ips;
    window.__networkIPs = netR.ips;
  }
  if (tunnelR.success && tunnelR.url) {
    const tLink = document.getElementById('tunnel-link');
    const tUrl = document.getElementById('tunnel-url');
    if (tLink) { tLink.href = tunnelR.url; tLink.textContent = `🌐 ${tunnelR.type}`; tLink.style.display = ''; }
    if (tUrl) { tUrl.textContent = tunnelR.url; tUrl.style.display = ''; }
    window.__tunnelUrl = tunnelR.url;
  }
  renderDashboard(); renderSidebar();
  setTimeout(() => { initFM(); fmBrowse(workDir || homeDir); }, 300);
}

function updateModelButton() {
  const m = models.find(m => m.id === selectedModel);
  document.getElementById('model-name').textContent = m ? m.name : selectedModel;
}

// ===== DRAWER =====
function toggleDrawer() {
  const drawer = document.getElementById('drawer');
  const overlay = document.getElementById('drawer-overlay');
  drawer.classList.toggle('on');
  overlay.classList.toggle('on');
}

// ===== MODEL MENU (bottom sheet) =====
function hubUpdate() {
  // Same logic as desktop-app.js
  const btn = document.getElementById('hub-update-btn');
  const busy = t => { if (btn) btn.textContent = t; };
  busy('…');
  (async () => {
    let check;
    try { check = await fetch('/api/update').then(r => r.json()); }
    catch (e) { check = { success: false, error: e.message }; }
    if (!check.success) { busy('🔄'); fmInfo('Обновление: ' + (check.error || 'не удалось проверить')); return; }
    if (check.same) { busy('🔄'); fmInfo(`Актуальная версия (${check.version}), обновлений нет.`); return; }
    // Подтверждения спрашивать нечем — системный confirm в WebView не работает —
    // показываем что нашли и обновляем.
    fmInfo(`Новая версия: ${check.current} → ${check.latest} (+${check.behind} коммит.) — обновляю…`);
    try {
      const apply = await fetch('/api/update', { method: 'POST' }).then(r => r.json());
      if (!apply.success) { busy('🔄'); fmInfo('Обновление: ' + (apply.error || 'не удалось применить')); return; }
      busy('♻');
      fmInfo('Обновление применено, хаб перезапускается…');
      let tries = 0;
      const poll = async () => {
        tries++;
        try {
          const r = await fetch('/api/info').then(r => r.json());
          if (r.version && tries > 3) { location.reload(); return; }
          if (r.version && r.version !== check.version) { location.reload(); return; }
        } catch (e) {}
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 1200);
    } catch (e) { busy('🔄'); fmInfo('Обновление: ошибка — ' + e.message); }
  })();
}
function toggleModelMenu(e) {
  e.stopPropagation();
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  const menu = document.getElementById('model-menu');
  if (!menu) return;
  menu.innerHTML = `
    <div class="model-menu-title">
      <span>Модель</span>
      <input type="text" id="model-search" placeholder="Поиск..." oninput="filterModels(this.value)">
    </div>
    <div class="model-menu-list" id="model-list">
      ${renderModelList(models)}
    </div>
    <div class="model-menu-foot">
      <button class="btn" onclick="showApiKeyModal()" style="width:100%;text-align:center">🔑 API Key</button>
    </div>
  `;
  menu.classList.add('on');
}

function renderModelList(list) {
  return list.map(m => `
    <div class="apply-item" onclick="selectModel('${m.id}')" style="flex-direction:column;align-items:flex-start;gap:2px">
      <div style="display:flex;align-items:center;gap:6px;width:100%">
        <span style="font-size:13px;flex:1">${m.name}</span>
        ${m.free ? '<span style="font-size:9px;color:var(--ok);background:rgba(63,185,80,.15);padding:2px 6px;border-radius:4px">FREE</span>' : '<span style="font-size:9px;color:var(--warn);background:rgba(210,153,34,.15);padding:2px 6px;border-radius:4px">PAID</span>'}
        ${m.id === selectedModel ? '<span style="font-size:11px;color:var(--acc)">✓</span>' : ''}
      </div>
      <div style="font-size:10px;color:var(--t3);width:100%">${escHtml(m.desc)} • ${(m.ctx/1000).toFixed(0)}K ctx</div>
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

document.addEventListener('click', () => { document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on')); });

// ===== PAGE NAVIGATION =====
function showPage(p) {
  document.querySelectorAll('.page,.term-page').forEach(e => e.classList.remove('on'));
  const pageEl = document.getElementById('p-' + p);
  if (pageEl) pageEl.classList.add('on');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('on'));
  const navBtn = document.getElementById('nav-' + p);
  if (navBtn) navBtn.classList.add('on');
  if (p === 'terminal') {
    if (activeTab) setTimeout(() => activeTab.fitAddon?.fit(), 50);
    else if (tabs.length === 0) openTerminal();
  }
  if (p === 'files') initFM();
  if (p === 'git') loadGit();
  if (p === 'linux') { linuxStatus(); setTimeout(()=>{ try{ linuxConnect(); }catch{} }, 400); }
  document.body.classList.toggle('pg-linux', p === 'linux');
}

showPage('files');

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

// ===== LINUX DESKTOP: launch browser on VNC =====
async function linuxRunBrowser(url, vertical) {
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  // This function is normally called by a tap on Go/YouTube; start the local
  // audio receiver before the fetch so mobile autoplay rules allow playback.
  try { remoteAudioStart(); } catch {}
  try {
    // mobile: хаб откроет окно размером с экран телефона в левом верхнем углу
    // стола — телефон показывает стол крупно (1:1), и окно занимает весь экран.
    const r = await fetch('/api/linux/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'browser', url, vertical: !!vertical, mobile: true })
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
  if (grid.dataset.loaded && !ghRepos.length) return;
  grid.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка...</div>';
  try {
    const r = await fetch('/api/gh/repos?per_page=50');
    const d = await r.json();
    if (!d.success) { grid.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error || 'ошибка') + '</div>'; return; }
    ghRepos = d.repos || [];
    const cnt = document.getElementById('gh-repos-count');
    if (cnt) cnt.textContent = ghRepos.length + ' репозиториев';
    grid.innerHTML = ghRepos.map(r => `
      <div class="card" style="cursor:pointer;padding:12px" onclick="ghOpenRepo('${escAttr(r.full_name)}')">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:14px">${r.private ? '🔒' : '📂'}</span>
          <span style="font-size:14px;font-weight:600;color:var(--acc)">${escHtml(r.full_name)}</span>
        </div>
        <div style="font-size:12px;color:var(--t2);margin-bottom:4px">${escHtml(r.description || '(нет описания)')}</div>
        <div style="display:flex;gap:8px;font-size:10px;color:var(--t3);align-items:center">
          ${r.language ? '<span>' + escHtml(r.language) + '</span>' : ''}
          ${r.stargazers_count ? '<span>⭐ ' + r.stargazers_count + '</span>' : ''}
          <span>🌿 ${escHtml(r.default_branch)}</span>
          <span style="margin-left:auto;display:flex;gap:4px">
            <button class="btn btn-sm btn-p" style="font-size:10px;padding:4px 6px" onclick="event.stopPropagation(); ghQuickClone('${escAttr(r.full_name)}')" title="Клонировать и открыть в любом агенте (как в Файлах)">📂</button>
            <button class="btn btn-sm" style="font-size:10px;padding:4px 6px" onclick="event.stopPropagation(); browserOpenDesktop('https://github.com/${escAttr(r.full_name)}')" title="Открыть на github.com в браузере">🌐</button>
          </span>
        </div>
      </div>
    `).join('');
    grid.dataset.loaded = '1';
  } catch (e) { grid.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghOpenRepo(fullName) {
  ghCurrentRepo = fullName;
  ghCurrentPath = '';
  const section = document.getElementById('gh-repos-section');
  if (section) section.style.display = 'none';
  const detail = document.getElementById('gh-repo-detail');
  detail.style.display = 'block';
  document.getElementById('gh-repo-name').textContent = fullName;
  try {
    const r = await fetch('/api/gh/repos/' + fullName);
    const d = await r.json();
    document.getElementById('gh-repo-desc').textContent = d.description || '';
    document.getElementById('gh-repo-name').innerHTML = escHtml(fullName) + (d.language ? ' <span style="font-size:11px;color:var(--t3);font-weight:400">' + escHtml(d.language) + '</span>' : '');
  } catch {}
  ghShowTab('contents', document.querySelector('.gh-tab'));
  setTimeout(() => detail.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

function ghBackToList() {
  const section = document.getElementById('gh-repos-section');
  if (section) section.style.display = '';
  document.getElementById('gh-repo-detail').style.display = 'none';
  if (section) section.scrollIntoView({ block: 'start' });
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
    let url = '/api/gh/repos/' + ghCurrentRepo + '/contents';
    if (ghCurrentPath) url += '?path=' + encodeURIComponent(ghCurrentPath);
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    const items = d.items || [];
    let breadcrumb = '<div style="margin-bottom:8px;font-size:12px"><span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents(\'\')">📁 корень</span>';
    if (ghCurrentPath) {
      const parts = ghCurrentPath.split('/');
      parts.forEach((p, i) => {
        const pth = parts.slice(0, i + 1).join('/');
        breadcrumb += ' / <span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents(\'' + escAttr(pth) + '\')">' + escHtml(p) + '</span>';
      });
    }
    breadcrumb += '</div>';
    items.sort((a, b) => (a.type === 'dir' ? -1 : 1) - (b.type === 'dir' ? -1 : 1));
    el.innerHTML = breadcrumb + items.map(it => {
      const icon = it.type === 'dir' ? '📁' : fileIcon(it.name);
      const click = it.type === 'dir' ? `ghLoadContents('${escAttr(it.path)}')` : `ghViewFile('${escAttr(it.path)}')`;
      return `<div style="display:flex;align-items:center;gap:8px;padding:10px 8px;border-radius:8px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--bdr)" onclick="${click}">
        <span>${icon}</span>
        <span style="flex:1;color:var(--t1)">${escHtml(it.name)}</span>
        <span style="font-size:10px;color:var(--t3)">${it.size ? formatSize(it.size) : ''}</span>
      </div>`;
    }).join('');
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

async function ghViewFile(path) {
  const el = document.getElementById('gh-repo-contents');
  if (!el || !ghCurrentRepo) return;
  el.innerHTML = '<div style="color:var(--t3);font-size:12px">Загрузка файла...</div>';
  try {
    const r = await fetch('/api/gh/repos/' + ghCurrentRepo + '/contents?path=' + encodeURIComponent(path));
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(d.error) + '</div>'; return; }
    let content = '';
    if (d.download_url) {
      const fr = await fetch(d.download_url);
      content = await fr.text().catch(() => '(не удалось загрузить)');
    }
    el.innerHTML = `
      <div style="margin-bottom:8px;font-size:12px">
        <span style="cursor:pointer;color:var(--acc)" onclick="ghLoadContents('${escAttr(ghCurrentPath)}')">← Назад</span>
        <span style="margin-left:8px;font-weight:600">${escHtml(path)}</span>
      </div>
      <pre style="background:var(--bg0);border:1px solid var(--bdr);border-radius:8px;padding:12px;font-size:12px;font-family:monospace;color:var(--t1);overflow:auto;max-height:60vh;white-space:pre-wrap">${escHtml(content)}</pre>`;
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
      <div style="display:flex;align-items:center;gap:8px;padding:10px 8px;border-radius:8px;font-size:13px;border:1px solid var(--bdr);margin-bottom:6px">
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
      <div style="display:flex;align-items:flex-start;gap:8px;padding:10px 8px;border-radius:8px;font-size:12px;border:1px solid var(--bdr);margin-bottom:6px">
        <span style="font-family:monospace;font-size:11px;color:var(--pur);min-width:50px">${escHtml(c.sha || '')}</span>
        <div style="flex:1">
          <div style="color:var(--t1)">${escHtml(c.message || '')}</div>
          <div style="font-size:10px;color:var(--t3);margin-top:2px">${escHtml(c.author || '')} · ${c.date ? new Date(c.date).toLocaleString('ru') : ''}</div>
        </div>
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
      <div style="display:flex;align-items:center;gap:8px;padding:10px 8px;border-radius:8px;font-size:12px;border:1px solid var(--bdr);margin-bottom:6px">
        <span style="font-size:16px">${w.state === 'active' ? '🟢' : '⚪'}</span>
        <div style="flex:1">
          <div style="color:var(--t1);font-weight:500">${escHtml(w.name)}</div>
          <div style="font-size:10px;color:var(--t3)">${escHtml(w.path)}</div>
        </div>
        <span class="tag ${w.state === 'active' ? 'tag-on' : 'tag-off'}">${escHtml(w.state)}</span>
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
      <div style="display:flex;align-items:center;gap:8px;padding:10px 8px;border-radius:8px;font-size:12px;border:1px solid var(--bdr);margin-bottom:6px">
        <span style="font-size:16px">${icon}</span>
        <div style="flex:1">
          <div style="color:var(--t1);font-weight:500">${escHtml(run.name)} #${run.run_number}</div>
          <div style="font-size:10px;color:var(--t3)">🌿 ${escHtml(run.head_branch || '')} · ${run.created_at ? new Date(run.created_at).toLocaleString('ru') : ''}</div>
        </div>
        <button class="btn btn-sm" onclick="ghLoadArtifacts('${run.id}',this.parentElement)" title="Артефакты">📦</button>
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
        <div style="display:flex;align-items:center;gap:6px;padding:6px 0;flex-wrap:wrap">
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
      <div style="padding:12px;border-radius:8px;border:1px solid var(--bdr);margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          <span style="font-size:14px">📦</span>
          <span style="font-size:14px;font-weight:600;color:var(--t1)">${escHtml(rel.name || rel.tag_name)}</span>
          <span class="tag tag-on">${escHtml(rel.tag_name)}</span>
        </div>
        <div style="font-size:10px;color:var(--t3);margin-bottom:6px">${rel.created_at ? new Date(rel.created_at).toLocaleString('ru') : ''}</div>
        ${(rel.assets || []).map(a => `
          <div style="display:flex;align-items:center;gap:6px;padding:6px 0;font-size:11px;flex-wrap:wrap">
            <span>📄 ${escHtml(a.name)}</span>
            <span style="color:var(--t3)">${formatSize(a.size)}</span>
            <a href="${escAttr(a.browser_download_url)}" class="btn btn-sm" style="margin-left:auto;text-decoration:none;font-size:10px" download>📥 Скачать</a>
          </div>
        `).join('')}
      </div>
    `).join('') || '<div style="color:var(--t3);font-size:12px">Нет релизов</div>';
  } catch (e) { el.innerHTML = '<div style="color:var(--err);font-size:12px">' + escHtml(e.message) + '</div>'; }
}

// ===== DASHBOARD =====
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

function toggleApplyMenu(e, toolId) {
  e.stopPropagation();
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  const menu = document.getElementById('amenu-' + toolId);
  if (!menu) return;
  const dir = document.getElementById('cdir-' + toolId)?.value?.trim() || homeDir;
  menu.innerHTML = `<div class="apply-menu-title">Запустить в</div>` +
    tools.filter(t => t.installed).map(t => `
    <div class="apply-item" onclick="event.stopPropagation();openFromCard('${toolId}','${escAttr(dir)}','${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color};width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800">${t.icon}</div>
      <span>${t.name}</span>
    </div>
  `).join('') + `<div class="apply-item" onclick="event.stopPropagation();openFromCard('${toolId}','${escAttr(dir)}','_terminal')">
      <div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800">&gt;_</div>
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

// ===== SIDEBAR (in drawer) =====
function renderSidebar() {
  document.getElementById('tool-list').innerHTML = tools.filter(t => t.installed).map(t => {
    const dir = toolDirs[t.id] || homeDir;
    const short = (homeDir ? dir.replace(homeDir, '~') : dir).split('\\').pop();
    return `<div class="sb-i" onclick="launchTool('${t.id}');toggleDrawer()">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color}">${t.icon}</div>
      <div style="overflow:hidden;flex:1"><div>${t.name}</div><div style="font-size:9px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${short}</div></div>
    </div>`;
  }).join('');

  document.getElementById('term-list').innerHTML = tabs.map(t => `
    <div class="sb-i ${activeTab?.id === t.id ? 'on' : ''}" onclick="switchTab('${t.id}');toggleDrawer()">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color}">${t.icon}</div><span class="term-close" onclick="closeTab('${t.id}')" title="Закрыть">✕</span>
      <div style="overflow:hidden;flex:1"><div>${t.toolName}</div><div style="font-size:9px;color:var(--t3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.dirShort}</div></div>
    </div>`).join('');
}

// ===== SESSIONS =====
function showNewTermModal() {
  document.getElementById('newterm-grid').innerHTML = `
    <div class="newterm-tool" onclick="openTerminal()">
      <div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px">&gt;_</div>
      <div><div style="font-size:13px;font-weight:500">Terminal</div><div style="font-size:10px;color:var(--t3)">Пустой терминал</div></div>
    </div>
  ` + tools.filter(t => t.installed).map(t => `
    <div class="newterm-tool" onclick="createTerm('${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color};width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px">${t.icon}</div>
      <div><div style="font-size:13px;font-weight:500">${t.name}</div></div>
    </div>`).join('');

  const rp = document.getElementById('recent-paths');
  rp.innerHTML = recentPaths.length ? '<div style="font-size:10px;color:var(--t3);margin-bottom:4px">Недавние:</div>' +
    recentPaths.slice(0, 8).map(p => {
      const short = (homeDir ? p.replace(homeDir, '~') : p).replace(/\\/g, '/');
      return `<div class="path-dd-item" onclick="document.getElementById('newterm-cwd').value='${escAttr(p)}'" style="padding:6px 8px;font-size:12px;font-family:monospace;cursor:pointer;color:var(--t2);border-bottom:1px solid var(--bdr)">${short}</div>`;
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
  const toolName = isPlain ? 'Terminal' : tool.name;
  const toolColor = isPlain ? '#58a6ff' : tool.color;
  const toolIcon = isPlain ? '>_ ' : tool.icon;

  const tab = { id, toolId, toolName, toolColor, toolIcon, cwd, dirShort, term, fitAddon, socket: null, pty: null, manualClose: false, lastPong: 0, reconnectTimer: null, keepAlive: null, resizeObs: null, touchHandler: null, connect: () => {} };
  tabs.push(tab);
  activeTab = tab;

  renderTabs();
  renderSidebar();

  const panel = document.createElement('div');
  panel.className = 'term-panel on';
  panel.id = 'panel-' + id;
  panel.innerHTML = `<div class="term-header">
    <div class="term-header-title"><span class="tab-dot" style="background:${toolColor}"></span>${toolIcon} ${toolName}</div>
    <div class="term-info">${dirShort}</div>
  </div>`;
  const termEl = document.createElement('div');
  termEl.className = 'term';
  termEl.id = 'term-' + id;
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap';
  wrap.appendChild(termEl);
  const scrollEl = document.createElement('div');
  scrollEl.className = 'term-scroll';
  scrollEl.innerHTML = '<div class="term-scroll-thumb"></div>';
  wrap.appendChild(scrollEl);
  panel.appendChild(wrap);
  document.getElementById('term-container').appendChild(panel);

  term.open(termEl);
  fitAddon.fit();
  tab.scroll = attachTermScroll(id, panel);
  tab.touchHandler = setupTermTouch(termEl, term);

  const connect = () => {
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    tab.socket = socket;

    socket.onopen = () => {
      tab.lastPong = Date.now();
      socket.send(JSON.stringify({ type: 'open', toolId: isPlain ? '_terminal' : toolId, sessionId: id, cwd, cols: term.cols, rows: term.rows }));
      if (!isTouch) term.focus();
    };

    socket.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'pong') { tab.lastPong = Date.now(); return; }
      if (m.type === 'output' && m.id === id) term.write(m.data);
      if (m.type === 'exit') {
        term.write(`\r\n\x1b[33m[Exited ${m.code}]\x1b[0m\r\n`);
        renderSidebar();
      }
      if (m.type === 'error') term.write(`\r\n\x1b[31m[Error: ${m.error}]\x1b[0m\r\n`);
    };

    socket.onclose = () => {
      if (tab.manualClose) return;
      if (tab.reconnectTimer) { clearTimeout(tab.reconnectTimer); tab.reconnectTimer = null; }
      term.write('\r\n\x1b[33m[Disconnected — reconnecting...]\x1b[0m\r\n');
      tab.reconnectTimer = setTimeout(connect, 3000);
    };
  };
  tab.connect = connect;
  connect();

  // Keepalive: ping/pong + forced close when the socket goes stale (>45s).
  tab.keepAlive = setInterval(() => {
    if (tab.manualClose || !tab.socket) return;
    if (tab.socket.readyState === WebSocket.OPEN) {
      if (Date.now() - tab.lastPong > 45000) tab.socket.close();
      else tab.socket.send(JSON.stringify({ type: 'ping' }));
    }
  }, 15000);

  term.onData((data) => {
    if (tab.socket && tab.socket.readyState === WebSocket.OPEN) tab.socket.send(JSON.stringify({ type: 'input', data }));
  });

  term.onResize(({ cols, rows }) => {
    if (tab.socket && tab.socket.readyState === WebSocket.OPEN) tab.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  });

  tab.resizeObs = new ResizeObserver(() => { if (activeTab?.id === id) fitAddon.fit(); });
  tab.resizeObs.observe(panel);

  switchTab(id);
}

function renderTabs() {
  document.getElementById('tabs').innerHTML = tabs.map(t => `
    <div class="tab ${activeTab?.id === t.id ? 'on' : ''}" onclick="switchTab('${t.id}')">
      <span class="tab-dot" style="background:${t.toolColor}"></span>
      <span>${t.toolIcon} ${t.toolName}</span>
      <span class="tab-x" onclick="event.stopPropagation();closeTab('${t.id}')">✕</span>
    </div>
  `).join('') + `<div class="tab-add" onclick="showNewTermModal()">+</div>`;
}

function switchTab(id) {
  activeTab = tabs.find(t => t.id === id);
  document.querySelectorAll('.tab').forEach((el, i) => el.classList.toggle('on', tabs[i]?.id === id));
  document.querySelectorAll('.term-panel').forEach(p => p.classList.remove('on'));
  const panel = document.getElementById('panel-' + id);
  if (panel) panel.classList.add('on');
  if (activeTab) setTimeout(() => {
    activeTab.fitAddon?.fit();
    if (!isTouch) activeTab.term?.focus();
    activeTab.scroll?.upd?.();
  }, 50);
  renderSidebar();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const t = tabs[idx];
  t.manualClose = true;
  if (t.keepAlive) clearInterval(t.keepAlive);
  if (t.resizeObs) t.resizeObs.disconnect();
  if (t.scroll?.destroy) t.scroll.destroy();
  if (t.touchHandler?.destroy) t.touchHandler.destroy();
  t.socket?.close();
  t.term?.dispose();
  document.getElementById('panel-' + id)?.remove();
  tabs.splice(idx, 1);
  if (activeTab?.id === id) activeTab = tabs[Math.min(idx, tabs.length - 1)] || null;
  if (activeTab) switchTab(activeTab.id);
  renderTabs();
  renderSidebar();
}

function openTerminal() {
  closeModal('modal-newterm');
  createTerm('_terminal');
}

function launchTool(toolId) {
  const tool = tools.find(t => t.id === toolId);
  if (!tool || !tool.installed) return;
  const dir = toolDirs[toolId] || homeDir;
  showPage('terminal');
  createTerm(toolId, dir);
}

function zoomTerm(dir) {
  if (dir === 0) zoomLevel = 100;
  else zoomLevel = Math.max(50, Math.min(200, zoomLevel + dir * 10));
  document.getElementById('zoom-label').textContent = zoomLevel + '%';
  tabs.forEach(t => {
    t.term.options.fontSize = Math.round(14 * zoomLevel / 100);
    t.fitAddon?.fit();
  });
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
  setTimeout(() => tabs.forEach(t => t.fitAddon?.fit()), 100);
}

function killTerm() {
  if (!activeTab || !activeTab.socket) return;
  if (activeTab.socket.readyState === WebSocket.OPEN) {
    activeTab.socket.send(JSON.stringify({ type: 'kill', signal: 'SIGINT' }));
  }
}

function sendEscape() {
  if (!activeTab || !activeTab.socket) return;
  if (activeTab.socket.readyState === WebSocket.OPEN) {
    activeTab.socket.send(JSON.stringify({ type: 'input', data: '\x1b' }));
  }
}

async function pasteClipboard() {
  if (!activeTab || !activeTab.socket) return;
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        if (activeTab.socket.readyState === WebSocket.OPEN) {
          activeTab.socket.send(JSON.stringify({ type: 'input', data: text }));
        }
        return;
      }
    }
  } catch {}
  const text = await clipBox('Вставь текст (долгий тап → Вставить), затем «Вставить»:', '', 'Вставить');
  if (text && activeTab.socket.readyState === WebSocket.OPEN) {
    activeTab.socket.send(JSON.stringify({ type: 'input', data: text }));
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
  const cwd = activeTab.cwd || homeDir;
  closeTab(activeTab.id);
  setTimeout(() => createTerm(toolId, cwd), 100);
}

function sendKey(key) {
  if (!activeTab || !activeTab.socket) return;
  if (activeTab.socket.readyState === WebSocket.OPEN) {
    activeTab.socket.send(JSON.stringify({ type: 'input', data: key }));
  }
  // Не фокусируем терминал на таче, чтобы клавиатура не всплывала при тапе по экранным кнопкам
  if (isTouch) { try { activeTab.term.blur(); } catch {} }
}

// ===== FILE MANAGER =====
async function initFM() {
  const devR = await fetch('/api/devices').then(r => r.json());
  if (devR.success) {
    document.getElementById('devices-list').innerHTML = devR.devices.map(d => {
      const icon = d.type === 'phone' ? '📱' : d.type === 'tablet' ? '📟' : '💻';
      return `<div class="fm-sidebar-item" onclick="fmBrowse('${d.id}')"><span style="font-size:16px">${icon}</span><div><div style="font-size:13px">${d.name}</div><div style="font-size:10px;color:var(--t3)">${d.id}</div></div></div>`;
    }).join('') || '<div style="padding:8px;font-size:12px;color:var(--t3)">Нет устройств</div>';
  }

  const storR = await fetch('/api/storages').then(r => r.json());
  if (storR.success) {
    storages = storR.storages || [];
    document.getElementById('storages-list').innerHTML = storages.map(s => {
      return `<div class="fm-sidebar-item" onclick="fmSwitchBackend('${s.id}','/')"><span style="font-size:16px">${s.icon}</span><div><div style="font-size:13px">${s.name}</div></div></div>`;
    }).join('') || '<div style="padding:8px;font-size:12px;color:var(--t3)">Нет хранилищ</div>';
  }
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
  
  // Show loading state
  list.innerHTML = '<div style="padding:20px;color:var(--t3);text-align:center">Загрузка…</div>';
  
  // Build HTML in documentFragment for performance
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
    div.setAttribute('data-isdir', item.isDir ? '1' : '0');
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
  
  if (infoEl) infoEl.textContent = r.items ? r.items.length + " элементов | " + fmBackend : "0 элементов | " + fmBackend;
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
function browserTap(el) {
  if (el.classList.contains('fm-sel')) { browseTo(el.dataset.path); return; }
  document.querySelectorAll('#browser-list .fm-item').forEach(e => e.classList.remove('fm-sel'));
  el.classList.add('fm-sel');
}

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

function toggleFmMenu(e) {
  e.stopPropagation();
  document.querySelectorAll('.apply-menu').forEach(m => m.classList.remove('on'));
  const menu = document.getElementById('fm-apply-menu');
  if (!menu) return;
  const dir = fmCurrentPath || homeDir;
  menu.innerHTML = `<div class="apply-menu-title">Открыть в</div>` +
    tools.filter(t => t.installed).map(t => `
    <div class="apply-item" onclick="event.stopPropagation();fmOpenIn('${escAttr(dir)}','${t.id}')">
      <div class="sb-ico" style="background:${t.color}18;color:${t.color};width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800">${t.icon}</div>
      <span>${t.name}</span>
    </div>
  `).join('') + `<div class="apply-item" onclick="event.stopPropagation();fmOpenIn('${escAttr(dir)}','_terminal')">
      <div class="sb-ico" style="background:rgba(88,166,255,.15);color:var(--acc);width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800">&gt;_</div>
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
  const fragment = document.createDocumentFragment();
  if (path !== '/') {
    const parent = path.split('/').slice(0, -1).join('/') || '/';
    const div = document.createElement('div');
    div.className = 'fm-item';
    div.onclick = function() { fmBrowseAdbPath(device, parent); };
    div.innerHTML = '<span class="fm-ico">📁</span><span class="fm-name">..</span><span class="fm-size"></span>';
    fragment.appendChild(div);
  }
  const items = r.items || [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const div = document.createElement('div');
    div.className = 'fm-item';
    div.dataset.path = item.path;
    div.setAttribute('data-isdir', item.isDir ? '1' : '0');
    div.onclick = function() { fmTap(this); };
    const iconSpan = document.createElement('span');
    iconSpan.className = 'fm-ico';
    iconSpan.textContent = item.isDir ? '📁' : '📄';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'fm-name';
    nameSpan.textContent = item.name;
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'fm-size';
    sizeSpan.textContent = item.isDir ? '' : formatSize(item.size);
    div.appendChild(iconSpan);
    div.appendChild(nameSpan);
    div.appendChild(sizeSpan);
    fragment.appendChild(div);
  }
  list.innerHTML = '';
  list.appendChild(fragment);
  document.getElementById('fm-info').textContent = items.length + ' элементов | ADB:' + device + ':' + path;
}

function showAddStorageModal() {
  document.getElementById('modal-addstorage').classList.add('on');
}

function setStorageType(type) {
  document.querySelectorAll('.storage-type-btn').forEach(b => b.classList.toggle('on', b.dataset.type === type));
  ['adb','ftp','gdrive','github','http','webdav'].forEach(t => {
    const el = document.getElementById('form-' + t);
    if (el) el.style.display = t === type ? 'block' : 'none';
  });
}

async function saveStorage() {
  const type = document.querySelector('.storage-type-btn.on')?.dataset.type;
  if (!type) return;
  let config = { type, id: type + '_' + Date.now() };
  if (type === 'adb') {
    config.name = 'ADB: ' + document.getElementById('adb-host').value;
    config.host = document.getElementById('adb-host').value;
    config.port = document.getElementById('adb-port').value;
  } else if (type === 'ftp') {
    config.name = document.getElementById('ftp-name').value || 'FTP';
    config.host = document.getElementById('ftp-host').value;
    config.port = document.getElementById('ftp-port').value;
    config.user = document.getElementById('ftp-user').value;
    config.pass = document.getElementById('ftp-pass').value;
  } else if (type === 'gdrive') {
    config.name = document.getElementById('gdrive-name').value;
    config.token = document.getElementById('gdrive-token').value;
  } else if (type === 'github') {
    config.name = 'GitHub';
    config.repo = document.getElementById('github-repo').value;
    config.branch = document.getElementById('github-branch').value;
    config.token = document.getElementById('github-token').value;
  } else if (type === 'http') {
    config.name = document.getElementById('http-name').value || 'HTTP';
    config.url = document.getElementById('http-url').value;
  } else if (type === 'webdav') {
    config.name = document.getElementById('webdav-name').value || 'WebDAV';
    config.url = document.getElementById('webdav-url').value;
    config.user = document.getElementById('webdav-user').value;
    config.pass = document.getElementById('webdav-pass').value;
  }
  const r = await fetch('/api/storages/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }).then(r => r.json());
  if (r.success) {
    closeModal('modal-addstorage');
    initFM();
  } else {
    fmInfo('Ошибка: ' + (r.error || 'неизвестная'));
  }
}


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

function fmArchive() {
  if (!fmSelected) return;
  window.open(`/api/fs/archive?path=${encodeURIComponent(fmSelected)}`);
}

async function fmSaveGithub() {
  if (!fmSelected) return;
  const name = fmSelected.split(/[/\\]/).pop();
  const dir = String(fmSelected).split(/[/\\]/).slice(-2, -1)[0] || '';
  const isDirSel = document.querySelector('#fm-list .fm-item.fm-sel[data-isdir="1"]') != null;
  const what = isDirSel ? ('папку «' + name + '»') : ('файл «' + name + '»');
  if (!(await fmConfirm('Сохранить ' + what + ' в GitHub (session-state, artifacts/)?' + (isDirSel ? '\nПапка будет упакована в tar.xz (GitHub хранит только файлы).' : ''), 'Сохранить'))) return;
  try {
    const r = await fetch('/api/gh/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fmSelected })
    }).then(r => r.json());
    if (r.success) await fmInfo((r.packed ? 'Упаковано и сохранено: ' : 'Сохранено: ') + r.url);
    else await fmInfo('Ошибка: ' + (r.error || 'unknown'));
  } catch (e) { await fmInfo('Ошибка: ' + e.message); }
}

// SAF-пикер на телефоне: множественный выбор любых файлов, включая
// картинки. У млножественного режима.ACTION_GET_CONTENT открывает
// полноценный менеджер с галочками — Android готов к этому.
async function fmUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true; // все виды файлов (accept не задан — включая картинки, APK…)
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    const info = document.getElementById('fm-info');
    if (info) info.textContent = 'загружаю…';
    let ok = 0;
    for (const file of files) {
      const target = fmCurrentPath + '/' + file.name;
      try {
        const r = await fetch('/api/fs/upload?path=' + encodeURIComponent(target), {
          method: 'POST', body: file
        });
        const j = await r.json().catch(() => ({}));
        if (j && j.success) ok++;
      } catch (e) { /* keep going */ }
    }
    if (info) info.textContent = ok + ' из ' + files.length + ' загружено' + (ok === files.length ? '' : ' (некоторые не прошли)');
    fmRefresh();
  };
  input.click();
}

// Папка: работает в браузере (webkitdirectory), в APK пикер не покажет.
function fmUploadFolder() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.webkitdirectory = true;
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    const info = document.getElementById('fm-info');
    if (info) info.textContent = 'загружаю папку…';
    let ok = 0;
    for (const file of files) {
      const rel = file.webkitRelativePath || file.name;
      const target = fmCurrentPath + '/' + rel.replace(/^\/+/, '');
      try {
        const r = await fetch('/api/fs/upload?path=' + encodeURIComponent(target), {
          method: 'POST', body: file
        });
        const j = await r.json().catch(() => ({}));
        if (j && j.success) ok++;
      } catch (e) { /* keep going */ }
    }
    if (info) info.textContent = 'Папка: ' + ok + ' из ' + files.length + ' загружено';
    fmRefresh();
  };
  input.click();
}

// ===== BROWSER MODAL =====
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

function selectBrowserPath() {
  const sel = document.querySelector('#browser-list .fm-sel');
  if (sel) document.getElementById('newterm-cwd').value = sel.dataset.path;
  closeModal('modal-browser');
  document.getElementById('modal-newterm').classList.add('on');
}

// ===== HELPERS =====
function formatSize(b) { if (!b) return ''; if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB'; return (b / 1073741824).toFixed(1) + ' GB'; }
function fileIcon(n) { const e = n.split('.').pop().toLowerCase(); return {js:'📜',ts:'📜',py:'🐍',rs:'🦀',go:'🔷',html:'🌐',css:'🎨',json:'📋',md:'📝',txt:'📝',jpg:'🖼',png:'🖼',mp3:'🎵',mp4:'🎬',zip:'📦',exe:'⚙',bat:'🖥',sh:'🖥'}[e] || '📄'; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }

function copyTunnelUrl() {
  if (window.__tunnelUrl) {
    navigator.clipboard.writeText(window.__tunnelUrl).then(() => {
      const el = document.getElementById('tunnel-url');
      if (el) {
        const orig = el.textContent;
        el.textContent = '✓ Скопировано!';
        setTimeout(() => { el.textContent = orig; }, 1500);
      }
    });
  }
}

// ===== MODELS FULL PAGE =====
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
  const el = document.getElementById('account-overview');
  el.innerHTML = providers.map(p => `
    <div class="tool-config-card" style="cursor:pointer" onclick="filterByProvider('${p.id}')">
      <div class="tc-name">${p.icon} ${p.name}</div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
        <span style="font-size:11px;color:var(--t2)">${p.modelCount} моделей</span>
        ${p.free ? '<span style="font-size:9px;color:var(--ok);background:rgba(63,185,80,.15);padding:2px 6px;border-radius:4px">FREE</span>' : ''}
        ${p.configured ? '<span style="font-size:10px;color:var(--ok)">✓</span>' : '<span style="font-size:10px;color:var(--err)">⚠️</span>'}
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
        <span style="font-size:14px">${m.providerIcon}</span>
        <div class="model-name">${m.name}</div>
        ${m.selected ? '<span style="font-size:9px;color:var(--ok);background:rgba(63,185,80,.15);padding:2px 6px;border-radius:4px">✓ ACTIVE</span>' : ''}
        ${m.free ? '<span style="font-size:9px;color:var(--ok);background:rgba(63,185,80,.15);padding:2px 6px;border-radius:4px">FREE</span>' : ''}
        ${m.reasoning ? '<span style="font-size:9px;color:var(--pur);background:rgba(188,140,255,.15);padding:2px 6px;border-radius:4px">REASONING</span>' : ''}
      </div>
      <div class="model-id">${m.id}</div>
      <div style="font-size:10px;color:var(--t3);margin-top:2px">${m.providerName} • ${(m.ctx/1000).toFixed(0)}K in / ${(m.out/1000).toFixed(0)}K out</div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="btn btn-sm btn-ok" onclick="selectModelFull('${escAttr(m.id)}','${m.providerId}')">▶ Выбрать</button>
        ${m.key && m.key !== '(free)' ? `<span style="font-size:9px;color:var(--t3);display:flex;align-items:center">🔑 ${m.key.slice(0,10)}...</span>` : ''}
      </div>
    </div>
  `).join('');
}

let providerFilter = null;
function filterByProvider(providerId) {
  providerFilter = providerFilter === providerId ? null : providerId;
  const filtered = providerFilter
    ? modelsFullData.models.filter(m => m.providerId === providerFilter)
    : modelsFullData.models;
  renderModelsFullList(filtered);
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

// Load models-full when page is shown
const origShowPage = showPage;
showPage = function(p) {
  origShowPage(p);
  if (p === 'git') ghLoadRepos();
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
function cloudPhoneUrl(suffix) {
  const proto = location.protocol === 'https:' ? 'https' : 'http';
  return proto + '://' + location.host + '/phone/' + (suffix || 'vnc.html');
}
function phoneMsg(msg) {
  const el = document.getElementById('cp-status');
  if (el) { el.textContent = msg; el.className = 'tag tag-off'; }
}
async function cloudPhoneStatus(prefix) {
  const pfx = prefix || '';
  const el = document.getElementById(pfx ? 'cp-status-desktop' : 'cp-status');
  const btn = document.getElementById(pfx ? 'cp-start-desktop' : 'cp-start');
  try {
    if (el) { el.textContent = 'проверка…'; el.className = 'tag'; }
    const r = await fetch('/api/phone/status');
    const d = await r.json();
    const ok = d.running && d.adb;
    if (el) {
      el.textContent = ok ? '● запущен' : '○ выключен';
      el.className = 'tag ' + (ok ? 'tag-on' : 'tag-off');
    }
    if (btn) btn.textContent = d.running ? '→ Закрыть' : '▶ Старт';
    return d;
  } catch (e) {
    if (el) { el.textContent = '? ошибка'; el.className = 'tag tag-off'; }
    return { running: false };
  }
}
async function cloudPhoneStart(prefix) {
  const pfx = prefix || '';
  const d = await cloudPhoneStatus(pfx);
  const btn = document.getElementById(pfx ? 'cp-start-desktop' : 'cp-start');
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
  } catch (e) { phoneMsg('Ошибка запуска: ' + e.message); }
}
async function cloudPhoneStop(prefix) {
  const pfx = prefix || '';
  try {
    await fetch('/api/phone/stop', { method: 'POST' });
    const frame = document.getElementById(pfx ? 'cp-frame-desktop' : 'cp-frame');
    if (frame) { frame.src = 'about:blank'; frame.style.display = 'none'; }
    const ph = document.getElementById(pfx ? 'cp-placeholder-desktop' : 'cp-placeholder');
    if (ph) ph.style.display = 'flex';
    cloudPhoneStatus(pfx);
  } catch (e) { phoneMsg('Ошибка: ' + e.message); }
}
function cloudPhoneConnect(prefix) {
  const pfx = prefix || '';
  const frame = document.getElementById(pfx ? 'cp-frame-desktop' : 'cp-frame');
  const ph = document.getElementById(pfx ? 'cp-placeholder-desktop' : 'cp-placeholder');
  cloudPhoneStatus(pfx).then(d => {
    const url = d.url
      ? d.url
      : cloudPhoneUrl('vnc.html?autoconnect=1&path=ws/vnc&reconnect=1&reconnect_delay=3000');
    frame.src = url;
    frame.style.display = 'block';
    if (ph) ph.style.display = 'none';
  });
}
async function phoneBrowserOpen(url, prefix) {
  const pfx = prefix || '';
  const urlEl = document.getElementById(pfx ? 'cp-url-desktop' : 'cp-url');
  let val = String(url || (urlEl && urlEl.value) || '').trim();
  if (!val) return;
  if (!/^https?:\/\//i.test(val)) val = 'https://' + val;
  if (urlEl) urlEl.value = val;
  try { localStorage.setItem('cp.lastUrl', val); } catch {}
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
  const frame = document.getElementById(pfx ? 'cp-frame-desktop' : 'cp-frame');
  if (frame.requestFullscreen) frame.requestFullscreen();
  else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
}
if (document.getElementById('p-linux')) {
  cloudPhoneStatus();
  (function() {
    const last = localStorage.getItem('cp.lastUrl');
    const urlEl = document.getElementById('cp-url');
    if (urlEl && last) urlEl.value = last;
    pulseStatus();
  })();
}

// ===== LINUX DESKTOP (VNC) — всегда включён =====
// Экран поднимается сам на раннере, где живёт хаб (src/vnc-keepalive.js), и
// держится живым без кнопок: подключаемся сразу, повторяем до готовности,
// один раз за сессию перезагружаем iframe и просим хаб пересобрать экран,
// если он молчит. Никаких «Открыть экран»/«Подключение».
let linuxRetries = 0, linuxRepairAsked = 0, linuxPollTimer = null;
// Профиль картинки: для видео по мобильной сети нужны маленькие кадры
// (quality/compression — параметры Tight-кодирования noVNC).
const LINUX_PROFILES = {
  smooth:   { quality: 3, compression: 7, label: '⚡ плавно' },
  balanced: { quality: 6, compression: 2, label: '⚡ баланс' },
  sharp:    { quality: 9, compression: 0, label: '⚡ чётко' }
};
let linuxPerf = (() => { try { return localStorage.getItem('hub_perf') || 'smooth'; } catch { return 'smooth'; } })();
function linuxProfileQuery(u) {
  const p = LINUX_PROFILES[linuxPerf] || LINUX_PROFILES.smooth;
  return u + `&quality=${p.quality}&compression=${p.compression}`;
}
function linuxPerfToggle() {
  const order = ['smooth', 'balanced', 'sharp'];
  linuxPerf = order[(order.indexOf(linuxPerf) + 1) % order.length];
  try { localStorage.setItem('hub_perf', linuxPerf); } catch {}
  // Перезагружаем кадр с новыми параметрами (noVNC читает их при запуске).
  const fr = document.getElementById('linux-frame');
  if (fr) { fr.dataset.src = ''; }
  linuxConnect();
  linuxSetNote('картинка: ' + (LINUX_PROFILES[linuxPerf] || {}).label);
  setTimeout(() => linuxSetNote(''), 4000);
}
function linuxSetNote(text) {
  const n = document.getElementById('linux-note');
  if (n) n.textContent = text || '';
}
async function linuxStatus() {
  const el = document.getElementById('linux-status');
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
    if (d.keepalive && d.keepalive.note && d.keepalive.note !== 'running'
        && !/^\(/.test(String(d.keepalive.note)) && typeof d.keepalive.note === 'string'
        && !d.keepalive.note.startsWith('running')) {
      linuxSetNote(String(d.keepalive.note).slice(0, 90));
    }
    return d;
  } catch (e) {
    if (el) { el.textContent = '? нет связи с хабом'; el.className = 'tag tag-off'; }
    return { running: false, url: null };
  }
}
async function linuxConnect() {
  const fr = document.getElementById('linux-frame');
  const ph = document.getElementById('linux-placeholder');
  const d = await linuxStatus();
  if (!d.url) {
    linuxRetries++;
    if (fr) fr.style.display = 'none';
    if (ph) ph.style.display = 'flex';
    linuxSetNote('поднимаю экран на этом раннере: попытка ' + linuxRetries + '…');
    // 6 неудач ≈ 30 c — просим хаб пересобрать рабочий стол (repair)
    if (linuxRetries >= 6 && Date.now() - linuxRepairAsked > 60000) {
      linuxRepairAsked = Date.now();
      try { await fetch('/api/vnc/keepalive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'repair' }) }); } catch {}
      linuxSetNote('хаб пересобирает рабочий стол…');
    }
    clearTimeout(linuxPollTimer);
    linuxPollTimer = setTimeout(() => { try { linuxConnect(); } catch {} }, 5000);
    return;
  }
  linuxRetries = 0;
  let u = d.url;
  // noVNC: без кнопки «Подключение», с авто-реконнектом, масштабом и профилем
  // картинки (плавность/качество — кнопка ⚡).
  if (u && !u.includes('autoconnect')) {
    u += (u.includes('?') ? '&' : '?') + 'autoconnect=true&reconnect=true&reconnect_delay=2000&resize=scale';
    u = linuxProfileQuery(u);
  }
  if (fr) {
    // Единственное место, где iframe меняет src: иначе noVNC перезагружался бы
    // каждые 15 c и экран выглядел чёрным.
    if (fr.dataset.src !== u) { fr.dataset.src = u; fr.src = u; }
    fr.style.display = 'block';
    fr.allow = 'fullscreen; clipboard-read; clipboard-write';
    linuxPatchFrame(fr);
    setTimeout(() => linuxApplyZoom(fr), 3000);
  }
  if (ph) ph.style.display = 'none';
  linuxRetries = 0;
  // Строка «ставлю недостающее: …» осталась от момента запуска — убираем.
  if (d.keepalive && d.keepalive.note && String(d.keepalive.note).startsWith('running')) linuxSetNote('');
}
async function linuxRepair() {
  linuxSetNote('починка экрана…');
  linuxRepairAsked = Date.now(); linuxRetries = 0;
  try { await fetch('/api/vnc/keepalive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'repair' }) }); } catch {}
  setTimeout(() => { try { linuxConnect(); } catch {} }, 3000);
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

      // Панорамирование пальцем в режиме «заполнить»: перетаскивание двигает
      // стол, короткий тап остаётся кликом по экрану.
      if (!doc.__hubPan) {
        doc.__hubPan = true;
        const screenEl = doc.getElementById('noVNC_screen') || doc.body;
        let drag = null;
        screenEl.addEventListener('touchstart', (e) => {
          if (resolveZoom() !== 'clip' || e.touches.length !== 1) { drag = null; return; }
          drag = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }, { passive: true, capture: true });
        screenEl.addEventListener('touchmove', (e) => {
          if (!drag || e.touches.length !== 1) return;
          const t = e.touches[0];
          const dx = t.clientX - drag.x, dy = t.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) < 8) return;
          drag.x = t.clientX; drag.y = t.clientY;
          try { doc.__hub.pan(dx, dy); } catch {}
          e.preventDefault(); e.stopPropagation();
        }, { passive: false, capture: true });
        screenEl.addEventListener('touchend', () => { drag = null; }, { passive: true, capture: true });
      }

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
        // Масштаб: 'fit' — виден весь рабочий стол целиком, 'clip' — стол крупно
        // (1:1), лишнее уходит за края, панорамирование пальцем.
        scale(mode) {
          const sel = doc.getElementById('noVNC_setting_resize');
          const clip = doc.getElementById('noVNC_setting_view_clip');
          const fire = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));
          const wantClip = mode === 'clip';
          if (sel) { sel.value = mode === 'clip' ? 'off' : 'scale'; fire(sel); }
          if (clip) { clip.checked = wantClip; fire(clip); }
          // clip включаем и через объект RFB: кнопка в панели noVNC ссылается на
          // ту же настройку, но событие не всегда успевает примениться.
          const rfb = doc.defaultView && doc.defaultView.__rfb;
          if (rfb && wantClip) { try { rfb.scaleViewport = false; rfb.clipViewport = true; } catch {} }
          return Boolean(sel) || Boolean(rfb);
        },
        // Панорамирование (режим «заполнить»): палец двигает стол.
        pan(dx, dy) {
          try {
            const rfb = doc.defaultView && doc.defaultView.__rfb;
            const d = rfb && rfb._display;
            if (!d) return false;
            const k = d.scale || 1;
            d.viewportChangePos(-dx / k, -dy / k);
            return true;
          } catch { return false; }
        },
        info() {
          const sel = doc.getElementById('noVNC_setting_resize');
          const cv = doc.querySelector('canvas');
          return { resize: sel && sel.value, canvas: cv ? cv.width + 'x' + cv.height : null };
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
  try { if (fr && fr.contentDocument && fr.contentDocument.__hub) fr.contentDocument.__hub.scale(resolveZoom()); } catch {}
}

// Всегда включён: коннект при загрузке и keepalive без перезагрузки iframe.
setTimeout(() => { try { linuxConnect(); } catch {} }, 500);
setInterval(() => {
  const fr = document.getElementById('linux-frame');
  if (!fr || !fr.dataset.src || fr.style.display === 'none') { try { linuxConnect(); } catch {} }
}, 15000);

// Настоящий полный экран страницы + поворот в ландшафт (если браузер умеет:
// Android Chrome умеет, iOS Safari — нет, там остаётся CSS-режим с 100dvh).
// Тап по «Экран» в нижнем меню: на телефоне сразу разворачиваем рабочий стол
// на весь экран (и в ландшафт) — тогда видно стол, а не мелкую картинку в
// окружении панелей. Вышел через ✕ — в этой сессии больше не навязываемся.
function linuxOpen() {
  showPage('linux');
  let skip = false; try { skip = sessionStorage.getItem('hub_nofs') === '1'; } catch {}
  const touchy = (navigator.maxTouchPoints || 0) > 0 && Math.min(screen.width, screen.height) < 820;
  if (skip || !touchy) return;
  setTimeout(() => { try { linuxFullscreen(true); } catch {} }, 400);
}

async function linuxFullscreen(force) {
  const page = document.getElementById('p-linux');
  if (!page) return;
  const want = typeof force === 'boolean' ? force : !page.classList.contains('linux-full');
  page.classList.toggle('linux-full', want);
  try {
    const el = document.documentElement;
    if (want) {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        try { await screen.orientation.lock('landscape'); } catch {}
      }
    } else {
      if (document.exitFullscreen && document.fullscreenElement) await document.exitFullscreen();
      else if (document.webkitExitFullscreen && document.webkitFullscreenElement) document.webkitExitFullscreen();
      if (screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch {} }
    }
  } catch (e) { /* браузер отказал — остаёмся в CSS-режиме, он тоже на весь экран */ }
  // Запомнили, что полный экран не нужен — сами больше не разворачиваем.
  if (!want) { try { sessionStorage.setItem('hub_nofs', '1'); } catch {} }
  try { fmInfo(want ? '⛶ На весь экран · ландшафт (✕ — выход)' : '⛶ Обычный размер'); } catch {}
}
// Браузер сам вышел из fullscreen (жест «назад», Esc) — синхронизируем класс.
document.addEventListener('fullscreenchange', () => {
  const page = document.getElementById('p-linux');
  if (!page) return;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) page.classList.remove('linux-full');
  linuxRefit();
});
// Поворот телефона: noVNC пересчитывает масштаб по своему resize, но в
// iframe он приходит с задержкой — просим ещё раз.
window.addEventListener('orientationchange', () => setTimeout(linuxRefit, 350));
window.addEventListener('resize', () => { clearTimeout(window.__linuxRefitT); window.__linuxRefitT = setTimeout(linuxRefit, 300); });
function linuxRefit() {
  const fr = document.getElementById('linux-frame');
  try {
    if (fr && fr.contentDocument) {
      fr.contentDocument.defaultView.dispatchEvent(new Event('resize'));
      if (fr.contentDocument.__hub) fr.contentDocument.__hub.scale(resolveZoom());
    }
  } catch {}
  if (window.visualViewport) setTimeout(() => { try { fr.contentWindow.dispatchEvent(new Event('resize')); } catch {} }, 200);
}

// Клавиатура телефона: печатаем в скрытый input внутри noVNC, он передаёт
// нажатия на удалённый экран (xterm, браузер и т.д.).
function linuxKeyboard() {
  const fr = document.getElementById('linux-frame');
  let ok = false;
  try { ok = fr && fr.contentDocument && fr.contentDocument.__hub ? fr.contentDocument.__hub.kbd() : false; } catch {}
  if (!ok) { linuxSetNote('клавиатура: экран ещё грузится…'); return; }
  // Первый раз подсказываем хоткеи: на YouTube кнопки не показываются,
  // пока он требует логин («Sign in to confirm you're not a bot»), а с
  // клавиатуры телефона всё управляется: k — пуск/пауза, f — во весь экран,
  // m — звук, ←/→ — перемотка.
  const first = (() => { try { return !localStorage.getItem('hub_kbd_hint'); } catch { return true; } })();
  linuxSetNote(first
    ? '⌨ печатайте на телефоне · в YouTube: k — пуск/пауза, f — во весь экран, m — звук'
    : '⌨ клавиатура открыта — печатайте');
  if (first) { try { localStorage.setItem('hub_kbd_hint', '1'); } catch {} }
  setTimeout(() => linuxSetNote(''), first ? 9000 : 4000);
}

// 🔍 Заполнить (вписать всё) ⇄ 1:1 (точные пиксели + панорамирование пальцем).
const LINUX_ZOOMS = {
  auto: { icon: '🔎', note: 'сам: вертикально — крупно, горизонтально — весь стол' },
  fit:  { icon: '🔍', note: 'весь рабочий стол целиком' },
  clip: { icon: '🔎', note: 'стол крупно — двигайте пальцем, чтобы плавать по нему' }
};
// 'auto' (по умолчанию) сам выбирает: вертикальный телефон — крупно с
// панорамой, горизонтальный — весь стол. До этого картинка висела мелкой
// вставкой посреди чёрного поля — на это и жаловались («каша»).
let linuxZoomMode = (() => { try { return localStorage.getItem('hub_zoom') || 'auto'; } catch { return 'auto'; } })();

// Что реально делать сейчас: авто-режим смотрит на пропорции кадра.
function resolveZoom() {
  if (linuxZoomMode === 'fit' || linuxZoomMode === 'clip') return linuxZoomMode;
  // auto: вертикальный телефон — стол крупно (заполняет экран, лишнее за краем,
  // панорама пальцем); горизонтальный — весь стол (там пропорции совпадают).
  const st = document.getElementById('linux-stack');
  const r = st ? st.getBoundingClientRect() : { width: 0, height: 0 };
  if (!r.width || !r.height) return 'fit';
  return (r.width / r.height) >= 1.2 ? 'fit' : 'clip';
}

function linuxZoomToggle() {
  const order = ['auto', 'fit', 'clip'];
  linuxZoomMode = order[(order.indexOf(linuxZoomMode) + 1) % order.length];
  try { localStorage.setItem('hub_zoom', linuxZoomMode); } catch {}
  const fr = document.getElementById('linux-frame');
  try { if (fr && fr.contentDocument && fr.contentDocument.__hub) fr.contentDocument.__hub.scale(resolveZoom()); } catch {}
  const btn = document.getElementById('linux-zoom-btn');
  if (btn) btn.textContent = (LINUX_ZOOMS[linuxZoomMode] || LINUX_ZOOMS.auto).icon;
  linuxSetNote((LINUX_ZOOMS[linuxZoomMode] || {}).note);
  setTimeout(() => linuxSetNote(''), 4000);
}

// Применить текущий режим зума к кадру (кнопкой, при повороте и в тестах).
function linuxZoomApply() {
  const fr = document.getElementById('linux-frame');
  try { if (fr && fr.contentDocument && fr.contentDocument.__hub) fr.contentDocument.__hub.scale(resolveZoom()); } catch {}
}

// «⋯» — адрес, звук и починка. Экран должен быть экраном.
function linuxMoreToggle() {
  const el = document.getElementById('linux-more');
  if (!el) return;
  el.hidden = !el.hidden;
  const b = document.getElementById('linux-more-btn');
  if (b) b.textContent = el.hidden ? '⋯' : '×';
  if (!el.hidden) { try { pulseStatus(); } catch {} }
}


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
  const fr = document.getElementById('linux-frame');
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

// ===== BROWSER TAB (Chrome вкладка) =====
let browserHist = [], browserIdx = -1;
// Раньше это открывало iframe во вкладке «Chrome». Вкладку убрали (она
// дублировала «Экран»), поэтому любой «открыть ссылку» ведёт прямо на
// удалённый рабочий стол — один браузер вместо двух.
function hubBrowserGo(url){
  if(!url) return;
  url = url.trim();
  if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const input = document.getElementById('browser-url') || document.getElementById('browser-url-main');
  if(input) input.value = url;
  try{ localStorage.setItem('hub_browser_last', url); }catch{}
  const isYt = /youtube|youtu\.be/i.test(url);
  linuxRunBrowser(url, isYt);
  fmInfo('🌐 ' + url + ' → открываю на экране (звук вкл)');
  if (typeof linuxMoreToggle === 'function') { const m=document.getElementById('linux-more'); if (m && !m.hidden) linuxMoreToggle(); }
  showPage('linux');
}

function browserOpenDesktop(url, vertical){
  if(!url) url = (document.getElementById('browser-url') || {}).value || '';
  if(!url) return;
  url=url.trim(); if(!/^https?:\/\//i.test(url)) url='https://'+url;
  // vertical=true для ютуб Shorts — узкое окно + мобильный UA + звук
  if(vertical===true) url = url; // флаг передаётся в API
  linuxRunBrowser(url, vertical);
  fmInfo((vertical?'📱 Вертикальный браузер: ':'🖥 Браузер: ')+url+' → смотри в «Экран» (звук вкл)');
  showPage('linux');
  setTimeout(()=>{ linuxConnect(); }, 900);
}
async function pulseToggleMute(){
  try{
    const r=await fetch('/api/pulse/mute',{method:'POST'});
    const d=await r.json();
    fmInfo(d.muted ? '🔇 Мьют' : '🔊 Звук вкл');
  }catch{}
}
async function pulseSetVol(v){
  const lbl=document.getElementById('browser-vol-label');
  if(lbl) lbl.textContent=v+'%';
  try{ await fetch('/api/pulse/volume',{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({volume: Number(v)})}); }catch{}
}
// ===== TTS / OCR (читалка) =====
// Живёт на странице «Экран»: читает вслух то, что открыто на удалённом
// рабочем столе (OCR снимает скриншот экрана на сервере).
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
  // Раньше текст брался из iframe вкладки Chrome. Вкладки больше нет —
  // страница живёт на удалённом столе, поэтому всегда идём через OCR.
  try{
    const frame=null;
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
  const url=document.getElementById('browser-url')?.value||'';
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
function browserAgentHint(url){
  if(!url) return;
  const hint=document.getElementById('browser-agent-hint');
  const a=document.getElementById('browser-agent-url');
  if(!hint||!a) return;
  a.textContent=url; a.href=url;
  hint.style.display='flex';
  fmInfo('🔗 Агент прислал ссылку: '+url);
}
window.openInHubBrowser = (url)=>{ browserAgentHint(url); hubBrowserGo(url); };
window.addEventListener('message', (e)=>{
  try{
    const d = typeof e.data==='string' ? JSON.parse(e.data) : e.data;
    if(d && d.type==='hub-open-url' && d.url) browserAgentHint(d.url);
  }catch{}
});
let lastAgentUrl = '';
async function pollAgentUrls(){
  try{
    const last = localStorage.getItem('agent_last_url');
    if(last && last!==lastAgentUrl && /^https?:\/\//.test(last)){
      lastAgentUrl=last;
      browserAgentHint(last);
    }
  }catch{}
}
setInterval(pollAgentUrls, 8000);

// ===== LIVE DESKTOP PIP — удалён =====
// Окошко «● LIVE Экран · агент» внутри показывало заглушку «LIVE Экран», но
// висело поверх рабочего стола и превращало экран в кашу. Если понадобится
// снова — это был обычный абсолютный блок #live-pip в mobile.html.
function closeLivePip(){}

if (document.getElementById('p-linux')) {
  linuxStatus();
  // PulseAudio поднимается вместе с хабом, поэтому бейдж звука нельзя
  // измерять один раз при загрузке страницы — он оставался 'stopped' даже
  // когда бэкенд уже отвечал running:true.
  setTimeout(() => { try { pulseStatus(); } catch {} }, 2500);
  setInterval(() => { try { pulseStatus(); } catch {} }, 30000);
}

// ===== BROWSER (Chrome / YouTube) =====
function browserGo(url, prefix) {
  const pfx = prefix || '';
  const frame = document.getElementById(pfx ? 'browser-frame-desktop' : 'browser-frame');
  const urlEl = document.getElementById(pfx ? 'browser-url-desktop' : 'browser-url');
  try { new URL(url); } catch { return; }
  frame.src = url;
  urlEl.value = url;
}

// ===== PULSE AUDIO =====
async function pulseStatus() {
  try {
    const r = await fetch('/api/pulse/status');
    const d = await r.json();
    const el = document.getElementById('pulse-status');
    if (!el) return;
    // Короткая подпись: в панели это узкий тег рядом с Go.
    el.textContent = d.running ? ((_remoteAudio && _remoteAudio.ws && _remoteAudio.ws.readyState === 1) ? '🔊 видео' : '🔊 звук') : '🔇 нет звука';
    el.className = 'tag ' + (d.running ? 'tag-on' : 'tag-off');
    const devEl = document.getElementById('pulse-devices');
    if (d.sinks && d.sinks.length) {
      devEl.innerHTML = '<b>Sinks:</b><br>' + d.sinks.map(s => '• ' + s).join('<br>') +
        (d.sources && d.sources.length ? '<br><b>Sources:</b><br>' + d.sources.map(s => '• ' + s).join('<br>') : '');
    } else {
      devEl.textContent = 'Нет данных. Нажмите Start.';
    }
  } catch(e) {
    document.getElementById('pulse-status').textContent = 'error';
    document.getElementById('pulse-status').className = 'tag tag-off';
  }
}
async function pulseStart() {
  await fetch('/api/pulse/start', {method:'POST'});
  setTimeout(pulseStatus, 500);
}
async function pulseStop() {
  await fetch('/api/pulse/stop', {method:'POST'});
  setTimeout(pulseStatus, 500);
}
async function pulseMute() {
  const r = await fetch('/api/pulse/mute', {method:'POST'});
  const d = await r.json();
  if (d.ok) {
    const el = document.getElementById('pulse-status');
    el.textContent = d.muted ? 'muted' : 'running';
    el.className = 'tag ' + (d.muted ? 'tag-off' : 'tag-on');
  }
}
async function pulseSetVol(val) {
  document.getElementById('pulse-vol-label').textContent = val + '%';
  await fetch('/api/pulse/volume', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({volume:parseInt(val)})});
}

// ===== REMOTE VIDEO AUDIO =====
// VNC carries only pixels. The remote Chromium audio is captured from PulseAudio
// by /ws/audio and played here, in the phone/desktop browser.
let _remoteAudio = null;
function remoteAudioBadge(text, on) {
  const el = document.getElementById('pulse-status');
  if (!el) return;
  el.textContent = text;
  el.title = on ? 'Звук видео идёт на телефон. Нажмите, чтобы выключить.' : 'Включить звук видео';
  el.className = 'tag ' + (on ? 'tag-on' : 'tag-off');
}
function remoteAudioStart() {
  try {
    if (_remoteAudio && _remoteAudio.ws && _remoteAudio.ws.readyState <= 1) {
      _remoteAudio.ctx.resume().catch(() => {});
      return _remoteAudio;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.WebSocket) return null;
    const ctx = new AC();
    const rate = ctx.sampleRate || 44100;
    const node = ctx.createScriptProcessor(4096, 2, 2);
    const q = [];
    let qFrames = 0, current = null, currentAt = 0, pending = new Uint8Array(0);
    const state = { ctx, ws: null, node, q, close: false };
    node.onaudioprocess = (ev) => {
      const left = ev.outputBuffer.getChannelData(0);
      const right = ev.outputBuffer.numberOfChannels > 1 ? ev.outputBuffer.getChannelData(1) : left;
      left.fill(0); if (right !== left) right.fill(0);
      let n = 0;
      while (n < left.length) {
        if (!current || currentAt >= current.length) {
          current = q.shift(); currentAt = 0;
          if (!current) break;
          qFrames -= current.length / 2;
        }
        const avail = Math.min(left.length - n, (current.length - currentAt) / 2);
        for (let i = 0; i < avail; i++) {
          left[n + i] = current[currentAt + i * 2];
          if (right !== left) right[n + i] = current[currentAt + i * 2 + 1];
        }
        currentAt += avail * 2; n += avail;
      }
    };
    node.connect(ctx.destination);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/ws/audio?rate=' + encodeURIComponent(rate));
    state.ws = ws; _remoteAudio = state;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { ctx.resume().catch(() => {}); remoteAudioBadge('🔊 подключение', false); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ready') remoteAudioBadge('🔊 видео', true);
          if (msg.type === 'error') remoteAudioBadge('🔇 ' + (msg.error || 'нет потока'), false);
        } catch {}
        return;
      }
      const bytes = new Uint8Array(ev.data);
      const all = new Uint8Array(pending.length + bytes.length);
      all.set(pending); all.set(bytes, pending.length);
      const usable = all.length - (all.length % 4);
      pending = all.slice(usable);
      if (!usable) return;
      const view = new DataView(all.buffer, all.byteOffset, usable);
      const samples = new Float32Array(usable / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      q.push(samples); qFrames += samples.length / 2;
      // Do not let a stalled phone accumulate minutes of delayed audio.
      while (qFrames > rate * 2 && q.length > 1) qFrames -= q.shift().length / 2;
    };
    ws.onerror = () => remoteAudioBadge('🔇 нет потока', false);
    ws.onclose = () => {
      if (_remoteAudio === state) { try { node.disconnect(); } catch {} _remoteAudio = null; }
      remoteAudioBadge('🔇 звук', false);
    };
    ctx.resume().catch(() => {});
    return state;
  } catch { return null; }
}
function remoteAudioStop() {
  const a = _remoteAudio;
  _remoteAudio = null;
  if (!a) return;
  try { a.close = true; a.ws && a.ws.close(); } catch {}
  try { a.node.disconnect(); } catch {}
  try { a.ctx.close(); } catch {}
  remoteAudioBadge('🔇 звук', false);
}
function remoteAudioToggle() {
  if (_remoteAudio && _remoteAudio.ws && _remoteAudio.ws.readyState <= 1) remoteAudioStop();
  else remoteAudioStart();
}

// ===== AUDIO KEEP-ALIVE (background playback) =====
let _audioCtx = null;
let _silentOsc = null;
let _keepAliveInterval = null;

function _ensureAudioCtx() {
  if (_audioCtx) return _audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _audioCtx = new AC();
    // Silent oscillator — keeps AudioContext alive in background
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

// Resume audio on any user interaction (required by browsers)
['click','touchstart','keydown','mousedown'].forEach(evt => {
  document.addEventListener(evt, () => {
    _ensureAudioCtx();
    _resumeAudio();
    // A user gesture unlocks the phone speaker; the PCM stream then carries
    // audio from the video playing in remote Chromium.
    try { if (typeof remoteAudioStart === 'function') remoteAudioStart(); } catch {}
    // Also resume all iframes (YouTube, noVNC)
    document.querySelectorAll('iframe').forEach(f => {
      try { f.contentWindow.postMessage({type:'audio-resume'}, '*'); } catch {}
    });
  }, { passive: true });
});

// Handle visibility change — re-init audio when returning to tab
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    _resumeAudio();
    // Reconnect any broken WebSocket terminals
    if (typeof tabs !== 'undefined') {
      tabs.forEach(t => {
        if (t.socket && t.socket.readyState > 1 && !t.manualClose) {
          if (t.reconnectTimer) { clearTimeout(t.reconnectTimer); t.reconnectTimer = null; }
          // Trigger reconnect via showPage
          if (typeof activeTab !== 'undefined' && t === activeTab) {
            t.term?.writeln?.('\x1b[33m[Reconnecting...]\x1b[0m');
          }
        }
      });
    }
  }
});

// Periodic keep-alive — ping server every 30s to keep tunnel/session alive
_keepAliveInterval = setInterval(() => {
  fetch('/api/pulse/status').catch(() => {});
}, 30000);

// Prevent page sleep (keeps audio + WebSocket alive on mobile)
(function _preventSleep() {
  // Init silent audio keep-alive
  try {
    const el = document.getElementById('keepalive-audio');
    if (el) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(ctx.destination);
      src.start();
      el._ctx = ctx;
      el._src = src;
    }
  } catch {}

  let wakeLock = null;
  async function requestWake() {
    if ('wakeLock' in navigator && !document.hidden) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) requestWake();
    else if (wakeLock) { wakeLock.release(); wakeLock = null; }
  });
  requestWake();
})();
