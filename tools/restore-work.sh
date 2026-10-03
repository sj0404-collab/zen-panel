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
#
# WHAT TO RESTORE (all optional; unset means everything, which is what the
# automatic restore at hub start wants. The hub's snapshot tab ticks these.)
#   WORK_BACKUP_ONLY_REPOS      set: newline-separated `rel` paths, * for all,
#                               empty string for none. Unset = everything.
#   WORK_BACKUP_SKIP_CHATS=1     no opencode chat sessions
#   WORK_BACKUP_SKIP_SETTINGS=1  no opencode settings
#   WORK_BACKUP_SKIP_FILES=1     no loose home files, no chunked big files
#   WORK_BACKUP_SKIP_SESSIONS=1  no terminal descriptors / TUI snapshots
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

# Rebuild a repository from worktree.tar.gz - what backup-work.sh writes for a
# shallow clone, whose bundle cannot be cloned ("Failed to traverse parents").
# The result is a real repository (git init + one commit), so the next backup
# can bundle it properly; the caller then applies the WIP diff and the untracked
# files exactly as it does for a cloned repository.
rebuild_from_archive() {
  local repodir="$1" dest="$2" rel="$3"
  [ -s "$repodir/worktree.tar.gz" ] || return 1
  mkdir -p "$dest" || return 1
  if ! tar -xzf "$repodir/worktree.tar.gz" -C "$dest" 2>/dev/null; then
    log "could not unpack the archive of $rel"
    return 1
  fi
  ( cd "$dest" && git init -q ) || return 1
  if [ -f "$repodir/meta.json" ]; then
    META_REMOTE=$(python3 - "$repodir/meta.json" <<'META'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding='utf-8')).get('remote', ''))
except Exception:
    print('')
META
)
    [ -z "$META_REMOTE" ] || git -C "$dest" remote add origin "$META_REMOTE" 2>/dev/null || true
  fi
  # `git -c key=value`, with the equals sign: written as `-c user.email value`
  # git reads the value as the subcommand, the commit silently never happens and
  # the restored repository is left with no commits at all.
  if ! ( cd "$dest" && git add -A && \
      GIT_AUTHOR_NAME="Restore" GIT_AUTHOR_EMAIL="restore@zen-panel" \
      GIT_COMMITTER_NAME="Restore" GIT_COMMITTER_EMAIL="restore@zen-panel" \
          git commit -q -m "state restored from the previous runner" ) >/dev/null 2>&1; then
    log "could not commit the restored tree of $rel (the files are there, but it is not a repository yet)"
    return 1
  fi
  return 0
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

# Only ONE snapshot is read here, but a plain clone pulls the blobs of EVERY
# snapshot on the branch. work-backup passed 70 MB long ago and grows with
# every backup, while the hub gives a restore 40 minutes and then SIGKILLs it -
# so the whole-branch clone was killed mid-flight ("завершилось с кодом 137")
# having restored nothing. A partial clone fetches the tree and no blobs, and
# the sparse checkout below materialises exactly the snapshot asked for.
# Remotes that do not speak partial clone (a local path, as in the tests) fall
# back to the plain clone, exactly as before.
if git clone -q --depth 1 --filter=blob:none --no-checkout --branch "$BRANCH" "$REMOTE" "$WORK/state" 2>/dev/null; then
  TARGET="$WORK/state"
elif git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" "$WORK/state" 2>/dev/null; then
  TARGET="$WORK/state"
else
  log "no $BRANCH branch yet; nothing to restore"
  exit 0
fi

# Nothing is checked out yet, so every lookup below reads the commit directly
# instead of the working tree. `git show` on a partial clone fetches that ONE
# blob and no others, which is what keeps the listing cheap.
read_branch_file() { git -C "$TARGET" show "$BRANCH:$1" 2>/dev/null; }
list_branch_dirs() { git -C "$TARGET" ls-tree -d --name-only "$BRANCH" -- "$1" 2>/dev/null; }

if [ -n "${WORK_BACKUP_SNAPSHOT:-}" ]; then
  SNAP_REL="${WORK_BACKUP_SNAPSHOT#/}"
elif read_branch_file latest.json | grep -q '"stamp"'; then
  LATEST_STAMP=$(read_branch_file latest.json | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("stamp", ""))
except Exception:
    print("")')
  if [ -n "$LATEST_STAMP" ] && list_branch_dirs "snapshots/$LATEST_STAMP" | grep -q .; then
    SNAP_REL="snapshots/$LATEST_STAMP"
  fi
fi
if [ -z "${SNAP_REL:-}" ]; then
  SNAP_REL="$(list_branch_dirs snapshots | LC_ALL=C sort -r | head -n1)"
