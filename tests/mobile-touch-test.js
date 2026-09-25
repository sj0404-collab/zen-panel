// Stage Q: phone taps + touch scroll + default work folder. Plain node,
// no deps — greps the original-based files for the exact fixes.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/src/server.js'), 'utf8');
const mob = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile-app.js'), 'utf8');
const desk = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/desktop-app.js'), 'utf8');
const remoteAudio = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/remote-audio.js'), 'utf8');
const mgr = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/src/storage/manager.js'), 'utf8');
const mobHtml = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile.html'), 'utf8');
const deskHtml = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/desktop.html'), 'utf8');
const keep = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/src/vnc-keepalive.js'), 'utf8');
const startDesktop = fs.readFileSync(path.join(__dirname, '..', 'tools/start_desktop.sh'), 'utf8');
const mainKt = fs.readFileSync(path.join(__dirname, '..', 'hub/src/main/java/dev/zen/hub/MainActivity.kt'), 'utf8');
const panelKt = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/java/dev/zen/panel/MainActivity.kt'), 'utf8');
const hubWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/hub.yml'), 'utf8');
const agentWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/agent.yml'), 'utf8');
const opencodeWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/opencode.yml'), 'utf8');
const desksWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/desks.yml'), 'utf8');
const snapshotAudit = fs.readFileSync(path.join(__dirname, '..', 'tools/snapshot-audit-code.sh'), 'utf8');
const publishSession = fs.readFileSync(path.join(__dirname, '..', 'tools/publish_session.sh'), 'utf8');
const backupWork = fs.readFileSync(path.join(__dirname, '..', 'tools/backup-work.sh'), 'utf8');
const restoreWork = fs.readFileSync(path.join(__dirname, '..', 'tools/restore-work.sh'), 'utf8');
const exportChats = fs.readFileSync(path.join(__dirname, '..', 'tools/export-chats.sh'), 'utf8');
const restoreChats = fs.readFileSync(path.join(__dirname, '..', 'tools/restore-chats.sh'), 'utf8');
const filesApp = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/files-app.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

