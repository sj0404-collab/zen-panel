'use strict';
/**
 * Always-on, self-healing Linux desktop (VNC) for the hub's OWN runner.
 *
 * Why this exists
 * ---------------
 * The hub only ever ran the desktop from the workflow (`hub.yml` → `vnc` job),
 * which can land on a DIFFERENT runner of the same self-hosted cluster. The
 * hub then showed a screen it could not paint: `Go · 🖥` launches Chromium on
 * the hub's own `:99`, so a remote desktop stayed dark, and when that job's
 * openbox/pcmanfm died nobody noticed — the noVNC page kept answering, so the
 * panel kept showing a black rectangle.
 *
 * What it does
 * ------------
 *   * registers `/novnc` (http proxy) and `/ws/desktop` (websocket → 5901) on
 *     the hub's own server, so the screen is served from the hub origin;
 *   * starts Xvfb + openbox + desktop programs + x11vnc + websockify on the
 *     runner if they are not up yet (`tools/start_desktop.sh`, VNC_RESTART=1);
 *   * every VNC_TICK ms verifies X, noVNC, x11vnc and openbox, and repairs
 *     what died (openbox/pcmanfm/tint2 re-spawn + x11vnc restart → the client
 *     reconnects and gets a fresh framebuffer instead of a stale black one);
 *   * writes the desktop itself: wallpaper (ImageMagick, or a pure-JS PNG
 *     fallback) and the launcher icons in ~/Desktop.
 *
 * Everything is best-effort: on a runner without sudo/apt the local screen is
 * simply announced as unavailable and the caller falls back to the URL the
 * `vnc` job published in session-vnc.json.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.npm-hub', 'logs');
const DATA_DIR = path.join(HOME, '.npm-hub');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const PICTURES = path.join(HOME, 'Pictures');
const DESKTOP_DIR = path.join(HOME, 'Desktop');
const WALL = path.join(PICTURES, 'wallpaper.png');

const DISPLAY = process.env.VNC_DISPLAY || ':99';
const VNC_PORT = String(process.env.VNC_PORT || 5901);
const NOVNC_PORT = String(process.env.NOVNC_PORT || 6081);
const RESOLUTION = process.env.VNC_RESOLUTION || '1920x1080';
const W = parseInt(RESOLUTION.split('x')[0], 10) || 1920;
const H = parseInt(RESOLUTION.split('x')[1], 10) || 1080;
const TICK_MS = Number(process.env.VNC_TICK_MS || 15000);
const REPAIR_COOLDOWN_MS = Number(process.env.VNC_REPAIR_COOLDOWN_MS || 45000);

// noVNC query: connect without the "Подключение" button, reconnect by itself,
// scale to the iframe, and talk to OUR websocket relay (path=ws/desktop).
// The hub already ships noVNC (public/novnc), so the iframe talks to the hub's
// own origin and only the websocket has to be relayed: path=ws/desktop.
const NOVNC_QUERY = 'autoconnect=true&reconnect=true&reconnect_delay=2000'
  + '&resize=scale&shared=true&path=ws/desktop';
const NOVNC_UI = path.join(__dirname, '..', 'public', 'novnc', 'vnc.html');

const state = {
  enabled: false,
  busy: false,             // идёт старт/починка — новые не наслаиваются
  platform: process.platform,
  display: DISPLAY,
  desktop: 'unknown',      // xvfb + openbox alive?
  novnc: 'unknown',        // websockify answering?
  x11vnc: 'unknown',
  proxy: null,             // registered on the hub server?
  wall: null,              // wallpaper path in use
  paint: null,             // 'ok' | 'flat' — pixels actually drawn?
  hubUrl: null,            // public hub address (from ~/.npm-hub/logs/hub-url)
  starts: 0,
  repairs: 0,
  lastTick: 0,
  lastRepair: 0,
  note: 'init',
  log: () => {}
};

// ─────────────────────────── small shell helpers ───────────────────────────

function sh(cmd, timeoutMs = 60000, extraEnv) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('bash', ['-lc', cmd], {
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) { return resolve({ code: -1, out: String(e.message || e) }); }
    let out = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    const add = (d) => { if (out.length < 20000) out += String(d); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
  });
}

const which = async (bin) => {
  const r = await sh(`command -v ${bin} >/dev/null 2>&1; echo $?`, 8000);
  return r.out.endsWith('0');
};

const pgrep = async (pattern) => {
  const r = await sh(`pgrep -f ${JSON.stringify(pattern)} >/dev/null 2>&1; echo $?`, 8000);
  return r.out.endsWith('0');
};

const portOpen = (port, timeout = 1500) => new Promise((resolve) => {
  const sock = net.connect(Number(port), '127.0.0.1');
  const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
  sock.setTimeout(timeout);
  sock.on('connect', () => done(true));
  sock.on('timeout', () => done(false));
  sock.on('error', () => done(false));
});

const httpOk = (url, timeout = 3000) => new Promise((resolve) => {
  const req = http.get(url, { timeout }, (res) => {
    res.resume();
    resolve(res.statusCode >= 200 && res.statusCode < 500);
  });
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
});

const xDisplayUp = async () => {
  const num = DISPLAY.replace(/^:/, '');
  if (fs.existsSync(`/tmp/.X11-unix/X${num}`)) return true;
  if (await which('xdpyinfo')) {
    const r = await sh(`xdpyinfo -display ${DISPLAY} >/dev/null 2>&1; echo $?`, 8000);
    return r.out.endsWith('0');
  }
  return false;
};

const paintCheck = async (size = 24) => {
  if (state.magick === undefined) {
    state.magick = (await which('import')) ? 'import' : null;
  }
  if (!state.magick) return { checked: false, ok: true, colors: 0 };
  const r = await sh(`DISPLAY=${DISPLAY} import -window root -resize ${size}x${size} txt:- 2>/dev/null | tail -n +2 | awk '{print $3}' | sort -u | wc -l`, 15000);
  const colors = parseInt(r.out, 10);
  if (!Number.isFinite(colors)) return { checked: false, ok: true, colors: 0 };
  // Градиент + иконки + панель дают десятки оттенков; плоский фон — 1-2.
  return { checked: true, ok: colors > 4, colors };
};

const hubPublicUrl = () => {
  try {
    const u = fs.readFileSync(path.join(LOG_DIR, 'hub-url'), 'utf8').trim();
    return /^https?:\/\//.test(u) ? u.replace(/\/+$/, '') : null;
  } catch { return null; }
};

// ─────────────────────── pure-JS wallpaper (no ImageMagick) ───────────────
// A 1920x1080 PNG costs ~6 MB of raw scanlines; deflate turns it into a few
// hundred KB. Used only when ImageMagick is missing, so the runner never shows
// a flat black root window.

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function gradientPng(w = W, h = H) {
  const top = [13, 20, 30];       // #0d141e
  const bottom = [46, 82, 116];   // #2e5274 — заметно светлее «чёрного»
  const accent = [88, 166, 255];  // #58a6ff
  const GRID = Math.max(48, Math.round(w / 16)); // тонкая сетка = «обои», а не пустота
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    const t = y / (h - 1);
    const e = t * t * (3 - 2 * t); // smoothstep
    const gy = (y - h * 0.42) / (h * 0.55);
    const gridY = (y % GRID < 1) ? 7 : 0;
    // акцентная линия под «панелью» внизу
    const barY = (y > h - 3 && y < h) ? 1 : 0;
    for (let x = 0; x < w; x++) {
      const gx = (x - w * 0.5) / (w * 0.5);
      const d = Math.sqrt(gx * gx + gy * gy);
      const glow = d < 1 ? Math.pow(1 - d, 3) * 0.22 : 0;
      const gridX = (x % GRID < 1) ? 7 : 0;
      const grid = gridY + gridX;
      const base = [
        top[0] + (bottom[0] - top[0]) * e,
        top[1] + (bottom[1] - top[1]) * e,
        top[2] + (bottom[2] - top[2]) * e
      ];
      let r = base[0] + glow * accent[0] + grid;
      let g = base[1] + glow * accent[1] + grid;
      let b = base[2] + glow * accent[2] + grid * 1.5;
      if (barY) { r += 30; g += 60; b += 90; }
      raw[o++] = r > 255 ? 255 : r < 0 ? 0 : r | 0;
      raw[o++] = g > 255 ? 255 : g < 0 ? 0 : g | 0;
      raw[o++] = b > 255 ? 255 : b < 0 ? 0 : b | 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ────────────────────────────── wallpaper ─────────────────────────────────

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf'
];

const findFont = () => FONT_CANDIDATES.find((p) => fs.existsSync(p)) || null;

async function ensureWallpaper(force) {
  try { fs.mkdirSync(PICTURES, { recursive: true }); } catch {}
  if (!force && fs.existsSync(WALL) && fs.statSync(WALL).size > 20000) {
    state.wall = WALL;
    return WALL;
  }
  const magick = (await which('convert')) ? 'convert' : (await which('magick')) ? 'magick' : null;
  if (magick) {
    const font = findFont();
    const args = [
      '-size', `${W}x${H}`, 'gradient:#0b0f14-#1a2a3e',
      '-fill', '#0b0f14', '-draw', `rectangle 0,${Math.round(H * 0.72)},${W},${H}`,
      '-blur', '0x28'
    ];
    if (font) {
      args.push(
        '-font', font,
        '-fill', '#58a6ff', '-pointsize', '86', '-gravity', 'center',
        '-annotate', '+0-60', 'NPM Hub',
        '-fill', '#7d8590', '-pointsize', '30',
        '-annotate', '+0+40', 'Один экран для всего',
        '-pointsize', '20', '-fill', '#3d444d',
        '-annotate', `+0+${Math.round(H / 2) - 70}`, DISPLAY + '  ·  openbox  ·  noVNC'
      );
    }
    // PNG24 обязателен: ImageMagick по умолчанию пишет 16-битный PNG, а
    // старые GTK2-менеджеры рабочего стола его молча не грузят (чёрный фон).
    const r = await sh(`${magick} ${args.map((a) => JSON.stringify(a)).join(' ')} PNG24:${JSON.stringify(WALL)}`, 30000);
    if (r.code === 0 && fs.existsSync(WALL) && fs.statSync(WALL).size > 20000) {
      state.wall = WALL;
      return WALL;
    }
    state.note = 'convert failed: ' + r.out.slice(0, 120);
  }
  // Fallback: draw the gradient ourselves — always works, no packages needed.
  try {
    fs.writeFileSync(WALL, gradientPng());
    state.wall = WALL;
    state.note = 'wallpaper: built-in gradient';
    return WALL;
  } catch (e) {
    state.note = 'wallpaper failed: ' + e.message;
    state.wall = null;
    return null;
  }
}

// ───────────────────────────── shortcuts ─────────────────────────────────

const SHORTCUTS = [
  { name: 'Терминал',   exec: 'xterm',                                          glyph: '>_',   c1: '#1f6feb', c2: '#0d419d', icon: 'utilities-terminal' },
  { name: 'Файлы',      exec: 'pcmanfm $HOME/hub-work',                         glyph: 'F',    c1: '#bb8009', c2: '#7d5e05', icon: 'system-file-manager' },
  { name: 'Google',     exec: '$BROWSER --start-maximized https://www.google.com', glyph: 'G', c1: '#1a73e8', c2: '#0b47a1', icon: 'google-chrome' },
  { name: 'YouTube',    exec: '$BROWSER --start-maximized https://www.youtube.com', glyph: 'YT', c1: '#cc0000', c2: '#7a0000', icon: 'youtube' },
  { name: 'Hub',        exec: '$BROWSER --start-maximized http://127.0.0.1:$PORT', glyph: 'H', c1: '#8957e5', c2: '#4c2889', icon: 'applications-internet' },
  { name: 'GitHub',     exec: '$BROWSER --start-maximized https://github.com',   glyph: 'GH',   c1: '#30363d', c2: '#161b22', icon: 'github' },
  { name: 'AI',         exec: 'xterm -title "OpenCode" -e bash -lc "opencode; exec bash"', glyph: 'AI', c1: '#00a887', c2: '#005f4c', icon: 'utilities-terminal' },
  { name: 'Редактор',   exec: '(command -v geany >/dev/null && geany) || (command -v gedit >/dev/null && gedit) || xterm -e nano', glyph: '</>', c1: '#d29922', c2: '#7a5605', icon: 'accessories-text-editor' },
  { name: 'Звук',       exec: 'pavucontrol',                                     glyph: '♪',    c1: '#2596be', c2: '#124e63', icon: 'multimedia-volume-control' },
  { name: 'Проекты',    exec: 'pcmanfm $HOME/hub-work',                          glyph: 'P',    c1: '#3fb950', c2: '#1b6d2c', icon: 'folder' }
];

async function ensureShortcutIcons(magick, font) {
  try { fs.mkdirSync(ICON_DIR, { recursive: true }); } catch {}
  const made = {};
  for (const s of SHORTCUTS) {
    const file = path.join(ICON_DIR, s.name.replace(/[^A-Za-zА-Яа-я0-9_-]/g, '_') + '.png');
    made[s.name] = file;
    if (!magick || !font) continue;
    if (fs.existsSync(file) && fs.statSync(file).size > 500) continue;
    const args = [
      '-size', '96x96', `gradient:${s.c1}-${s.c2}`,
      '-font', font,
      '-fill', '#ffffff', '-gravity', 'center', '-pointsize', s.glyph.length > 2 ? '30' : '40',
      '-annotate', '+0+2', s.glyph,
      file
    ];
    await sh(`${magick} ${args.map((a) => JSON.stringify(a)).join(' ')}`, 15000);
  }
  return made;
}

async function ensureShortcuts(port) {
  const magick = (await which('convert')) ? 'convert' : (await which('magick')) ? 'magick' : null;
  const font = findFont();
  const icons = await ensureShortcutIcons(magick, font);
  const browser = (await which('google-chrome')) ? 'google-chrome'
    : (await which('chromium')) ? 'chromium'
      : (await which('chromium-browser')) ? 'chromium-browser'
        : (await which('firefox')) ? 'firefox' : 'xdg-open';
  const available = new Set();
  for (const bin of ['xterm', 'pcmanfm', 'pavucontrol', 'geany', 'gedit']) {
    if (await which(bin)) available.add(bin);
  }
  try { fs.mkdirSync(DESKTOP_DIR, { recursive: true }); } catch {}
  // Drop the launchers the hub used to write with the old naming, so the
  // desktop does not end up with two icons for the same program.
  for (const stale of ['Браузер.desktop', 'Файловый менеджер.desktop', 'NPM Hub.desktop', 'Hub папка.desktop', 'Редактор (Geany).desktop']) {
    try { fs.unlinkSync(path.join(DESKTOP_DIR, stale)); } catch {}
  }
  // idesk (иконки + подписи на рабочем столе) читает ~/.ideskrc и ~/.idesktop
  const ideskDir = path.join(HOME, '.idesktop');
  try { fs.mkdirSync(ideskDir, { recursive: true }); } catch {}
  const ideskRc = path.join(HOME, '.ideskrc');
  if (!fs.existsSync(ideskRc) || fs.statSync(ideskRc).size < 200) {
    const sample = '/usr/share/idesk/dot.ideskrc';
    let base = null;
    try { base = fs.readFileSync(sample, 'utf8'); } catch {}
    if (base) {
      // Готовый шаблон дистрибутива + наши цвета/шрифт — idesk требует все
      // ключи (Background.Source и т.д.), минимальный конфиг он отвергает.
      base = base
        .replace(/^  FontName:.*$/m, '  FontName: DejaVu Sans')
        .replace(/^  FontSize:.*$/m, '  FontSize: 10')
        .replace(/^  FontColor:.*$/m, '  FontColor: #e6edf3')
        .replace(/^  Bold: true$/m, '  Bold: false')
        .replace(/^  Background\.Color:.*$/m, '  Background.Color: #0b0f14');
      try { fs.writeFileSync(ideskRc, base); } catch {}
    }
  }

  try {
    for (const f of fs.readdirSync(ideskDir)) if (f.endsWith('.lnk')) fs.unlinkSync(path.join(ideskDir, f));
  } catch {}
  let written = 0, ideskWritten = 0, col = 0, row = 0;
  for (const s of SHORTCUTS) {
    if (s.name === 'Звук' && !available.has('pavucontrol')) continue;
    if (s.name === 'Редактор' && !available.has('geany') && !available.has('gedit') && !available.has('xterm')) continue;
    const icon = (icons[s.name] && fs.existsSync(icons[s.name])) ? icons[s.name] : s.icon;
    const exec = s.exec.replace(/\$BROWSER\b/g, browser).replace(/\$PORT\b/g, String(port || 8090))
      .replace(/\$HOME\b/g, HOME);
    const body = [
      '[Desktop Entry]',
      'Version=1.0',
      `Name=${s.name}`,
      `Comment=NPM Hub · ${s.name}`,
      `Exec=${exec}`,
      'Type=Application',
      'Terminal=false',
      `Icon=${icon}`,
      'Categories=Utility;'
    ];
    try {
      const f = path.join(DESKTOP_DIR, s.name + '.desktop');
      fs.writeFileSync(f, body.join('\n') + '\n');
      fs.chmodSync(f, 0o755);
      written++;
    } catch {}
    // Иконка idesk: своя колонка ~64 px, чтобы подписи не наезжали друг на друга.
    const iconFile = (icons[s.name] && fs.existsSync(icons[s.name])) ? icons[s.name] : null;
    if (iconFile) {
      const lnk = [
        'table Icon',
        `  Caption: ${s.name}`,
        `  Command: ${exec}`,
        `  Icon: ${iconFile}`,
        '  Width: 64',
        '  Height: 64',
        `  X: ${40 + col * 130}`,
        `  Y: ${60 + row * 120}`,
        'end',
        ''
      ].join('\n');
      try {
        // Имя файла только латиницей: подписи (Caption) кириллицей — можно,
        // а вот пути с кириллицей idesk/glib иногда не находит.
        fs.writeFileSync(path.join(ideskDir, `shortcut-${s.name.length}-${ideskWritten}.lnk`), lnk);
        ideskWritten++;
        row++;
        if (row > 6) { row = 0; col++; }
      } catch {}
    }
  }
  return written;
}

async function ensureAutostart() {
  const cfg = path.join(HOME, '.config', 'openbox');
  try { fs.mkdirSync(cfg, { recursive: true }); } catch {}
  const lines = [
    '# zen-desktop autostart — managed by npm-hub/src/vnc-keepalive.js',
    '# (re-written on every start/repair; local edits are lost)',
    state.wall ? `feh --bg-scale "${state.wall}" 2>/dev/null &` : 'xsetroot -solid "#101418" &',
    // idesk: фон + иконки с подписями. pcmanfm здесь бесполезен — его
    // GTK2-конфиг молча игнорируется и экран остаётся чёрным (проверено).
    'if command -v idesk >/dev/null 2>&1; then idesk 2>/dev/null & else pcmanfm --desktop 2>/dev/null & fi',
    'tint2 2>/dev/null &',
    '( timeout -k 3 8 pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true ) &',
    `xterm -geometry 100x26+60+90 -title "NPM Hub · терминал" 2>/dev/null &`
  ];
  try { fs.writeFileSync(path.join(cfg, 'autostart'), lines.join('\n') + '\n'); } catch {}
  // pcmanfm's own desktop config: wallpaper + hand the right-click menu to the WM.
  for (const prof of ['default', 'LXDE']) {
    const dir = path.join(HOME, '.config', 'pcmanfm', prof);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const conf = [
      '[Desktop]',
      state.wall ? 'wallpaper_mode=1' : 'wallpaper_mode=0',
      state.wall ? `wallpaper=${state.wall}` : 'wallpaper=',
      'desktop_bg=#101418',
      'desktop_fg=#ffffff',
      'desktop_shadow=#000000',
      'show_wm_menu=1',
      'desktop_sort=mtime',
      '',
      '[pcmanfm]',
      ''
    ].join('\n');
    try { fs.writeFileSync(path.join(dir, 'pcmanfm.conf'), conf); } catch {}
  }
}

// ─────────────────────────── the desktop stack ───────────────────────────

async function runStartScript(repoRoot, restart) {
  const script = path.join(repoRoot, 'tools', 'start_desktop.sh');
  if (!fs.existsSync(script)) {
    state.note = 'нет ' + script;
    return { ok: false, out: state.note };
  }
  const r = await sh(`bash ${JSON.stringify(script)} 2>&1 | tail -n 20`, 420000, {
    VNC_DISPLAY: DISPLAY,
    VNC_PORT,
    NOVNC_PORT,
    VNC_RESOLUTION: RESOLUTION,
    VNC_RESTART: restart ? '1' : '0'
  });
  const ok = r.code === 0 && /READY/.test(r.out);
  return { ok, out: r.out };
}

async function fullStart(repoRoot) {
  if (state.busy) return false;
  state.busy = true;
  state.starts++;
  state.lastRepair = Date.now();
  try {
    return await fullStartInner(repoRoot);
  } finally {
    state.busy = false;
  }
}

async function fullStartInner(repoRoot) {
  state.note = 'building the desktop…';
  // Обои — до скрипта: он их только докрашивает, если файла нет.
  await ensureWallpaper(false);
  // Скрипт НЕ ждём: он качает пакеты и умеет подвисать на apt/pcmanfm/
  // pulseaudio. Экран доводим до рабочего состояния сами и параллельно, а
  // скрипт пусть доделывает своё в фоне (его autostart/ярлыки перезапишем).
  const scriptRun = runStartScript(repoRoot, true);
  let scriptOk = false;
  const scriptDone = scriptRun.then((r) => { scriptOk = r.ok; return r; });
  for (const wait of [9000, 11000, 15000, 20000]) {
    await sleep(wait);
    if (await ensureEssentials()) break;
  }
  await ensureShortcuts(process.env.PORT || 8090);
  await ensureAutostart();
  await ensureEssentials();
  if (!scriptOk) {
    const r = await Promise.race([scriptDone, sleep(45000).then(() => ({ ok: false, out: 'скрипт всё ещё работает — экран поднят своими силами' }))]);
    scriptOk = r.ok;
    if (!scriptOk && r.out) state.note = String(r.out).split('\n').slice(-2).join(' | ').slice(0, 200);
  }
  if (!(await which('Xvfb'))) {
    state.note = 'на этом раннере нет Xvfb (sudo apt-get install xvfb нужен один раз)';
    state.log(state.note);
    return false;
  }
  const alive = (await portOpen(VNC_PORT)) && state.desktop !== 'down';
  state.log((alive ? 'рабочий стол поднят' : 'рабочий стол не поднялся') + ' (Xvfb ' + DISPLAY + ', VNC ' + VNC_PORT
    + ', noVNC ' + NOVNC_PORT + (scriptOk ? '' : ', скрипт не завершился — поднял сам') + ')');
  return alive;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Absolute guarantee, independent of start_desktop.sh: whatever the script did
 * (or failed to do — e.g. it hung on a package prompt or on pcmanfm without
 * D-Bus), the window manager, the wallpaper and x11vnc MUST be up on this
 * display. This is the difference between «noVNC отвечает» and «на экране
 * что-то видно».
 */
