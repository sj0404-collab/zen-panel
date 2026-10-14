#!/usr/bin/env bash
# tunnl.gg FOURTH leg for the hub endpoint (SSH-based, no account).
#
# WHY
#   Legs 1-2 (trycloudflare quick tunnels) flap every 15-60 min by design;
#   leg 3 (ngrok static domain) is steady but dies for the rest of the month
#   when the free bandwidth quota is hit (ERR_NGROK_725, measured 14.10.26).
#   tunnl.gg is a fourth, provider-independent door with NO bandwidth cap.
#   Connecting as stable@ ties the address to OUR SSH key (repo secret
#   TUNNL_SSH_KEY), so the URL survives restarts, relays and re-installs.
#   Free tier: one session lives up to 24 h - the reconnect loop below just
#   re-establishes it, on the same address, transparency for the panel.
#
# OWNS
#   One `ssh -R` agent for the hub VM: key materialisation, start, restart
#   with backoff, health probes, and publishing the address into the live
#   session descriptor as `tgg`. Full-descriptor republish style (same as
#   ngrok_keeper.publish_full) so no key is ever lost.
set -uo pipefail

VM="${1:-hub}"
case "$VM" in hub|vnc) ;; *) echo "[tunnl-keeper] unknown VM '$VM' (hub|vnc)" >&2; exit 1 ;; esac

HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
HUB_TMP="${HUB_TMP:-$HOME/.npm-hub/tmp}"
mkdir -p "$HUB_LOGS" "$HUB_TMP" 2>/dev/null || true
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
KEY="${TUNNL_SSH_KEY:-}"
[ -z "$TOKEN" ] && { echo "[tunnl-keeper] no GitHub token - staying off" >&2; exit 1; }
[ -z "$KEY" ] && { echo "[tunnl-keeper] TUNNL_SSH_KEY is empty - staying off" >&2; exit 1; }

if [ "$VM" = "vnc" ]; then
  PORT="${TUNNL_VNC_PORT:-6081}"    # noVNC/websockify на деске
  URLFILE="$HUB_LOGS/vnc-url"
  R_URLFILE="$HUB_LOGS/vnc-url2"
  NGROK_URLFILE=""
else
  PORT=8090
  URLFILE="$HUB_LOGS/hub-url"       # main cloudflared leg (read-only here)
  R_URLFILE="$HUB_LOGS/hub-url2"    # reserve cloudflared leg (read-only here)
  NGROK_URLFILE="$HUB_LOGS/hub-ngrok.url"  # ngrok leg (read-only here)
fi
TGG_URLFILE="$HUB_LOGS/$VM-tgg.url"
PIDFILE="$HUB_LOGS/tunnl-$VM.pid"
JSONL="$HUB_LOGS/tunnl-$VM.jsonl"
LOG="$HUB_LOGS/tunnl-$VM.log"
KEYFILE="$HOME/.ssh/tunnl_ed25519"
INTERVAL="${TUNNL_KEEPER_INTERVAL:-15}"
COOLDOWN="${TUNNL_KEEPER_COOLDOWN:-60}"
FAILS_REST=30                       # after this many consecutive failed starts, slow down hard

log() { echo "[tunnl-keeper $(date -u '+%H:%M:%S')] $*" >> "$HUB_LOGS/tunnl-keeper.log"; }
# NB: log() must NOT touch stdout - start_tunnel runs under $(...) capture,
# and any leak lands in the published tgg= address (same lesson as run 379).

setup_key() {
  mkdir -p "$HOME/.ssh" 2>/dev/null || true
  printf '%s\n' "$KEY" > "$KEYFILE"
  chmod 700 "$HOME/.ssh" 2>/dev/null || true
  chmod 600 "$KEYFILE"
}

