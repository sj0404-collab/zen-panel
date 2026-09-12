// Stage Q: phone taps + touch scroll + default work folder. Plain node,
// no deps — greps the original-based files for the exact fixes.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/src/server.js'), 'utf8');
const mob = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile-app.js'), 'utf8');
const desk = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/desktop-app.js'), 'utf8');
const mgr = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/src/storage/manager.js'), 'utf8');
const mobHtml = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/mobile.html'), 'utf8');
const deskHtml = fs.readFileSync(path.join(__dirname, '..', 'npm-hub/public/desktop.html'), 'utf8');
const mainKt = fs.readFileSync(path.join(__dirname, '..', 'hub/src/main/java/dev/zen/hub/MainActivity.kt'), 'utf8');

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
check('q10 tools report warming:false', server.includes('res.json({ success: true, warming: false, tools })'));

// q11: 16+ installable agents on choice (pkg set, bins verified in the registry).
check('q11 installable agents', (server.match(/pkg: '/g) || []).length >= 16,
  (server.match(/pkg: '/g) || []).length);

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
const panelKt = fs.readFileSync(path.join(__dirname, '..', 'app/src/main/java/dev/zen/panel/MainActivity.kt'), 'utf8');
check('q35 panel runner', panel.includes('id="runner-card-panel"') &&
  panel.includes('async function runnerPanelScan(') &&
  panel.includes('async function runnerPanelSave(') &&
  panel.includes('async function runnerPanelRestart(') &&
  panel.includes('async function runnerPanelStop(') &&
  panel.includes('async function rerunRun('));
check('q35b panel rerun link', panel.includes('onclick="rerunRun('));
check('q35c panel apk file chooser', panelKt.includes('onShowFileChooser') &&
  panelKt.includes('ActivityResultContracts') && panelKt.includes('filePicker.launch'));

console.log(`MOBILE-TOUCH: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
