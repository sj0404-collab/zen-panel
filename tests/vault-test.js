// Внешняя память (vault): движок зеркала (diff/пропуск >50МБ/удалено на сервере)
// на фейковой IndexedDB + статические проверки вёрстки standalone PWA.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'npm-hub', 'public');
const src = fs.readFileSync(path.join(PUB, 'vault.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' got=' + JSON.stringify(extra) : '')); }
}

const sandbox = { console, Promise, Object, Date, JSON, String, Array, encodeURIComponent, RegExp, Math };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const Vault = sandbox.Vault;
check('v vault.js defines Vault engine', typeof Vault === 'object' && typeof Vault.plan === 'function');
check('v 50MB cap constant', Vault.MAX_BYTES === 50 * 1024 * 1024);

function FakeDB() { this.meta = {}; this.blobs = {}; this.state = {}; }
const db = new FakeDB();
Vault._db = {
  get: (s, k) => Promise.resolve(db[s][k] || null),
  put: (s, v) => Promise.resolve().then(() => { db[s][v.path || v.k] = v; }),
  del: (s, k) => Promise.resolve().then(() => { delete db[s][k]; }),
  all: (s) => Promise.resolve(Object.keys(db[s]).map(k => db[s][k]))
};
Vault.setDb(Vault._db);

const bigSize = 60 * 1024 * 1024;
const locals = [
  { path: '/hw/a/keep.txt', isDir: false, size: 10, mtime: 111, serverOk: true, serverDeleted: false },
  { path: '/hw/a/old.txt', isDir: false, size: 20, mtime: 222, serverOk: true, serverDeleted: false },
  { path: '/hw/z/gone.txt', isDir: false, size: 5, mtime: 333, serverOk: true, serverDeleted: false }
];
const tree = [
  { path: '/hw/a', isDir: true, size: 0, mtime: 1 },
  { path: '/hw/a/keep.txt', isDir: false, size: 10, mtime: 111 },
  { path: '/hw/a/old.txt', isDir: false, size: 25, mtime: 999 },
  { path: '/hw/a/new.txt', isDir: false, size: 7, mtime: 444 },
  { path: '/hw/big.apk', isDir: false, size: bigSize, mtime: 555 }
];
const p = Vault.plan(locals, tree, Vault.MAX_BYTES);
const dirtyNames = p.dirty.map(e => e.path);
check('v changed file is re-downloaded', dirtyNames.includes('/hw/a/old.txt'), dirtyNames);
check('v unchanged file is kept', p.dirty.length === 2 && !dirtyNames.includes('/hw/a/keep.txt'), dirtyNames);
check('v new file is downloaded', dirtyNames.includes('/hw/a/new.txt'), dirtyNames);
check('v >50MB file is skipped, not downloaded',
  p.big.some(b => b.path === '/hw/big.apk') && p.big[0].size === bigSize &&
  !dirtyNames.includes('/hw/big.apk'), JSON.stringify({ big: p.big, dirtyNames }));
check('v file deleted on server is marked, not erased', p.markDeleted.includes('/hw/z/gone.txt'), p.markDeleted);

// Functional sync: fake fetch serves a tree, then per-file downloads.
// Preload the mirror as if it had already synced once (keep/old/gone present).
locals.forEach(function (m) { db.meta[m.path] = m; });
let dlCalls = [];
let syncRes, state;
const fetchImpl = {
  fetch: (url) => {
    const u = String(url);
    if (u.includes('/api/fs/tree')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, root: '/hw', maxBytes: Vault.MAX_BYTES, entries: tree, files: 4, totalBytes: bigSize + 42, big: [{ path: '/hw/big.apk', size: bigSize }] })
      });
    }
    if (u.includes('/api/fs/download')) {
      dlCalls.push(u);
      const pth = decodeURIComponent(u.split('?path=')[1]);
      return Promise.resolve({ ok: true, blob: () => Promise.resolve('DATA:' + pth) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  }
};

(async () => {
  syncRes = await Vault.sync('', fetchImpl, null, Vault.MAX_BYTES);
  state = syncRes.state;
  check('v sync ok', syncRes.ok === true, syncRes);
  check('v state marks skipped big', state && state.skipped === 1 && state.skippedSize === bigSize, state);
  check('v download url is binary-safe + encoded',
    dlCalls.length === 2 &&
    dlCalls.every(u => u.startsWith('/api/fs/download?path=')) &&
    dlCalls.some(u => !u.split('?path=')[1].includes('/')), dlCalls);
  check('v unchanged file not re-downloaded', dlCalls.length === 2 &&
    !dlCalls.some(u => decodeURIComponent(u).includes('keep.txt')), dlCalls);
  check('v changed + new downloaded', dlCalls.length === 2 &&
    (decodeURIComponent(dlCalls[0]).includes('old.txt') || decodeURIComponent(dlCalls[0]).includes('new.txt')), dlCalls);
  check('v dir stored as meta', db.meta['/hw/a'] && db.meta['/hw/a'].isDir === true);
  check('v blob stored for every downloaded file',
    dlCalls.length === 2 && dlCalls.every(u => db.blobs[decodeURIComponent(u.split('?path=')[1])] !== undefined));
  check('v deleted file marked serverDeleted, blob not stored',
    db.meta['/hw/z/gone.txt'] && db.meta['/hw/z/gone.txt'].serverDeleted === true &&
    !Object.prototype.hasOwnProperty.call(db.blobs, '/hw/z/gone.txt'));
  check('v status serverOk set', state.serverOk === true && state.serverRoot === '/hw');
  let ch = await Vault.children('/hw/a');
  const chNames = ch.map(c => c.path).sort();
  check('v children lists one level (new synced in)',
    ch.length === 3 && chNames.join('|') === '/hw/a/keep.txt|/hw/a/new.txt|/hw/a/old.txt', chNames);
  check('v server-deleted file flagged in its dir',
    db.meta['/hw/z/gone.txt'].serverDeleted === true);
  await Vault.remove('/hw/a/new.txt');
  check('v remove drops blob+meta', !db.blobs['/hw/a/new.txt'] && !db.meta['/hw/a/new.txt']);
  ch = await Vault.children('/hw/a');
  check('v children after remove', ch.length === 2 &&
    !ch.some(c => c.path === '/hw/a/new.txt'), ch.map(c => c.path).sort());

  // Offline: fetch throws -> serverOk false, saved copies remain.
  dlCalls = [];
  const failFetch = { fetch: () => Promise.reject(new Error('offline')) };
  const r2 = await Vault.sync('', failFetch, null, Vault.MAX_BYTES);
  const st2 = await Vault.getState();
  check('v offline marks server dead', r2.ok === false && st2.serverOk === false, st2);

  // Static wiring of the standalone PWA.
  const pageHtml = fs.readFileSync(path.join(PUB, 'external-memory.html'), 'utf8');
  check('v page links its own manifest', pageHtml.includes('external-memory.webmanifest'));
  check('v page loads vault.js first', /<script src="vault\.js">/.test(pageHtml));
  check('v page registers vault-sw on its scope',
    pageHtml.includes("navigator.serviceWorker.register('vault-sw.js', { scope: './external-memory.html' })"));
  const manifest = JSON.parse(fs.readFileSync(path.join(PUB, 'external-memory.webmanifest'), 'utf8'));
  check('v manifest pins start_url + standalone', manifest.start_url === '/external-memory.html' &&
    manifest.scope === '/external-memory.html' && manifest.display === 'standalone' &&
    manifest.short_name === 'Память', manifest);
  const sw = fs.readFileSync(path.join(PUB, 'vault-sw.js'), 'utf8');
  check('v vault-sw precaches shell', /external-memory\.html/.test(sw) && /vault\.js/.test(sw));
  check('v vault-sw leaves /api/ alone', /\/api\//.test(sw));

  const server = fs.readFileSync(path.join(ROOT, 'npm-hub', 'src', 'server.js'), 'utf8');
  check('v server has tree endpoint', server.includes("'/api/fs/tree'") && server.includes('VAULT_MAX_BYTES'));
  check('v server serves /vault', server.includes("'/vault'") && server.includes("'external-memory.html'"));
  const desktop = fs.readFileSync(path.join(PUB, 'desktop.html'), 'utf8');
  check('v desktop tab added',
    desktop.includes("showPage('vault')") && desktop.includes('id="p-vault"') && desktop.includes('/external-memory.html'));
  const mobile = fs.readFileSync(path.join(PUB, 'mobile.html'), 'utf8');
  check('v mobile nav added',
    mobile.includes('id="nav-vault"') && desktop.includes('id="p-vault"') && mobile.includes('/external-memory.html'));

  console.log('\nVAULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();