// q1: every terminal/arrow button re-fires its own onclick on touchend
// (the original had bare preventDefault = dead buttons on phones).
const btns = [...html.matchAll(/<button[^>]*class="(?:tc-btn|arr-btn)[^"]*"[^>]*>/g)];
const paired = btns.filter(b => {
  const oc = (b[0].match(/onclick="([^"]+)"/) || [])[1];
  const ot = (b[0].match(/ontouchend="([^"]+)"/) || [])[1];
  return oc && ot && ot === 'event.preventDefault();' + oc;
});
check('q1 touchend re-fires onclick', btns.length === 16 && paired.length === 16,
  `${paired.length}/${btns.length}`);

// q2: no dead preventDefault-only handlers left.
check('q2 no bare preventDefault', !/ontouchend="event\.preventDefault\(\)"/.test(html));

// q3: long-press menu suppressed on terminal buttons.
check('q3 contextmenu guard', (html.match(/oncontextmenu="event\.preventDefault\(\)"/g) || []).length === 16);

// q4: terminal scrolls by touch swipe.
check('q4 viewport touch-action', html.includes('.term .xterm-viewport{touch-action:pan-x pan-y!important}'));

// q5: buttons don't select text / call out on touch.
check('q5 no-select css', html.includes('.tc-btn,.arr-btn{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}'));

// q6: server defines the work folder and creates it on boot.
check('q6 server workdir', server.includes("path.join(HOME, 'hub-work')") &&
  server.includes('fs.mkdirSync(WORK_DIR, { recursive: true })'));

// q7: /api/info exposes it.
check('q7 info exposes workDir', /workDir:\s*WORK_DIR/.test(server));

// q8: both file managers boot into the work folder.
check('q8 fm boots to workdir', mob.includes('fmBrowse(workDir || homeDir)') &&
  desk.includes('fmBrowse(workDir || homeDir)') &&
  mob.includes('if (infoR.workDir) workDir = infoR.workDir;') &&
  desk.includes('if (infoR.workDir) workDir = infoR.workDir;'));

// q9: hub-work is first in the devices list.
check('q9 workdir first device', /devices\.push\(\{ type: 'local', id: path\.join\(HOME, 'hub-work'\), name: 'hub-work'/.test(mgr));

// q10: the runner's start step waits for `"warming":false` in /api/tools
// (hub.yml, linux+windows). The original response lacked it: the run failed
// with "the hub did not start" and the site never came up.
check('q10 tools report warming:false', server.includes('warming: false') &&
  server.includes("runId: process.env.GITHUB_RUN_ID"));

// q11: the full tool registry is present; tools without npm installers use their native setup.
check('q11 installable agents', (server.slice(server.indexOf('const TOOLS = ['), server.indexOf('const storage =')).match(/\{ id: '/g) || []).length >= 14,
  (server.slice(server.indexOf('const TOOLS = ['), server.indexOf('const storage =')).match(/\{ id: '/g) || []).length);

// q12: install endpoints exist.
check('q12 install endpoints', server.includes("app.post('/api/tools/install'") &&
  server.includes("app.get('/api/tools/install-status'"));

// q13: mobile cards show the download button + live-log overlay code.
check('q13 mobile install ui', mob.includes('installTool(') && mob.includes('Скачать') &&
  mob.includes('install-ov') && mob.includes('/api/tools/install-status'));

// q14: same for desktop.
check('q14 desktop install ui', desk.includes('installTool(') && desk.includes('Скачать') &&
  desk.includes('install-ov') && desk.includes('/api/tools/install-status'));

// q15: Files tab works without system dialogs (dead in some WebViews).
check('q15 mobile no system dialogs', !/prompt\('/.test(mob) && !/confirm\('/.test(mob) && !/alert\('/.test(mob));

// q16: same for desktop.
check('q16 desktop no system dialogs', !/prompt\('/.test(desk) && !/confirm\('/.test(desk) && !/alert\('/.test(desk));

// q17: tap-to-enter folders (dblclick is dead on phones).
check('q17 tap to enter', mob.includes('function fmTap(') && desk.includes('function fmTap(') &&
  (mob.includes('data-isdir=') || mob.includes('dataset.isdir') || mob.includes("setAttribute('data-isdir'")) &&
  (desk.includes('data-isdir=') || desk.includes('dataset.isdir') || desk.includes("setAttribute('data-isdir'")) &&
  !/ondblclick/.test(mob) && !/ondblclick/.test(desk));

// q18: create-file button exists in both UIs.
check('q18 create file', mob.includes('function fmCreateFile(') && desk.includes('function fmCreateFile(') &&
  mobHtml.includes('fmCreateFile()') && deskHtml.includes('fmCreateFile()'));

// q19: APK opens the system file picker for uploads.
check('q19 apk file chooser', mainKt.includes('onShowFileChooser') && mainKt.includes('ActivityResultContracts'));

// q20: APK hands downloads to the system DownloadManager.
check('q20 apk downloads', mainKt.includes('setDownloadListener') && mainKt.includes('DownloadManager'));

// q21: paste falls back to the manual box when the clipboard API is blocked.
check('q21 paste fallback', mob.includes('await clipBox(') && desk.includes('await clipBox(') &&
  mob.includes('clipboard.readText') && desk.includes('clipboard.readText'));

// q22: copy grabs selection or the last screen lines.
check('q22 copy source', mob.includes('function copySelection(') && desk.includes('function copySelection(') &&
  mob.includes('term.buffer.active') && desk.includes('term.buffer.active') &&
  mob.includes('clipboard.writeText') && desk.includes('clipboard.writeText'));

// q23: copy buttons in both toolbars (touch handler on mobile).
check('q23 copy buttons', mobHtml.includes('onclick="copySelection()" ontouchend="event.preventDefault();copySelection()"') &&
  deskHtml.includes('onclick="copySelection()"'));

// q24: textarea clip box builder in both clients.
check('q24 clip box', mob.includes('function clipBox(') && desk.includes('function clipBox(') &&
  mob.includes('clip-ov') && desk.includes('clip-ov'));

// q25: every inline tap handler is actually defined (the dead-button audit).
(function () {
  const builtin = new Set(('if,for,while,switch,catch,function,return,setTimeout,setInterval,' +
    'clearTimeout,clearInterval,fetch,parseInt,parseFloat,encodeURIComponent,' +
    'decodeURIComponent,event,this,open,close,focus,blur,select,WebSocket,Terminal,' +
    'FitAddon,WebLinksAddon,FormData,FileReader,Blob,URL,localStorage,sessionStorage,' +
    'navigator,location,document,window,console,Error,Promise,requestFullscreen,' +
    'exitFullscreen,isNaN,isFinite,Math,Date,Object,Array,String,Number,JSON').split(','));
  let bad = [];
  for (const [js, ht, tag] of [[mob, mobHtml, 'mob'], [desk, deskHtml, 'desk']]) {
    const calls = new Set();
    for (const src of [js, ht]) {
      const re = /on(?:click|touchend|touchstart|touchmove|keydown|keyup|input|change|submit|focus)\s*=\s*"([^"]*)"/g;
      let m;
      while ((m = re.exec(src))) {
        const re2 = /(?<![\w$.])([A-Za-z_]\w*)\s*\(/g;
        let c;
        while ((c = re2.exec(m[1]))) calls.add(c[1]);
      }
    }
    const defs = new Set();
    for (const mm of js.matchAll(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/g)) defs.add(mm[1]);
    for (const mm of js.matchAll(/(?:const|let|var)\s+([A-Za-z_]\w*)\s*=/g)) defs.add(mm[1]);
    for (const c of calls) {
      if (!c.startsWith('on') && !builtin.has(c) && !defs.has(c)) bad.push(tag + ':' + c);
    }
  }
  check('q25 all tap handlers defined', bad.length === 0, bad.join(','));
})();

// q26: the server never spawns a terminal in a missing folder.
check('q26 pty cwd validated', server.includes('fs.statSync(cwd).isDirectory()'));

// q27: no baked-in Windows home to poison other machines.
check('q27 no baked home', !/C:[\\/]+Users[\\/]+virus/.test(mob) && !/C:[\\/]+Users[\\/]+virus/.test(desk));

// q28: desktop folder picker exists (was 3 dead buttons).
check('q28 desktop browser funcs', desk.includes('function openBrowser(') && desk.includes('function browseTo(') &&
  desk.includes('function browserTap(') && desk.includes('function selectBrowserPath('));

// q29: dashboard rebuild keeps typed folder paths.
check('q29 dir inputs preserved', mob.includes('dirStash') && desk.includes('dirStash'));

// q30: runner API on the server — scan/backup/stop/restart + binary upload.
check('q30 runner endpoints', server.includes("app.get('/api/runner'") &&
  server.includes("app.post('/api/runner/backup'") &&
  server.includes("app.post('/api/runner/stop'") &&
  server.includes("app.post('/api/runner/restart'"));
check('q30b upload binary-safe', server.includes("req.query.path") &&
  server.includes('upload.single') === false);

// q31: WS keepalive handled by the server (ping → pong).
check('q31 server ws ping', server.includes("case 'ping'") && server.includes("type: 'pong'"));

// q32: runner card + controls in both UIs.
check('q32 runner ui', mobHtml.includes('id="runner-card"') && deskHtml.includes('id="runner-card"') &&
  mob.includes('async function runnerScan(') && desk.includes('async function runnerScan(') &&
  mob.includes('async function runnerSave(') && desk.includes('async function runnerSave(') &&
  mob.includes('async function runnerStop(') && desk.includes('async function runnerStop(') &&
  mob.includes('async function runnerRestart(') && desk.includes('async function runnerRestart('));

// q33: client heartbeat (ping/pong) + instant reconnect on tab return.
check('q33 keepalive', mob.includes("type: 'ping'") && desk.includes("type: 'ping'") &&
  mob.includes('lastPong') && desk.includes('lastPong') &&
  mob.includes('function kickReconnect(') && desk.includes('function kickReconnect(') &&
  mob.includes("visibilitychange") && desk.includes("visibilitychange"));

// q34: uploads go through the binary /api/fs/upload (no more file.text()).
check('q34 binary upload client', mob.includes("/api/fs/upload?path='") && desk.includes("/api/fs/upload?path='") &&
  !mob.includes("const content = await file.text()") && !desk.includes("const content = await file.text()"));

// q34a: a browser omits Content-Type when File.type is empty (Android SAF pick,
// drag&drop from some apps, unknown extension), and body-parser's type-is then
// refuses to match '*/*' — the raw body stayed unparsed and the old
// String(req.body) fallback wrote the 15-byte text "[object Object]" while still
// answering success:true. Parse any body and refuse to stringify a non-Buffer.
check('q34a upload parses body without Content-Type',
  server.includes("express.raw({ type: () => true") &&
  !server.includes("Buffer.from(String(req.body") &&
  server.includes('if (!Buffer.isBuffer(req.body)) return res.json({ success: false'));

// q34f: clients name the MIME type explicitly so the request is never headless.
check('q34f upload sends explicit content type',
  filesApp.includes("'Content-Type': f.type || 'application/octet-stream'") &&
  desk.includes("'Content-Type': f.type || 'application/octet-stream'") &&
  mob.includes("xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')"));

// q34b: folder upload (webkitdirectory) on desktop, mobile note "not in APK".
check('q34b folder upload', mob.includes('function fmUploadFolder(') && desk.includes('function fmUploadFolder(') &&
  desk.includes('webkitdirectory') && mob.includes('webkitdirectory'));

// q34c: desktop drag-and-drop zone for files + folders (webkitGetAsEntry).
check('q34c dropzone', desk.includes('function setupDropZone(') && desk.includes('webkitGetAsEntry') &&
  deskHtml.includes('Перетащи файлы'));

// q34d: fmUpload no longer blocks on a pre-info modal (kept synchronous for
// Chromium's user-gesture requirement).
const mobUploadFn = mob.slice(mob.indexOf('async function fmUpload'), mob.indexOf('function fmUploadFolder'));
const deskUploadFn = desk.slice(desk.indexOf('function fmUpload'), desk.indexOf('function fmUploadFolder'));
const deskPick = desk.slice(desk.indexOf('function pickFiles'), desk.indexOf('function fmUpload'));
check('q34d upload sync', !mobUploadFn.includes('await fmInfo') && !deskUploadFn.includes('await fmInfo') &&
  mobUploadFn.includes('input.click()') && deskPick.includes('input.click()'));

// q34e: html shows both buttons + tip hint.
check('q34e html buttons', mobHtml.includes('fmUploadFolder()') && deskHtml.includes('fmUploadFolder()') &&
  deskHtml.includes('⬆📁'));

// q35: the panel gets its own runner card + rerun + SAF in its APK shell.
const panel = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/panel/index.html'), 'utf8');
check('q35 panel runner', panel.includes('id="runner-card-panel"') &&
  panel.includes('async function runnerPanelScan(') &&
  panel.includes('async function runnerPanelSave(') &&
  panel.includes('async function runnerPanelRestart(') &&
  panel.includes('async function runnerPanelStop(') &&
  panel.includes('async function rerunRun('));
check('q35b panel rerun link', panel.includes('onclick="rerunRun('));
check('q35c panel apk file chooser', panelKt.includes('onShowFileChooser') &&
  panelKt.includes('ActivityResultContracts') && panelKt.includes('filePicker.launch'));

// q36: cloud-phone last URL is saved and restored (cp.lastUrl, not the stale
// cp.server key) in both clients.
check('q36 cp lastUrl restore', mob.includes("localStorage.setItem('cp.lastUrl'") &&
  mob.includes("localStorage.getItem('cp.lastUrl')") &&
  !/cp\.server/.test(mob) &&
  desk.includes("localStorage.setItem('cp.lastUrl'") &&
  desk.includes("localStorage.getItem('cp.lastUrl')"));

// q37: Linux desktop VNC is wired end-to-end: server endpoint + remote status
// reader, page + nav in both UIs, connect handlers in both clients.
check('q37 vnc endpoint', server.includes("app.get('/api/vnc/status'") &&
  server.includes('session-vnc.json') &&
  server.includes('vncRemoteStatus('));
check('q37b vnc server route', server.includes("app.get('/desktop-vnc'"));
check('q37c vnc publish slot', fs.readFileSync(path.join(__dirname, '..', 'tools/publish_session.sh'), 'utf8')
  .includes('slot=vnc)      FILE="session-vnc.json"'));
// Контракт изменился (требование владельца: «всё время включённым, а не
// подключаться каждый раз»): кнопки «подключиться» в разметке НЕТ, экран
// поднимает сам хаб и кадр подключается автоподключением. Поэтому проверяем
// не кнопку, а отсутствие ручного шага + наличие автоподключения.
check('q37d vnc mobile ui', mobHtml.includes('id="p-linux"') &&
  mobHtml.includes('id="nav-linux"') &&
  mobHtml.includes('onclick="linuxOpen()"') &&
  mobHtml.includes('onclick="linuxFullscreen()"') &&
  !mobHtml.includes('linuxConnect()') &&
  mob.includes('function linuxConnect(') && mob.includes('function linuxStatus(') &&
  mob.includes('autoconnect=true'));
check('q37e vnc desktop ui', deskHtml.includes('id="p-linux"') &&
  deskHtml.includes('onclick="showPage(\'linux\')"') &&
  deskHtml.includes("linuxFullscreen('desktop')") &&
  deskHtml.includes('id="linux-frame-desktop"') &&
  desk.includes("linuxConnect('desktop')") &&
  desk.includes('function linuxConnect(') && desk.includes('function linuxStatus(') &&
  desk.includes('autoconnect=true'));
check('q37f vnc workflow', /job|vnc:/.test(fs.readFileSync(path.join(__dirname, '..', '.github/workflows/hub.yml'), 'utf8')) &&
  fs.readFileSync(path.join(__dirname, '..', '.github/workflows/hub.yml'), 'utf8').includes('start_desktop.sh') &&
  fs.readFileSync(path.join(__dirname, '..', '.github/workflows/hub.yml'), 'utf8').includes('slot=vnc'));


// q38: touch on the terminal — tap types, long-press selects (user bug
// «каждый тап бесконечно копирует весь текст при запуске клавиатуры»).
// (a) никакой копировки по удержанию/контекстному меню
check('q38a no copy on touch', !/holdTimer\s*=\s*setTimeout\([^)]*copySelection/.test(mob) &&
  !/holdTimer\s*=\s*setTimeout\([^)]*copySelection/.test(desk) &&
  !/onContext\s*=\s*\(e\)\s*=>\s*\{[^}]*copySelection\(/.test(mob) &&
  !/onContext\s*=\s*\(e\)\s*=>\s*\{[^}]*copySelection\(/.test(desk));
// (b) тап возвращает фокус (клавиатура) и НЕ прячет её на старте касания
check('q38b tap focuses', /function setupTermTouch/.test(mob) &&
  /term\.focus\(\)/.test(mob.slice(mob.indexOf('function setupTermTouch'), mob.indexOf('async function createTerm'))) &&
  /term\.focus\(\)/.test(desk.slice(desk.indexOf('function setupTermTouch'), desk.indexOf('async function createTerm'))) &&
  !/const onStart = \(e\) => \{[\s\S]{0,400}?term\.blur\(\)/.test(mob.slice(mob.indexOf('function setupTermTouch'), mob.indexOf('async function createTerm'))));
// (c) удержание выделяет слово под пальцем, протяжка расширяет по строкам
check('q38c hold selects', mob.includes('function termSelectWordAt(') && desk.includes('function termSelectWordAt(') &&
  mob.includes('term.select(') && mob.includes('term.selectLines(') && mob.includes('function termCellAt('));
// (d) без выделения НЕ копируем последние 200 строк — только подсказка
check('q38d no silent full-buffer copy', !mob.includes('buf.length - 200') && !desk.includes('buf.length - 200') &&
  mob.includes('Сначала выдели текст') && desk.includes('Сначала выдели текст'));
// (e) выделение чистого текста работает: никакого preventDefault на старте тапа,
//     который убивает нативное выделение страницы
const mobTouch = mob.slice(mob.indexOf('function setupTermTouch'), mob.indexOf('async function createTerm'));
check('q38e native selection alive', mobTouch.includes("addEventListener('touchstart', onStart, { passive: true })") &&
  mob.includes('function termSelectWordAt') && mob.includes('term.select('));

// q39: «наложение» на Экране — иконки рабочего стола всплывали ПОВЕРХ окна
// браузера (жалоба 19.09: контент страницы смешан с иконками стола).
// Лечение: иконки idesk (окна override-redirect, WM их не переставляет)
// опускаются под окна приложений — при старте стола, при лечении keepalive,
// раз в 30 с и сразу после запуска приложения.
check('q39a icons lowered by keepalive', keep.includes('async function lowerDesktopIcons') &&
  /module\.exports = \{[^}]*lowerDesktopIcons/.test(keep) && keep.includes('tickCount % 2 === 0') &&
  /iconsRaised[\s\S]{0,120}lowerDesktopIcons/.test(keep));
check('q39b xwit installed by hub', keep.includes("['xwit', 'xwit']") &&
  startDesktop.includes('xwit') && startDesktop.includes('-lower'));
check('q39c launch lowers icons', (server.match(/require\('\.\/vnc-keepalive'\)\.lowerDesktopIcons/g) || []).length >= 2);


// q40: виртуальная мышь на «Экране» — сенсор, две кнопки, колесо стрелками
// (вместо «палец по картинке»: он закрывает то место, куда целишься).
check('q40a panel markup', (mobHtml.match(/id="linux-mouse"/g) || []).length === 1 &&
  (deskHtml.match(/id="linux-mouse"/g) || []).length === 1 &&
  mobHtml.includes('id="lm-pad"') && deskHtml.includes('id="lm-pad"') &&
  mobHtml.includes('id="lm-left"') && mobHtml.includes('id="lm-right"'));
check('q40b wheel arrows', ['up', 'down', 'left', 'right'].every((d) =>
  mobHtml.includes('data-dir="' + d + '"') && deskHtml.includes('data-dir="' + d + '"')) &&
  mobHtml.includes('vMouseWheelStart(\'up\')'));
check('q40c touchpad logic', mob.includes('function vMouseInitPad') && desk.includes('function vMouseInitPad') &&
  mob.includes('VMOUSE_SENS') && desk.includes('VMOUSE_SENS') &&
  mob.includes('pad.addEventListener(\'pointermove\'') && mob.includes('wasTap'));
check('q40d rfb pointer api', mob.includes('mouse: {') && desk.includes('mouse: {') &&
  mob.includes('r._sendMouse(p.x, p.y, mask | 0)') && desk.includes('r._sendMouse(p.x, p.y, mask | 0)') &&
  mob.includes('click(mask)') && mob.includes('wheel(mask)'));
check('q40e wheel masks', mob.includes('up: 8, down: 16, left: 32, right: 64') &&
  desk.includes('up: 8, down: 16, left: 32, right: 64'));
check('q40f follow cursor', mob.includes('_follow()') && desk.includes('_follow()') &&
  mob.includes('viewportChangePos') && desk.includes('viewportChangePos'));


// q41: читалка на «Экране» — /api/ocr и /api/screenshot падали с
// «_exec is not a function» (в модуле хелпер объявлен как `const { exec: _exec }`,
// а в OCR-хелпере его повторно доставали как `const {_exec}` — такого свойства
// у child_process нет). Проверяем, что такого дубля больше нет и что OCR-пакеты
// хаб ставит сам.
check('q41a ocr helper uses module exec', !server.includes('const {_exec} = require(') &&
  server.includes('const { exec: _exec } = require(') &&
  server.includes('const ocrRun = (cmd) => new Promise') &&
  server.includes('/api/screenshot'));
check('q41b hub installs tesseract', keep.includes("['tesseract', 'tesseract-ocr']") &&
  keep.includes("OCR_LANG_PKG = 'tesseract-ocr-rus'") && keep.includes('ocrLangMissing'));


// q42: файловый менеджер открывается без паразитного диалога pcmanfm
// «Desktop manager is not active» (idesk уже держит рабочий стол). Файлы на
// экране — через обёртку hub-files, плюс разовая уборка залипшего диалога.
check('q42a files launcher', keep.includes('FILES_LAUNCHER') && keep.includes('ensureFilesLauncher') &&
  keep.includes("exec: 'hub-files $HOME/hub-work'") &&
  (keep.match(/hub-files \$HOME\/hub-work/g) || []).length === 2 &&
  keep.includes('filesLauncher ? JSON.stringify(filesLauncher)'));
check('q42b dialogs cleaned', keep.includes('async function dismissStrayDialogs') &&
  /tickCount % 2 === 1\) await dismissStrayDialogs/.test(keep) &&
  server.includes('dismissStrayDialogs'));


// q43: звук видео — VNC сам звук не передаёт, поэтому PulseAudio идёт
// отдельным PCM-потоком в браузер телефона/десктопа.
check('q43a audio websocket bridge', server.includes('REMOTE DESKTOP AUDIO') &&
  server.includes("u.pathname !== '/ws/audio'") && server.includes('parec') &&
  server.includes('audioWss.handleUpgrade') && server.includes("'/ws/audio'"));
check('q43b PCM packets are coalesced', server.includes('AUDIO_PACKET = 8192') &&
  server.includes('pendingAudio') && server.includes('sendAudio(false)') &&
  server.includes("'--latency-msec=40'"));
check('q43c audio client decodes and schedules', mob.includes('function remoteAudioStart') &&
  desk.includes('function remoteAudioStart') && mob.includes('window.RemoteAudio') &&
  desk.includes('window.RemoteAudio') && remoteAudio.includes("'/ws/audio?codec='") &&
  remoteAudio.includes('createBufferSource') && remoteAudio.includes('AudioDecoder') &&
  remoteAudio.includes('opusHead') && remoteAudio.includes('const feed ='));
check('q43e opus negotiated end to end', server.includes("require('opusscript')") &&
  server.includes('OpusScript') && server.includes("codec === 'opus'") &&
  server.includes('const sendOpus') && server.includes('frameMs') &&
  remoteAudio.includes('EncodedAudioChunk') && remoteAudio.includes('f32-planar') &&
  remoteAudio.includes("codec: 'opus'"));
check('q43f shared player loaded before app', mobHtml.includes('src="remote-audio.js"') &&
  deskHtml.includes('src="remote-audio.js"') &&
  mobHtml.indexOf('remote-audio.js') < mobHtml.indexOf('mobile-app.js') &&
  deskHtml.indexOf('remote-audio.js') < deskHtml.indexOf('desktop-app.js'));
check('q43g audio scheduler never overlaps queued audio', remoteAudio.includes('const MAX_LEAD') &&
  remoteAudio.includes('state.dropped') && !remoteAudio.includes('too much backlog') &&
  remoteAudio.includes('state.nextTime - now > MAX_LEAD') && remoteAudio.includes('rs <= 1'));
check('q43d sound button and clean Pulse path', mobHtml.includes('remoteAudioToggle()') &&
  deskHtml.includes('remoteAudioToggle()') &&
  keep.includes("['parec', 'pulseaudio-utils']") && startDesktop.includes('pulseaudio-utils') &&
  server.includes('module-loopback') && server.includes('module-null-sink') &&
  server.includes('keptNull') && server.includes('unload-module') &&
  !server.includes('source=browser_youtube.monitor sink=auto_null'));


// q44: video launch prefers a codec-complete Google Chrome over a bare
// Chromium build; the latter showed controls but returned NotSupportedError
// for H.264/AAC media and produced no PulseAudio sink input.
check('q44 chrome media codec priority', /BROWSER_BIN=\$\(command -v google-chrome-stable \|\| command -v google-chrome \|\| command -v chromium/.test(server) &&
  server.includes('PULSE_SINK=browser_youtube') && server.includes("browserProfile = googleAvailable ? 'google' : 'chromium'") &&
  server.includes('--no-default-browser-check') && server.includes('--disable-signin-promo'));

// q45: browser video keeps the GPU compositor/raster path on Xvfb. The old
// --disable-gpu contradicted accelerated video decode and made FPS low.
check('q45 Mesa GPU compositor and Android UA', !server.includes('--test-type --disable-gpu --autoplay-policy') &&
  server.includes('--use-gl=angle') && server.includes('--use-angle=gl') &&
  server.includes('--ignore-gpu-blocklist') && server.includes('--enable-gpu-rasterization') &&
  server.includes('--enable-oop-rasterization') && server.includes('GALLIUM_DRIVER=llvmpipe') &&
  server.includes('MESA_LOADER_DRIVER_OVERRIDE=llvmpipe') && server.includes('LIBGL_ALWAYS_SOFTWARE=1') &&
  server.includes('Pixel Tablet') && server.includes('Pixel 8'));
check('q46 Mesa package and VNC latency', keep.includes("['glxinfo', 'mesa-utils']") &&
  startDesktop.includes('-wait 2 -defer 2'));
check('q47 noVNC smooth profile is applied to live URL', mob.includes("if (!/[?&]quality=/.test(u)) u = linuxProfileQuery(u)") &&
  desk.includes("if (!/[?&]quality=/.test(u))") &&
  mob.includes('quality: 3') && desk.includes('quality: 3'));
check('q48 terminal sessions survive hub restart', server.includes("app.get('/api/sessions'") &&
  server.includes('const tmuxHas = () =>') && server.includes('reviveTmuxSession') &&
  keep.includes("['tmux', 'tmux']") && mob.includes('restoreServerSessions') &&
  desk.includes('restoreServerSessions') && mob.includes('color: toolColor, icon: toolIcon') &&
  desk.includes('toolColor: color, toolIcon: icon'));
check('q49 desktop tab opens one websocket', (desk.match(/td\.connect = connect;/g) || []).length === 1 &&
  (desk.match(/socket\.send\(JSON\.stringify\(\{ type: 'open'/g) || []).length === 1);
check('q50 stale tmux tabs are pruned', server.includes('A detached tmux session can be killed') &&
  server.includes('if (s.tmux && !tmuxSessionAlive(s.id))') &&
  server.includes('sessions.delete(s.id)'));

// q51: a surviving session carries the actual project/worktree context and
// the selected emulator through a hub restart; a new local phone uses the
// persisted emulator instead of silently reverting to a hard-coded AVD.
check('q51 project and emulator persistence',
  server.includes('const repoContext = (dir)') &&
  server.includes('repoPath: session.repo && session.repo.path') &&
  server.includes('repoBranch: session.repo && session.repo.branch') &&
  server.includes('syncTmuxSession') &&
  server.includes("app.get('/api/emulator/default'") &&
  server.includes("app.post('/api/emulator/default'") &&
  server.includes("app.get('/api/phone/runner'") &&
  server.includes('const getDefaultEmulator = ()') &&
  server.includes('const getDefaultPhoneRunner = ()') &&
  server.includes('phoneRunner: session.phoneRunner') &&
  server.includes('runner: getDefaultPhoneRunner()') &&
  server.includes("phoneCtrl('start', 90000, { ANDROID_AVD: emulator })") &&
  server.includes('defaultEmulator: getDefaultEmulator()') &&
  mob.includes('repoPath: (resume && resume.repoPath)') &&
  desk.includes('repoPath: (resume && resume.repoPath)'));

// q52: an emulator/runner update is atomic — a failed request must not
// half-apply (e.g. persist the runner while rejecting the emulator); and repo
// sync compares stable identity, not the mutable git-status snapshot.
check('q52 atomic default save + repo identity sync',
  server.includes('// Validate everything before persisting anything') &&
  server.includes('const savedEmulator = setDefaultEmulator(emulator)') &&
  server.includes('const savedRunner = runner ? setDefaultPhoneRunner(runner)') &&
  server.includes("if (body.runner && !runner) return res.status(400)") &&
  server.includes('const repoIdentity = (r) => r ?') &&
  server.includes('repoChanged = repoIdentity(oldRepo) !== repoIdentity(nextRepo)'));

// q53: closing a tab must kill the server-side session. Detaching alone left a
// tmux session behind, which /api/sessions re-attached on every reload, so
// closed tabs came back and kept multiplying. The HTTP kill also covers a tab
// that is closed while its socket is mid-reconnect.
const term = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/term-app.js'), 'utf8');
check('q53 closing a tab kills the server session',
  server.includes("app.post('/api/sessions/:id/kill'") &&
  server.includes('const killServerSession = (id)') &&
  mob.includes("type: 'kill'") && desk.includes("type: 'kill'") &&
  term.includes("type: 'kill'") && !term.includes("type: 'close'") &&
  mob.includes("/api/sessions/' + encodeURIComponent(id) + '/kill'") &&
  desk.includes("/api/sessions/' + encodeURIComponent(id) + '/kill'") &&
  term.includes("/api/sessions/' + encodeURIComponent(id) + '/kill'"));

// q54: the custom scrollbar controls xterm's normal scrollback, while a
// full-screen alternate-screen app (OpenCode, vim, htop) receives synthetic
// wheel events that xterm converts into scroll keys / mouse reporting.
// A scrollbar cannot directly move that app's private transcript.
check('q54 alternate-screen program scrolling',
  mob.includes("b.type === 'alternate'") &&
  desk.includes("b.type === 'alternate'") &&
  term.includes("b&&b.type==='alternate'") &&
  mob.includes("new WheelEvent('wheel'") &&
  desk.includes("new WheelEvent('wheel'") &&
  term.includes("new WheelEvent('wheel'") &&
  term.includes("fireWheel(dir==='up'?-140:140)"));

// q55: Android downloads keep the server filename and recognize compound
// archives instead of letting DownloadManager rename them to .bin/.ts.
check('q55 APK preserves archive filenames',
  mainKt.includes('URLDecoder.decode') && panelKt.includes('URLDecoder.decode') &&
  mainKt.includes('lower.endsWith(".tar.xz")') && panelKt.includes('lower.endsWith(".tar.xz")') &&
  mainKt.includes('application/x-xz') && panelKt.includes('application/x-xz') &&
  mainKt.includes('detectedMime') && panelKt.includes('detectedMime'));

// q56: OpenCode descriptors survive the runner disk and are exposed to a new
// browser, while explicitly closed tabs remove the descriptor.
check('q56 durable OpenCode session restore',
  server.includes("const SESSION_DIR = path.join(DATA_DIR, 'sessions')") &&
  server.includes('autoRestore') && server.includes('resolveRestoredCwd') &&
  server.includes('restore: true') && mob.includes('durableIds') &&
  desk.includes('durableIds') && term.includes('restoreDurableSessions') &&
  backupWork.includes('"name": os.path.basename') &&
  restoreWork.includes('WORK_BACKUP_RESTORE_EXISTING'));

// q57: a fresh Hub runner installs OpenCode before chat import and restores
// repositories before calling opencode import.
check('q57 startup installs OpenCode before restore',
  hubWorkflow.includes('Install OpenCode for session recovery') &&
  hubWorkflow.indexOf('restore-work.sh') < hubWorkflow.indexOf('restore_audit_code.sh') &&
  hubWorkflow.includes('WORK_BACKUP_RESTORE_EXISTING=1') &&
  hubWorkflow.includes('Final durable repository and session backup'));

// q58: the archive button packages folders only; selecting an APK or another
// file always uses the binary-safe original-file download route.
check('q58 archive does not wrap files',
  mob.includes('return fmDownloadSingle()') &&
  desk.includes('return fmDownloadSingle()') &&
  filesApp.includes('return fmDownload()') &&
  mob.includes("item.dataset.isdir !== '1'") &&
  desk.includes("item.dataset.isdir !== '1'") &&
  filesApp.includes("item.dataset.isdir !== '1'"));

// q59: phone uploads show name/size/percentage/speed/ETA via XHR upload
// events — fetch() has no onprogress, so the queue runs on XMLHttpRequest
// and renders into the #fm-transfer box in mobile.html.
check('q59 upload progress UI',
  mob.includes('xhr.upload.onprogress') &&
  mob.includes('function fmTransferUpdate(') &&
  mob.includes('fmTransferEls()') &&
  mobHtml.includes('id="fm-transfer-bar"') &&
  mobHtml.includes('id="fm-transfer-progress"') &&
  mob.includes("st.fileName + ' (' + fmtBytes(st.fileSize) + ')'"));

const sessionWorkflows = [hubWorkflow, agentWorkflow, opencodeWorkflow, desksWorkflow];
check('q60 one session workflow lock', sessionWorkflows.every(x =>
  x.includes('zen-panel-session-${{ github.repository }}')) &&
  hubWorkflow.includes('cancel-in-progress: ${{ inputs.replace }}') &&
  agentWorkflow.includes('cancel-in-progress: false') &&
  opencodeWorkflow.includes('cancel-in-progress: false') &&
  desksWorkflow.includes('cancel-in-progress: false'));
check('q60a replacement launch is serialized', panel.includes('await cancelRunsAndWait(running)') &&
  panel.includes('foreignSession(runs, running)') && hubWorkflow.includes("trap 'cleanup_watchdog 143' TERM INT"));
check('q61 background snapshots receive token',
  hubWorkflow.includes('nohup env GH_TOKEN="${{ secrets.GITHUB_TOKEN }}"') &&
  agentWorkflow.includes('nohup env GH_TOKEN="${{ secrets.GITHUB_TOKEN }}"') &&
  hubWorkflow.includes('GITHUB_TOKEN="${{ secrets.GITHUB_TOKEN }}" SNAPSHOT_EXPORT_ALL_CHATS=1'));
check('q62 snapshot failures are not reported as success',
  snapshotAudit.includes('publish_snapshot()') && snapshotAudit.includes('published=$published/4') &&
  publishSession.includes('push attempt $attempt failed'));
check('q63 OpenCode resumes the last project session',
  server.includes('const commandForTool =') && server.includes("'opencode'") && server.includes('--continue'));
check('q64 clone manifest follows the real repository',
  server.includes('githubDefaultBranch') && server.includes("path.join(targetDir, 'MANIFEST.md')") &&
  server.includes('staging-${process.pid}-${Date.now()}'));
check('q65 incomplete clone is quarantined',
  restoreWork.includes('moved incomplete clone') && restoreWork.includes('git -C "$dest" rev-parse --git-dir'));
check('q66 double hub launch is serialized',
  panel.includes('let hubLaunchInFlight = false') && panel.includes('launchHubInternal'));
check('q67 new launch cannot open stale session data',
  panel.includes('born < sinceMs - 15000') && panel.includes('waitAndOpen(\'hub-\' + where, launchSince)') &&
  fs.readFileSync(path.join(__dirname, '..', 'hub/src/main/assets/hub/index.html'), 'utf8').includes('born >= sinceMs - 15000'));
check('q68 backup failures propagate',
  publishSession.includes('staging file is empty') && publishSession.includes('push failed after retries') &&
  backupWork.includes('result=1') && snapshotAudit.includes('[ "$published" -eq 4 ]'));
const recoveryFiles = [mob, desk, term, mobHtml, deskHtml,
  fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/term.html'), 'utf8')];
check('q69 quota recovery notification is disabled',
  recoveryFiles.every(x => !x.includes('TERM_QUOTA_RE') && !x.includes('Агент упёрся в лимит модели')));
check('q70 hub start verifies its own run id',
  hubWorkflow.includes('str(d.get("runId", "")) == sys.argv[1]') &&
  hubWorkflow.includes('HUB_PORT_STRICT=1') && server.includes("runId: process.env.GITHUB_RUN_ID"));
check('q71 watchdog removes its own hub and tunnel',
  hubWorkflow.includes('cleanup_watchdog') && hubWorkflow.includes('trap \'cleanup_watchdog 143\' TERM INT'));
check('q72 opencode path survives later steps',
  hubWorkflow.includes('echo "$HOME/.opencode/bin" >> "$GITHUB_PATH"') &&
  hubWorkflow.includes('Add-Content $env:GITHUB_PATH $bin'));
check('q73 session publication keeps identity and clock',
  publishSession.includes('session_publish_blocked') &&
  publishSession.includes('EXISTING_STARTED_AT') &&
  publishSession.includes('int(new_number) > int(old_number)'));
check('q74 backup keeps the newest snapshot and descriptors',
  backupWork.includes('LC_ALL=C sort -r') && backupWork.includes('backup_run_is_stale') &&
  backupWork.includes('stage/descriptors') && restoreWork.includes('SNAP/descriptors'));
check('q75 chat export finds repositories and exact paths',
  exportChats.includes('args+=( -path "*/$e/*" -prune -o )') &&
  exportChats.includes('repo_name in rp.split(os.sep)'));
check('q76 chat restore matches remotes before basenames',
  restoreChats.includes('remote_match') && restoreChats.includes('basename_match'));
check('q77 panel distinguishes queued runs',
  panel.includes('const runningFirst =') && panel.includes('в очереди') &&
  panel.includes('!Number.isFinite(born)'));
check('q78 panel refuses a hub from another run',
  panel.includes('identity.runId') && panel.includes('другой запуск раннера') &&
  fs.readFileSync(path.join(__dirname, '..', 'hub/src/main/assets/hub/index.html'), 'utf8')
    .includes('preflightHub(base, zt, s.runId)'));

console.log(`MOBILE-TOUCH: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
