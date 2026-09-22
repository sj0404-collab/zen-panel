let tabs = [], activeTab = null, zoomLevel = 60;
let tools = [], homeDir = '', recentPaths = [];
const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
const LS_KEY = 'npmhub.term.tabs.v1';

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('orientationchange', () => { setTimeout(() => tabs.forEach(t => t.fitAddon?.fit()), 300); });
window.addEventListener('resize', () => { if (activeTab) activeTab.fitAddon?.fit(); });

function kickReconnect() {
  tabs.forEach(t => {
    if (t.manualClose) return;
    const s = t.ws;
    if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) return;
    if (t.reconnectTimer) { clearTimeout(t.reconnectTimer); t.reconnectTimer = null; }
    t.lastPong = 0;
    t.retry = 1000;
    try { if (t.connect) t.connect(); } catch (e) {}
  });
}
window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kickReconnect(); });
window.addEventListener('focus', () => setTimeout(kickReconnect, 250));
window.addEventListener('online', kickReconnect);

function loadPersistedTabs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function persistTabs() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(tabs.map(t => ({ id: t.id, toolId: t.toolId, cwd: t.cwd, toolName: t.toolName, color: t.color, icon: t.icon, dirShort: t.dirShort })))); } catch (e) {}
}

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
  el.title = 'Раннер: осталось ' + fmtClockMs(ses.remainingMs) + ' (джоба убивается на 6-м часу)';
}

async function init() {
  const [toolsR, infoR, histR] = await Promise.all([
    fetch('/api/tools').then(r => r.json()).catch(() => ({ success: false })),
    fetch('/api/info').then(r => r.json()).catch(() => ({ success: false })),
    fetch('/api/path-history').then(r => r.json()).catch(() => ({ success: false }))
  ]);
  sessionClock();
  setInterval(sessionClock, 30000);
  if (toolsR.success) tools = toolsR.tools || [];
  if (infoR.home) homeDir = infoR.home;
  if (histR.success) recentPaths = histR.recentPaths || [];

  const saved = loadPersistedTabs();
  const seen = new Set();
  for (const m of saved) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    attachTab(m);
  }
  await restoreDurableSessions();
  if (tabs.length === 0) showEmpty(true); else showEmpty(false);
  syncZoom();
  refreshSessionsBadge();

  const qp = new URLSearchParams(location.search);
  const qTool = qp.get('tool');
  const qDir = qp.get('dir') || homeDir || '';
  if (qTool || qDir) {
    const tool = tools.find(t => t.id === qTool);
    attachTab({
      id: 'term_' + Date.now(), toolId: tool ? tool.id : null, cwd: qDir,
      toolName: tool ? tool.name : 'Terminal', color: tool ? tool.color : '#58a6ff',
      icon: tool ? tool.icon : '>_', dirShort: dirShortOf(qDir)
    });
  }
}

async function restoreDurableSessions() {
  try {
    const r = await fetch('/api/sessions');
    const d = await r.json();
    if (!d.success || !Array.isArray(d.sessions)) return;
    let created = false;
    for (const s of d.sessions) {
      if (!s || !s.id || !s.restore || tabs.some(t => t.id === String(s.id))) continue;
      attachTab({ ...s, id: String(s.id), cwd: s.cwd || s.repoPath || homeDir });
      created = true;
    }
    if (created) { persistTabs(); refreshSessionsBadge(); }
  } catch {}
}

function dirShortOf(cwd) {
  return (homeDir && cwd ? cwd.replace(homeDir, '~') : cwd || '~').split('\\').pop();
}

