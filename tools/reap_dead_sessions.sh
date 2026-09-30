#!/usr/bin/env bash
# Reaper: close session slots whose runner is provably gone (Z12).
#
# WHY
#   Every slot in live/ carries the runId that published it. When a run is
#   cancelled or fails, GitHub does NOT reach the `if: always()` steps inside
#   the job - the job dies with the run. So nothing ever flips the slot to
#   ended, and the panel keeps handing out an address that is already dead
#   (Cloudflare answers 1033 on a quick tunnel whose connector is gone).
#
#   Observed: run #242 (completed/cancelled) still published
#   state:"live" with url did-biz-doe-choosing.trycloudflare.com, and
#   session-hub-windows.json still said state:"live" for run #86, which has
#   been completed/failure since 21 Sep.
#
# WHAT IT DOES
#   For every live/session-*.json: read runId, ask the Actions API for that
#   run's status/conclusion, and rewrite the slot with state:"ended" when the
#   run is no longer in_progress/queued/requested/waiting/pending. A run that
#   has already been reaped is left alone (no commit churn).
#
#   It only ever writes to slots that carry a runId, so a slot published by
#   hand (no run) is never touched.
#
# WHY IT IS SAFE TO RUN ANYWHERE
#   It is a separate cron workflow, not part of the hub job, so it works even
#   when every session run is dead - which is exactly when it is needed.
#
# Usage: reap_dead_sessions.sh [--dry-run]
#   Needs GH_TOKEN/GITHUB_TOKEN and GITHUB_REPOSITORY (both are set by Actions).

set -uo pipefail

BRANCH="${CONTROL_BRANCH:-session-state}"
API="https://api.github.com/repos/${GITHUB_REPOSITORY:-sj0404-collab/zen-panel}"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ -z "$TOKEN" ]; then
  echo "[reaper] no token - nothing reaped" >&2
  exit 1
fi

# ── every slot file the panel reads, and the run that published it ──────
# New layout is live/; the flat names are kept so a branch that was never
# migrated still gets reaped.
SLOTS="live/session-hub-linux.json
live/session-hub-windows.json
live/session-vnc.json
live/session-hub.json
live/session-linux.json
live/session-windows.json
live/session-agent.json
live/session-agent-linux.json
live/session-agent-agent-windows.json
live/session-opencode.json
live/session-opencode-linux.json
live/session-opencode-windows.json
session-hub-linux.json
session-hub-windows.json
session-vnc.json
session-hub.json
session-linux.json
session-windows.json"

LIVE_STATES='in_progress,queued,requested,waiting,pending'

run_is_alive() {  # $1 = runId -> 0 alive, 1 gone, 2 unknown
  local id="$1" body status conclusion
  body="$(curl -sf -m 20 -H "Authorization: token $TOKEN" \
    "$API/actions/runs/$id" 2>/dev/null)" || return 2
  status="$(printf '%s' "$body" | python3 -c \
    'import json,sys;print(json.load(sys.stdin).get("status",""))' 2>/dev/null)"
  conclusion="$(printf '%s' "$body" | python3 -c \
    'import json,sys;print(json.load(sys.stdin).get("conclusion") or "")' 2>/dev/null)"
  if [ -z "$status" ]; then return 2; fi
  case ",$LIVE_STATES," in
    *",$status,"*) return 0 ;;
  esac
  echo "[reaper] run $id is $status/$conclusion" >&2
  return 1
}

list_files() {  # the slot paths, one per line; paths carry no spaces
  printf '%s\n' "$SLOTS" | grep -v '^$'
}

fetch_slot() {  # $1 = path -> json or empty
  curl -sf -m 20 -H "Authorization: token $TOKEN" \
    "$API/contents/$1?ref=$BRANCH" 2>/dev/null |
    python3 -c '
import base64,json,sys
try:
    o=json.load(sys.stdin)
    sys.stdout.write(base64.b64decode(o["content"]).decode())
except Exception:
    pass
'
}

put_slot() {  # $1 = path, $2 = json
  local b64 sha
  b64="$(printf '%s' "$2" | base64 -w0)"
  sha="$(curl -sf -m 20 -H "Authorization: token $TOKEN" \
    "$API/contents/$1?ref=$BRANCH" 2>/dev/null |
    python3 -c 'import json,sys;print(json.load(sys.stdin).get("sha",""))' 2>/dev/null)"
  curl -sf -m 25 -X PUT -H "Authorization: token $TOKEN" \
    -d "{\"message\":\"reaper: run gone, slot closed\",\"content\":\"$b64\",\"sha\":\"$sha\",\"branch\":\"$BRANCH\"}" \
    "$API/contents/$1" 2>/dev/null >/dev/null
}

reaped=0
checked=0
for path in $(list_files); do
  json="$(fetch_slot "$path")"
  [ -n "$json" ] || continue

  state="$(printf '%s' "$json" | python3 -c \
    'import json,sys;print(json.load(sys.stdin).get("state",""))' 2>/dev/null)"
  run_id="$(printf '%s' "$json" | python3 -c \
    'import json,sys;print(json.load(sys.stdin).get("runId",""))' 2>/dev/null)"
  [ "$state" = "live" ] || continue
  [ -n "$run_id" ] || continue

  checked=$((checked + 1))
  run_is_alive "$run_id"; rc=$?
  case $rc in
    0) continue ;;                 # still running - leave it alone
    2) echo "[reaper] could not read run $run_id for $path - leaving alone" >&2
       continue ;;
  esac

  ended="$(printf '%s' "$json" | python3 -c '
import json,sys,datetime
o=json.load(sys.stdin)
o["state"]="ended"
o["reapedAt"]=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
o["reapedWhy"]="run %s is no longer in progress" % o.get("runId","")
print(json.dumps(o,ensure_ascii=False,indent=2))
' 2>/dev/null)"
  [ -n "$ended" ] || continue

  if [ "$DRY" = "1" ]; then
    echo "[reaper] would close $path (run $run_id)"
  else
    put_slot "$path" "$ended" && { echo "[reaper] closed $path"; reaped=$((reaped+1)); } \
      || echo "[reaper] failed to close $path" >&2
  fi
done

echo "[reaper] checked $checked live slot(s), closed $reaped"