async function ensureEssentials() {
  if (!(await xDisplayUp())) return false;
  const fixes = [];
  const logFile = JSON.stringify(path.join(LOG_DIR, 'openbox.log'));
  if (!(await pgrep('openbox'))) {
    await sh(`DISPLAY=${DISPLAY} nohup openbox >>${logFile} 2>&1 &`, 8000);
    await sleep(1200);
    fixes.push('openbox');
  }
  if (!(await portOpen(VNC_PORT))) {
    const vlog = JSON.stringify(path.join(LOG_DIR, 'x11vnc.log'));
    await sh(`nohup x11vnc -display ${DISPLAY} -nopw -forever -shared -bg -localhost -rfbport ${VNC_PORT}`
      + ` -noxdamage -wirecopyrect top -alwaysshared >>${vlog} 2>&1 &`, 12000);
    for (let i = 0; i < 12; i++) {
      if (await portOpen(VNC_PORT)) break;
      await sleep(700);
    }
    if (await portOpen(VNC_PORT)) fixes.push('x11vnc');
    else state.note = 'x11vnc не поднялся: ' + (await sh(`tail -n 2 ${JSON.stringify(path.join(LOG_DIR, 'x11vnc.log'))}`, 5000)).out.slice(0, 160);
  }
  if (!(await pgrep('tint2'))) { await sh(`DISPLAY=${DISPLAY} nohup tint2 >/dev/null 2>&1 &`, 6000); fixes.push('tint2'); }
  // Обои — последними: feh выставляет корневой pixmap и сразу выходит (процесса
  // нет), а любой перезапуск Xvfb этот pixmap обнуляет — тогда экран снова
  // чёрный при живых иконках (проверено скриншотом).
  if (state.wall && fs.existsSync(state.wall) && (await which('feh'))) {
    await sh(`DISPLAY=${DISPLAY} feh --bg-scale ${JSON.stringify(state.wall)} 2>/dev/null`, 10000);
    fixes.push('обои');
  }
  // Иконки: idesk, иначе (если пакета нет) pcmanfm --desktop.
  if (!(await pgrep('idesk')) && (await which('idesk'))) {
    await sh(`DISPLAY=${DISPLAY} nohup idesk >/dev/null 2>&1 &`, 6000);
    fixes.push('idesk');
  } else if (!(await pgrep('idesk')) && !(await pgrep('pcmanfm'))) {
    await sh(`DISPLAY=${DISPLAY} nohup pcmanfm --desktop >/dev/null 2>&1 &`, 6000);
    fixes.push('pcmanfm');
  }
  // Экран, который «работает», но остался плоским — это и есть жалоба
  // «чёрный экран»: проверяем пиксели и, если плоско, перекрашиваем фон.
  const paint = await paintCheck();
  if (paint.checked && !paint.ok) {
    if (state.wall && fs.existsSync(state.wall)) {
      await sh(`DISPLAY=${DISPLAY} feh --bg-scale ${JSON.stringify(state.wall)} 2>/dev/null`, 10000);
      await sh(`DISPLAY=${DISPLAY} xsetroot -solid '#121c28' 2>/dev/null || true`, 6000);
    }
    const again = await paintCheck();
    fixes.push(`перекраска (${paint.colors}->${again.colors} цв.)`);
    state.paint = again.ok ? 'ok' : 'flat';
  } else if (paint.checked) {
    state.paint = 'ok';
  }
  if (fixes.length) state.log('доподнял: ' + fixes.join(', '));
  // «true» = экран видно (не «что-то починил»): иначе цикл ожидания в
  // fullStartInner всегда отматывал бы все 55 секунд даже на живом экране.
  return fixes.length > 0 || (await portOpen(VNC_PORT));
}

