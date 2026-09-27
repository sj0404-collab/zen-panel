#!/usr/bin/env bash
# tmate rescue shell for a runner: a real SSH (and read-only web) session that
# survives the hub server, the cloudflared tunnel and even a wedged web app.
#
# WHY THIS EXISTS
#   The runner used to be unreachable the moment its web stack died. tmate
#   keeps a reverse session to the tmate hub: as long as the box itself is
#   alive, 'ssh <string>' from anywhere lands on the runner as the runner
#   user with full sudo - enough to inspect, run backup-work by hand, or save
#   whatever is worth keeping.
#
# WHAT IT DOES
#   1. installs tmate when missing (ubuntu-latest: plain apt, ~15s)
#   2. starts a detached tmate session on a fixed socket
#   3. publishes the connection strings to session-state control/rescue.json
#      (rewritten on beacons so the file going stale means the box is gone)
#   4. exits quietly without doing anything if installation fails - rescue
#      must never be the reason a session does not start
#
# ENV
#   GH_TOKEN / GITHUB_TOKEN   contents:write on the control repo
#   GITHUB_REPOSITORY         owner/repo
#   CONTROL_BRANCH            default session-state
#   RESCUE_BEACON_SEC         seconds between rescue.json beacons (default 60)
set -uo pipefail

HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true
SOCK="$HUB_LOGS/tmate.sock"
log() { echo "[rescue-ssh $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/rescue-ssh.log"; }

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
REPO="${GITHUB_REPOSITORY:-sj0404-collab/zen-panel}"
BRANCH="${CONTROL_BRANCH:-session-state}"
BEACON="${RESCUE_BEACON_SEC:-60}"
API="https://api.github.com/repos/$REPO/contents"

if ! command -v tmate >/dev/null 2>&1; then
  log "tmate missing - installing"
  if ! (sudo apt-get update -qq >/dev/null 2>&1 && sudo apt-get install -y -qq tmate >/dev/null 2>&1); then
    log "install failed; rescue ssh is OFF for this run"
    exit 0
  fi
fi

# One session per runner socket: reuse a live one instead of stacking new ones.
if ! tmate -S "$SOCK" ls >/dev/null 2>&1; then
  tmate -S "$SOCK" new-session -d 2>/dev/null || { log "new-session failed"; exit 0; }
fi

SSH=""; WEB=""
for i in $(seq 1 30); do
  SSH="$(tmate -S "$SOCK" display -p '#{tmate_ssh}' 2>/dev/null || true)"
  WEB="$(tmate -S "$SOCK" display -p '#{tmate_web_ro}' 2>/dev/null || true)"
  [ -n "$SSH" ] && break
  sleep 1
done
if [ -z "$SSH" ]; then
  log "tmate did not come up; rescue ssh is OFF"
  exit 0
fi

{
  echo ""
  echo "### Rescue shell (tmate)"
  echo ""
  echo "- ssh: \`$SSH\`"
  [ -n "$WEB" ] && echo "- read-only web: <${WEB}>"
  echo ""
} >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
log "up: $SSH"

publish() {
  local payload
  payload="$(python3 - "$@" <<'PY' 2>/dev/null || echo ""
import json, sys, datetime
print(json.dumps({
    "kind": "rescue-ssh",
    "state": sys.argv[1],
    "ssh": sys.argv[2],
    "web_ro": sys.argv[3],
    "runId": sys.argv[4],
    "beaconAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}, ensure_ascii=False))
PY
)"
  [ -n "$payload" ] || return 1
  [ -n "$TOKEN" ] || return 0
  local b64 sha
  b64="$(printf '%s' "$payload" | base64 -w0)"
  sha="$(curl -sf -m 20 -H "Authorization: token $TOKEN" "$API/control/rescue.json?ref=$BRANCH" 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha",""))' 2>/dev/null || echo)"
  if [ -n "$sha" ]; then
    curl -sf -m 20 -X PUT -H "Authorization: token $TOKEN" "$API/control/rescue.json" \
      -d "{\"message\":\"rescue beacon\",\"content\":\"$b64\",\"branch\":\"$BRANCH\",\"sha\":\"$sha\"}" >/dev/null
  else
    curl -sf -m 20 -X PUT -H "Authorization: token $TOKEN" "$API/control/rescue.json" \
      -d "{\"message\":\"rescue beacon\",\"content\":\"$b64\",\"branch\":\"$BRANCH\"}" >/dev/null
  fi
}

cleanup() {
  trap - TERM INT
  log "closing tmate"
  tmate -S "$SOCK" kill-session >/dev/null 2>&1 || true
  publish ended "" "" "${GITHUB_RUN_ID:-local}" >/dev/null 2>&1 || true
  exit 0
}
trap cleanup TERM INT

publish live "$SSH" "${WEB:-}" "${GITHUB_RUN_ID:-local}" || log "publish failed (beacon will retry)"
while true; do
  sleep "$BEACON"
  if ! tmate -S "$SOCK" ls >/dev/null 2>&1; then
    log "tmate session died - relaunching"
    tmate -S "$SOCK" new-session -d 2>/dev/null || continue
    for i in $(seq 1 30); do
      SSH="$(tmate -S "$SOCK" display -p '#{tmate_ssh}' 2>/dev/null || true)"
      [ -n "$SSH" ] && break
      sleep 1
    done
  fi
  publish live "${SSH:-}" "${WEB:-}" "${GITHUB_RUN_ID:-local}" || true
done