fi
if [ -z "${SNAP_REL:-}" ]; then
  log "no snapshot found in $BRANCH"
  exit 0
fi
SNAP="$TARGET/$SNAP_REL"

# ── Materialise only the snapshot we were asked for ─────────────────────
# The tree is already here; this pulls the blobs of snapshots/<stamp> and
# nothing else. If the remote ignored the filter above the worktree is still
# empty, so a full checkout is the honest fallback.
if [ -d "$SNAP" ]; then
  :
elif git -C "$TARGET" sparse-checkout init --cone >/dev/null 2>&1 \
  && git -C "$TARGET" sparse-checkout set "$SNAP_REL" >/dev/null 2>&1 \
  && git -C "$TARGET" checkout -q "$BRANCH" >/dev/null 2>&1 \
  && [ -d "$SNAP" ]; then
  log "fetched only $SNAP_REL (the branch itself is much larger)"
else
  log "partial fetch unavailable; checking out the whole branch (slow, but it restores)"
  git -C "$TARGET" sparse-checkout disable >/dev/null 2>&1 || true
  git -C "$TARGET" checkout -q -f "$BRANCH" >/dev/null 2>&1 || true
  git -C "$TARGET" reset -q --hard "$BRANCH" >/dev/null 2>&1 || true
fi
if [ ! -d "$SNAP" ]; then
  log "no snapshot found in $BRANCH"
  exit 0
fi
log "restoring from $SNAP"

# ── Glue back the split blobs ────────────────────────────────────────────
# Anything over 100 MB cannot be a git blob on GitHub, so backup-work.sh split
# it into big/<n>/part.NNN and wrote big-blobs.json. Rebuild every entry in
# place, verify the size and the sha256, and only then read the snapshot. A
# mismatch is reported and the file is left out rather than half-written.
rebuild_split_blobs() {
  local snap="$1" failed=0
  [ -f "$snap/big-blobs.json" ] || return 0
  if python3 - "$snap" <<'BLOBS'
import hashlib, json, os, sys
snap = sys.argv[1]
try:
    doc = json.load(open(os.path.join(snap, 'big-blobs.json'), encoding='utf-8'))
except Exception as exc:
    print('unreadable big-blobs.json: %s' % exc)
    raise SystemExit(1)
blobs = doc.get('blobs') or []
ok = True
for n, blob in enumerate(blobs, start=1):
    rel = str(blob.get('rel') or '').strip('/')
    parts = blob.get('parts') or []
    if not rel or not parts:
        continue
    dest = os.path.join(snap, rel)
    os.makedirs(os.path.dirname(dest) or snap, exist_ok=True)
    tmp = dest + '.rebuilt'
    digest = hashlib.sha256()
    try:
        with open(tmp, 'wb') as out:
            for part in parts:
                src = os.path.join(snap, 'blobs', str(n), part)
                if not os.path.isfile(src):
                    raise IOError('missing chunk %s' % part)
                with open(src, 'rb') as fh:
                    while True:
                        block = fh.read(1 << 20)
                        if not block:
                            break
                        digest.update(block)
                        out.write(block)
        want = str(blob.get('sha256') or '')
        if want and digest.hexdigest() != want:
            raise IOError('sha256 mismatch')
        want_size = int(blob.get('size') or 0)
        if want_size and os.path.getsize(tmp) != want_size:
            raise IOError('size mismatch: %d != %d' % (os.path.getsize(tmp), want_size))
        os.replace(tmp, dest)
        print('rebuilt %s (%d bytes)' % (rel, os.path.getsize(dest)))
    except Exception as exc:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        print('could not rebuild %s: %s' % (rel, exc))
        ok = False
raise SystemExit(0 if ok else 1)
BLOBS
  then
    log "rebuilt the split blobs"
  else
    log "some split blobs could not be rebuilt - the snapshot is incomplete"
    failed=1
  fi
  return "$failed"
}
BLOBS_FAILED=0
rebuild_split_blobs "$SNAP" || BLOBS_FAILED=1

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
# ── What the user ticked ───────────────────────────────────────────────
# A snapshot holds more than a user usually wants back: repositories, chat
# sessions, settings, loose home files, terminal descriptors. Restoring all of
# it every time is slow and, for the big files, expensive - so the hub passes
# the selection down and this script honours it exactly. No variable set (the
# old behaviour, and every plain run) still means "everything", which is what
# the automatic restore at hub start needs.
# An UNSET variable means everything, which is what the automatic restore at
# hub start passes and what every plain run expects. A variable that is set -
# even to an empty string - is a decision by the caller: empty therefore means
# "nothing", and that is the difference between "I ticked nothing" and "I did
# not say", which must not quietly restore the whole snapshot.
ONLY_REPOS_SET=0
[ "${WORK_BACKUP_ONLY_REPOS+x}" = "x" ] && ONLY_REPOS_SET=1
ONLY_REPOS="${WORK_BACKUP_ONLY_REPOS:-}"
SKIP_CHATS="${WORK_BACKUP_SKIP_CHATS:-0}"
SKIP_SETTINGS="${WORK_BACKUP_SKIP_SETTINGS:-0}"
SKIP_FILES="${WORK_BACKUP_SKIP_FILES:-0}"
SKIP_SESSIONS="${WORK_BACKUP_SKIP_SESSIONS:-0}"
selection_is_partial() {
  [ "$ONLY_REPOS_SET" = "1" ] && [ "$ONLY_REPOS" != "*" ] \
    || [ "$SKIP_CHATS" = "1" ] || [ "$SKIP_SETTINGS" = "1" ] \
    || [ "$SKIP_FILES" = "1" ] || [ "$SKIP_SESSIONS" = "1" ]
}
repo_selected() {
  local rel="$1"
  [ "$ONLY_REPOS_SET" = "1" ] || return 0
  [ -n "$ONLY_REPOS" ] || return 1
  [ "$ONLY_REPOS" = "*" ] && return 0
  printf '%s\n' "$ONLY_REPOS" | grep -qxF -- "$rel"
}
SELECTED_METAS="$WORK/selected-metas.txt"
: > "$SELECTED_METAS"
if selection_is_partial; then
  if [ "$ONLY_REPOS_SET" = "1" ] && [ "$ONLY_REPOS" = "*" ]; then
    repos_desc='*'
  elif [ "$ONLY_REPOS_SET" = "1" ]; then
    repos_desc="$(printf '%s' "$ONLY_REPOS" | tr '\n' ' ')"
  else
    repos_desc='(не задано — все)'
  fi
  log "selection: repos=[$repos_desc]" \
    "chats=$([ "$SKIP_CHATS" = 1 ] && echo no || echo yes)" \
    "settings=$([ "$SKIP_SETTINGS" = 1 ] && echo no || echo yes)" \
    "files=$([ "$SKIP_FILES" = 1 ] && echo no || echo yes)" \
    "sessions=$([ "$SKIP_SESSIONS" = 1 ] && echo no || echo yes)"
