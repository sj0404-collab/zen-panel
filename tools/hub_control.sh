#!/usr/bin/env bash
# Remote-control + heartbeat daemon for one runner VM (Z10 round 2).
#
# WHY ROUND 2
#   Round 1 proved the queue works, but run 175 showed it lives on the wrong
#   assumption: the workflow starts TWO VMs (hub web + VNC desktop) and the
#   hub VM's agent itself can die, taking every step with it while detached
#   daemons keep breathing. So now:
#     - BOTH VMs run this daemon, each with its own CONTROL_TARGET
#     - liveness is verifiable from outside: control/heartbeat-<vm>.json is
#       rewritten every 2 minutes with a process census
#     - this daemon can REPAIR, not only report: reopen-tunnel and up-hub fix
#       the exact failure mode of a dead cloudflared / dead hub server without
#       needing the job's keep-alive step at all
#
# CHANNEL (session-state branch)
#   control/queue.json             one slot: { seq, op, target?, from? }
#                                  target = hub | vnc | any (default any)
#   control/results/<seq>-<vm>.json per-VM ack
#   control/heartbeat-<vm>.json    liveness + process census every 2 min
#
# WHITELIST (never arbitrary shell)
#   ping, backup-now, handoff-save, restart-hub, up-hub, reopen-tunnel
set -uo pipefail

HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true
VM="${CONTROL_TARGET:-hub}"
log() { echo "[hub-control:$VM $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/hub-control-$VM.log"; }

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  log "no token - the command queue stays cold"
  exit 1
fi
REPO="${GITHUB_REPOSITORY:-sj0404-collab/zen-panel}"
BRANCH="${CONTROL_BRANCH:-session-state}"
INTERVAL="${CONTROL_INTERVAL:-20}"
HEARTBEAT_SEC="${CONTROL_HEARTBEAT_SEC:-120}"
API="https://api.github.com/repos/$REPO/contents"
QUEUE_PATH="control/queue.json"
SEEN_FILE="$HUB_LOGS/hub-control-$VM.seen"
SEEN="$(cat "$SEEN_FILE" 2>/dev/null || echo 0)"
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_PORT="${HUB_PORT:-8090}"

trap 'log "stopped"; exit 0' TERM INT

api_get() {
  local body
  body="$(curl -sf -m 20 -H "Authorization: token $TOKEN" "$API/$1?ref=$BRANCH" 2>/dev/null)" || return 1
  echo "$body"
}

api_put() {
  local b64 sha
  b64="$(printf '%s' "$2" | base64 -w0)"
  sha="$(api_get "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha",""))' 2>/dev/null || echo)"
  if [ -n "$sha" ]; then
    curl -sf -m 25 -X PUT -H "Authorization: token $TOKEN" "$API/$1" \
      -d "{\"message\":\"control: ack $1\",\"content\":\"$b64\",\"branch\":\"$BRANCH\",\"sha\":\"$sha\"}" >/dev/null
  else
    curl -sf -m 25 -X PUT -H "Authorization: token $TOKEN" "$API/$1" \
      -d "{\"message\":\"control: ack $1\",\"content\":\"$b64\",\"branch\":\"$BRANCH\"}" >/dev/null
  fi
}

publish_url() {  # $1 = slot, $2 = new tunnel base url (no trailing slash)
  local slot="$1" base="$2"
  if [ "$slot" = "hub-linux" ]; then
    GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
      "slot=hub-linux" "kind=NPM-Hub" "os=linux" \
      "url=$base" "hubUrl=$base" "desktop=$base/d" "mobile=$base/m" \
      "auth=без пароля" "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
  else
    GH_TOKEN="$TOKEN" bash "$TOOLS_DIR/publish_session.sh" \
      "slot=vnc" "kind=Linux-VNC" "os=linux" \
      "url=$base/vnc.html" "novncUrl=$base/vnc.html" \
      "label=${HUB_LABEL:-hub}" 2>&1 | tail -1
  fi
}

run_op() {
  local pid url
  case "$1" in
    ping)
      echo "pong from $VM $(date -Iseconds)"
      ;;
    backup-now)
      GH_TOKEN="$TOKEN" GITHUB_TOKEN="$TOKEN" WORK_BACKUP_ROOT="$HOME" \
        bash "$TOOLS_DIR/backup-work.sh" --once
      ;;
    restart-hub)
      pid="$(tr -dc '0-9' < "$HUB_LOGS/hub.pid" 2>/dev/null || true)"
      if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" && echo "hub pid $pid signalled"
      else
        echo "no live hub pid (already down?)"
      fi
      ;;
    up-hub)
      if [ "$VM" != "hub" ]; then echo "the npm-hub server lives on the hub VM not $VM"; return 0; fi
      pid="$(tr -dc '0-9' < "$HUB_LOGS/hub.pid" 2>/dev/null || true)"
      [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null && { echo "hub already running (pid $pid)"; return 0; }
      (
        cd "$TOOLS_DIR/../npm-hub" || exit 1
        HUB_PORT_STRICT=1 HUB_TOKEN="${HUB_TOKEN_VALUE:-}" HUB_LABEL="${HUB_LABEL:-hub}" \
          GH_TOKEN="$TOKEN" PORT="$HUB_PORT" \
          SESSION_STARTED_MS="$(cat "$HOME/.npm-hub/session-start" 2>/dev/null || date +%s000)" \
          SESSION_LIMIT_MS=21600000 nohup node src/server.js >> "$HUB_LOGS/hub.log" 2>&1 &
        echo $! > "$HUB_LOGS/hub.pid"
      )
      sleep 2; echo "hub relaunched (pid $(cat "$HUB_LOGS/hub.pid" 2>/dev/null))"
      ;;
    reopen-tunnel)
      local port slot
      if [ "$VM" = "hub" ]; then port=8090; slot=hub-linux; else port=6081; slot=vnc; fi
      pid="$(tr -dc '0-9' < "$HUB_LOGS/cloudflared-$port.pid" 2>/dev/null || true)"
      [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
      pkill -f "cloudflared [t]unnel --url http://127.0.0.1:$port" 2>/dev/null || true
      sleep 1
      url="$(bash "$TOOLS_DIR/open_tunnel.sh" "$port" "$HUB_LOGS/control-tunnel.log" 2>/dev/null || echo)"
      if [ -z "$url" ]; then echo "open_tunnel gave no URL"; return 1; fi
      [ "$VM" = "hub" ] && echo "$url" > "$HUB_LOGS/hub-url" || echo "$url" > "$HUB_LOGS/vnc-url"
      echo "tunnel up: $url"
      publish_url "$slot" "$url"
      ;;
    handoff-save)
      [ "$VM" = "hub" ] || { echo "handoff-save runs on the hub VM"; return 0; }
      GH_TOKEN="$TOKEN" GITHUB_TOKEN="$TOKEN" WORK_BACKUP_ROOT="$HOME" \
        bash "$TOOLS_DIR/handoff.sh"
      ;;
    *)
      echo "unknown op: $1" >&2
      return 64
      ;;
  esac
}

