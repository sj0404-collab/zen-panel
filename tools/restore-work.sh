#!/usr/bin/env bash
# Restore the working tree from the newest `work-backup` snapshot.
#
# Runs at hub startup, after restore_audit_code.sh, so a runner that died with
# unpushed work comes back with that work in place: each repo is rebuilt from
# its git bundle, the uncommitted diff is reapplied and untracked files are
# unpacked. Small non-repo files are restored only when missing.
#
# SAFETY
#   An existing directory that is already a git repo is never touched: it holds
#   newer work than the snapshot and clobbering it would be the very data loss
#   this is meant to prevent. Restore only fills in paths that are absent.
#
# ENV
#   WORK_BACKUP_ROOT        root to restore into   (default $HOME)
#   WORK_BACKUP_BRANCH      source branch          (default work-backup)
#   WORK_BACKUP_SNAPSHOT    explicit snapshot dir  (default: newest)
#   SESSION_STATE_URL       git remote override for local tests
#   WORK_BACKUP_RESTORE=0   skip entirely
set -uo pipefail

ROOT="${WORK_BACKUP_ROOT:-$HOME}"
BRANCH="${WORK_BACKUP_BRANCH:-work-backup}"
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true
log() { echo "[restore-work $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/restore-work.log"; }

[ "${WORK_BACKUP_RESTORE:-1}" = "0" ] && { log "disabled"; exit 0; }

REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN:-${GITHUB_TOKEN:-}}@github.com/${GITHUB_REPOSITORY:-}.git}"

WORK="$(mktemp -d)"
TARGET=""
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" "$WORK/state" 2>/dev/null; then
  TARGET="$WORK/state"
else
  log "no $BRANCH branch yet; nothing to restore"
  exit 0
fi

if [ -n "${WORK_BACKUP_SNAPSHOT:-}" ]; then
  SNAP="$TARGET/$WORK_BACKUP_SNAPSHOT"
else
  SNAP="$(ls -1dt "$TARGET"/snapshots/*/ 2>/dev/null | head -n1)"
fi
if [ -z "${SNAP:-}" ] || [ ! -d "$SNAP" ]; then
  log "no snapshot found in $BRANCH"
  exit 0
fi
log "restoring from $SNAP"

restored=0
for repodir in "$SNAP"/repos/*/; do
  [ -d "$repodir" ] || continue
  rel="$(basename "$repodir")"
  dest="$ROOT/$rel"
  if [ -e "$dest/.git" ]; then
    log "skip $rel: already a repo at $dest"
    continue
  fi
  if [ -e "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
    log "skip $rel: $dest exists and is not empty"
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  if [ -f "$repodir/repo.bundle" ]; then
    if ! git clone -q "$repodir/repo.bundle" "$dest" 2>/dev/null; then
      log "clone of $rel failed; skipped"
      continue
    fi
  else
    mkdir -p "$dest"
    ( cd "$dest" && git init -q )
  fi
  if [ -s "$repodir/wip.patch" ]; then
    ( cd "$dest" && git apply --3way --whitespace=nowarn "$repodir/wip.patch" 2>/dev/null \
      || git apply --whitespace=nowarn "$repodir/wip.patch" 2>/dev/null ) \
      && log "applied uncommitted changes to $rel" \
      || log "could not reapply uncommitted changes to $rel (kept at $repodir/wip.patch)"
  fi
  if [ -s "$repodir/untracked.tar.gz" ]; then
    ( cd "$dest" && tar -xzf "$repodir/untracked.tar.gz" 2>/dev/null ) \
      && log "restored untracked files for $rel"
  fi
  restored=$((restored + 1))
  log "restored $rel -> $dest"
done

if [ -s "$SNAP/files.tar.gz" ]; then
  # --keep-old-files: never overwrite whatever the fresh runner already has.
  ( cd "$ROOT" && tar --keep-old-files -xzf "$SNAP/files.tar.gz" 2>/dev/null ) || true
  log "restored loose home files (existing ones left untouched)"
fi

log "done: $restored repo(s) restored"
