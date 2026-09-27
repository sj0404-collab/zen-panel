#!/usr/bin/env bash
# Remote-control queue for a runner whose hub and tunnel may already be dead.
#
# WHY THIS EXISTS
#   A wedged runner (hub down, cloudflared down, watchdog stalled) used to be
#   unreachable: no SSH, no API route in, only GitHub's blunt «cancel». This
#   daemon adds a narrow, SAFE control channel that keeps working for as long
#   as the runner box itself is alive: it polls a single JSON slot on the
#   session-state branch and executes ONLY a fixed whitelist of operations.
#
# CHANNEL
#   control/queue.json          single slot, overwritten per command:
#                               { "seq": <monotonic int>, "op": "<op>", "from": "who" }
#   control/results/<seq>.json  ack: { "seq", "op", "ok", "rc", "at", "out" }
#
# WHITELIST (never arbitrary shell - anything else is acked "unknown op")
#   ping            just ack (channel health check)
#   backup-now      tools/backup-work.sh --once
#   restart-hub     kill the hub pid; the workflow watchdog restarts it
#   restart-tunnel  kill the cloudflared pid; the watchdog reopens the tunnel
#   handoff-save    tools/handoff.sh (durable save + relay marker)
#
# ENV
#   GH_TOKEN / GITHUB_TOKEN   token with contents:write on the control repo
#   GITHUB_REPOSITORY         owner/repo (falls back to the workflow's repo)
#   CONTROL_BRANCH            default session-state
#   CONTROL_INTERVAL          poll seconds (default 20)
#   HUB_LOGS                  $HOME/.npm-hub/logs by default
set -uo pipefail

HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true
log() { echo "[hub-control $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/hub-control.log"; }

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  log "no token - the command queue stays cold"
  exit 1
fi
REPO="${GITHUB_REPOSITORY:-sj0404-collab/zen-panel}"
BRANCH="${CONTROL_BRANCH:-session-state}"
INTERVAL="${CONTROL_INTERVAL:-20}"
API="https://api.github.com/repos/$REPO/contents"
QUEUE_PATH="control/queue.json"
SEEN_FILE="$HUB_LOGS/hub-control.seen"
SEEN="$(cat "$SEEN_FILE" 2>/dev/null || echo 0)"
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

trap 'log "stopped"; exit 0' TERM INT

api_get() {  # $1 = ref path -> body on stdout, rc: 0 ok / 1 404-miss / 2 error
  local rc body code
  body="$(curl -sf -m 20 -H "Authorization: token $TOKEN" "$API/$1?ref=$BRANCH" 2>/dev/null)"
  rc=$?
  [ $rc -eq 0 ] && { echo "$body"; return 0; }
  return 1
}

api_put() {  # $1 = path, $2 = json payload
  local payload="$2"
  local b64 sha
  b64="$(printf '%s' "$payload" | base64 -w0)"
  sha="$(api_get "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha",""))' 2>/dev/null || echo)"
  if [ -n "$sha" ]; then
    curl -sf -m 25 -X PUT -H "Authorization: token $TOKEN" "$API/$1" \
      -d "{\"message\":\"control: ack $1\",\"content\":\"$b64\",\"branch\":\"$BRANCH\",\"sha\":\"$sha\"}" >/dev/null
  else
    curl -sf -m 25 -X PUT -H "Authorization: token $TOKEN" "$API/$1" \
      -d "{\"message\":\"control: ack $1\",\"content\":\"$b64\",\"branch\":\"$BRANCH\"}" >/dev/null
  fi
}

run_op() {   # $1 = op -> rc; output goes to stdout (captured for the ack)
  case "$1" in
    ping)
      echo "pong $(date -Iseconds)"
      ;;
    backup-now)
      GH_TOKEN="$TOKEN" GITHUB_TOKEN="$TOKEN" WORK_BACKUP_ROOT="$HOME" \
        bash "$TOOLS_DIR/backup-work.sh" --once
      ;;
    restart-hub)
      local pid; pid="$(tr -dc '0-9' < "$HUB_LOGS/hub.pid" 2>/dev/null || true)"
      if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" && echo "hub pid $pid signalled; the watchdog will restart it"
      else
        echo "no live hub pid found"
      fi
      ;;
    restart-tunnel)
      local pid; pid="$(tr -dc '0-9' < "$HUB_LOGS/cloudflared-8090.pid" 2>/dev/null || true)"
      if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" && echo "tunnel pid $pid signalled; the watchdog will reopen it"
      else
        pkill -f "cloudflared [t]unnel --url http://127.0.0.1:8090" 2>/dev/null || true
        echo "no tunnel pid file; asked the watchdog to reopen whichever tunnel is stale"
      fi
      ;;
    handoff-save)
      GH_TOKEN="$TOKEN" GITHUB_TOKEN="$TOKEN" WORK_BACKUP_ROOT="$HOME" \
        bash "$TOOLS_DIR/handoff.sh"
      ;;
    *)
      echo "unknown op: $1" >&2
      return 64
      ;;
  esac
}

log "queue daemon up on $BRANCH:$QUEUE_PATH (every ${INTERVAL}s; seen=$SEEN)"
# A stale command left behind by a previous runner must not fire on a fresh
# box: baseline the seen counter to whatever the queue holds right now.
boot_slot="$(api_get "$QUEUE_PATH" || true)"
if [ -n "$boot_slot" ]; then
  boot_seq="$(python3 -c 'import json,sys,base64; print(json.loads(base64.b64decode(json.load(sys.stdin)["content"])).get("seq",0))' <<<"$boot_slot" 2>/dev/null || echo 0)"
  if [[ "$boot_seq" =~ ^[0-9]+$ ]] && [ "$boot_seq" -gt "$SEEN" ] 2>/dev/null; then
    SEEN="$boot_seq"; echo "$SEEN" > "$SEEN_FILE"
    log "queue baseline set to #$SEEN (command left by an earlier runner - not executing)"
  fi
fi
while true; do
  sleep "$INTERVAL"
  slot="$(api_get "$QUEUE_PATH" || true)"
  [ -n "$slot" ] || continue
  body="$(python3 -c 'import json,sys,base64; print(base64.b64decode(json.load(sys.stdin)["content"]).decode(), end="")' <<<"$slot" 2>/dev/null || true)"
  [ -n "$body" ] || continue
  read -r seq op < <(python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(int(d.get("seq", 0)), str(d.get("op", ""))[:64])
except Exception:
    print(0, "")
' <<<"$body" 2>/dev/null || echo "0 ")
  [[ "$seq" =~ ^[0-9]+$ ]] || continue
  [ "$seq" -le "$SEEN" ] 2>/dev/null && continue
  [ -n "$op" ] || continue
  log "command #$seq: $op"
  out="$(run_op "$op" 2>&1 | tail -c 3000)"; rc=$?
  log "command #$seq rc=$rc"
  ack="$(python3 -c '
import json, sys, datetime
print(json.dumps({
    "seq": int(sys.argv[1]),
    "op": sys.argv[2],
    "ok": sys.argv[3] == "0",
    "rc": int(sys.argv[3]),
    "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "runId": sys.argv[4],
    "out": sys.stdin.read()[-2800:],
}, ensure_ascii=False))
' "$seq" "$op" "$rc" "${GITHUB_RUN_ID:-local}" <<<"$out" 2>/dev/null || echo "{\"seq\":$seq,\"ok\":false}")"
  if api_put "control/results/$seq.json" "$ack"; then
    echo "$seq" > "$SEEN_FILE"; SEEN="$seq"
  else
    log "ack push failed - the command WILL rerun on the next loop until pushed"
  fi
done