function attachTab(meta) {
  if (tabs.some(t => t.id === meta.id)) return;
  const id = meta.id || ('term_' + Date.now());
  const cwd = meta.cwd || homeDir || '~';
  const toolId = meta.toolId || null;
  const isPlain = toolId === '_terminal' || !toolId || !tools.find(t => t.id === toolId);
  const tool = tools.find(t => t.id === toolId);
  const displayName = meta.toolName || (isPlain ? 'Terminal' : (tool ? tool.name : 'Terminal'));
  const color = meta.color || (isPlain ? '#58a6ff' : (tool ? tool.color : '#58a6ff'));
  const icon = meta.icon || (isPlain ? '>_' : (tool ? tool.icon : '>_'));
  const dirShort = meta.dirShort || dirShortOf(cwd);
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

  const panel = document.createElement('div');
  panel.className = 'term-panel';
  panel.id = 'panel-' + id;
  panel.innerHTML = `<div class="term-header"><div class="term-header-title"><div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${displayName}</span></div><div class="term-info">${dirShort}</div><button class="btn" style="padding:2px 8px;font-size:10px" onclick="closeTab('${id}')">✕</button></div><div class="term-wrap"><div class="term" id="term-${id}"></div><div class="term-scroll"><button class="term-scroll-arr up">▲</button><div class="term-scroll-track"><div class="term-scroll-thumb"></div></div><button class="term-scroll-arr down">▼</button></div></div><div class="term-resumed" id="resumed-${id}">✓ Восстановлено</div>`;
  document.getElementById('term-container').appendChild(panel);
  term.open(document.getElementById('term-' + id));
  setTimeout(() => fitAddon.fit(), 30);

  const td = {
    id, toolId: toolId === '_terminal' ? null : toolId, toolName: displayName, color, icon, dirShort, cwd,
    term, fitAddon, el: panel, ws: null, manualClose: false, lastPong: 0, reconnectTimer: null, keepAlive: null, resizeObs: null, connect: () => {}
  };
  tabs.push(td);

  const showResumed = (n) => {
    const b = document.getElementById('resumed-' + id);
    if (!b) return;
    b.classList.add('on');
    clearTimeout(b._t);
    b._t = setTimeout(() => b.classList.remove('on'), Math.max(n * 1000, 2500));
  };

  const opened = () => {
    if (td.ws && td.ws.readyState === 1) {
      td.ws.send(JSON.stringify({ type: 'open', toolId: td.toolId && tools.find(t => t.id === td.toolId) ? td.toolId : '_terminal', sessionId: id, cwd, cols: td.term.cols, rows: td.term.rows }));
      fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: cwd }) });
    }
  };

  const connect = () => {
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    td.ws = socket;
    socket.onopen = () => {
      td.lastPong = Date.now();
      td.retry = 1000;
      opened();
      if (!isTouch) term.focus();
    };
    socket.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'pong') { td.lastPong = Date.now(); return; }
      if (m.type === 'opened') { if (m.resumed) showResumed(1.5); }
      if (m.type === 'output') { term.write(m.data); if (TERM_QUOTA_RE.test(String(m.data || ''))) termRecoverShow('⚠ Агент упёрся в лимит модели — перезапустите'); }
      if (m.type === 'exit') { term.write(`\r\n\x1b[33m[Exited ${m.code} — нажми ⟲, чтобы перезапустить]\x1b[0m\r\n`); termRecoverShow('⚠ Сессия завершилась — перезапустите агента'); }
      if (m.type === 'error') term.write(`\r\n\x1b[31m[Error: ${m.error}]\x1b[0m\r\n`);
    };
    socket.onclose = () => {
      if (td.manualClose) return;
      if (td.reconnectTimer) { clearTimeout(td.reconnectTimer); td.reconnectTimer = null; }
      term.write('\r\n\x1b[33m[Disconnected — reconnecting...]\x1b[0m\r\n');
      // Backoff: хаб рестартует при обновлении — соединение должно выживать, а
      // не зацикливаться. Начало — 1с, каждая неудача ×1.5, потолок 20с.
      td.retry = td.retry || 1000;
      const delay = Math.min(td.retry, 20000);
      td.retry = Math.round(td.retry * 1.5);
      td.reconnectTimer = setTimeout(connect, delay);
    };
    socket.onerror = () => {
      // Always enter the reconnect path on Android WebViews where `error`
      // may arrive without a subsequent usable close event.
      try { if (socket.readyState !== WebSocket.CLOSED) socket.close(); } catch {}
    };
    return socket;
  };
  td.connect = connect;
  connect();

  td.keepAlive = setInterval(() => {
    if (td.manualClose || !td.ws) return;
    if (td.ws.readyState === WebSocket.OPEN) {
      if (Date.now() - td.lastPong > 45000) td.ws.close();
      else td.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 15000);

  term.onData((d) => { if (td.ws && td.ws.readyState === 1) td.ws.send(JSON.stringify({ type: 'input', data: d })); });
  term.onResize(({ cols, rows }) => { if (td.ws && td.ws.readyState === 1) td.ws.send(JSON.stringify({ type: 'resize', cols, rows })); });

  td.resizeObs = new ResizeObserver(() => {
    if (activeTab?.id === id) {
      fitAddon.fit();
      if (td.ws && td.ws.readyState === 1) td.ws.send(JSON.stringify({ type: 'resize', cols: td.term.cols, rows: td.term.rows }));
    }
  });
  td.resizeObs.observe(panel);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.onclick = () => switchTab(id);
  tabEl.innerHTML = `<div class="tab-dot" style="background:${color}"></div><span>${displayName}</span><span class="tab-x" onclick="event.stopPropagation();closeTab('${id}')">×</span>`;
  document.getElementById('tabs').appendChild(tabEl);
  td.tabEl = tabEl;
  // виртуальный скролл + удержание для копирования
  try{ const vp=document.getElementById('term-'+td.id).querySelector('.xterm-viewport'); }catch{}
  td.scroll = attachTermScroll(td.id, panel, td.term);
  td.touchHandler = setupTermTouch(document.getElementById('term-'+td.id), td.term);

  showEmpty(false);
  persistTabs();
  switchTab(id);
  refreshSessionsBadge();
}

function switchTab(id) {
  activeTab = tabs.find(t => t.id === id);
  if (!activeTab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  activeTab.tabEl?.classList.add('on');
  document.querySelectorAll('.term-panel').forEach(p => p.classList.remove('on'));
  activeTab.el.classList.add('on');
  setTimeout(() => {
    activeTab.fitAddon?.fit();
    if (!isTouch) activeTab.term?.focus();
  }, 40);
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  tab.manualClose = true;
  if (tab.keepAlive) clearInterval(tab.keepAlive);
  if (tab.resizeObs) tab.resizeObs.disconnect();
  if (tab.scroll?.destroy) tab.scroll.destroy();
  if (tab.touchHandler?.destroy) tab.touchHandler.destroy();
  // 'kill' (not 'close'): closing a tab should end the tmux session, otherwise
  // it survives and is re-attached on the next page load, so closed tabs kept
  // coming back.
  try { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ type: 'kill' })); } catch (e) {}
  // HTTP fallback: the tab may be mid-reconnect, when a WS frame cannot be sent.
  try { fetch('/api/sessions/' + encodeURIComponent(id) + '/kill', { method: 'POST' }).catch(() => {}); } catch (e) {}
  tab.ws?.close();
  tab.term?.dispose();
  tab.el?.remove();
  tab.tabEl?.remove();
  tabs.splice(idx, 1);
  if (activeTab?.id === id) { activeTab = tabs[Math.min(idx, tabs.length - 1)] || null; activeTab ? switchTab(activeTab.id) : showEmpty(true); }
  persistTabs();
  refreshSessionsBadge();
}

