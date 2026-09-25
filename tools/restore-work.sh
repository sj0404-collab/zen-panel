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
    if ( cd "$dir" && git apply --whitespace=nowarn "$repodir/wip.patch" 2>/dev/null ); then
      log "applied uncommitted changes to $label"
    else
      log "could not reapply uncommitted changes to $label (kept at $repodir/wip.patch)"
      result=1
    fi
  fi
  if [ -s "$repodir/untracked.tar.gz" ]; then
    if extract_keep_old "$dir" "$repodir/untracked.tar.gz"; then
      log "restored untracked files for $label"
    else
      log "could not restore untracked files for $label"
      result=1
    fi
  fi
  return "$result"
}
extract_keep_old() {
  local dir="$1" archive="$2" output rc=0
  output="$(cd "$dir" && tar --keep-old-files -xzf "$archive" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then return 0; fi
  case "$output" in
    *"Cannot open: File exists"*) return 0 ;;
  esac
  [ -n "$output" ] && log "tar: ${output:0:200}"
  return 1
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
elif [ -f "$TARGET/latest.json" ]; then
  LATEST_STAMP=$(python3 - "$TARGET/latest.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding='utf-8')).get('stamp', ''))
except Exception:
    print('')
PY
)
  if [ -n "$LATEST_STAMP" ] && [ -d "$TARGET/snapshots/$LATEST_STAMP" ]; then
    SNAP="$TARGET/snapshots/$LATEST_STAMP"
  fi
fi
if [ -z "${SNAP:-}" ]; then
  SNAP="$(ls -1d "$TARGET"/snapshots/*/ 2>/dev/null | LC_ALL=C sort -r | head -n1)"
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
rel = str(meta.get('rel') or '').strip('/')
wanted_remote = str(meta.get('remote') or '').strip()

def is_repo(path):
    try:
        return os.path.isdir(os.path.join(path, '.git')) or subprocess.run(
            ['git', '-C', path, 'rev-parse', '--git-dir'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    except Exception:
        return False

def norm(url):
    value = str(url or '').strip().rstrip('/')
    if value.endswith('.git'): value = value[:-4]
    if value.startswith('git@github.com:'): value = 'https://github.com/' + value.split(':', 1)[1]
    if value.startswith('ssh://git@github.com/'):
        value = 'https://github.com/' + value.split('github.com/', 1)[1]
    return value

wanted = norm(wanted_remote)
def remote_of(path):
    try:
        return subprocess.check_output(
            ['git', '-C', path, 'remote', 'get-url', 'origin'],
            text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ''

if rel:
    exact = os.path.join(root, rel)
    if is_repo(exact) and (not wanted or norm(remote_of(exact)) == wanted):
        print(exact)
        raise SystemExit(0)
if not wanted:
    raise SystemExit(0)
for base, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in ('node_modules', '.cache', '.npm', '.gradle', '.git')]
    if not is_repo(base):
        continue
    try:
        remote = subprocess.check_output(
            ['git', '-C', base, 'remote', 'get-url', 'origin'],
            text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        continue
    if norm(remote) == wanted:
        print(base)
        raise SystemExit(0)
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
     if [ -f "$repodir/meta.json" ]; then
       META_REMOTE=$(python3 - "$repodir/meta.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding='utf-8')).get('remote', ''))
except Exception:
    print('')
PY
)
       [ -z "$META_REMOTE" ] || git -C "$dest" remote set-url origin "$META_REMOTE" 2>/dev/null || true
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
  if extract_keep_old "$ROOT" "$SNAP/files.tar.gz"; then
    log "restored loose home files (existing ones left untouched)"
  else
    log "could not restore loose home files"
    failed=1
  fi
fi

if [ -d "$SNAP/big" ]; then
  # Files that were too big for files.tar.gz arrived as chunks (see
  # collect_big_files in backup-work.sh): glue them back, check the sha256 the
  # backup recorded, and only then delete the chunks. A missing or corrupt
  # part is reported instead of leaving a half file behind.
  if python3 - "$ROOT" "$SNAP/big" <<'PY'
import hashlib, json, os, sys
root, bigdir = sys.argv[1], sys.argv[2]
ok = True
for name in sorted(os.listdir(bigdir)):
    meta_path = os.path.join(bigdir, name, 'meta.json')
    if not os.path.isfile(meta_path):
        continue
    try:
        meta = json.load(open(meta_path, encoding='utf-8'))
    except Exception as exc:
        print('unreadable meta %s: %s' % (name, exc))
        ok = False
        continue
    rel = str(meta.get('rel') or '').strip('/')
    parts = [p for p in (meta.get('parts') or [])]
    if not rel or not parts:
        continue
    dest = os.path.join(root, rel)
    os.makedirs(os.path.dirname(dest) or root, exist_ok=True)
    digest = hashlib.sha256()
    tmp = dest + '.handoff-part'
    try:
        with open(tmp, 'wb') as out:
            for part in parts:
                src = os.path.join(bigdir, name, part)
                if not os.path.isfile(src):
                    raise IOError('missing chunk %s' % part)
                with open(src, 'rb') as fh:
                    while True:
                        block = fh.read(1 << 20)
                        if not block:
                            break
                        digest.update(block)
                        out.write(block)
        want = str(meta.get('sha256') or '')
        if want and digest.hexdigest() != want:
            raise IOError('sha256 mismatch (expected %s)' % want)
        os.replace(tmp, dest)
        print('restored %s (%d bytes)' % (rel, os.path.getsize(dest)))
    except Exception as exc:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        print('could not rebuild %s: %s' % (rel, exc))
        ok = False
raise SystemExit(0 if ok else 1)
PY
  then
    log "rebuilt chunked big files"
  else
    log "some chunked big files could not be rebuilt"
    failed=1
  fi
fi

if [ -d "$SNAP/descriptors" ]; then
  mkdir -p "$ROOT/.npm-hub/sessions" 2>/dev/null || failed=1
  if ! cp -a -n "$SNAP/descriptors/." "$ROOT/.npm-hub/sessions/" 2>/dev/null; then
    log "could not restore durable session descriptors"
    failed=1
  else
    log "restored durable session descriptors"
  fi
fi

log "done: $restored repo(s) restored"
[ "$failed" -eq 0 ]
