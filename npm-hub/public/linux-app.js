/* =========================================================================
 * linux-app.js — страница «Экран» (Linux VNC).
 * Просто экран: подключается сам, как только рабочий стол ответит.
 * Программы/браузер/файлы/звук — на самом рабочем столе.
 * ========================================================================= */

let linuxLastUrl = '';
let linuxPollTimer = null;

function pageInit() {
  linuxAutoConnect();
}

async function linuxStatus(prefix) {
  const pfx = prefix || '';
  const el = document.getElementById(pfx ? 'linux-status-desktop' : 'linux-status');
  try {
    if (el) { el.textContent = 'проверка…'; el.className = 'tag'; }
    const r = await fetch('/api/vnc/status');
    const d = await r.json();
    const ok = d.running && d.url;
    if (el) {
      el.textContent = ok ? '● запущен' : '○ выключен';
      el.className = 'tag ' + (ok ? 'tag-on' : 'tag-off');
    }
    return d;
  } catch (e) {
    if (el) { el.textContent = '? ошибка'; el.className = 'tag tag-off'; }
    return { running: false, url: null };
  }
}

async function linuxConnect(prefix) {
  const pfx = prefix || '';
  const d = await linuxStatus(pfx);
  if (!d.url) { linuxStatus(pfx); return; }
  const frame = document.getElementById(pfx ? 'linux-frame-desktop' : 'linux-frame');
  const ph = document.getElementById(pfx ? 'linux-placeholder-desktop' : 'linux-placeholder');
  frame.src = d.url;
  frame.style.display = 'block';
  if (ph) ph.style.display = 'none';
}

function linuxFullscreen(prefix) {
  const pfx = prefix || '';
  const frame = document.getElementById(pfx ? 'linux-frame-desktop' : 'linux-frame');
  if (frame.requestFullscreen) frame.requestFullscreen();
  else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
}

// Авто-подключение: экран подключается, как только Linux-десктоп ответит,
// и продолжает опрашивать, пока тот не поднялся (job стартует его при первом запуске).
async function linuxAutoConnect(force) {
  const frame = document.getElementById('linux-frame-desktop');
  if (!frame) return;
  const ph = document.getElementById('linux-placeholder-desktop');
  const d = await linuxStatus('desktop');
  const el = document.getElementById('linux-status-desktop');
  if (el) {
    el.textContent = d.url ? '● работает' : '○ запускается…';
    el.className = 'tag ' + (d.url ? 'tag-on' : 'tag-off');
  }
  if (d.url && (force || d.url !== linuxLastUrl)) {
    linuxLastUrl = d.url;
    frame.src = '';
    frame.src = d.url;
    frame.style.display = 'block';
    if (ph) ph.style.display = 'none';
    return;
  }
  if (!d.url) {
    frame.style.display = 'none';
    if (ph) ph.style.display = 'flex';
    if (linuxPollTimer) clearTimeout(linuxPollTimer);
    linuxPollTimer = setTimeout(() => linuxAutoConnect(), 8000);
  }
}

async function linuxReload() {
  const frame = document.getElementById('linux-frame-desktop');
  if (frame) { frame.src = ''; frame.style.display = 'block'; }
  linuxLastUrl = '';
  await linuxAutoConnect(true);
}