/* =========================================================================
 * files-app.js — страница «Файлы».
 * Файловый менеджер (local / adb / хранилища), загрузка drag&drop,
 * операции над файлами. Общее состояние и топбар — в bridge.js.
 * ========================================================================= */

let fmCurrentPath = '';
let fmSelected = null;
let fmBackend = 'local';
let fmCacheInfo = ''; // «(кеш)» — текущий список показан из IndexedDB (сервер недоступен)

// ─── Локальный кеш в IndexedDB ───
// Кеш на устройстве — как у PWA: листинги папок и содержимое открытых файлов
// лежат в IndexedDB (тот же hub-files-cache, что и offline.js) и переживают
// отключение/смерть раннера. Если хаб недоступен, вкладка «Файлы» продолжает
// работать из кеша. Реализация — в offline.js: window.HubOffline.idb.
const _fs = (() => { try { return (window.HubOffline && HubOffline.idb) ? HubOffline.idb : null; } catch (e) { return null; } })();
function fsCachePutList(key, json) {
  if (!_fs) return Promise.resolve();
  return _fs.put('list', { key, status: 200, ct: 'application/json', body: JSON.stringify(json), ts: Date.now() });
}
function fsCacheGetList(key) {
  if (!_fs) return Promise.resolve(null);
  return _fs.get('list', key).then(r => {
    if (!r || !r.body) return null;
    try { return { json: JSON.parse(r.body) }; } catch (e) { return null; }
  }).catch(() => null);
}
function fsCachePutBlob(key, blob) {
  if (!_fs || !blob) return Promise.resolve();
  return _fs.put('blob', { key, blob, ts: Date.now() });
}
function fsCacheGetBlob(key) {
  if (!_fs) return Promise.resolve(null);
  return _fs.get('blob', key).catch(() => null);
}
function fsCacheClear() {
  if (!_fs) return Promise.resolve();
  return _fs.clear('list').then(() => _fs.clear('blob'));
}

async function pageInit() {
  try {
    const r = await (await fetch('/api/tools')).json();
    if (r.success) tools = r.tools;
  } catch (e) {}
  await initFM();
  fmBrowse(workDir || homeDir);
  setTimeout(setupDropZone, 300);
}

// ─── ИНИЦИАЛИЗАЦИЯ ───
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
  const key = fmBackend + '|' + p;
  let r = null;
  let fromCache = false;
  try {
    const res = await fetch("/api/browse?backend=" + fmBackend + "&path=" + encodeURIComponent(p));
    if (res.headers.get('x-hub-offline') === '1') fromCache = true; // кеш из offline.js (localStorage)
    const j = await res.json();
    if (j && j.success) { r = j; if (!fromCache) fsCachePutList(key, j); }
    else if (j && j.offline) { /* сервер недоступен — ниже упадём в кеш */ }
    else r = j;
  } catch (e) { /* network/parse error */ }
  if (!r || !r.success) {
    const c = await fsCacheGetList(key);
    if (c && c.json && c.json.success) { r = c.json; fromCache = true; fmCacheInfo = 'кеш'; }
  }
  if (fromCache) fmCacheInfo = fromCache ? 'кеш (' + (r.path || p) + ')' : '';
  else if (r && r.success) fmCacheInfo = '';
  if (!r || !r.success) {
    const list = document.getElementById("fm-list");
    if (list) list.innerHTML = '<div style="padding:20px;color:var(--t3);text-align:center">Сервер недоступен, данных в кеше нет</div>';
    return;
  }
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
    div.dataset.size = String(item.size || 0);
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

  // Восстановление пути в поле ввода для локального бэкенда
  const inp = document.getElementById("fm-path");
  if (inp) inp.value = fmBackend.indexOf(':') > -1 ? '[' + fmBackend + '] ' + r.path : r.path;
  if (infoEl) infoEl.textContent = (fromCache ? '🧊 ' + fmCacheInfo + ' · ' : '') + items.length + " элементов | " + fmBackend;
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
    if (!p) return;
    const name = String(p).split(/[/\\]/).pop();
    if (HubOffline && HubOffline.isOffline) {
      fsCacheGetBlob(fmBackend + '|' + p).then(rec => {
        if (rec && rec.blob) fmSaveBlob(rec.blob, name);
        else fmInfo('Нет связи, в кеше нет: ' + name);
      });
    } else {
      dlNow('/api/fs/download?backend=' + fmBackend + '&path=' + encodeURIComponent(p), name);
      fmWarm(p);
    }
  });
}