heartbeat() {
  local hb
  hb="$(python3 - <<PYH 2>/dev/null || echo ""
import json, subprocess, datetime
def pc(pat):
    try:
        return subprocess.run(["pgrep","-fc",pat], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return "?"
print(json.dumps({
    "vm": "$VM", "runId": "${GITHUB_RUN_ID:-local}",
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "procs": {
        "hub_server": pc("node src/server.js"),
        "cloudflared": pc("cloudflared [t]unnel"),
        "backup_daemon": pc("[b]ackup-work.sh"),
        "snapshot_daemon": pc("[s]napshot-audit-code.sh"),
        "control_daemon": pc("[h]ub_control.sh"),
        "rescue_ssh": pc("[r]escue_ssh.sh"),
    },
}, ensure_ascii=False))
PYH
)"
  [ -n "$hb" ] && api_put "control/heartbeat-$VM.json" "$hb" >/dev/null 2>&1 || true
}

log "queue daemon up ($VM) on $BRANCH:$QUEUE_PATH (every ${INTERVAL}s; seen=$SEEN)"
boot_slot="$(api_get "$QUEUE_PATH" || true)"
if [ -n "$boot_slot" ]; then
  boot_seq="$(python3 -c 'import json,sys,base64; print(json.loads(base64.b64decode(json.load(sys.stdin)["content"])).get("seq",0))' <<<"$boot_slot" 2>/dev/null || echo 0)"
  if [[ "$boot_seq" =~ ^[0-9]+$ ]] && [ "$boot_seq" -gt "$SEEN" ] 2>/dev/null; then
    SEEN="$boot_seq"; echo "$SEEN" > "$SEEN_FILE"
    log "queue baseline set to #$SEEN (stale command - not executing)"
  fi
fi
heartbeat
LAST_BEAT=$SECONDS
while true; do
  sleep "$INTERVAL"
  if [ $((SECONDS - LAST_BEAT)) -ge "$HEARTBEAT_SEC" ]; then
    heartbeat; LAST_BEAT=$SECONDS
  fi
  slot="$(api_get "$QUEUE_PATH" || true)"
  [ -n "$slot" ] || continue
  read -r seq op target < <(python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(int(d.get("seq", 0)), str(d.get("op", ""))[:64], str(d.get("target", "any"))[:16])
except Exception:
    print(0, "", "any")
' <<<"$(python3 -c 'import json,sys,base64; c=json.load(sys.stdin)["content"]; print(base64.b64decode(c).decode(), end="")' <<<"$slot" 2>/dev/null)" 2>/dev/null || echo "0  any")
  [[ "$seq" =~ ^[0-9]+$ ]] || continue
  [ "$seq" -le "$SEEN" ] 2>/dev/null && continue
  [ -n "$op" ] || continue
  { [ "$target" = "any" ] || [ "$target" = "$VM" ]; } || { log "skip #$seq ($op for target=$target)"; echo "$seq" > "$SEEN_FILE"; SEEN="$seq"; continue; }
  log "command #$seq: $op (target=$target)"
  out="$(run_op "$op" 2>&1 | tail -c 3000)"; rc=$?
  log "command #$seq rc=$rc"
  ack="$(python3 -c '
import json, sys, datetime
print(json.dumps({
    "seq": int(sys.argv[1]), "op": sys.argv[2], "vm": sys.argv[4],
    "ok": sys.argv[3] == "0", "rc": int(sys.argv[3]),
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "runId": sys.argv[5],
    "out": sys.stdin.read()[-2800:],
}, ensure_ascii=False))
' "$seq" "$op" "$rc" "$VM" "${GITHUB_RUN_ID:-local}" <<<"$out" 2>/dev/null || echo "{\"seq\":$seq,\"ok\":false}")"
  if api_put "control/results/$seq-$VM.json" "$ack"; then
    echo "$seq" > "$SEEN_FILE"; SEEN="$seq"
  else
    log "ack push failed - the command WILL rerun until pushed"
  fi
done
