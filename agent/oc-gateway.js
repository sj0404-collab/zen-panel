#!/usr/bin/env node
'use strict';
/**
 * Tiny reverse proxy in front of `opencode serve`.
 *
 * Two modes, chosen by OC_UI:
 *   OC_UI=web     (default) — proxy EVERYTHING to the headless server,
 *                  including `/`, so the real OpenCode web SPA (which
 *                  `opencode serve` serves itself) appears. This is the
 *                  original web UI on the same origin as the API.
 *   OC_UI=mobile  — serve a one-file mobile chat at `/` (oc-mobile.html) and
 *                  forward everything else. Because the official SPA is heavy
 *                  and janks a phone WebView, the lightweight chat was used.
 *
 * Either way the panel talks to one origin, so it does not hit CORS.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const urlMod = require('url');

const LISTEN = process.env.OC_LISTEN || '0.0.0.0';
const PORT = Number(process.env.OC_PORT || 4100);
const UP_HOST = process.env.OC_UP_HOST || '127.0.0.1';
const UP_PORT = Number(process.env.OC_UP_PORT || 4096);
const UI = String(process.env.OC_UI || 'web').toLowerCase();
// Only read the bundled mobile chat when it is actually used.
const MOBILE_HTML = UI === 'mobile' ? fs.readFileSync(path.join(__dirname, 'oc-mobile.html')) : null;

function proxy(req, res) {
  const headers = Object.assign({}, req.headers, { host: UP_HOST + ':' + UP_PORT });
  delete headers['accept-encoding'];
  const p = http.request({
    hostname: UP_HOST,
    port: UP_PORT,
    path: req.url,
    method: req.method,
    headers
  }, pr => {
    // The upstream may be a WebSocket-upgrade endpoint (opencode SSE uses
    // long-lived HTTP). Pass the status and headers through unchanged.
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });
  p.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('OpenCode serve is down');
  });
  req.pipe(p);
}

function serveMobileChat(res) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(MOBILE_HTML);
}

const server = http.createServer((req, res) => {
  const pathname = urlMod.parse(req.url || '/').pathname || '/';
  // In web mode, hand the root (the real SPA) to the upstream too.
  if (UI !== 'web' && req.method === 'GET' &&
      (pathname === '/' || pathname === '/index.html' || pathname === '/mobile')) {
    serveMobileChat(res);
    return;
  }
  proxy(req, res);
});

server.listen(PORT, LISTEN, () => {
  console.log(`oc-gateway (UI=${UI}) http://${LISTEN}:${PORT} → ${UP_HOST}:${UP_PORT}`);
});