fi
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
  # An unticked repository is not touched at all: no clone, no wip patch, no
  # untracked files, and no chat import for it further down.
  if ! repo_selected "$rel"; then
    log "skipped $rel (not selected)"
    continue
  fi
  printf '%s\n' "$meta" >> "$SELECTED_METAS"
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
       # A bundle that will not clone is still better than no repository: the
       # archive next to it holds the committed tree, and the WIP patch plus
       # the untracked pack that follow bring the working state with it.
       if rebuild_from_archive "$repodir" "$dest" "$rel"; then
         log "restored $rel from its archive (the bundle would not clone)"
       else
         log "clone of $rel failed; skipped"
         failed=1
         continue
       fi
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

  elif ! rebuild_from_archive "$repodir" "$dest" "$rel"; then
    mkdir -p "$dest"
    ( cd "$dest" && git init -q )
  fi
   if ! apply_payload "$dest" "$repodir" "$rel"; then failed=1; fi
   if ! copy_legacy_manifest "$dest"; then failed=1; fi

  restored=$((restored + 1))
  log "restored $rel -> $dest"
done < <(find "$SNAP/repos" -type f -name meta.json -print 2>/dev/null)

# ── OpenCode: settings + chat sessions from the SAME snapshot ──
# Settings go back to the exact path the manifest recorded, never clobbering
# whatever the fresh runner already wrote (--keep-old semantics via cp -n).
if [ "$SKIP_SETTINGS" = "1" ]; then
  log "skipped opencode settings (not selected)"
elif [ -f "$SNAP/opencode/settings/manifest.json" ]; then
  python3 - "$SNAP/opencode" <<'PYP'
import json, os, shutil, sys
oc = sys.argv[1]
try:
    manifest = json.load(open(os.path.join(oc, 'settings', 'manifest.json'), encoding='utf-8'))
except Exception as exc:
    print('opencode settings: bad manifest: %s' % exc)
    raise SystemExit(1)
