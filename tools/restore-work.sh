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
if ! mkdir -p "$HUB_LOGS" 2>/dev/null; then
  printf '%s\n' "restore-work: cannot create log directory" >&2
  exit 1
fi
log() { echo "[restore-work $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/restore-work.log"; }

[ "${WORK_BACKUP_RESTORE:-1}" = "0" ] && { log "disabled"; exit 0; }

# Apply the WIP/untracked part without replacing a repo that the workflow
# checked out freshly. This is enabled explicitly for the Hub checkout: the
# old runner's local edits must come back on top of the new checkout.
apply_payload() {
  local dir="$1" repodir="$2" label="$3" result=0
  if [ -s "$repodir/wip.patch" ]; then
    if ( cd "$dir" && git apply --3way --whitespace=nowarn "$repodir/wip.patch" 2>/dev/null \
      || git apply --whitespace=nowarn "$repodir/wip.patch" 2>/dev/null ); then
      log "applied uncommitted changes to $label"
    else
      log "could not reapply uncommitted changes to $label (kept at $repodir/wip.patch)"
      result=1
    fi
  fi
  if [ -s "$repodir/untracked.tar.gz" ]; then
    if ( cd "$dir" && tar --keep-old-files -xzf "$repodir/untracked.tar.gz" 2>/dev/null ); then
      log "restored untracked files for $label"
    else
      log "could not restore untracked files for $label"
      result=1
    fi
  fi
  return "$result"
}
copy_legacy_manifest() {
  local dir="$1"
  local legacy="$(dirname "$dir")/MANIFEST.md"
  if [ -f "$legacy" ] && [ ! -f "$dir/MANIFEST.md" ]; then
    if ! cp "$legacy" "$dir/MANIFEST.md" 2>/dev/null; then
      log "could not migrate legacy manifest into $dir"
      return 1
    fi
    log "migrated legacy manifest into $dir"
  fi
  return 0
}

REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN:-${GITHUB_TOKEN:-}}@github.com/${GITHUB_REPOSITORY:-}.git}"

if ! WORK="$(mktemp -d)"; then
  log "cannot create restore directory"
  exit 1
fi
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

find_existing_repo() {
  local meta="$1"
  [ "${WORK_BACKUP_RESTORE_EXISTING:-0}" = "1" ] || return 0
  python3 - "$ROOT" "$meta" <<'PY'
import json, os, subprocess, sys
root, meta_path = sys.argv[1:]
try: meta = json.load(open(meta_path, encoding='utf-8'))
except Exception: raise SystemExit(0)
wanted_remote = meta.get('remote') or ''
wanted_name = meta.get('name') or os.path.basename(str(meta.get('path') or '').rstrip('/'))
found = []
for base, dirs, files in os.walk(root):
    if '.git' not in dirs: continue
    if any(x in base.split(os.sep) for x in ('node_modules', '.cache', '.npm', '.gradle')):
        dirs[:] = []
        continue
    repo = base
    try:
        if subprocess.run(['git', '-C', repo, 'rev-parse', '--git-dir'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
            continue
        remote = subprocess.check_output(['git','-C',repo,'remote','get-url','origin'], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception: remote = ''
    if wanted_remote and remote != wanted_remote: continue
    if os.path.basename(repo) == wanted_name: print(repo); raise SystemExit(0)
    found.append(repo)
if found: print(found[0])
PY
}

restored=0
failed=0
while IFS= read -r meta; do
  [ -f "$meta" ] || continue
  repodir="$(dirname "$meta")"
  rel="$(python3 - "$meta" <<'PY'
import json, sys, os
try:
    d=json.load(open(sys.argv[1], encoding='utf-8'))
    print(d.get('rel') or os.path.basename(os.path.dirname(sys.argv[1])))
except Exception:
    print(os.path.basename(os.path.dirname(sys.argv[1])))
PY
)"
  dest="$ROOT/$rel"
  existing="$(find_existing_repo "$meta")"
  if [ -n "$existing" ] && [ -e "$existing/.git" ]; then
     if ! apply_payload "$existing" "$repodir" "$(basename "$existing")"; then failed=1; fi
     if ! copy_legacy_manifest "$existing"; then failed=1; fi

    restored=$((restored + 1))
    log "reused existing repo $existing for backup $rel"
    continue
  fi
  if [ -e "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ] \
    && ! git -C "$dest" rev-parse --git-dir >/dev/null 2>&1; then
    partial="$dest.partial-$(date +%s)"
     if ! mv "$dest" "$partial" 2>/dev/null; then
       log "could not quarantine incomplete clone $dest"
       failed=1
       continue
     fi

    log "moved incomplete clone $dest to $partial"
  fi
  if [ -e "$dest/.git" ] && git -C "$dest" rev-parse --git-dir >/dev/null 2>&1; then
    log "skip $rel: already a valid repo at $dest"
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  if [ -f "$repodir/repo.bundle" ]; then
     if ! git clone -q "$repodir/repo.bundle" "$dest" 2>/dev/null; then
       log "clone of $rel failed; skipped"
       failed=1
       continue
     fi

  else
    mkdir -p "$dest"
    ( cd "$dest" && git init -q )
  fi
   if ! apply_payload "$dest" "$repodir" "$rel"; then failed=1; fi
   if ! copy_legacy_manifest "$dest"; then failed=1; fi

  restored=$((restored + 1))
  log "restored $rel -> $dest"
done < <(find "$SNAP/repos" -type f -name meta.json -print 2>/dev/null)

if [ -s "$SNAP/files.tar.gz" ]; then
  # --keep-old-files: never overwrite whatever the fresh runner already has.
  if ! ( cd "$ROOT" && tar --keep-old-files -xzf "$SNAP/files.tar.gz" 2>/dev/null ); then
    log "could not restore loose home files"
    failed=1
  else
    log "restored loose home files (existing ones left untouched)"
  fi
fi

log "done: $restored repo(s) restored"
[ "$failed" -eq 0 ]
