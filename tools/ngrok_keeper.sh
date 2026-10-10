#!/usr/bin/env bash
# ngrok reserve leg (THIRD address) for the hub endpoint.
#
# WHY
#   Both Cloudflare quick tunnels share one failure domain: the trycloudflare
#   edge. Run 376 showed it - one address died mid-session and the phone went
#   «Офлайн» while the hub itself stayed perfectly healthy. ngrok is a
#   different provider, so its address keeps serving when every
#   trycloudflare leg is down; the connect page walks candidates in order
#   url -> url2 -> ngrok.
#
# OWNS
#   One `ngrok http <port>` agent for the hub VM: install, start, restart
#   with backoff, health probes, and publishing the address into the live
#   session descriptor as `ngrok`. The cloudflared pair (url/url2) is NOT
#   touched; every publish here re-sends the full descriptor (same style as
#   tunnel_keeper.publish_pair) so no key is lost.
#
# FREE-TIER NOTES
#   - The public URL changes on every agent restart -> republish on change.
#   - Browser hits see the ngrok interstitial page. Server-side health probes
#     below use a plain curl user-agent, which ngrok lets through; the hub
#     connect page sends `ngrok-skip-browser-warning: 1` on its preflight
#     (server.js whitelists that header in CORS).
#   - A dead address is left published until the next successful republish:
#     probing order makes that harmless (ngrok is tried last, and only when
#     both Cloudflare legs already failed).
set -uo pipefail

VM="${1:-hub}"
[ "$VM" = "hub" ] || { echo "[ngrok-keeper] hub VM only (free tier: one tunnel per account)" >&2; exit 1; }

HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
HUB_TMP="${HUB_TMP:-$HOME/.npm-hub/tmp}"
mkdir -p "$HUB_LOGS" "$HUB_TMP" 2>/dev/null || true
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
AUTHTOKEN="${NGROK_AUTHTOKEN:-}"
[ -z "$TOKEN" ] && { echo "[ngrok-keeper] no GitHub token - staying off" >&2; exit 1; }
[ -z "$AUTHTOKEN" ] && { echo "[ngrok-keeper] NGROK_AUTHTOKEN is empty - staying off" >&2; exit 1; }

PORT=8090
URLFILE="$HUB_LOGS/hub-url"        # main cloudflared leg (read-only here)
R_URLFILE="$HUB_LOGS/hub-url2"     # reserve cloudflared leg (read-only here)
NGROK_URLFILE="$HUB_LOGS/hub-ngrok.url"
PIDFILE="$HUB_LOGS/ngrok.pid"
LOG="$HUB_LOGS/ngrok.log"
INTERVAL="${NGROK_KEEPER_INTERVAL:-15}"
COOLDOWN="${NGROK_KEEPER_COOLDOWN:-60}"
API_URL="${NGROK_API_URL:-http://127.0.0.1:4040/api/tunnels}"
FAILS_REST=30                        # after this many consecutive failed starts, slow down hard

log() { echo "[ngrok-keeper $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/ngrok-keeper.log"; }

install_ngrok() {
  command -v ngrok >/dev/null 2>&1 && return 0
  local dl="$HUB_TMP/ngrok.tgz.$$"
  if curl -fL --retry 3 --connect-timeout 15 -o "$dl" \
      "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz"; then
    mkdir -p "$HOME/.local/bin"
    # The tarball contains a single `ngrok` binary at its root.
    tar -xzf "$dl" -C "$HOME/.local/bin" 2>/dev/null && chmod +x "$HOME/.local/bin/ngrok" 2>/dev/null || true
    export PATH="$HOME/.local/bin:$PATH"
  fi
  rm -f "$dl"
  command -v ngrok >/dev/null 2>&1
}

