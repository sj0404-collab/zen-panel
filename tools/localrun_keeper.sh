#!/usr/bin/env bash
# localhost.run SIXTH leg for the hub endpoint (and for the desktop VM).
#
# WHY
#   This leg exists for one hard requirement: NO ACCOUNT, NO PASSWORD, NO
#   AUTH KEY. Everything that is "nicer" than a quick tunnel wants a login -
#   Tailscale Funnel needs an authkey and a tailnet policy with nodeAttrs,
#   named Cloudflare tunnels need a Zero Trust account, ngrok needs an
#   authtoken. A forgotten password on any of those is an outage that cannot be
#   undone from the runner, because the runner is ephemeral by design.
#   localhost.run needs nothing: `ssh -R 80:localhost:<port> nokey@localhost.run`
#   and the public address appears in the output. It shares no failure domain
#   with the cloudflare pair, ngrok or tunnl.gg.
#
# WHY IT IS LAST IN THE ORDER
#   The address is anonymous and random on every reconnect, and the service may
#   answer a browser with a "you are tunnelling through localhost.run" notice.
#   The connect page therefore probes it after tgg, cloudflare and ngrok, and
#   the keeper only publishes it after a plain non-browser request has actually
#   reached the origin (tools/tunnel_health.sh).
#
# OWNS
#   One `ssh -R` agent per VM: start, restart with backoff, health probes, and
#   publishing the address into the live session descriptor as `lr`. Full
#   descriptor republish style (same as ngrok_keeper / tunnl_keeper) so no key
#   is ever lost.
set -uo pipefail

VM="${1:-hub}"
case "$VM" in hub|vnc) ;; *) echo "[localrun-keeper] unknown VM '$VM' (hub|vnc)" >&2; exit 1 ;; esac

HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
HUB_TMP="${HUB_TMP:-$HOME/.npm-hub/tmp}"
mkdir -p "$HUB_LOGS" "$HUB_TMP" 2>/dev/null || true
TOOLS_DIR="${LR_TOOLS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
[ -z "$TOKEN" ] && { echo "[localrun-keeper] no GitHub token - staying off" >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "[localrun-keeper] no ssh client - staying off" >&2; exit 1; }

if [ "$VM" = "vnc" ]; then
  PORT="${LR_VNC_PORT:-6081}"          # noVNC/websockify на деске
  URLFILE="$HUB_LOGS/vnc-url"
  R_URLFILE="$HUB_LOGS/vnc-url2"
  NGROK_URLFILE=""
else
  PORT=8090
  URLFILE="$HUB_LOGS/hub-url"           # main cloudflared leg (read-only here)
  R_URLFILE="$HUB_LOGS/hub-url2"        # reserve cloudflared leg (read-only here)
  NGROK_URLFILE="$HUB_LOGS/hub-ngrok.url"
fi
TGG_URLFILE="$HUB_LOGS/$VM-tgg.url"    # tunnl.gg leg (read-only here)
LR_URLFILE="$HUB_LOGS/$VM-lr.url"
PIDFILE="$HUB_LOGS/localrun-$VM.pid"
LOG="$HUB_LOGS/localrun-$VM.log"
KNOWN_HOSTS="$HUB_TMP/localrun-$VM.known_hosts"
INTERVAL="${LR_KEEPER_INTERVAL:-60}"
COOLDOWN="${LR_KEEPER_COOLDOWN:-180}"
FAILS_REST=30                           # after this many consecutive failed starts, slow down hard
UNHEALTHY_LIMIT="${LR_KEEPER_UNHEALTHY_LIMIT:-5}"   # consecutive dead probes before a reconnect

log() { echo "[localrun-keeper $(date -u '+%H:%M:%S')] $*" >> "$HUB_LOGS/localrun-keeper.log"; }
# NB: log() must NOT touch stdout - start_tunnel runs under $(...) capture, and
# any leak lands in the published lr= address (same lesson as run 379).

# The service has used two domains (localhost.run, and lhr.life after it). Match
# both instead of hardcoding one: an address printed in an unknown shape must
# never be published as-is.
addr_from_log() {
  grep -Eo 'https://[a-zA-Z0-9.-]+\.(localhost\.run|lhr\.life)' "$LOG" 2>/dev/null | tail -1 || true
}

start_tunnel() {  # echoes the public URL on success, nothing on failure
  local pid url i
  : > "$LOG"
  # -n -T: no stdin, no tty, so the client can never sit waiting for a password
  # prompt on a headless runner. BatchMode=yes makes a key-based login failure
  # an immediate error instead of a hang. accept-new pins the host key on first
  # contact without an interactive prompt, into a throwaway known_hosts file -
  # the runner is new every run, so the user's real ~/.ssh/known_hosts is never
  # touched.
  nohup ssh -n -T \
      -o BatchMode=yes \
      -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$KNOWN_HOSTS" \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -R "80:localhost:$PORT" nokey@localhost.run \
      >"$LOG" 2>&1 &
  pid=$!
  echo "$pid" > "$PIDFILE"
  url=""
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    url="$(addr_from_log)"
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

healthy() {  # $1 = base url: a real request through the public edge
  # Any HTTP body proves the pipe is alive: the hub answers "/" 401 to
  # anonymous callers, the desk's real page is /vnc.html. A body that is the
  # service's own notice page is treated as dead - it means the tunnel is up
  # but the address is not usable for a browser, which is exactly the state the
  # panel must not be handed.
  local target="${1:-}/"
  [ "$VM" = "vnc" ] && target="${1%/}/vnc.html"
  local body
  body="$(curl -s -m 15 -A 'zen-panel-tunnel-health/1' "$target" 2>/dev/null || true)"
  [ -n "${body:-}" ] || return 1
  case "$body" in
    *"localhost.run"*|*"lhr.life"*) case "$body" in *"<html"*|*"<HTML"*) return 1 ;; esac ;;
  esac
  return 0
}

publish_full() {  # $1 = lr base url (always non-empty here)
  local main reserve ng tgg lr="$1"
  main="$(cat "$URLFILE" 2>/dev/null || true)"
  reserve="$(cat "$R_URLFILE" 2>/dev/null || true)"
  tgg="$(cat "$TGG_URLFILE" 2>/dev/null || true)"
  ng=""
  [ -n "${NGROK_URLFILE:-}" ] && ng="$(cat "$NGROK_URLFILE" 2>/dev/null || true)"
  if [ "$VM" = "vnc" ]; then
    # Only the lr field is ours: url/novncUrl keep the cloudflare pair so
    # publishers don't tug-of-war; the READER (hub server.js) prefers it.
    GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
      "slot=vnc" "kind=Linux-VNC" "os=linux" \
      "lr=$lr/vnc.html" \
      "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
    return
  fi
  GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
    "slot=hub-linux" "kind=NPM-Hub" "os=linux" \
    ${main:+"url=$main"} ${main:+"hubUrl=$main"} ${main:+"desktop=$main/d"} ${main:+"mobile=$main/m"} \
    ${reserve:+"url2=$reserve"} \
    ${ng:+"ngrok=$ng"} \
    ${tgg:+"tgg=$tgg"} \
    "lr=$lr" \
    "auth=без пароля" "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
}

# HOW OFTEN
#   One probe a minute, not one every 15 seconds (user decision 17.10). A dead
#   probe only counts after UNHEALTHY_LIMIT consecutive misses, so a slow edge,
#   a GC pause or a game saturating the CPU costs nothing: nothing is restarted
#   until the address has been unreachable for five straight minutes. That is
#   the difference between a tunnel that is watched and a tunnel that is flogged.
trap 'log "stopped"; exit 0' TERM INT
log "keeper up (port $PORT; no account, no key - publishes .lr; one probe/min, reconnect only after $UNHEALTHY_LIMIT dead probes)"

LAST_URL="$(cat "$LR_URLFILE" 2>/dev/null || true)"
FAILS=0
UNHEALTHY=0
while true; do
  sleep "$INTERVAL"
  pid=""
  [ -f "$PIDFILE" ] && pid="$(tr -dc '0-9' < "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    url="$(cat "$LR_URLFILE" 2>/dev/null || true)"
    if [ -n "$url" ] && healthy "$url"; then
      UNHEALTHY=0
      if [ "$url" != "$LAST_URL" ]; then
        LAST_URL="$url"
        log "localhost.run address changed: $url - republishing"
        publish_full "$url" || true
      fi
      continue
    fi
    UNHEALTHY=$((UNHEALTHY + 1))
    if [ "$UNHEALTHY" -ge "$UNHEALTHY_LIMIT" ]; then
      log "localhost.run leg unhealthy $UNHEALTHY probes in a row (~$((UNHEALTHY * INTERVAL / 60)) min) - reconnecting"
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
    echo "$url" > "$LR_URLFILE"
    # The address existing is not reachability: publish only what answered.
    if ! healthy "$url"; then
      log "localhost.run up but not usable yet: $url - holding the publish"
      continue
    fi
    if [ "$url" != "$LAST_URL" ]; then
      LAST_URL="$url"
      log "localhost.run tunnel up: $url"
      publish_full "$url" || true
    else
      log "localhost.run tunnel up (same address): $url"
    fi
  else
    FAILS=$((FAILS + 1))
    wait_s="$COOLDOWN"
    if [ "$FAILS" -ge "$FAILS_REST" ]; then wait_s=$((COOLDOWN * 30)); fi
    log "tunnel start failed #$FAILS; backing off ${wait_s}s (see localrun-$VM.log)"
    sleep "$wait_s"
  fi
done