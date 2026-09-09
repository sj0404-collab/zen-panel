#!/usr/bin/env bash
# Zen Panel on a local PC, no GitHub Actions: starts npm-hub and the desktop panel.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v node >/dev/null || { echo "Node.js 20+ is required: https://nodejs.org/"; exit 1; }
major=$(node -p "process.versions.node.split('.')[0]")
[ "$major" -ge 20 ] || { echo "Node.js 20+ is required (found $(node --version))"; exit 1; }

if [ ! -d "$ROOT/npm-hub/node_modules" ]; then
  echo "== installing npm-hub dependencies (first run only) =="
  (cd "$ROOT/npm-hub" && npm ci --no-audit --no-fund)
fi

PORT="${PORT:-8090}"
if [ -z "${HUB_TOKEN:-}" ]; then
  echo "tip: HUB_TOKEN=... $0  to gate the hub with a token (?zt=)"
fi
echo "== starting npm-hub on :$PORT =="
PORT="$PORT" nohup node "$ROOT/npm-hub/src/server.js" > /tmp/zen-hub.log 2>&1 &
echo "$!" > /tmp/zen-hub.pid
echo "hub pid $! (log /tmp/zen-hub.log, stop with pc-local/stop.sh)"

if [ -n "${DISPLAY:-}" ] || [ "$(uname -s)" = "Darwin" ]; then
  if [ -d "$ROOT/desktop/node_modules" ]; then
    echo "== opening the desktop panel =="
    (cd "$ROOT/desktop" && nohup npm start > /tmp/zen-panel.log 2>&1 &)
  else
    echo "desktop shell not installed - opening the hub in the browser instead."
    echo "install it later: cd desktop && npm install && npm start"
  fi
else
  echo "no display - the desktop shell is skipped (headless machine)."
fi
echo "  hub:     http://localhost:$PORT/"
echo "  desktop: http://localhost:$PORT/d"
echo "  mobile:  http://localhost:$PORT/m   (phone in the same LAN: http://<this-pc-ip>:$PORT/m)"
