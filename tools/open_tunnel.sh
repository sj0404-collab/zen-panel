#!/usr/bin/env bash
# Put a local HTTP port on the public internet with a Cloudflare quick tunnel.
#
# The URL printed by this script is usable only while the cloudflared process
# below is alive. A quick-tunnel hostname may appear in the log before the
# Cloudflare edge has a connector, so this script waits for a real HTTP answer
# and refuses to publish an Error 1033 page.
#
# Usage: open_tunnel.sh <local-port> [log-file]
# Prints one ready https URL on stdout, or nothing and exit 1.

set -uo pipefail

PORT="${1:?usage: open_tunnel.sh <local-port> [log]}"
case "$PORT" in
  ''|*[!0-9]*) echo "open_tunnel: invalid port: $PORT" >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "open_tunnel: invalid port: $PORT" >&2
  exit 1
fi

HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
HUB_TMP="${HUB_TMP:-$HOME/.npm-hub/tmp}"
mkdir -p "$HUB_LOGS" "$HUB_TMP"
LOG="${2:-$HUB_LOGS/cloudflared-$PORT.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
PIDFILE="$HUB_LOGS/cloudflared-$PORT.pid"
URLFILE="$HUB_LOGS/cloudflared-$PORT.url"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill only the connector for this origin. The bracket in the pattern keeps
# pkill from matching the shell that is executing this script. The pidfile is
# preferred because it cannot accidentally match another tunnel.
kill_old() {
  local old=""
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$old" 2>/dev/null || break
      sleep 1
    done
  fi
  rm -f "$PIDFILE" "$URLFILE"
  pkill -f "cloudflared [t]unnel --url http://localhost:$PORT" 2>/dev/null || true
  pkill -f "cloudflared [t]unnel --url http://127[.]0[.]0[.]1:$PORT" 2>/dev/null || true
}
kill_old

if ! command -v cloudflared >/dev/null 2>&1; then
  download="$HUB_TMP/cloudflared.$$"
  if ! curl -fL --retry 3 --connect-timeout 15 -o "$download" \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64; then
    rm -f "$download"
    echo "open_tunnel: cloudflared download failed" >&2
    exit 1
  fi
  chmod +x "$download"
  if sudo -n mv "$download" /usr/local/bin/cloudflared 2>/dev/null; then
    :
  else
    mkdir -p "$HOME/.local/bin"
    mv "$download" "$HOME/.local/bin/cloudflared"
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

CF="$(command -v cloudflared 2>/dev/null || true)"
if [ -z "$CF" ] || [ ! -x "$CF" ]; then
  echo "open_tunnel: cloudflared is not executable" >&2
  exit 1
fi

# Use IPv4 explicitly. On some hosts localhost resolves to ::1 while the
# service listens only on IPv4; cloudflared then stays alive with a dead origin.
nohup "$CF" tunnel --url "http://127.0.0.1:$PORT" \
  --no-autoupdate --loglevel info >"$LOG" 2>&1 &
PID=$!
echo "$PID" > "$PIDFILE"

URL=""
# The quick-tunnel hostname normally appears in 10–20 seconds. Keep polling
# for up to 80 seconds, but stop immediately if the connector exits.
for _ in $(seq 1 40); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "open_tunnel: cloudflared exited before reporting an address" >&2
    tail -30 "$LOG" >&2 2>/dev/null || true
    rm -f "$PIDFILE"
    exit 1
  fi
  URL="$(grep -Eo 'https://[a-zA-Z0-9-]+[.]trycloudflare[.]com' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 2
done

if [ -z "$URL" ]; then
  echo "open_tunnel: no address after 80s" >&2
  tail -30 "$LOG" >&2 2>/dev/null || true
  kill "$PID" 2>/dev/null || true
  rm -f "$PIDFILE"
  exit 1
fi

# The hostname existing in DNS is not enough. Wait until a request reaches the
# origin; this is what prevents publishing the exact URL that shows Error 1033.
READY=0
for _ in $(seq 1 30); do
  if "$SCRIPT_DIR/tunnel_health.sh" "$URL" "/"; then
    READY=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 2
done

if [ "$READY" != 1 ]; then
  echo "open_tunnel: Cloudflare edge never became ready (possible Error 1033)" >&2
  tail -30 "$LOG" >&2 2>/dev/null || true
  kill "$PID" 2>/dev/null || true
  rm -f "$PIDFILE" "$URLFILE"
  exit 1
fi

# Consumers/watchdogs can verify which URL belongs to this pid. Write it only
# after the health check and atomically so a concurrent reader never sees a
# half-written hostname.
printf '%s\n' "$URL" > "$URLFILE.tmp.$$"
mv -f "$URLFILE.tmp.$$" "$URLFILE"
printf '%s\n' "$URL"
