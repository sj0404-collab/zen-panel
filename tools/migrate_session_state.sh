#!/usr/bin/env bash
# One-time reorganisation of the session-state branch: from one pile in the
# root into folders that say what each thing IS.
#
#   live/session-<slot>.json      the live descriptor of a slot
#   live/handoff.json             the relay limits + its live status
#   models/models-<slot>.json     the model roster of that session
#   snapshots/audit.json          the audit trail
#   snapshots/code.json           the code snapshot
#   history/<YYYY-MM-DD>/<Wd>/    everything historical, by day and weekday
#   chats/, artifacts/            unchanged
#
# WHY IT IS SAFE TO RUN TWICE, OR NOT AT ALL
#   Every reader tries the new path first and falls back to the old name, so a
#   branch that was never migrated keeps working, and a half-migrated branch is
#   still readable. The migration only ever MOVES files (git mv, so history is
#   kept) and never rewrites their content.
#
#   Note that publish_session.sh already writes into the new layout, so files
#   that appeared after the deploy are skipped (the source no longer exists).
#
# USAGE
#   migrate_session_state.sh            migrate the branch over the network
#   SESSION_STATE_URL=file:///tmp/x.git migrate_session_state.sh   (local test)
set -uo pipefail

BRANCH="session-state"
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true
log() { echo "[migrate-session-state $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/migrate-session-state.log"; }

REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN:-${GITHUB_TOKEN:-}}@github.com/${GITHUB_REPOSITORY:-}.git}"
if [ -z "${SESSION_STATE_URL:-}" ] && [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  log "no GitHub token; set GH_TOKEN or SESSION_STATE_URL"
  exit 1
fi

WORK="$(mktemp -d)" || { log "cannot create a work directory"; exit 1; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if ! git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" "$WORK/state" 2>/dev/null; then
  log "no $BRANCH branch yet; nothing to migrate"
  exit 0
fi
cd "$WORK/state" || exit 1

moved=0
move() {
  [ -e "$1" ] || return 0
  mkdir -p "$(dirname "$2")" || return 1
  if git mv -q "$1" "$2" 2>/dev/null || mv -f "$1" "$2" 2>/dev/null; then
    moved=$((moved + 1))
    return 0
  fi
  log "could not move $1 -> $2"
  return 1
}

# 1. the live descriptors
for f in session.json session-*.json handoff.json; do
  [ -e "$f" ] || continue
  move "$f" "live/$f"
done

# 2. the model rosters
for f in models-*.json; do
  [ -e "$f" ] || continue
  move "$f" "models/$f"
done

# 3. the audit/code pair
for f in audit.json code.json; do
  [ -e "$f" ] || continue
  move "$f" "snapshots/$f"
done

# 4. the historical bundles, filed under the day and the weekday in their name
#    (saved/<name>-YYYYMMDDTHHMMSS.json -> history/YYYY-MM-DD/Wd/<name>-<stamp>.json)
if [ -d saved ]; then
  for f in saved/*.json; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    day=""
    if [[ "$base" =~ ([0-9]{8})T[0-9]{6} ]]; then
      raw="${BASH_REMATCH[1]}"
      day="${raw:0:4}-${raw:4:2}-${raw:6:2}"
    else
      day="$(date -u '+%Y-%m-%d')"
    fi
    wd="$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1]).strftime('%a'))" "$day" 2>/dev/null || echo '---')"
    move "$f" "history/$day/$wd/saved-$base"
  done
  rmdir saved 2>/dev/null || true
fi

if [ "$moved" -eq 0 ]; then
  log "nothing to migrate - the branch is already in folders"
  exit 0
fi

git add -A >/dev/null 2>&1
if git diff --cached --quiet; then
  log "nothing to migrate - the branch is already in folders"
  exit 0
fi

git config user.email "migrate@zen-panel"
git config user.name  "Session state migration"
git commit -q -m "session-state: split the root into live/, models/, snapshots/, history/"

pushed=0
for attempt in $(seq 1 8); do
  if git push -q origin "HEAD:$BRANCH" 2>/dev/null; then
    pushed=1
    break
  fi
  # Somebody published while we worked: rebase our moves on top and try again.
  git fetch -q origin "$BRANCH" 2>/dev/null || true
  git rebase -q FETCH_HEAD >/dev/null 2>&1 || git reset -q --hard FETCH_HEAD
  sleep $((attempt * 2))
done

if [ "$pushed" = 1 ]; then
  log "migrated $moved file(s) into folders on $BRANCH"
  exit 0
fi
log "push failed after retries; the branch is untouched (nothing was force-pushed)"
exit 1