start_tunnel() {  # echoes the public URL on success, nothing on failure
  local pid url i
  : > "$JSONL"
  # -n -T: no stdin, no tty; output=json => stdout is a JSONL feed, the first
  # {"event":"tunnel",...} line carries the URL. accept-new pins the host key
  # on first contact without an interactive prompt.
  nohup ssh -n -T -i "$KEYFILE" -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=accept-new \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -R "80:localhost:$PORT" stable@proxy.tunnl.gg output=json \
      >"$JSONL" 2>"$LOG" &
  pid=$!
  echo "$pid" > "$PIDFILE"
  url=""
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    url=$(python3 - "$JSONL" <<'PY' 2>/dev/null || true
import json, sys
try:
    for line in open(sys.argv[1]):
        line = line.strip()
        if not line: continue
        try: d = json.loads(line)
        except Exception: continue
        if d.get("event") == "tunnel" and str(d.get("url", "")).startswith("https://"):
            print(d["url"]); break
except Exception:
    pass
PY
)
    [ -n "$url" ] && break
    sleep 2
  done
  if [ -z "$url" ]; then
    log "no address after 40s (ssh tail: $(tail -c 300 "$LOG" 2>/dev/null | tr '\n' ' '))"
    kill "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    return 1
  fi
  printf '%s\n' "$url"
}

healthy() {  # $1 = base url: any HTTP body proves the pipe is alive
             # (the hub answers "/" 401; the desk's real page is /vnc.html).
  local target="${1:-}/"
  [ "$VM" = "vnc" ] && target="${1%/}/vnc.html"
  local body
  body="$(curl -s -m 15 "$target" 2>/dev/null || true)"
  [ -n "${body:-}" ]
}

publish_full() {  # $1 = tgg base url (always non-empty here)
  local main reserve ng tgg="$1"
  main="$(cat "$URLFILE" 2>/dev/null || true)"
  reserve="$(cat "$R_URLFILE" 2>/dev/null || true)"
  ng=""
  [ -n "${NGROK_URLFILE:-}" ] && ng="$(cat "$NGROK_URLFILE" 2>/dev/null || true)"
  if [ "$VM" = "vnc" ]; then
    # Only the tgg field is ours: url/novncUrl keep the cloudflare pair so
    # publishers don't tug-of-war; the READER (hub server.js) prefers tgg.
    GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
      "slot=vnc" "kind=Linux-VNC" "os=linux" \
      "tgg=$tgg/vnc.html" \
      "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
    return
  fi
  GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
    "slot=hub-linux" "kind=NPM-Hub" "os=linux" \
    ${main:+"url=$main"} ${main:+"hubUrl=$main"} ${main:+"desktop=$main/d"} ${main:+"mobile=$main/m"} \
    ${reserve:+"url2=$reserve"} \
    ${ng:+"ngrok=$ng"} \
    "tgg=$tgg" \
    "auth=без пароля" "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
}

trap 'log "stopped"; exit 0' TERM INT
log "keeper up (port $PORT; stable SSH key -> one address; publishes .tgg)"
setup_key

LAST_URL="$(cat "$TGG_URLFILE" 2>/dev/null || true)"
FAILS=0
UNHEALTHY=0
while true; do
  sleep "$INTERVAL"
  pid=""
  [ -f "$PIDFILE" ] && pid="$(tr -dc '0-9' < "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    url="$(cat "$TGG_URLFILE" 2>/dev/null || true)"
    if [ -n "$url" ] && healthy "$url"; then
      UNHEALTHY=0
      if [ "$url" != "$LAST_URL" ]; then
        LAST_URL="$url"
        log "tunnl address changed: $url - republishing"
        publish_full "$url" || true
      fi
      continue
    fi
    UNHEALTHY=$((UNHEALTHY + 1))
    if [ "$UNHEALTHY" -ge 3 ]; then
      log "tunnl leg unhealthy $UNHEALTHY probes in a row - reconnecting ssh (same address returns: stable key)"
      kill "$pid" 2>/dev/null || true
      rm -f "$PIDFILE"
      UNHEALTHY=0
    fi
    continue
  fi
  url="$(start_tunnel || true)"
  case "$url" in https://*) ;; *) url="" ;; esac
  if [ -n "$url" ]; then
    FAILS=0
    echo "$url" > "$TGG_URLFILE"
    if [ "$url" != "$LAST_URL" ]; then
      LAST_URL="$url"
      log "tunnl tunnel up: $url"
      publish_full "$url" || true
    else
      log "tunnl tunnel up (same address): $url"
    fi
  else
    FAILS=$((FAILS + 1))
    wait_s="$COOLDOWN"
    if [ "$FAILS" -ge "$FAILS_REST" ]; then wait_s=$((COOLDOWN * 30)); fi
    log "tunnel start failed #$FAILS; backing off ${wait_s}s (see tunnl.log)"
    sleep "$wait_s"
  fi
done