done = 0
for e in manifest if isinstance(manifest, list) else manifest.get('files', []):
    rel, fn = e.get('rel', ''), e.get('file', '')
    src = os.path.join(oc, fn)
    if not rel or not fn or not os.path.isfile(src):
        continue
    dest = os.path.expanduser(rel) if rel.startswith('~') else rel
    if rel.startswith('hub-work'):
        dest = os.path.join(os.environ.get('WORK_BACKUP_ROOT', os.path.expanduser('~')), rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        continue  # keep the fresh runner's own copy
    shutil.copy2(src, dest)
    done += 1
print('opencode settings: %d file(s) restored' % done)
PYP
fi
# Chat sessions: per-repo bundle from this very snapshot, imported back into
# the repo we just restored (restore-chats.sh assigns sessions to the CWD).
#
# It walks the SAME list of metas the repo loop above wrote, not a glob over
# repos/hub-work/*/meta.json. That glob only ever matched repositories the Files
# tab happened to clone into hub-work/, so chat sessions of the hub clone and of
# any repo elsewhere under $HOME were silently never restored.
if [ "$SKIP_CHATS" = "1" ]; then
  log "skipped opencode chats (not selected)"
elif [ -d "$SNAP/opencode/chats" ] && ls "$SNAP/opencode/chats"/*.json >/dev/null 2>&1; then
  RESTORE_CHATS_BIN="$HOME/.local/bin/restore-chats.sh"; [ -f "$RESTORE_CHATS_BIN" ] || RESTORE_CHATS_BIN="$(dirname "$0")/restore-chats.sh"
  while IFS= read -r meta; do
    [ -f "$meta" ] || continue
    name="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); print(d.get("name") or "")' "$meta" 2>/dev/null | tr -c 'A-Za-z0-9._-' '_')"
    [ -n "$name" ] || continue
    bundle="$SNAP/opencode/chats/$name.json"
    [ -s "$bundle" ] || continue
    rel="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); print(d.get("rel") or "")' "$meta" 2>/dev/null)"
    dest="$ROOT/$rel"
    [ -d "$dest" ] || continue
    CHAT_BUNDLE="$bundle" CHAT_REPO_DIR="$dest" bash "$RESTORE_CHATS_BIN" >/dev/null 2>&1 && log "chats restored for $name" || log "chats restore failed for $name"
  done < "$SELECTED_METAS"
fi

if [ "$SKIP_FILES" = "1" ]; then
  log "skipped loose home files and big files (not selected)"
elif [ -s "$SNAP/files.tar.gz" ]; then
  # --keep-old-files: never overwrite whatever the fresh runner already has.
  if extract_keep_old "$ROOT" "$SNAP/files.tar.gz"; then
    log "restored loose home files (existing ones left untouched)"
  else
    log "could not restore loose home files"
    failed=1
  fi
fi

if [ "$SKIP_FILES" != "1" ] && [ -d "$SNAP/big" ]; then
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

# Descriptors and TUI snapshots of the sessions. cp -n: whatever the fresh
# runner wrote itself is newer and must survive; everything missing comes back.
# Then the counts, because a silent restore here is indistinguishable from
# «the user has no unfinished sessions» - and the snapshot is exactly what
# makes a reopened terminal show the last known screen instead of a black one.
if [ "$SKIP_SESSIONS" = "1" ]; then
  log "skipped durable session descriptors and TUI snapshots (not selected)"
elif [ -d "$SNAP/descriptors" ]; then
  mkdir -p "$ROOT/.npm-hub/sessions" 2>/dev/null || failed=1
  if ! cp -a -n "$SNAP/descriptors/." "$ROOT/.npm-hub/sessions/" 2>/dev/null; then
    log "could not restore durable session descriptors"
    failed=1
  else
    log "restored durable session descriptors"
  fi
  session_dir="$ROOT/.npm-hub/sessions"
  metas=0; snaps=0
  if [ -d "$session_dir" ]; then
    metas="$(find "$session_dir" -maxdepth 1 -name 'npmhub-*.meta.json' -type f 2>/dev/null | wc -l | tr -d ' ')"
    # A snapshot without its descriptor is unusable: there is no session to
    # attach it to, so nothing would ever read it. Drop it instead of leaving
    # a file that only costs restore time and confuses the next backup.
    for snap_file in "$session_dir"/npmhub-*.snapshot; do
      [ -f "$snap_file" ] || continue
      base="${snap_file%.snapshot}"
      if [ -f "$base.meta.json" ]; then
        snaps=$((snaps + 1))
      else
        rm -f "$snap_file" 2>/dev/null || true
        log "dropped orphan TUI snapshot $(basename "$snap_file") (no descriptor)"
      fi
    done
    # Tail of a snapshot write that a dead runner never finished.
    find "$session_dir" -maxdepth 1 -name '*.snapshot.tmp' -type f -delete 2>/dev/null || true
  fi
  log "sessions available after restore: $metas descriptor(s), $snaps TUI snapshot(s)"
fi

log "done: $restored repo(s) restored"
[ "$failed" -eq 0 ] && [ "$BLOBS_FAILED" -eq 0 ]
