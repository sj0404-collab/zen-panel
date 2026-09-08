'use strict';
// Pure panel-serving helpers for the desktop shell. No Electron dependency,
// so the CI syntax job and test-panel-store.js exercise this with plain node.
//
// This mirrors app/src/main/java/dev/zen/panel/PanelAssets.kt + the host
// policy from MainActivity.kt: the same pages, the same allow-list, the same
// "panel is local, the GitHub API is not" split.

const fs = require('fs');
const path = require('path');

const PANEL_HOST = 'panel.symbiosis.local';
const PANEL_SCHEME = 'zen-panel';
const PANEL_URL = `${PANEL_SCHEME}://${PANEL_HOST}/index.html`;
const APP_ID = 'dev.zen.panel.desktop';

// Everything the panel may serve. An allow-list rather than a bare read: it
// keeps a stray request from probing the disk, and it fails loudly if a page
// is renamed without updating it. Mirrors PanelAssets.ALLOWED.
const ALLOWED = new Set([
  'index.html',
  'desks.html',
  'icon.svg',
  'manifest.webmanifest',
]);

// Hosts the shell keeps inside its own windows (tunnels serve the sessions).
// Mirrors MainActivity.INTERNAL_SUFFIXES.
const INTERNAL_SUFFIXES = [
  'trycloudflare.com',
  'cfargotunnel.com',
  'ngrok-free.app',
  'ngrok.io',
  'ngrok.app',
  'github.io',
];

function isInternal(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === PANEL_HOST) return true;
  return INTERNAL_SUFFIXES.some(s => h === s || h.endsWith('.' + s));
}

function mimeFor(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8';
  if (name.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  if (name.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (name.endsWith('.json') || name.endsWith('.webmanifest')) return 'application/json; charset=utf-8';
  if (name.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

// Maps a request path onto a file in the panel dir, refusing anything that
// tries to climb out of it. Returns the file name, 'version.json' for the
// synthesized build descriptor, or null.
function fileNameFor(pathname) {
  let p = String(pathname || '');
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  p = p.replace(/^\/+/, '');
  if (!p) return 'index.html';
  if (p === 'version.json') return 'version.json';
  // No traversal, no subdirectories: the panel is a flat set of files.
  if (p.includes('..') || p.includes('/') || p.includes('\\')) return null;
  if (!ALLOWED.has(p)) return null;
  return p;
}

function defaultBuildInfo() {
  return { versionCode: 0, versionName: 'dev', sha: '' };
}

// Build descriptor baked by CI (desktop/build-info.json). Missing in a dev
// checkout, where zeros simply mean "not a packaged build".
function readBuildInfo(appDir) {
  try {
    const raw = fs.readFileSync(path.join(appDir, 'build-info.json'), 'utf8');
    const j = JSON.parse(raw);
    return {
      versionCode: parseInt(j.versionCode, 10) || 0,
      versionName: String(j.versionName || 'dev'),
      sha: String(j.sha || ''),
    };
  } catch {
    return defaultBuildInfo();
  }
}

function versionJson(build) {
  const b = build || defaultBuildInfo();
  return JSON.stringify({
    versionCode: b.versionCode,
    versionName: b.versionName,
    applicationId: APP_ID,
  });
}

const MISSING_PAGE =
  '<!doctype html><meta charset=utf-8>' +
  '<body style="background:#0d0d12;color:#e8e8f0;font:15px sans-serif;padding:24px">' +
  '<h3>Страница не входит в сборку</h3>' +
  '<p style="color:#8a8a9e">Этот файл не был упакован в приложение. ' +
  'Обычно это значит, что сборка собрана не полностью — переустановите приложение.</p>';

function baseHeaders() {
  return {
    // The panel must not be cached across upgrades, or a reinstall could keep
    // showing the previous build's pages.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

// Serves one request path out of the panel dir.
// Returns { status, headers, body: Buffer }.
function servePath(panelDir, pathname, build) {
  const name = fileNameFor(pathname);
  if (name === 'version.json') {
    return { status: 200, headers: { ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8' }, body: Buffer.from(versionJson(build), 'utf8') };
  }
  if (!name) {
    return { status: 404, headers: { ...baseHeaders(), 'Content-Type': 'text/html; charset=utf-8' }, body: Buffer.from(MISSING_PAGE, 'utf8') };
  }
  try {
    const data = fs.readFileSync(path.join(panelDir, name));
    return { status: 200, headers: { ...baseHeaders(), 'Content-Type': mimeFor(name) }, body: data };
  } catch {
    return { status: 404, headers: { ...baseHeaders(), 'Content-Type': 'text/html; charset=utf-8' }, body: Buffer.from(MISSING_PAGE, 'utf8') };
  }
}

module.exports = {
  PANEL_HOST,
  PANEL_SCHEME,
  PANEL_URL,
  APP_ID,
  ALLOWED,
  INTERNAL_SUFFIXES,
  isInternal,
  mimeFor,
  fileNameFor,
  defaultBuildInfo,
  readBuildInfo,
  versionJson,
  servePath,
};