function showEmpty(on) {
  document.getElementById('empty-state').classList.toggle('on', on);
}

function newSession() {
  document.getElementById('newterm-cwd').value = homeDir || '';
  document.getElementById('recent-paths').innerHTML = recentPaths.length ?
    '<div class="recent-hint">Недавние:</div>' + recentPaths.slice(0, 8).map(p =>
      `<div class="recent-item" onclick="setNewCwd('${escAttr(p)}')">${escHtml(p)}</div>`).join('') : '';
  const trayHtml = tools.filter(t => t.installed).map(t =>
    `<button class="btn tool-launch" style="border-color:${t.color}55;color:${t.color}" onclick="createToolSession('${t.id}')">${t.icon} ${t.name}</button>`
  ).join('');
  document.getElementById('newterm-tools').innerHTML = trayHtml ? `<label style="font-size:10px;color:var(--t2);display:block;margin-bottom:6px">Запустить инструмент:</label>${trayHtml}` : '';
  document.getElementById('modal-newterm').classList.add('on');
  document.getElementById('newterm-cwd')?.focus();
}

function setNewCwd(p) { document.getElementById('newterm-cwd').value = p; }

function createNewSession() {
  const cwd = (document.getElementById('newterm-cwd').value || homeDir || '').trim();
  if (!recentPaths.includes(cwd)) recentPaths.unshift(cwd);
  fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: cwd }) });
  closeModal('modal-newterm');
  attachTab({ id: 'term_' + Date.now(), toolId: null, cwd, toolName: 'Terminal', color: '#58a6ff', icon: '>_', dirShort: dirShortOf(cwd) });
}

