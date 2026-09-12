'use strict';
// Self-test for panel-store.js. Plain node, no Electron needed:
//   node test-panel-store.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./panel-store');

let n = 0;
const ok = (cond, label) => { n++; assert(cond, `FAIL: ${label}`); };

// Host policy (mirrors MainActivity.isInternal).
ok(store.isInternal('panel.symbiosis.local'), 'own host is internal');
ok(store.isInternal('x.trycloudflare.com'), 'tunnel suffix is internal');
ok(store.isInternal('TRYcloudflare.com'.toLowerCase()), 'case-insensitive');
ok(!store.isInternal('api.github.com'), 'api is external');
ok(!store.isInternal('evil-trycloudflare.com.evil.com'), 'lookalike suffix is external');
ok(!store.isInternal(''), 'empty host is external');

// Path mapping (mirrors PanelAssets.fileNameFor).
ok(store.fileNameFor('/') === 'index.html', 'root maps to index');
ok(store.fileNameFor('/desks.html') === 'desks.html', 'page maps');
ok(store.fileNameFor('/version.json') === 'version.json', 'version descriptor maps');
ok(store.fileNameFor('/%76ersion.json') === 'version.json', 'encoded path decodes');
ok(store.fileNameFor('/../main.js') === null, 'traversal blocked');
ok(store.fileNameFor('/%2e%2e/main.js') === null, 'encoded traversal blocked');
ok(store.fileNameFor('/sub/index.html') === null, 'subdirectory blocked');
ok(store.fileNameFor('/main.js') === null, 'non-panel file blocked');

// MIME map.
ok(store.mimeFor('index.html').startsWith('text/html'), 'html mime');
ok(store.mimeFor('manifest.webmanifest').startsWith('application/json'), 'manifest mime');

// Build info.
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-panel-test-'));
ok(store.readBuildInfo('/nonexistent-dir-xyz').versionCode === 0, 'missing build-info falls back');
fs.writeFileSync(path.join(fakeDir, 'build-info.json'), JSON.stringify({ versionCode: 41, versionName: '1.41.abc', sha: 'abc' }));
const bi = store.readBuildInfo(fakeDir);
ok(bi.versionCode === 41 && bi.versionName === '1.41.abc', 'build-info parses');
const vj = JSON.parse(store.versionJson(bi));
ok(vj.applicationId === 'dev.zen.panel.desktop' && vj.versionCode === 41, 'version.json shape');

// servePath against a fixture dir.
fs.writeFileSync(path.join(fakeDir, 'index.html'), '<h1>hi</h1>');
const hit = store.servePath(fakeDir, '/index.html', bi);
ok(hit.status === 200 && hit.body.toString() === '<h1>hi</h1>', 'serves allowed file');
ok(hit.headers['Cache-Control'] === 'no-store', 'no-store header');
const ver = store.servePath(fakeDir, '/version.json', bi);
ok(ver.status === 200 && JSON.parse(ver.body.toString()).versionCode === 41, 'serves version.json');
const miss = store.servePath(fakeDir, '/main.js', bi);
ok(miss.status === 404, 'blocks non-allowed file');
const gone = store.servePath(fakeDir, '/desks.html', bi);
ok(gone.status === 404, 'missing allowed file is 404');
fs.rmSync(fakeDir, { recursive: true, force: true });

console.log(`panel-store self-test: ${n} assertions passed`);