agent_url() {  # prints the https public URL if the local agent API answers
  curl -sf -m 5 "$API_URL" 2>/dev/null | python3 -c '
import json, os, sys
try:
    allow_http = os.environ.get("NGROK_ALLOW_HTTP_URLS") == "1"  # tests only
    d = json.load(sys.stdin)
    for t in d.get("tunnels") or []:
        u = str(t.get("public_url", ""))
        if u.startswith("https://") or (allow_http and u.startswith("http://")):
            print(u)
            break
except Exception:
    pass
' 2>/dev/null || true
}

healthy() {  # $1 = url; curl UA passes the ngrok interstitial by design
  [ -n "${1:-}" ] && curl -sf -m 10 -o /dev/null "$1/" 2>/dev/null
}

publish_full() {  # $1 = ngrok url (always non-empty here)
  local main reserve ng="$1"
  main="$(cat "$URLFILE" 2>/dev/null || true)"
  reserve="$(cat "$R_URLFILE" 2>/dev/null || true)"
  GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
    "slot=hub-linux" "kind=NPM-Hub" "os=linux" \
    ${main:+"url=$main"} ${main:+"hubUrl=$main"} ${main:+"desktop=$main/d"} ${main:+"mobile=$main/m"} \
    ${reserve:+"url2=$reserve"} \
    "ngrok=$ng" \
    "auth=без пароля" "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
}

start_agent() {  # echoes the new URL on success, nothing on failure
  local pid url i
  [ -f "$HOME/.config/ngrok/ngrok.yml" ] || ngrok config add-authtoken "$AUTHTOKEN" >/dev/null 2>&1 || true
  nohup ngrok http "http://127.0.0.1:$PORT" --log=stdout >"$LOG" 2>&1 &
  pid=$!
  echo "$pid" > "$PIDFILE"
  url=""
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    url="$(agent_url || true)"
    [ -n "$url" ] && break
    sleep 2
  done
  if [ -z "$url" ]; then
    log "no address after 40s (agent tail: $(tail -c 300 "$LOG" 2>/dev/null | tr '\n' ' '))"
    kill "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    return 1
  fi
  printf '%s\n' "$url"
}

trap 'log "stopped"; exit 0' TERM INT
log "keeper up (port $PORT; publishes .ngrok into the live session descriptor)"
install_ngrok || { log "ngrok download failed; retrying every loop"; }

LAST_URL="$(cat "$NGROK_URLFILE" 2>/dev/null || true)"
FAILS=0
UNHEALTHY=0
while true; do
  sleep "$INTERVAL"
  install_ngrok || continue
  pid=""
  [ -f "$PIDFILE" ] && pid="$(tr -dc '0-9' < "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    url="$(agent_url || true)"
    if [ -n "$url" ] && healthy "$url"; then
      UNHEALTHY=0
      if [ "$url" != "$LAST_URL" ]; then
        echo "$url" > "$NGROK_URLFILE"
        LAST_URL="$url"
        log "ngrok address changed: $url - republishing"
        publish_full "$url" || true
      fi
      continue
    fi
    UNHEALTHY=$((UNHEALTHY + 1))
    if [ "$UNHEALTHY" -ge 3 ]; then
      log "ngrok leg unhealthy $UNHEALTHY probes in a row - restarting the agent"
      kill "$pid" 2>/dev/null || true
      rm -f "$PIDFILE"
      UNHEALTHY=0
    fi
    continue
  fi
  url="$(start_agent || true)"
  if [ -n "$url" ]; then
    FAILS=0
    echo "$url" > "$NGROK_URLFILE"
    if [ "$url" != "$LAST_URL" ]; then
      LAST_URL="$url"
      log "ngrok tunnel up: $url"
      publish_full "$url" || true
    else
      log "ngrok tunnel up (same address): $url"
    fi
  else
    FAILS=$((FAILS + 1))
    wait_s="$COOLDOWN"
    if [ "$FAILS" -ge "$FAILS_REST" ]; then wait_s=$((COOLDOWN * 30)); fi
    log "agent start failed #$FAILS; backing off ${wait_s}s (see ngrok.log)"
    sleep "$wait_s"
  fi
done
