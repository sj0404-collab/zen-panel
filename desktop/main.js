'use strict';
// Zen Panel — desktop shell for Windows and Linux (Electron).
//
// The PC analog of the Android app (app/src/main/...): a window that serves
// the same panel pages from the repo and lets them reach the network. The
// panel itself is NOT duplicated here - it is served from
// app/src/main/assets/panel/ in a dev checkout, or from the packaged
// resources in a build, so Android and desktop always show the same UI.
//
// Parity with MainActivity.kt:
//   panel host + allow-list + version.json -> panel-store.js
//   external links to the system browser   -> openExternalIfNeeded()
//   "session ready" notification           -> zen:notify-ready IPC + click
//   build info injection                   -> ZEN_PANEL_BUILD on did-finish-load
//   singleTask                             -> requestSingleInstanceLock()

const path = require('path');
const { app, BrowserWindow, Notification, protocol, session, shell, ipcMain, Menu } = require('electron');
const store = require('./panel-store');

protocol.registerSchemesAsPrivileged([
  { scheme: store.PANEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let pageReady = false;
let pendingOpen = null; // { slot, url } - notification/CLI tap before the page loaded
const buildInfo = store.readBuildInfo(__dirname);

function panelDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'panel');
  return path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'panel');
}

function handlePanelRequest(request) {
  let url;
  try { url = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
  if (url.host.toLowerCase() !== store.PANEL_HOST) return new Response('Not found', { status: 404 });
  const served = store.servePath(panelDir(), url.pathname, buildInfo);
  return new Response(served.body, { status: served.status, headers: served.headers });
}

function shouldStayInApp(target) {
  try {
    const u = new URL(target);
    if (u.protocol === store.PANEL_SCHEME + ':') return u.host.toLowerCase() === store.PANEL_HOST;
    if (u.protocol === 'http:' || u.protocol === 'https:') return store.isInternal(u.hostname);
    return false;
  } catch { return false; }
}

// Returns true when the URL was handed to the OS (same split as Android:
// internal hosts stay, everything else opens in the default browser).
function openExternalIfNeeded(target) {
  if (shouldStayInApp(target)) return false;
  shell.openExternal(target).catch(() => {});
  return true;
}

function zenBuildJs() {
  const b = { versionCode: buildInfo.versionCode, versionName: buildInfo.versionName, applicationId: store.APP_ID };
  return `window.ZEN_PANEL_BUILD=${JSON.stringify(b)};` +
    'if(window.onZenPanelBuild)window.onZenPanelBuild(window.ZEN_PANEL_BUILD);';
}

function flushPendingOpen() {
  if (!pendingOpen || !mainWindow || mainWindow.isDestroyed()) return;
  const { slot, url } = pendingOpen;
  pendingOpen = null;
  mainWindow.webContents.executeJavaScript(
    `if(window.zenOpenFromNotify)window.zenOpenFromNotify(${JSON.stringify(slot)},${JSON.stringify(url)});`
  ).catch(() => {});
}

function notifySimple(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title: String(title), body: String(body || ''), silent: true }).show();
}

function showSessionNotification({ title, body, slot, url }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title || 'Zen Panel'), body: String(body || ''), silent: false });
  n.on('click', () => {
    pendingOpen = { slot: String(slot || ''), url: String(url || '') };
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (pageReady) flushPendingOpen();
  });
  n.show();
}

function parseOpenArgs(argv) {
  const out = { slot: '', url: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slot' && argv[i + 1]) out.slot = argv[++i];
    else if (argv[i] === '--url' && argv[i + 1]) out.url = argv[++i];
  }
  return out;
}

const LOAD_ERROR_PAGE = '<!doctype html><meta charset=utf-8>' +
  '<body style="background:#0d0d12;color:#e8e8f0;font:15px sans-serif;padding:40px">' +
  '<h3>Панель не открылась</h3>' +
  '<p style="color:#8a8a9e">Страница входит в состав приложения, поэтому связь тут ни при чём. ' +
  'Похоже, сборка повреждена — переустановите приложение.</p>';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0d0d12',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pageReady = false;
  mainWindow.webContents.setUserAgent(mainWindow.webContents.getUserAgent() + ` ZenPanel/${buildInfo.versionName}`);

  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (openExternalIfNeeded(target)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // target=_blank to a tunnel (session chat) gets its own app window;
    // anything else goes to the system browser.
    if (shouldStayInApp(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#0d0d12', width: 1100, height: 750 } };
    }
    void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-start-loading', () => { try { mainWindow.setProgressBar(2); } catch {} });
  mainWindow.webContents.on('did-stop-loading', () => { try { mainWindow.setProgressBar(-1); } catch {} });
  mainWindow.webContents.on('did-finish-load', () => {
    pageReady = true;
    mainWindow.webContents.executeJavaScript(zenBuildJs()).catch(() => {});
    flushPendingOpen();
  });
  mainWindow.webContents.on('did-fail-load', () => {
    mainWindow.webContents.executeJavaScript(
      `document.open();document.write(${JSON.stringify(LOAD_ERROR_PAGE)});document.close();`
    ).catch(() => {});
  });

  mainWindow.loadURL(store.PANEL_URL).catch(() => {});
}

function buildMenu() {
  const template = [
    {
      label: 'Панель',
      submenu: [
        { label: 'Обновить', accelerator: 'CmdOrCtrl+R', click: (_i, w) => { if (w) w.reload(); } },
        { label: 'Полный экран', accelerator: 'F11', click: (_i, w) => { if (w) w.setFullScreen(!w.isFullScreen()); } },
        { type: 'separator' },
        { label: 'Выйти', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
  ];
  if (!app.isPackaged) {
    template.push({
      label: 'Dev',
      submenu: [{ label: 'DevTools', accelerator: 'CmdOrCtrl+Shift+I', click: (_i, w) => { if (w) w.webContents.toggleDevTools(); } }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('zen:notify-ready', (_event, p) => showSessionNotification(p || {}));
ipcMain.handle('zen:request-notifications', () => Notification.isSupported());

app.whenReady().then(() => {
  // Required for Windows toast notifications to show the app name.
  app.setAppUserModelId(store.APP_ID);
  protocol.handle(store.PANEL_SCHEME, handlePanelRequest);
  buildMenu();

  session.defaultSession.on('will-download', (_event, item) => {
    const fileName = item.getFilename() || 'download';
    item.setSavePath(path.join(app.getPath('downloads'), fileName));
    notifySimple('Скачивается…', fileName);
    item.once('done', (_e, state) => {
      notifySimple(state === 'completed' ? 'Скачивание завершено' : 'Скачивание не удалось', fileName);
    });
  });

  const args = parseOpenArgs(process.argv);
  if (args.slot) pendingOpen = args;
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', (_event, argv) => {
  const args = parseOpenArgs(argv);
  if (args.slot) {
    pendingOpen = args;
    if (pageReady) flushPendingOpen();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