function createToolSession(toolId) {
  closeModal('modal-newterm');
  const tool = tools.find(t => t.id === toolId);
  const cwd = (document.getElementById('newterm-cwd').value || homeDir || '').trim();
  fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: cwd }) });
  attachTab({ id: 'term_' + Date.now(), toolId, cwd, toolName: tool ? tool.name : toolId, color: tool ? tool.color : '#58a6ff', icon: tool ? tool.icon : '>_', dirShort: dirShortOf(cwd) });
}

function goDashboard() { location.href = '/d'; }

// ── Sessions panel ──
let serverSessions = [];
async function toggleSessions(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('sessions-panel');
  const was = panel.classList.contains('on');
  document.querySelectorAll('.sessions-panel').forEach(p => p.classList.remove('on'));
  if (!was) { panel.classList.add('on'); await loadSessions(); }
}

async function loadSessions(e) {
  if (e) e.stopPropagation();
  const r = await fetch('/api/sessions').then(r => r.json()).catch(() => ({ success: false }));
  const list = document.getElementById('sessions-list');
  if (!r.success) { list.innerHTML = '<div class="ses-empty">Не удалось получить список.</div>'; return; }
  serverSessions = r.sessions || [];
  const openIds = new Set(tabs.map(t => t.id));
  if (!serverSessions.length) { list.innerHTML = '<div class="ses-empty">Активных сессий нет. Запустите новую.</div>'; return; }
  list.innerHTML = serverSessions.map(s => {
    const isOpen = openIds.has(s.id);
    return `<div class="ses-item ${isOpen ? 'open' : ''}" onclick="attachSession('${escAttr(s.id)}')">
      <div class="ses-ico" style="background:${s.color}18;color:${s.color}">${s.icon}</div>
      <div class="ses-meta">
        <div class="ses-name">${escHtml(s.toolName)}</div>
        <div class="ses-dir">${escHtml(s.cwd || '~')}</div>
      </div>
      <div class="ses-state">${isOpen ? 'открыта' : (s.clients > 0 ? s.clients + ' подключ.' : 'подхватить ⇢')}</div>
    </div>`;
  }).join('');
}

function attachSession(id) {
  const s = serverSessions.find(x => x.id === id);
  if (!s || tabs.some(t => t.id === id)) return;
  document.getElementById('sessions-panel').classList.remove('on');
  attachTab({ id: s.id, toolId: s.toolId || null, cwd: s.cwd || homeDir, toolName: s.toolName, color: s.color, icon: s.icon, dirShort: dirShortOf(s.cwd) });
}

