#!/usr/bin/env bash
# Save everything worth keeping BEFORE the next runner takes the session over.
#
# WHY A SEPARATE SCRIPT
#   The relay (npm-hub/src/handoff.js) decides WHEN to hand over; this script
#   does the part that must not be re-implemented in JavaScript: the durable
#   push. Its contract is deliberately blunt - exit 0 only when everything the
#   next runner needs is really on GitHub, non-zero otherwise. A failed push
#   must keep the old runner alive (the server treats non-zero as "stay here
#   and retry"), never hand over an unsaved session.
#
# WHAT IS SAVED
#   work-backup branch : every repo (bundle + uncommitted diff + untracked),
#                        loose home files, files >25 MB as chunks
#   session-state      : the OpenCode chat bundles (chats/<repo>.json) and the
#                        session descriptor with handoff=1 + who handed over
#
# ENV
#   GH_TOKEN / GITHUB_TOKEN   token for both branches
#   GITHUB_REPOSITORY         control repository
#   HANDOFF_SLOT              session slot to stamp (default hub-linux)
#   HANDOFF_KIND              session kind  (default NPM-Hub)
#   HANDOFF_LABEL             session label (default handoff)
#   HANDOFF_URL               current address, republished with the marker
#   WORK_BACKUP_ROOT          root the backup scans (default $HOME)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true
log() { echo "[handoff $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/handoff.log"; }

SLOT="${HANDOFF_SLOT:-hub-linux}"
KIND="${HANDOFF_KIND:-NPM-Hub}"
LABEL="${HANDOFF_LABEL:-handoff}"
RUN_ID="${GITHUB_RUN_ID:-local}"
STARTED="${HANDOFF_STARTED_AT:-}"

if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  log "no GitHub token: refusing to hand over an unsaved session"
  exit 1
fi

fail() {
  log "SAVE FAILED: $*"
  echo "result=1"
  exit 1
}

# 0. What was in flight right now? The resume report is informational: it ends
#    up in this log, so the record of the handover says which sessions were open
#    and what they were doing, not just that files were pushed.
if [ -x "$SCRIPT_DIR/session_resume_report.sh" ] || [ -f "$SCRIPT_DIR/session_resume_report.sh" ]; then
  RESUME_LIMIT=5 bash "$SCRIPT_DIR/session_resume_report.sh" 2>&1 | tee -a "$HUB_LOGS/handoff.log" || true
fi

# 1. OpenCode sessions. Missing CLI or database is NOT fatal (the user may run
#    no agent at all), but a real error while exporting a repo is.
log "exporting chats"
if ! bash "$SCRIPT_DIR/export-chats.sh" --all 2>&1 | tee -a "$HUB_LOGS/handoff.log"; then
  log "chat export reported a problem; continuing with the repository backup"
fi

# 2. Repositories, loose files and big files. This is the step that must work.
log "snapshotting repositories and files"
if ! WORK_BACKUP_ROOT="${WORK_BACKUP_ROOT:-$HOME}" bash "$SCRIPT_DIR/backup-work.sh" --once \
  2>&1 | tee -a "$HUB_LOGS/handoff.log"; then
  fail "backup-work.sh did not publish a snapshot"
fi

# 3. Mark the session as being handed over, so the panel can say "передаём" and
#    the next runner can tell the two apart.
log "publishing the session marker"
MARKER=("slot=$SLOT" "kind=$KIND" "label=$LABEL" "handoff=1" "handoffFrom=$RUN_ID")
[ -n "$STARTED" ] && MARKER+=("startedAt=$STARTED")
[ -n "${HANDOFF_URL:-}" ] && MARKER+=("url=$HANDOFF_URL" "hubUrl=$HANDOFF_URL")
if ! bash "$SCRIPT_DIR/publish_session.sh" "${MARKER[@]}" 2>&1 | tee -a "$HUB_LOGS/handoff.log"; then
  fail "publish_session.sh could not write the session descriptor"
fi

# 4. Verify, do not assume: the snapshot and the marker must be readable from
#    the remote branches, otherwise the next runner starts from nothing.
verify_remote() {
  local url="$1" branch="$2" path="$3"
  git ls-remote --exit-code --heads "$url" "$branch" >/dev/null 2>&1 || return 1
  git ls-remote "$url" "refs/heads/$branch" >/dev/null 2>&1 || return 1
  [ -n "$path" ] || return 0
  local tmp; tmp="$(mktemp -d)" || return 1
  if git clone -q --depth 1 --branch "$branch" "$url" "$tmp/state" 2>/dev/null; then
    if [ -e "$tmp/state/$path" ]; then rm -rf "$tmp"; return 0; fi
  fi
  rm -rf "$tmp"
  return 1
}

BASE="https://x-access-token:${GH_TOKEN:-${GITHUB_TOKEN:-}}@github.com/${GITHUB_REPOSITORY:-}.git"
if ! verify_remote "$BASE" "work-backup" "latest.json"; then
  fail "work-backup/latest.json is not on the remote yet"
fi
if ! verify_remote "$BASE" "session-state" "live/session-$SLOT.json" \
  && ! verify_remote "$BASE" "session-state" "session-$SLOT.json"; then
  fail "the session descriptor for $SLOT is not on session-state yet"
fi

log "saved: snapshot + chats + session marker are on GitHub"
echo "result=0"
exit 0