function fmDownloadSingle() {
  if (!fmSelected) return;
  const name = String(fmSelected).split(/[/\\]/).pop();
  if (HubOffline && HubOffline.isOffline) {
    fsCacheGetBlob(fmBackend + '|' + fmSelected).then(rec => {
      if (rec && rec.blob) { fmSaveBlob(rec.blob, name); fmInfo('🧊 Из кеша: ' + name); }
      else fmInfo('Нет связи и файла в кеше');
    });
    return;
  }
  dlNow('/api/fs/download?backend=' + fmBackend + '&path=' + encodeURIComponent(fmSelected), name);
  fmWarm(fmSelected);
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
  try {
    await fetch('/api/path-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: dir }) });
  } catch (e) {}
  if (!recentPaths.includes(dir)) recentPaths.unshift(dir);
  openTermPage(toolId, dir);
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
  bindModalBgs();
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
  const p = fmCurrentPath + '/' + name;
  await fetch('/api/fs/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: fmBackend, path: p }) });
  fmRefresh();
}

async function fmDelete() {
  if (!fmSelected) return;
  const list = document.querySelectorAll('#fm-list .fm-item.fm-sel');
  const items = list.length ? list : (fmSelected ? [{ dataset: { path: fmSelected } }] : []);
  const paths = [...items].map(e => e.dataset.path);
  if (!(await fmConfirm('Удалить ' + paths.length + ' элемент(ов)?'))) return;
  for (const p of paths) {
    await fetch('/api/fs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: fmBackend, path: p }) });
  }
  fmSelected = null;
  fmRefresh();
}

async function fmRename() {
  if (!fmSelected) return;
  const list = document.querySelectorAll('#fm-list .fm-item.fm-sel');
  if (list.length > 1) { fmInfo('Выберите один элемент для переименования'); return; }
  const dir = fmSelected.split(/[/\\]/).slice(0, -1).join('/') || '/';
  const oldName = fmSelected.split(/[/\\]/).pop();
  const newName = await fmAsk('Новое имя для ' + oldName + ':', oldName);
  if (!newName || newName === oldName) return;
  const newPath = dir + '/' + newName;
  await fetch('/api/fs/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: fmBackend, oldPath: fmSelected, newPath }) });
  fmRefresh();
}

// ─── КЕШ НА УСТРОЙСТВЕ (IndexedDB) ───
// Кнопка «💾 В кеш»: скачивает выбранный файл на устройство (в IndexedDB) или
// рекурсивно — всю папку. Пока сервер жив — данные есть в кеше; если раннер
// умер, файлы/папки продолжают работать через fmOpenView/fmDownload, которые
// при недоступности сервера берут содержимое из кеша (как PWA).

function fmCacheSelection() {
  const sel = [...document.querySelectorAll('#fm-list .fm-item.fm-sel')];
  if (!sel.length && fmSelected) {
    const all = [...document.querySelectorAll('#fm-list .fm-item')];
    const hit = all.find(e => e.dataset.path === fmSelected);
    if (hit) sel.push(hit);
  }
  if (!sel.length) { fmInfo('Выберите файл или папку'); return; }
  const real = sel.filter(Boolean);
  const count = real.length;
  let ok = 0;
  (async () => {
    for (const el of real) {
      const p = el.dataset.path;
      const isDir = el.dataset.isdir === '1';
      if (!p) continue;
      const done = isDir ? await fmCacheFolder(p) : await fmCacheOneFile(p, true);
      if (done) ok++;
    }
    fmInfo('💾 В кеш сохранено: ' + ok + ' из ' + count + (HubOffline && HubOffline.isOffline ? ' (офлайн)' : ''));
  })();
}
async function fmCacheOneFile(p, force) {
  const key = fmBackend + '|' + p;
  if (!force) {
    const ex = await fsCacheGetBlob(key);
    if (ex && ex.blob) return true;
  }
  try {
    const res = await fetch('/api/fs/download?backend=' + fmBackend + '&path=' + encodeURIComponent(p));
    if (!res.ok) return false;
    const blob = await res.blob();
    if (!blob || !blob.size) return false;
    await fsCachePutBlob(key, blob);
    return true;
  } catch (e) { return false; }
}
async function fmCacheFolder(p) {
  // Рекурсивный обход папки с лимитом, чтобы не забить устройство.
  const MAX = 40 * 1024 * 1024;
  let total = 0, files = [];
  const walk = async (dir) => {
    if (total > MAX) return;
    const r = await fetch('/api/browse?backend=' + fmBackend + '&path=' + encodeURIComponent(dir)).then(r => r.json()).catch(() => null);
    if (!r || !r.success) return;
    fsCachePutList(fmBackend + '|' + dir, r);
    for (const it of (r.items || [])) {
      if (total > MAX) return;
      if (it.isDir) await walk(it.path);
      else files.push(it.path);
    }
  };
  await walk(p);
  let saved = 0;
  for (const f of files) {
    if (total > MAX) break;
    const b = await (async () => { try { const r = await fetch('/api/fs/download?backend=' + fmBackend + '&path=' + encodeURIComponent(f)); if (!r.ok) return null; const x = await r.blob(); total += x.size; return x; } catch (e) { return null; } })();
    if (b && b.size) { await fsCachePutBlob(fmBackend + '|' + f, b); saved++; }
  }
  return files.length ? saved > 0 : true;
}
// Скачивание: если сервер жив — как обычно, идущее мимо кеша содержимое
// параллельно сохраняем в IndexedDB. Если офлайн — берём блоб из кеша.
function fmDownload() {
  if (!fmSelected) return;
  const url = `/api/fs/download?backend=${fmBackend}&path=${encodeURIComponent(fmSelected)}`;
  const name = String(fmSelected).split(/[/\\]/).pop();
  if (HubOffline && HubOffline.isOffline) {
    fsCacheGetBlob(fmBackend + '|' + fmSelected).then(rec => {
      if (rec && rec.blob) { fmSaveBlob(rec.blob, name); fmInfo('🧊 Из кеша: ' + name); }
      else fmInfo('Нет связи и файла в кеше');
    });
    return;
  }
  window.open(url);
  fmWarm(fmSelected); // тёплая загрузка в фоне (в пределах разумного размера)
}
function fmSaveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

// Авто-кеш при открытии/скачивании: только файлы, у которых известен размер
// и он в разумных пределах (≤ 50 МБ). Гигабайтные видео в фоне не качаем.
const FM_WARM_MAX = 50 * 1024 * 1024;
function fmWarm(filePath) {
  const item = [...document.querySelectorAll('#fm-list .fm-item')]
    .find(e => e.dataset.path === filePath);
  const size = item ? (parseInt(item.dataset.size, 10) || 0) : 0;
  if (!size || size > FM_WARM_MAX) return;
  fmCacheOneFile(filePath, false);
}

// Открыть выбранный файл в новой вкладке: браузер сам покажет любой формат
// (картинка, PDF, видео, аудио, HTML, JSON, код) через inline-отдачу.
function fmOpenView() {
  if (!fmSelected) return;
  const list = document.querySelectorAll('#fm-list .fm-item.fm-sel');
  if (list.length > 1) { fmInfo('Выберите один файл для просмотра во вкладке.'); return; }
  const item = [...document.querySelectorAll('#fm-list .fm-item.fm-sel')]
    .find(el => el.dataset.path === fmSelected);
  if (item && item.dataset.isdir === '1') { fmInfo('Это папка — для просмотра выберите файл.'); return; }
  const url = `/api/fs/view?backend=${encodeURIComponent(fmBackend)}&path=${encodeURIComponent(fmSelected)}`;
  if (HubOffline && HubOffline.isOffline) {
    fsCacheGetBlob(fmBackend + '|' + fmSelected).then(rec => {
      if (rec && rec.blob) {
        const name = String(fmSelected).split(/[/\\]/).pop();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(rec.blob);
        a.download = name;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        fmInfo('🧊 Показан из кеша: ' + name);
      } else {
        fmInfo('Нет связи и файла в кеше — откройте вкладку при онлайн-доступе');
      }
    });
    return;
  }
  fmWarm(fmSelected); // тёплая загрузка в кеш в фоне
  window.open(url, '_blank', 'noopener');
}

function fmArchive() {
  if (!fmSelected) return;
  const item = [...document.querySelectorAll('#fm-list .fm-item.fm-sel')]
    .find(el => el.dataset.path === fmSelected);
  // Do not wrap a selected APK/binary in tar.xz. Archives are for folders;
  // files use the binary-safe download endpoint with their original name.
  if (item && item.dataset.isdir !== '1') return fmDownload();
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

// ─── UPLOAD ───
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