function refreshSessionsBadge() {
  fetch('/api/sessions').then(r => r.json()).catch(() => ({ success: false })).then(r => {
    if (r && r.success) {
      const unseen = (r.sessions || []).filter(s => !tabs.some(t => t.id === s.id)).length;
      document.getElementById('tab-add').title = unseen ? `Сессий можно подхватить: ${unseen}` : 'Новая сессия';
    }
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.sessions-wrap')) document.getElementById('sessions-panel')?.classList.remove('on');
});

// ── Controls ──
function zoomTerm(dir) {
  if (dir === 0) zoomLevel = 100; else zoomLevel = Math.max(50, Math.min(300, zoomLevel + dir * 10));
  syncZoom();
}
function syncZoom() {
  document.getElementById('zoom-label').textContent = zoomLevel + '%';
  tabs.forEach(t => { t.term.options.fontSize = Math.round(14 * zoomLevel / 100); setTimeout(() => t.fitAddon?.fit(), 10); });
}

// ── Спасение от «застывшего» агента ──
// opencode и другие CLI-агенты при исчерпании лимита модели (особенно у
// бесплатных OpenCode Zen) печатают полноэкранное уведомление/модалку и
// перестают реагировать на клавиатуру — терминал выглядит «глючным, не даёт
// нажать что-либо». Даём всегда кликабельный ♻ прямо поверх экрана.
let __termRecoverT = null;
function termRecoverHide() {
  const bar = document.getElementById('term-recover');
  if (bar) bar.classList.remove('on');
  clearTimeout(__termRecoverT);
}
function termRecoverShow(note) {
  const bar = document.getElementById('term-recover');
  if (!bar) return;
  const lbl = document.getElementById('term-recover-note');
  if (lbl) lbl.textContent = note || '⚠ Агент упёрся в лимит модели';
  bar.classList.add('on');
  clearTimeout(__termRecoverT);
  __termRecoverT = setTimeout(termRecoverHide, 25000);
}
const TERM_QUOTA_RE = /(quota|rate\s?limit|insufficient|429|402|credits|balance|лимит|квот|баланс|закончил|недостаточно|не хвата|оплат|продл|premium)/i;

// ===== TERMINAL SCROLLBAR (виртуальный ползунок, как мышка) =====
function attachTermScroll(id, panel){
  const termEl=document.getElementById('term-'+id);
  const vp=termEl.querySelector('.xterm-viewport');
  const track=panel.querySelector('.term-scroll-track');
  const thumb=panel.querySelector('.term-scroll-thumb');
  if(!vp||!track||!thumb) return null;
  const term=(tabs.find(t=>t.id===id)||{}).term;
  // В alternate screen (vim/htop/OpenCode) нет scrollback-буфера: программе нужно
  // слать события колеса, а не крутить viewport. Обычный ползунок крутит xterm.
  const isAlt=()=>{ const b=term&&term.buffer&&term.buffer.active; return !!(b&&b.type==='alternate'); };
  const fireWheel=(dy)=>{
    if(!term) return;
    const scr=termEl.querySelector('.xterm-screen')||termEl;
    try{ scr.dispatchEvent(new WheelEvent('wheel',{deltaY:dy,deltaMode:0,bubbles:true,cancelable:true,composed:true})); }catch(_){}
  };
  // Стрелки ▲▼ внизу полосы прокрутки: по нажатию (и удержанию) крутят терминал.
  // На телефоне прокрутка пальцем по тексту часто не работает — стрелки это чинят.
  const scrollStep=(dir)=>{
    if(isAlt()){ fireWheel(dir==='up'?-140:140); return; }
    const max=vp.scrollHeight-vp.clientHeight;
    if(max<=0) return;
    const step=Math.max(70,Math.round(vp.clientHeight*0.45));
    vp.scrollTop=Math.max(0,Math.min(max,vp.scrollTop+(dir==='up'?-step:step)));
  };
  let arrTimer=null;
  const arrStop=()=>{ if(arrTimer){ clearInterval(arrTimer); arrTimer=null; } };
  const bindArr=(btn,dir)=>{
    if(!btn) return;
    btn.addEventListener('pointerdown',(e)=>{
      e.preventDefault(); e.stopPropagation();
      btn.classList.add('on'); scrollStep(dir); arrStop();
      arrTimer=setInterval(()=>scrollStep(dir),90);
    });
    ['pointerup','pointercancel','pointerleave'].forEach(ev=>btn.addEventListener(ev,()=>{ btn.classList.remove('on'); arrStop(); }));
  };
  bindArr(panel.querySelector('.term-scroll-arr.up'),'up');
  bindArr(panel.querySelector('.term-scroll-arr.down'),'down');
  let altDrag=0;
  const updAlt=()=>{
    thumb.style.display='block';
    const trackH=track.clientHeight;
    const th=Math.max(24,Math.min(110,trackH*0.25));
    altDrag=Math.max(0,Math.min(Math.max(1,trackH-th),altDrag));
    thumb.style.height=th+'px';
    thumb.style.transform='translateY('+altDrag+'px)';
  };
  const upd=()=>{
    if(isAlt()){ updAlt(); return; }
    const max=vp.scrollHeight - vp.clientHeight;
    if(max<=2){ thumb.style.display='none'; return; }
    thumb.style.display='block';
    const trackH=track.clientHeight;
    const th=Math.max(24, trackH * (vp.clientHeight / vp.scrollHeight));
    const pos= trackH<=th?0:(vp.scrollTop/max)*(trackH-th);
    thumb.style.height=th+'px';
    thumb.style.transform='translateY('+pos+'px)';
  };
  vp.addEventListener('scroll',upd);
  let ro=null;
  if(typeof ResizeObserver!=='undefined'){ ro=new ResizeObserver(upd); ro.observe(track); }
  const resizeHandler=upd; window.addEventListener('resize',resizeHandler);
  let bufSub=null;
  if(term&&term.buffer&&term.buffer.onBufferChange){ bufSub=term.buffer.onBufferChange(upd); }
  let dragging=false,startY=0,startTop=0;
  const toTop=(e)=>{
    if(isAlt()){
      const dy=e.clientY-startY;
      startY=e.clientY;
      const trackH=track.clientHeight;
      altDrag=Math.max(0,Math.min(Math.max(1,trackH-thumb.clientHeight),altDrag+dy));
      thumb.style.transform='translateY('+altDrag+'px)';
      fireWheel(dy*8);
      e.preventDefault();
      return;
    }
    const max=vp.scrollHeight - vp.clientHeight;
    if(max<=0) return;
    const trackH=track.clientHeight;
    const th=Math.max(24, trackH * (vp.clientHeight / vp.scrollHeight));
    const ratio=trackH-th; const dy=e.clientY-startY;
    vp.scrollTop=Math.max(0,Math.min(1,((startTop/max)*ratio+dy)/ratio))*max;
    e.preventDefault();
  };
  thumb.addEventListener('pointerdown',(e)=>{dragging=true; startY=e.clientY; startTop=vp.scrollTop; try{thumb.setPointerCapture(e.pointerId);}catch{} e.preventDefault();});
  thumb.addEventListener('pointermove',(e)=>{ if(dragging) toTop(e); });
  const endDrag=()=>{dragging=false;};
  thumb.addEventListener('pointerup',endDrag); thumb.addEventListener('pointercancel',endDrag);
  track.addEventListener('pointerdown',(e)=>{
    if(e.target===thumb) return;
    if(isAlt()){
      const rect=track.getBoundingClientRect();
      const down=e.clientY>rect.top+rect.height/2;
      fireWheel(down?120:-120);
      const trackH=track.clientHeight;
      altDrag=Math.max(0,Math.min(Math.max(1,trackH-thumb.clientHeight),altDrag+(down?60:-60)));
      thumb.style.transform='translateY('+altDrag+'px)';
      e.preventDefault();
      return;
    }
    const max=vp.scrollHeight - vp.clientHeight;
    if(max<=0) return;
    const rect=track.getBoundingClientRect();
    const ratio=(e.clientY-rect.top-14)/rect.height;
    vp.scrollTop=max*Math.max(0,Math.min(1,ratio));
    e.preventDefault();
  });
  upd();
  return{upd,destroy(){ arrStop(); if(ro) ro.disconnect(); window.removeEventListener('resize',resizeHandler); if(bufSub&&bufSub.dispose) bufSub.dispose(); }};
}
// ===== LONG-PRESS COPY =====
function setupTermTouch(termEl, term){
  if(!('ontouchstart' in window) && !(navigator.maxTouchPoints||0)) return null;
  let startY=0,startX=0,startT=0,scrolled=false,longPress=false,holdTimer=null;
  const onStart=(e)=>{
    const t=e.touches[0]; startY=t.clientY; startX=t.clientX; startT=Date.now(); scrolled=false; longPress=false;
    term.blur();
    clearTimeout(holdTimer);
    holdTimer=setTimeout(()=>{ if(!scrolled){ longPress=true; try{if(navigator.vibrate) navigator.vibrate(30);}catch{} copySelection(); } },600);
  };
  const onMove=(e)=>{
    const t=e.touches[0];
    if(Math.abs(t.clientY-startY)>8 || Math.abs(t.clientX-startX)>8){ scrolled=true; clearTimeout(holdTimer); term.blur(); }
  };
  const onEnd=(e)=>{
    clearTimeout(holdTimer);
    if(longPress){ e.preventDefault(); return; }
    if(!scrolled && Date.now()-startT<500){ e.preventDefault(); term.focus(); }
  };
  const onContext=(e)=>{ e.preventDefault(); copySelection(); return false; };
  termEl.addEventListener('touchstart',onStart,{passive:true});
  termEl.addEventListener('touchmove',onMove,{passive:true});
  termEl.addEventListener('touchend',onEnd,{passive:false});
  termEl.addEventListener('contextmenu',onContext);
  return{destroy(){ clearTimeout(holdTimer); termEl.removeEventListener('touchstart',onStart); termEl.removeEventListener('touchmove',onMove); termEl.removeEventListener('touchend',onEnd); termEl.removeEventListener('contextmenu',onContext); }};
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
  }
  if (('ontouchstart' in window) || (navigator.maxTouchPoints||0)) { try{activeTab.term.blur();}catch{} } else { activeTab.term?.focus(); }
}
function sendEscape() {
  if (!activeTab || !activeTab.ws) return;
  if (activeTab.ws.readyState === WebSocket.OPEN) {
    activeTab.ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
  }
  if (('ontouchstart' in window) || (navigator.maxTouchPoints||0)) { try{activeTab.term.blur();}catch{} }
}
function restartTerm() {
  if (!activeTab) return;
  termRecoverHide();
  activeTab.lastPong = 0;
  activeTab.ws?.close();
  if (activeTab.reconnectTimer) { clearTimeout(activeTab.reconnectTimer); activeTab.reconnectTimer = null; }
  setTimeout(() => { try { activeTab.connect(); } catch (e) {} }, 200);
}
async function pasteClipboard() {
  if (!activeTab || !activeTab.ws) return;
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text && activeTab.ws.readyState === WebSocket.OPEN) {
        activeTab.ws.send(JSON.stringify({ type: 'input', data: text }));
        activeTab.term?.focus();
      }
      return;
    }
  } catch (e) {}
}
async function copySelection() {
  const term = activeTab && activeTab.term;
  if (!term) return;
  let txt = '';
  try { txt = term.getSelection() || ''; } catch (e) {}
  if (!txt) {
    try {
      const buf = term.buffer.active;
      const from = Math.max(0, buf.length - 200);
      const lines = [];
      for (let y = from; y < buf.length; y++) lines.push(buf.getLine(y).translateToString(true));
      txt = lines.join('\n').replace(/\s+$/, '');
    } catch (e) {}
  }
  if (txt) { try { await navigator.clipboard.writeText(txt); } catch (e) {} }
}

// ── Folder browser modal ──
let browseSelected = null;
async function openBrowser() {
  closeModal('modal-newterm');
  document.getElementById('modal-browser').classList.add('on');
  const drivesR = await fetch('/api/drives').then(r => r.json()).catch(() => ({ success: false }));
  if (drivesR.success) {
    document.getElementById('browser-drives').innerHTML = drivesR.drives.map(d =>
      `<button class="drive-btn" onclick="browseTo('${d}')">${d}</button>`).join('');
  }
  browseTo(homeDir || '/');
}
async function browseTo(p) {
  const r = await fetch(`/api/browse?backend=local&path=${encodeURIComponent(p)}`).then(r => r.json()).catch(() => ({ success: false }));
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
  browseSelected = el.dataset.path;
}
function selectBrowserPath() {
  if (browseSelected) document.getElementById('newterm-cwd').value = browseSelected;
  closeModal('modal-browser');
  document.getElementById('modal-newterm').classList.add('on');
}
function browseDir() { openBrowser(); }

function closeModal(id) { document.getElementById(id).classList.remove('on'); }
document.querySelectorAll('.modal-bg').forEach(bg => {
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('on'); });
});

function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }