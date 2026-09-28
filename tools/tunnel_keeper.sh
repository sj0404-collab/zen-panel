#!/usr/bin/env bash
# Dual-tunnel keeper (Z11): one endpoint, TWO public addresses, all the time.
#
# WHY
#   A quick tunnel dies eventually; when it is the only address the user's
#   phone instantly shows «Не открывается» until somebody repairs it. With a
#   reserve address always warm, the app just walks over to it (see the hub
#   APK: url2 fallback) while this daemon resurrects the main one. Repair no
#   longer depends on the job's keep-alive step being alive: this loop owns
#   both addresses by itself.
#
# WHAT IT OWNS
#   main    the workflow's own address (opened by the job, refreshed by the
#           watchdog when that survives - this daemon only fills in when the
#           address dropped and stayed dropped for ~a minute)
#   reserve TUNNEL_TAG=reserve, its own pid/url/log files, refreshed here on
#           every death and republished straight into the session descriptor
#
# PUBLISHED KEYS (preserved by url2-merge upstream in this workflow)
#   hub: url, hubUrl, desktop, mobile + url2 (reserve base)
#   vnc: url, novncUrl (+ url /vnc.html) + url2 (reserve base)
set -uo pipefail

VM="${1:-hub}"          # hub | vnc
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
[ -z "$TOKEN" ] && { echo "[tunnel-keeper] no token" >&2; exit 1; }

if [ "$VM" = "vnc" ]; then
  PORT=6081; SLOT=vnc; URLFILE="$HUB_LOGS/vnc-url"; HEALTH_PATH="/vnc.html"
  R_URLFILE="$HUB_LOGS/vnc-url2"
else
  PORT=8090; SLOT=hub-linux; URLFILE="$HUB_LOGS/hub-url"; HEALTH_PATH="/"
  R_URLFILE="$HUB_LOGS/hub-url2"
fi
INTERVAL="${KEEPER_INTERVAL:-20}"
MAIN_FAILS=0

log() { echo "[tunnel-keeper:$VM $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/tunnel-keeper.log"; }

healthy() {  # $1 = url
  [ -n "$1" ] && bash "$TOOLS_DIR/tunnel_health.sh" "$1" "$HEALTH_PATH" >/dev/null 2>&1
}

url_for_pidfile() {  # $1 = pidfile path
  local p
  p="$(tr -dc '0-9' < "$1" 2>/dev/null || true)" || true
  [ -n "${p:-}" ] && kill -0 "$p" 2>/dev/null || return 1
  cat "${1%.pid}.url" 2>/dev/null || true
}

publish_pair() {  # args k=v ... (always includes both base urls we know)
  local main reserve
  main="$(cat "$URLFILE" 2>/dev/null || true)"
  reserve="$(cat "$R_URLFILE" 2>/dev/null || true)"
  if [ "$SLOT" = "hub-linux" ]; then
    GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
      "slot=hub-linux" "kind=NPM-Hub" "os=linux" \
      ${main:+"url=$main"} ${main:+"hubUrl=$main"} ${main:+"desktop=$main/d"} ${main:+"mobile=$main/m"} \
      ${reserve:+"url2=$reserve"} \
      "auth=без пароля" "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
  else
    GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
      "slot=vnc" "kind=Linux-VNC" "os=linux" \
      ${main:+"url=$main/vnc.html"} ${main:+"novncUrl=$main/vnc.html"} \
      ${reserve:+"url2=$reserve"} \
      "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
  fi
}

open_reserve() {
  local url
  url="$(TUNNEL_TAG=reserve bash "$TOOLS_DIR/open_tunnel.sh" "$PORT" "$HUB_LOGS/tunnel-reserve.log" 2>/dev/null || echo)"
  if [ -n "$url" ]; then
    echo "$url" > "$R_URLFILE"
    log "reserve tunnel up: $url"
  else
    log "reserve tunnel reopen failed (retry next loop)"
  fi
}

open_main() {
  local url
  url="$(bash "$TOOLS_DIR/open_tunnel.sh" "$PORT" "$HUB_LOGS/keeper-tunnel.log" 2>/dev/null || echo)"
  if [ -n "$url" ]; then
    echo "$url" > "$URLFILE"
    log "main tunnel resurrected: $url (the keep-alive step was not up to it)"
  else
    log "main tunnel reopen failed (retry next loop)"
  fi
}

trap 'log "stopped"; exit 0' TERM INT
log "keeper up ($VM, port $PORT; reserve pid via TUNNEL_TAG=reserve)"
while true; do
  sleep "$INTERVAL"
  # ── reserve ──
  r_pid_ok=0; r_url="$(url_for_pidfile "$HUB_LOGS/cloudflared-$PORT-reserve.pid" || true)"
  [ -n "${r_url:-}" ] && healthy "$r_url" && r_pid_ok=1
  if [ "$r_pid_ok" = "0" ]; then
    open_reserve
    r_url="$(cat "$R_URLFILE" 2>/dev/null || true)"
    publish_pair || true
  fi
  # ── main (only kick it after several consecutive dead probes: a busy CPU
  # can make a single probe time out, same rule as the job watchdog) ──
  m_pid_ok=0; m_url="$(url_for_pidfile "$HUB_LOGS/cloudflared-$PORT.pid" || true)"
  if [ -n "${m_url:-}" ] && healthy "$m_url"; then
    [ "${m_url:-}" != "$(cat "$URLFILE" 2>/dev/null)" ] && echo "$m_url" > "$URLFILE" || true
    MAIN_FAILS=0
  else
    MAIN_FAILS=$((MAIN_FAILS + 1))
  fi
  if [ "$MAIN_FAILS" -ge 3 ]; then
    log "main tunnel dead $MAIN_FAILS probes in a row; reserve keeps serving - reopening main"
    open_main
    publish_pair || true
    MAIN_FAILS=0
  fi
done
