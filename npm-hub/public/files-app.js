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

// ─── Встроенный просмотр/редактор файла ───
// Вместо открытия во вкладке браузера: текст — как блокнот (с сохранением на
// сервер), картинки/видео/аудио/PDF — просмотр внутри панели. Работает и
// офлайн: если сервер недоступен, берём блоб из кеша (IndexedDB).
const FM_TEXT_MAX = 4 * 1024 * 1024;
function fmViewKind(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'bin';
  if (/\.png$|\.jpe?g$|\.gif$|\.webp$|\.svg$|\.bmp$|\.ico$|\.avif$|\.heic$/.test(n)) return 'image';
  if (/\.mp4$|\.webm$|\.mov$|\.m4v$|\.mkv$|\.avi$|\.ogv$/.test(n)) return 'video';
  if (/\.mp3$|\.wav$|\.ogg$|\.oga$|\.flac$|\.m4a$|\.aac$|\.opus$/.test(n)) return 'audio';
  if (/\.pdf$/.test(n)) return 'pdf';
  if (/^(makefile|dockerfile|gemfile|rakefile|vagrantfile|license|readme|copying)$/.test(n)) return 'text';
  if (/\.(txt|md|markdown|json|jsonc|ya?ml|toml|xml|js|jsx|mjs|cjs|mts|cts|ts|tsx|css|scss|less|sass|html?|vue|php|py|sh|bash|zsh|fish|rb|pl|lua|go|rs|java|kt|kts|swift|c|cc|cpp|h|hh|hpp|cs|sql|graphql|conf|ini|cfg|log|env|gitignore|dockerfile|makefile|cmake|gradle|properties|csv|tsv|bat|cmd|ps1|vim|editorconfig)$/.test(n)) return 'text';
  return 'bin';
}
let fmViewEl = null, fmViewUrl = null;
function fmViewClose() {
  if (fmViewUrl) { try { URL.revokeObjectURL(fmViewUrl); } catch (e) {} fmViewUrl = null; }
  if (fmViewEl) { fmViewEl.remove(); fmViewEl = null; }
}
const FM_SNIFF_MAX = 64 * 1024;
function fmSniffKind(u8) {
  if (!u8 || u8.length < 12) return null;
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 'image';
  if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'image';
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return 'image';
  if (u8[0] === 0x42 && u8[1] === 0x4D) return 'image';
  if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';
  if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return 'video';
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return 'audio';
  if (u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07)) return 'zip';
  return null;
}
function fmHexDump(u8) {
  const lim = Math.min(u8.byteLength, FM_SNIFF_MAX);
  const out = [];
  for (let i = 0; i < lim; i += 16) {
    const row = [String(i).padStart(8, '0') + '  '];
    const asc = [];
    for (let j = i; j < i + 16 && j < lim; j++) {
      row.push((u8[j] < 16 ? '0' : '') + u8[j].toString(16));
      asc.push(u8[j] >= 32 && u8[j] <= 126 ? String.fromCharCode(u8[j]) : '.');
    }
    out.push(row.join(' ').padEnd(61) + ' |' + asc.join('') + '|');
  }
  if (lim < u8.byteLength) out.push('… показаны первые ' + Math.round(FM_SNIFF_MAX / 1024) + ' КБ из ' + u8.byteLength + ' байт');
  return out.join('\n');
}
function fmLooksBinary(text) {
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(String(text || '').slice(0, 4096));
}
async function fmViewSniff(blob) {
  try { return fmSniffKind(new Uint8Array(await blob.slice(0, 256).arrayBuffer())); } catch (e) { return null; }
}
function fmViewBody(kind) {
  if (kind === 'image') return '<div style="flex:1;overflow:auto;display:flex"><img src="' + fmViewUrl + '" alt="" style="margin:auto;max-width:100%;max-height:100%"></div>';
  if (kind === 'video') return '<div style="flex:1;overflow:auto;display:flex;background:#000"><video src="' + fmViewUrl + '" controls autoplay style="margin:auto;max-width:100%;max-height:100%"></video></div>';
  if (kind === 'audio') return '<div style="padding:44px 16px"><audio src="' + fmViewUrl + '" controls autoplay style="width:100%"></audio></div>';
  if (kind === 'pdf') return '<iframe src="' + fmViewUrl + '" style="flex:1;width:100%;border:0;background:#fff"></iframe>';
  return '';
}
function fmViewBig(p, name) {
  fmViewClose();
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.82);display:flex;flex-direction:column;font:14px/1.4 system-ui,Roboto,sans-serif';
  ov.onclick = (e) => { if (e.target === ov) fmViewClose(); };
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0a0a0f;border-bottom:1px solid var(--bdr)';
  const t = document.createElement('div');
  t.style.cssText = 'flex:1;font-size:13px;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  t.textContent = name;
  head.appendChild(t);
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'btn';
    b.onclick = fn;
    head.appendChild(b);
    return b;
  };
  mk('⬇ Скачать', () => { window.open('/api/fs/download?backend=' + fmBackend + '&path=' + encodeURIComponent(p)); });
  mk('🪟 В браузере', () => { window.open('/api/fs/view?backend=' + fmBackend + '&path=' + encodeURIComponent(p), '_blank', 'noopener'); });
  mk('✖', fmViewClose);
  ov.appendChild(head);
  const msg = document.createElement('div');
  msg.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--t2)';
  msg.textContent = 'Файл больше 150 МБ — встроенный просмотр выключен. Используйте «⬇ Скачать» или «🪟 В браузере».';
  ov.appendChild(msg);
  document.body.appendChild(ov);
  fmViewEl = ov;
}
async function fmViewSave(p) {
  const ta = document.getElementById('fm-view-text');
  const btn = document.getElementById('fm-view-save');
  if (!ta) return;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await fetch('/api/fs/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: fmBackend, path: p, content: ta.value }) });
    const j = await r.json().catch(() => null);
    if (j && j.success) {
      try { fsCachePutBlob(fmBackend + '|' + p, new Blob([ta.value], { type: 'text/plain' })); } catch (e) {}
      if (btn) { btn.textContent = '✓ Сохранено'; setTimeout(() => { btn.textContent = '💾 Сохранить'; btn.disabled = false; }, 1400); }
      fmInfo('Сохранено: ' + String(p).split(/[/\\]/).pop());
    } else {
      if (btn) { btn.textContent = '💾 Сохранить'; btn.disabled = false; }
      fmInfo('Ошибка сохранения: ' + ((j && j.error) || 'сервер отказал'));
    }
  } catch (e) {
    if (btn) { btn.textContent = '💾 Сохранить'; btn.disabled = false; }
    fmInfo('Нет связи — сохранить не удалось');
  }
}
async function fmViewOpen(p, name, kind) {
  let blob = null, fromCache = false;
  try {
    const r = await fetch('/api/fs/download?backend=' + fmBackend + '&path=' + encodeURIComponent(p));
    if (r.ok) {
      if (kind === 'bin' && +(r.headers.get('Content-Length') || '0') > 150 * 1024 * 1024) { fmViewBig(p, name); return; }
      blob = await r.blob();
    }
  } catch (e) {}
  if (!blob) {
    const rec = await fsCacheGetBlob(fmBackend + '|' + p);
    if (rec && rec.blob) { blob = rec.blob; fromCache = true; }
  }
  if (!blob) { fmInfo('Нет связи и файла в кеше — нечего показать'); return; }
  if (kind === 'bin') {
    const sn = await fmViewSniff(blob);
    if (sn) kind = sn;
  }
  if (!fromCache && blob.size > 0 && blob.size <= FM_WARM_MAX) {
    try { fsCachePutBlob(fmBackend + '|' + p, blob); } catch (e) {}
  }
  fmViewClose();
  const media = kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf';
  const isText = kind === 'text' || kind === 'bin' || kind === 'zip';
  const tooBig = isText && blob.size > FM_TEXT_MAX;
  let text = '';
  if (isText && !tooBig) { try { text = await blob.text(); } catch (e) { text = ''; } }
  const looksBin = isText && fmLooksBinary(text);
  let binNote = null;
  if (kind === 'zip') binNote = 'Это ZIP/APK-архив — встроенного распаковщика нет, используйте «⬇ Скачать».';
  else if (kind === 'bin' && looksBin) binNote = 'Двоичный файл — текст ниже может быть «кашей». Вкладка «Hex» показывает сырые байты.';
  let editable = !tooBig && kind === 'text' && !looksBin;
  let mode = media ? 'view' : (kind === 'text' ? 'editor' : 'hex');
  const tabs = media ? [['view', 'Просмотр'], ['hex', 'Hex']]
    : (kind === 'text' ? [['editor', '✎ Редактор'], ['hex', 'Hex']] : [['text', 'Текст'], ['hex', 'Hex']]);
  const u8 = new Uint8Array(await blob.slice(0, FM_SNIFF_MAX).arrayBuffer());
  const ov = document.createElement('div');
  ov.id = 'fm-view-ov';
  ov.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.82);display:flex;flex-direction:column;font:14px/1.4 system-ui,Roboto,sans-serif';
  ov.onclick = (e) => { if (e.target === ov) fmViewClose(); };
  const head = document.createElement('div');
  head.style.cssText = 'flex:0 0 auto;background:#0a0a0f;border-bottom:1px solid var(--bdr)';
  const row1 = document.createElement('div');
  row1.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px';
  const title = document.createElement('div');
  title.style.cssText = 'flex:1;font-size:13px;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  title.textContent = name + (fromCache ? '  🧊 из кеша' : '');
  row1.appendChild(title);
  const mk = (label, cls, id, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'btn' + (cls ? ' ' + cls : '');
    if (id) b.id = id;
    b.onclick = fn;
    row1.appendChild(b);
    return b;
  };
  const saveBtn = mk('💾 Сохранить', 'btn-p', 'fm-view-save', () => fmViewSave(p));
  saveBtn.style.display = 'none';
  mk('⬇ Скачать', '', '', () => { fmSaveBlob(blob, name); });
  mk('🪟 В браузере', '', '', () => { window.open('/api/fs/view?backend=' + encodeURIComponent(fmBackend) + '&path=' + encodeURIComponent(p), '_blank', 'noopener'); });
  const forceBtn = mk('✎ Редактор', '', '', () => {
    mode = 'text';
    editable = true;
    if (note) note.style.display = 'none';
    forceBtn.style.display = 'none';
    saveBtn.style.display = '';
    renderTabs();
    fmInfo('Редактор включён — текст можно менять и сохранять');
  });
  forceBtn.style.display = (kind === 'bin' || kind === 'zip') ? '' : 'none';
  mk('✖', '', '', fmViewClose);
  head.appendChild(row1);
  const tabRow = document.createElement('div');
  tabRow.style.cssText = 'display:flex;overflow-x:auto;padding:0 4px;touch-action:pan-x pan-y;overscroll-behavior:contain;-webkit-overflow-scrolling:touch';
  const tabBtns = {};
  tabs.forEach((arr) => {
    const b = document.createElement('button');
    b.textContent = arr[1];
    b.style.cssText = 'border:0;background:transparent;color:var(--t2);font:12px/1 system-ui,sans-serif;padding:9px 12px;cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent';
    b.onclick = () => { mode = arr[0]; renderTabs(); };
    tabRow.appendChild(b);
    tabBtns[arr[0]] = b;
  });
  const renderTabs = () => {
    Object.keys(tabBtns).forEach(m => {
      const on = m === mode;
      tabBtns[m].style.color = on ? 'var(--acc)' : 'var(--t2)';
      tabBtns[m].style.borderBottomColor = on ? 'var(--acc)' : 'transparent';
    });
    pView.style.display = mode === 'view' ? 'flex' : 'none';
    pText.style.display = (mode === 'editor' || mode === 'text') ? 'flex' : 'none';
    pHex.style.display = mode === 'hex' ? 'block' : 'none';
    saveBtn.style.display = ((mode === 'editor' || mode === 'text') && editable) ? '' : 'none';
  };
  head.appendChild(tabRow);
  ov.appendChild(head);
  const note = document.createElement('div');
  note.style.cssText = 'flex:0 0 auto;padding:8px 14px;font-size:12px;color:#ffb020;background:rgba(255,176,32,.08);border-bottom:1px solid var(--bdr)';
  note.style.display = binNote ? '' : 'none';
  note.textContent = binNote || '';
  ov.appendChild(note);
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column';
  const pView = document.createElement('div');
  pView.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column';
  pView.style.display = 'none';
  fmViewUrl = URL.createObjectURL(blob);
  pView.innerHTML = fmViewBody(kind);
  body.appendChild(pView);
  const pText = document.createElement('div');
  pText.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column';
  pText.style.display = 'none';
  const ta = document.createElement('textarea');
  ta.id = 'fm-view-text';
  ta.spellcheck = false;
  ta.readOnly = !editable;
  ta.value = tooBig ? 'Файл слишком большой для редактора (' + Math.round(blob.size / 1048576) + ' МБ). Используйте «⬇ Скачать».' : text;
  ta.style.cssText = 'flex:1;min-height:0;resize:none;background:var(--bg0);border:0;color:var(--t1);font:13px/1.5 monospace;padding:12px;outline:none';
  pText.appendChild(ta);
  body.appendChild(pText);
  const pHex = document.createElement('div');
  pHex.style.cssText = 'flex:1;overflow:auto;background:var(--bg0);overscroll-behavior:contain;touch-action:pan-y';
  pHex.style.display = 'none';
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;padding:12px;color:var(--t2);font:12px/1.5 monospace;white-space:pre';
  pre.textContent = fmHexDump(u8);
  pHex.appendChild(pre);
  body.appendChild(pHex);
  ov.appendChild(body);
  document.body.appendChild(ov);
  fmViewEl = ov;
  renderTabs();
}

// Открыть выбранный файл встроенным просмотрщиком-редактором: любые форматы
// (текст, медиа, PDF, неизвестные и двоичные) открываются внутри панели —
// кнопка «глаз» ничего не скачивает.
function fmOpenView() {
  if (!fmSelected) return;
  const list = document.querySelectorAll('#fm-list .fm-item.fm-sel');
  if (list.length > 1) { fmInfo('Выберите один файл для просмотра.'); return; }
  const item = [...document.querySelectorAll('#fm-list .fm-item.fm-sel')]
    .find(el => el.dataset.path === fmSelected);
  if (item && item.dataset.isdir === '1') { fmInfo('Это папка — для просмотра выберите файл.'); return; }
  const p = fmSelected;
  const name = String(p).split(/[/\\]/).pop();
  fmViewOpen(p, name, fmViewKind(name));
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