/** Re-spawn the desktop programs + x11vnc without touching Xvfb: the client
 *  reconnects and redraws, which is what clears a stale black screen. */
async function repair(repoRoot, why) {
  // Один запуск за раз: пока идёт старт/починка, новые не наслаиваются —
  // иначе два start_desktop.sh убивают Xvfb друг у друга (проверено).
  if (state.busy) return false;
  if (Date.now() - state.lastRepair < REPAIR_COOLDOWN_MS) return false;
  state.repairs++;
  state.lastRepair = Date.now();
  state.log('починка экрана (' + why + ')');
  await ensureWallpaper(false);
  const r = await runStartScript(repoRoot, true);
  await ensureShortcuts(process.env.PORT || 8090);
  await ensureAutostart();
  await ensureEssentials();
  if (!r.ok) {
    // Xvfb itself may be gone — go all the way up.
    return fullStart(repoRoot);
  }
  return true;
}

// ───────────────────────── the /novnc http proxy ─────────────────────────

const WS_PATHS = new Set([
  '/ws/desktop',           // page served from the hub (public/novnc)
  '/novnc/ws/desktop',     // noVNC 1.2 resolves 'path' relative to the page
  '/websockify',           // noVNC's default path
  '/novnc/websockify'
]);

function registerProxy(app, server) {
  // HTTP: the hub already ships the noVNC UI in public/novnc, so normally
  // nothing is proxied. Only when that copy is missing do we fall back to
  // whatever websockify serves on 6081, mounted under /novnc-proxy so the
  // built-in UI is never shadowed.
  if (!fs.existsSync(NOVNC_UI)) {
    app.use('/novnc-proxy', (req, res) => {
      const headers = { ...req.headers, host: `127.0.0.1:${NOVNC_PORT}` };
      delete headers['accept-encoding'];
      const p = http.request({
        host: '127.0.0.1', port: Number(NOVNC_PORT), path: req.url, method: req.method, headers
      }, (pr) => {
        res.writeHead(pr.statusCode || 502, pr.headers);
        pr.pipe(res);
      });
      p.on('error', () => {
        if (!res.headersSent) res.statusCode = 502;
        res.end('noVNC on this runner is not answering yet');
      });
      req.pipe(p);
    });
  }

  // WebSocket: the noVNC client's socket → tcp 127.0.0.1:5901 (this runner's
  // x11vnc). noServer + our own listener, so it never fights the /ws
  // (terminals) or /ws/vnc (cloud phone) servers over the 'upgrade' event.
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
    catch { return; }
    if (!WS_PATHS.has(u.pathname.replace(/\/+$/, ''))) return;
    try {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = net.connect(Number(VNC_PORT), '127.0.0.1');
      const kill = () => { try { tcp.destroy(); } catch {} try { ws.terminate(); } catch {} };
      tcp.on('error', kill);
      tcp.on('connect', () => state.x11vnc = 'up');
      tcp.on('data', (d) => { if (ws.readyState === 1) ws.send(d, { binary: true }); });
      ws.on('message', (d) => { try { tcp.write(d); } catch {} });
      ws.on('close', kill);
      ws.on('error', kill);
    });
    } catch (e) {
      console.log('  🖥 ws/desktop upgrade: ' + e.message);
      try { socket.destroy(); } catch {}
    }
  });
  state.proxy = '/novnc';
}

