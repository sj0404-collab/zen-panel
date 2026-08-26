#!/usr/bin/env node
'use strict';
/**
 * Tiny reverse proxy in front of `opencode serve`.
 *
 * Official `opencode web` is a heavy SPA that janks a phone WebView. This
 * process serves a one-file mobile chat at `/` and forwards everything else
 * (REST + SSE) to the headless server on 127.0.0.1:4096, so the panel talks
 * to one origin and does not hit CORS.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const LISTEN = process.env.OC_LISTEN || '0.0.0.0';
const PORT = Number(process.env.OC_PORT || 4100);
const UP_HOST = process.env.OC_UP_HOST || '127.0.0.1';
const UP_PORT = Number(process.env.OC_UP_PORT || 4096);
const HTML = fs.readFileSync(path.join(__dirname, 'oc-mobile.html'));

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
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });
  p.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('OpenCode serve is down');
  });
  req.pipe(p);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/mobile')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(HTML);
    return;
  }
  proxy(req, res);
});

server.listen(PORT, LISTEN, () => {
  console.log('oc-gateway http://' + LISTEN + ':' + PORT + ' → ' + UP_HOST + ':' + UP_PORT);
});