// ──────────────────────────── status + tick ─────────────────────────────

/** The URL the panel should embed: served from the hub's own origin. */
async function localStatus() {
  if (!state.enabled) return { url: null, ready: false };
  const x = await xDisplayUp();
  const vnc = await portOpen(VNC_PORT);
  if (!x || !vnc) return { url: null, ready: false, display: x, x11vnc: vnc };
  state.hubUrl = hubPublicUrl();
  const base = state.hubUrl || '';
  const ui = fs.existsSync(NOVNC_UI) ? '/novnc/vnc.html' : `/novnc-proxy/vnc.html?path=websockify`;
  return {
    url: `${base}${ui}?${NOVNC_QUERY}`,
    ready: true, novnc: true, display: true, screen: vnc,
    base: base || '(относительный адрес)'
  };
}

let repoRootRef = null;
let ticking = false;

async function tick() {
  if (!state.enabled || ticking) return;
  ticking = true;
  try {
    state.lastTick = Date.now();
    const [x, vnc, ui, wm] = await Promise.all([
      xDisplayUp(),
      portOpen(VNC_PORT),
      Promise.resolve(fs.existsSync(NOVNC_UI)),
      pgrep('openbox')
    ]);
    state.desktop = x && wm ? 'up' : 'down';
    state.novnc = ui ? 'up' : 'down';
    state.x11vnc = vnc ? 'up' : 'down';
    if (!x || !vnc || !ui || !wm) {
      const why = [!x && 'нет X', !wm && 'нет openbox', !vnc && `нет x11vnc:${VNC_PORT}`, !ui && 'нет noVNC-UI']
        .filter(Boolean).join(', ');
      await repair(repoRootRef, why);
    }
  } catch (e) {
    state.note = 'tick: ' + e.message;
  } finally {
    ticking = false;
  }
}

function status() {
  return {
    enabled: state.enabled,
    busy: state.busy,
    platform: state.platform,
    display: DISPLAY,
    ports: { vnc: VNC_PORT, novnc: NOVNC_PORT },
    desktop: state.desktop,
    novnc: state.novnc,
    x11vnc: state.x11vnc,
    proxy: state.proxy,
    hubUrl: state.hubUrl || hubPublicUrl(),
    wall: state.wall,
    paint: state.paint,
    starts: state.starts,
    repairs: state.repairs,
    lastTick: state.lastTick ? new Date(state.lastTick).toISOString() : null,
    note: state.note
  };
}

/**
 * Boot the always-on desktop for this runner.
 * @param {{repoRoot:string, app:object, server:object, port:number, log?:Function}} opts
 */
function start(opts = {}) {
  state.log = typeof opts.log === 'function' ? opts.log : (m) => console.log('  🖥 ' + m);
  if (process.platform !== 'linux') {
    state.note = 'desktop unavailable on ' + process.platform;
    return { status, localStatus, ensureNow: async () => false, repair: async () => false, registerProxy: () => {}, stop: () => {}, keepalive: state };
  }
  const has = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, 'tools', 'start_desktop.sh'));
  // Prefer the checkout this very file lives in (npm-hub/src → ../.. = repo
  // root), then whatever the caller resolved (workspace/fork on Actions, the
  // work dir elsewhere). Without this a hub started by hand would look for the
  // desktop script in ~/hub-work and silently skip the always-on screen.
  const own = path.resolve(__dirname, '..', '..');
  const root = has(own) ? own : (has(opts.repoRoot) ? opts.repoRoot : null);
  if (!root) {
    state.note = 'start_desktop.sh не найден (искал в ' + own + ' и ' + (opts.repoRoot || '?') + ')';
    state.log('экран недоступен: ' + state.note);
    return { status, localStatus, ensureNow: async () => false, repair: async () => false, registerProxy: () => {}, stop: () => {}, keepalive: state };
  }
  repoRootRef = root;
  state.enabled = true;
  state.note = 'starting';
  if (opts.app && opts.server) {
    try { registerProxy(opts.app, opts.server); } catch (e) { state.note = 'proxy: ' + e.message; }
  }
  // Kill any stale desktop from a previous hub (or the vnc job of the same
  // runner), then bring ours up. Promises are deliberately not awaited: the
  // hub must finish booting (and answer /api/tools) while apt installs.
  (async () => {
    const w = await which('x11vnc');
    if (!w) state.log('ставлю desktop-стек (первый раз, ~1 мин)…');
    const ok = await fullStart(repoRootRef);
    if (ok) {
      state.note = 'running';
      // Prove the pixels are really there: the top-left 40x40 must not be a
      // single flat colour (that is exactly the black screen the user saw).
      const shot = await sh(`DISPLAY=${DISPLAY} import -window root -crop 40x40+0+0 txt:- 2>/dev/null | tail -n +2 | awk '{print $3}' | sort -u | wc -l`, 20000);
      const colors = parseInt(shot.out, 10);
      state.paint = colors > 1 ? 'ok' : 'flat';
      state.note = colors > 1 ? 'running (paint ok)' : 'running (paint flat?)';
    }
  })();
  const timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 5000);
  return {
    status,
    localStatus,
    ensureNow: () => fullStart(repoRootRef),
    repair: (why) => repair(repoRootRef, why || 'manual'),
    tick,
    registerProxy,
    stop: () => clearInterval(timer),
    keepalive: state
  };
}

module.exports = { start, gradientPng, SHORTCUTS };
