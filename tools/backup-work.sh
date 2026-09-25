#!/usr/bin/env bash
# Snapshot every working repository under $HOME to the `work-backup` branch.
#
# WHY
#   The runner disk is ephemeral. When the job ends - or the agent restarts the
#   hub and the working tree is reset - every uncommitted change and every repo
#   that was never pushed disappears for good. This script keeps a durable copy
#   on GitHub: for each repo it stores a git bundle of ALL refs plus the
#   uncommitted diff and the untracked files, so restore-work.sh can rebuild the
#   tree on the next run. Files that are not inside a repo are archived too.
#
# SELF-CONTAINED SNAPSHOTS
#   Every published snapshot holds every repo, not only the ones that changed,
#   so restoring from the newest snapshot is always complete. Idle work costs
#   nothing because a global signature (all repo HEAD/status digests plus the
#   loose-file listing) is compared first and the run stops before packing.
#
# WHAT IS SKIPPED
#   Heavy, regenerable paths (node_modules, caches, toolchains, the runner's own
#   checkout, the opencode database) are excluded by name.
#
# BIG FILES
#   A file over WORK_BACKUP_MAX_FILE_MB used to be dropped from the snapshot
#   without a word - a 150 MB dataset, a video, a big log simply never reached
#   the next runner. GitHub refuses any blob over 100 MB ("exceeds 100 MiB"),
#   so such a file cannot be committed whole either: it is split into chunks of
#   WORK_BACKUP_CHUNK_MB and restore-work.sh glues them back together.
#
# BIG BLOBS (the same limit, one level up)
#   The snapshot itself grows blobs: files.tar.gz of the loose home files, and
#   a repo.bundle of a big repository. Those are not "big files" - they are the
#   backup - and they outgrew the same 100 MB limit: measured on a live runner,
#   files.tar.gz reached 140 MB and repo.bundle 96 MB, so the whole snapshot
#   could not be pushed and the branch kept only the last few commits' worth of
#   latest.json pointing at snapshots that were never there.
#
#   So before publishing, EVERY file in the stage over
#   WORK_BACKUP_MAX_BLOB_MB is split into blobs/<n>/part.NNN with a
#   big-blobs.json manifest (name, size, parts). restore-work.sh glues every
#   manifest entry back before it reads the snapshot, and the manifest is
#   verified, not trusted. (blobs/ is its own directory: big/ already holds the
#   per-file chunks of collect_big_files, and both number from 1.)
#
# USAGE
#   backup-work.sh --once            one snapshot, then exit
#   backup-work.sh                   daemon: snapshot every WORK_BACKUP_INTERVAL
#
# ENV
#   WORK_BACKUP_ROOT        root to scan            (default $HOME)
#   WORK_BACKUP_BRANCH      destination branch      (default work-backup)
#   WORK_BACKUP_INTERVAL    daemon seconds          (default 300)
#   WORK_BACKUP_KEEP        snapshots to retain     (default 4)
#   WORK_BACKUP_MAX_FILE_MB max single file to pack (default 25)
#   WORK_BACKUP_MAX_TOTAL_MB bail out over this     (default 400)
#   WORK_BACKUP_MAX_BIG_MB  largest split-and-send file (default 200)
#   WORK_BACKUP_CHUNK_MB    chunk size for those     (default 20)
#   WORK_BACKUP_MAX_BLOB_MB anything bigger inside the snapshot is split
#                           before the push (default 80)
#   SESSION_STATE_URL       git remote override for local tests
set -uo pipefail

ROOT="${WORK_BACKUP_ROOT:-$HOME}"
BRANCH="${WORK_BACKUP_BRANCH:-work-backup}"
INTERVAL="${WORK_BACKUP_INTERVAL:-300}"
KEEP="${WORK_BACKUP_KEEP:-4}"
MAX_FILE_MB="${WORK_BACKUP_MAX_FILE_MB:-25}"
MAX_TOTAL_MB="${WORK_BACKUP_MAX_TOTAL_MB:-400}"
MAX_BIG_MB="${WORK_BACKUP_MAX_BIG_MB:-200}"
CHUNK_MB="${WORK_BACKUP_CHUNK_MB:-20}"
# GitHub refuses a blob over 100 MB. Stay well under it: the limit applies to
# the file as stored, so a snapshot is only pushable if every part of it is.
MAX_BLOB_MB="${WORK_BACKUP_MAX_BLOB_MB:-80}"
for _v in MAX_BIG_MB CHUNK_MB; do
  case "${!_v}" in
    ''|*[!0-9]*) eval "$_v=200" ;;
  esac
done
case "$MAX_BLOB_MB" in
  ''|*[!0-9]*) MAX_BLOB_MB=80 ;;
esac
[ "$MAX_BLOB_MB" -gt 0 ] && [ "$MAX_BLOB_MB" -le 90 ] || MAX_BLOB_MB=80
[ "$CHUNK_MB" -gt 0 ] && [ "$CHUNK_MB" -le 90 ] || CHUNK_MB=20
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
STATE_DIR="${WORK_BACKUP_STATE:-$HOME/.npm-hub/work-backup-state}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1
case "$MAX_TOTAL_MB" in
  ''|*[!0-9]*) MAX_TOTAL_MB=400 ;;
esac

if ! mkdir -p "$HUB_LOGS" "$STATE_DIR"; then
  printf '%s\n' "work-backup: cannot create log or state directory" >&2
  exit 1
fi
log() { echo "[work-backup $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/work-backup.log"; }
if [ -z "${SESSION_STATE_URL:-}" ] && [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  log "no GitHub token; backup is disabled"
  exit 1
fi

REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN:-${GITHUB_TOKEN:-}}@github.com/${GITHUB_REPOSITORY:-}.git}"
LOCK_DIR="$STATE_DIR/publish.lock"
acquire_backup_lock() {
  local owner now mtime
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    printf '%s\n' "$(date +%s)" > "$LOCK_DIR/started"
    return 0
  fi
  owner=""
  started=""
  [ -f "$LOCK_DIR/pid" ] && owner="$(tr -dc '0-9' < "$LOCK_DIR/pid")"
  [ -f "$LOCK_DIR/started" ] && started="$(tr -dc '0-9' < "$LOCK_DIR/started")"
  now="$(date +%s)"
  mtime="$(stat -c %Y "$LOCK_DIR" 2>/dev/null || printf '0')"
  if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } \
    || { [ -z "$owner" ] && [ "$mtime" -gt 0 ] && [ $((now - mtime)) -gt 120 ]; } \
    || { [ -n "$started" ] && [ $((now - started)) -gt 900 ]; }; then
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$LOCK_DIR/pid"
      printf '%s\n' "$now" > "$LOCK_DIR/started"
      return 0
    fi
  fi
  return 1
}
release_backup_lock() { rm -rf "$LOCK_DIR"; }

EXCLUDES=(
  '*/actions-runner/*' '*/.nvm/*' '*/.cache/*' '*/.npm/*' '*/.gradle/*'
  '*/.m2/*' '*/.cargo/*' '*/.rustup/*' '*/.local/share/opencode/*'
  '*/.local/share/Trash/*' '*/.zen-agent/*' '*/node_modules/*'
  '*/.venv/*' '*/venv/*' '*/__pycache__/*' '*/.tox/*' '*/.pytest_cache/*'
  '*/.config/gh/*' '*/.npm-hub' '*/.npm-hub/*' '*/.npm-hub/tmp/*' '*/.npm-hub/logs/*' '*/.ssh/*'
  '*/.docker/*' '*/.oh-my-zsh/*' '*/.opencode/*' '*/work/*'
  '*/hub-work/*/node_modules/*' '*/.git/lfs/*' '*/.local/share/Code/*'
  # Downloaded tool stores and browser model caches: hundreds of MB that any
  # tool re-fetches on its own. They were the reason files.tar.gz grew to
  # 140 MB and the whole snapshot stopped being pushable.
  '*.apk' '*.aab' '*.apks'
  '*/.dotnet/tools/.store/*' '*/optimization_guide_model_store/*'
  '*/component_crx_cache/*' '*/ShaderCache/*' '*/.local/state/*'
  '*/.vscode-server/*' '*/.java/*' '*/.sonar/*'
  # Gradle/Android build outputs: regenerable and routinely >500MB per build.
  # They were filling the snapshots (one gradle build alone was ~700MB) and
  # restoring them only re-triggered a rebuild anyway. `gradle/wrapper` stays
  # in the untracked pack (skip_regenerable keeps it) — it is needed to
  # rebuild and is tiny.
  '*/build/*' '*/.kotlin/*' '*/.idea/*' '*/gradle/*'
  '*/.gradle/*' '*/target/*' '*.apk' '*.aab' '*.hprof'
)

# Paths that never go into a snapshot: regenerable build/cache output. Used by
# the untracked-file packer where git ls-files would otherwise include them.
skip_regenerable() {
  case "$1" in
    *.apk|*.aab|*.apks|*.hprof) return 0 ;;
    # The tool's own payload inside a repository: a 60 MB binary that the
    # agent downloads for itself, not the user's work.
    .opencode|.opencode/*|*/.opencode|*/.opencode/*) return 0 ;;
    local.properties|*/local.properties) return 0 ;;
    */build/*|build/*|*/target/*|target/*) return 0 ;;
    */.gradle/*|.gradle/*|*/.kotlin/*|.kotlin/*) return 0 ;;
    */.idea/*|.idea/*) return 0 ;;
    */build/|build/|*/target/|target/|*/.gradle/|.gradle/|*/.kotlin/|.kotlin/|*/.idea/|.idea/) return 0 ;;
  esac
  return 1
}

find_repos() {
  local args=()
  for e in "${EXCLUDES[@]}"; do args+=( -path "$e" -prune -o ); done
  find "$ROOT" -maxdepth 8 "${args[@]}" -type d -name .git -print 2>/dev/null
}

# HEAD + a digest of the porcelain status (which already lists untracked files).
repo_sig() {
  local dir="$1" head status
  head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)"
  status="$(
    {
      git -C "$dir" diff --binary HEAD 2>/dev/null || true
      git -C "$dir" ls-files --others --exclude-standard -z 2>/dev/null \
        | while IFS= read -r -d '' f; do
            printf 'U %s ' "$f"
            sha1sum "$dir/$f" 2>/dev/null | cut -d' ' -f1
          done
    } | sha1sum | cut -d' ' -f1
  )"
  printf '%s %s' "$head" "$status"
}

sanitize() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-160; }

# Build the extra find predicates that keep repo trees out of the loose set.
loose_predicates() {
  local excl_args=() repo_excl=() rdir relp
  for e in "${EXCLUDES[@]}"; do excl_args+=( ! -path "$e" ); done
  while IFS= read -r rdir; do
    [ -n "$rdir" ] || continue
    relp="$(dirname "${rdir#"$ROOT"/}")"
    [ "$relp" = "." ] && continue
    repo_excl+=( ! -path "./$relp" ! -path "./$relp/*" )
  done < <(find_repos)
  LOOSE_PREDICATES=( ${excl_args[@]+"${excl_args[@]}"} ${repo_excl[@]+"${repo_excl[@]}"} )
}

loose_listing() {
  loose_predicates
  ( cd "$ROOT" || return 0
    find . -mindepth 1 ${LOOSE_PREDICATES[@]+"${LOOSE_PREDICATES[@]}"} \
      -printf '%y %P %s %T@\n' 2>/dev/null | LC_ALL=C sort )
}

# Loose files between MAX_FILE_MB and MAX_BIG_MB: too big for files.tar.gz
# (and unsendable as one git blob), so each is split into CHUNK_MB parts under
# big/<n>/ next to a meta.json with size + sha256. restore-work.sh rebuilds and
# verifies them. Anything over MAX_BIG_MB is reported, never silently dropped.
collect_big_files() {
  local stage="$1" list chunks=0 skipped=0
  list="$(mktemp)" || return 1
  loose_predicates
  if ! ( cd "$ROOT" || exit 1
    find . -mindepth 1 -type f ${LOOSE_PREDICATES[@]+"${LOOSE_PREDICATES[@]}"} \
      -size +"${MAX_FILE_MB}"M -print0 2>/dev/null > "$list" ); then
    rm -f "$list"
    return 1
  fi
  if [ ! -s "$list" ]; then
    rm -f "$list"
    return 0
  fi
  mkdir -p "$stage/big" || { rm -f "$list"; return 1; }
  if ! python3 - "$ROOT" "$stage" "$list" "$((CHUNK_MB * 1024 * 1024))" <<'PY'
import hashlib, json, os, sys
root, stage, listfile, chunk = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
index = 0
for raw in open(listfile, 'rb').read().split(b'\0'):
    if not raw:
        continue
    rel = raw.decode('utf-8', 'replace').replace('\\', '/')
    src = os.path.join(root, rel)
    if os.path.islink(src) or not os.path.isfile(src):
        continue
    size = os.path.getsize(src)
    if size <= 0:
        continue
    index += 1
    out = os.path.join(stage, 'big', str(index))
    os.makedirs(out, exist_ok=True)
    digest = hashlib.sha256()
    parts = []
    with open(src, 'rb') as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            digest.update(block)
            name = 'part.%03d' % len(parts)
            with open(os.path.join(out, name), 'wb') as w:
                w.write(block)
            parts.append(name)
    with open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8') as w:
        json.dump({'rel': rel, 'size': size, 'sha256': digest.hexdigest(),
                   'parts': parts, 'chunkBytes': chunk}, w, ensure_ascii=False, indent=2)
PY
  then
    log "python could not split the big files"
    rm -f "$list"
    return 1
  fi
  chunks="$(find "$stage/big" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  [ -n "$chunks" ] || chunks=0
  if ! ( cd "$ROOT" || exit 1
    find . -mindepth 1 -type f ${LOOSE_PREDICATES[@]+"${LOOSE_PREDICATES[@]}"} \
      -size +"${MAX_BIG_MB}"M -printf '%s %P\n' 2>/dev/null > "$stage/big-skipped.txt" ); then
    : > "$stage/big-skipped.txt"
  fi
  skipped="$(wc -l < "$stage/big-skipped.txt" 2>/dev/null | tr -d ' ')"
  [ -n "$skipped" ] || skipped=0
  if [ "$skipped" -gt 0 ]; then
    log "$skipped file(s) over ${MAX_BIG_MB}MB not sent (raise WORK_BACKUP_MAX_BIG_MB to include them):"
    while read -r size rel; do log "  skipped $rel ($((size / 1024 / 1024))MB)"; done \
      < "$stage/big-skipped.txt"
  fi
  rm -f "$list"
  [ "$chunks" -gt 0 ] && log "split $chunks big file(s) into ${CHUNK_MB}MB chunks"
  return 0
}

# Every file of the stage that GitHub would refuse (>100 MB) is split here.
# files.tar.gz and a big repo.bundle are the usual offenders, and one of them is
# enough to make the whole snapshot unpushable - which is exactly what happened
# on a live runner: the branch received latest.json updates for two days and
# not a single snapshot, while latest.json pointed at snapshots that were never
# there. The manifest is what restore-work.sh rebuilds from, and it is verified.
split_big_blobs() {
  local stage="$1"
  python3 - "$stage" "$MAX_BLOB_MB" "$CHUNK_MB" <<'BLOBS'
import hashlib, json, os, sys
stage, limit_mb, chunk_mb = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
limit = limit_mb * 1024 * 1024
chunk = max(chunk_mb, 1) * 1024 * 1024
SKIP = {'big-blobs.json', 'manifest.json', 'latest.json', 'tree.txt',
        'big-skipped.txt'}
manifest, index = [], 0
for base, dirs, files in os.walk(stage):
    dirs.sort()
    if os.path.basename(base) == 'big':
        continue
    for name in sorted(files):
        if name in SKIP:
            continue
        path = os.path.join(base, name)
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        if size <= limit:
            continue
        index += 1
        digest = hashlib.sha256()
        parts = []
        os.makedirs(os.path.join(stage, 'blobs', str(index)), exist_ok=True)
        with open(path, 'rb') as fh:
            while True:
                block = fh.read(chunk)
                if not block:
                    break
                digest.update(block)
                part = 'part.%03d' % len(parts)
                with open(os.path.join(stage, 'blobs', str(index), part), 'wb') as w:
                    w.write(block)
                parts.append(part)
        manifest.append({'rel': os.path.relpath(path, stage).replace(os.sep, '/'),
                         'size': size, 'sha256': digest.hexdigest(),
                         'parts': parts, 'chunkBytes': chunk})
        os.remove(path)
with open(os.path.join(stage, 'big-blobs.json'), 'w', encoding='utf-8') as w:
    json.dump({'kind': 'work-backup-blobs', 'blobs': manifest}, w,
              ensure_ascii=False, indent=2)
print(len(manifest))
BLOBS
}

# One digest covering every repo and every loose file: the gate for publishing.
compute_sig() {
  {
    local gitdir dir rel
    while IFS= read -r gitdir; do
      [ -n "$gitdir" ] || continue
      dir="$(dirname "$gitdir")"; rel="${dir#"$ROOT"/}"
      [ "$rel" = "$dir" ] && rel="$(basename "$dir")"
      printf 'REPO\t%s\t%s\n' "$rel" "$(repo_sig "$dir")"
    done < <(find_repos)
    printf 'DESCRIPTORS\n'
    if [ -d "$ROOT/.npm-hub/sessions" ]; then
      find "$ROOT/.npm-hub/sessions" -type f -print0 2>/dev/null \
        | LC_ALL=C sort -z | xargs -0 -r sha1sum
    fi
    printf 'LOOSE\n'
    loose_listing | sha1sum
  } | sha1sum | cut -d' ' -f1
}

collect() {
  local stage="$1"
  mkdir -p "$stage/repos" || return 1
  local total_bytes=0 budget=$(( MAX_TOTAL_MB * 1024 * 1024 )) gitdir dir rel out sz shallow

  while IFS= read -r gitdir; do
    [ -n "$gitdir" ] || continue
    dir="$(dirname "$gitdir")"
    rel="${dir#"$ROOT"/}"; [ "$rel" = "$dir" ] && rel="$(basename "$dir")"
    out="$stage/repos/$rel"
    mkdir -p "$out" || return 1
    if git -C "$dir" rev-parse HEAD >/dev/null 2>&1; then
      # A shallow clone (the Files tab clones with --depth 1, and so does a
      # restore) has no history before its boundary, and `git bundle create`
      # still writes a bundle - one that cannot be cloned: "Failed to traverse
      # parents of commit ...", "remote did not send all necessary objects".
      # Measured on a live runner: both big repositories were unrestorable for
      # exactly this reason, and the log said nothing. So for a shallow repo we
      # ship the committed tree as an archive instead; with the WIP diff and
      # the untracked files that follow it, that IS the working state.
      shallow=0
      [ "$(git -C "$dir" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ] && shallow=1
      if [ "$shallow" = 1 ]; then
        # Same rule as the untracked pack: an APK in the tree is a build
        # product, not the source. On the live runner the book app carried a
        # 40 MB .apk and a 13 MB .tar.xz in HEAD, which alone made the archive
        # too big to push.
        if ! git -C "$dir" archive --format=tar.gz -o "$out/worktree.tar.gz" HEAD -- . \
          ':(exclude)*.apk' ':(exclude)*.aab' ':(exclude)*.apks' \
          ':(exclude)build' ':(exclude)*/build/*' \
          ':(exclude).gradle' ':(exclude)*/.gradle/*' \
          ':(exclude).opencode' ':(exclude)*/.opencode/*' \
          ':(exclude)local.properties' ':(exclude)*/local.properties' 2>/dev/null; then
          # An old git without pathspec magic: fall back to the whole tree
          # rather than losing the repository.
          if ! git -C "$dir" archive --format=tar.gz -o "$out/worktree.tar.gz" HEAD 2>/dev/null; then
            log "worktree archive failed for $rel (shallow repository)"
            return 1
          fi
        fi
        [ -s "$out/worktree.tar.gz" ] || rm -f "$out/worktree.tar.gz"
      else
        if ! git -C "$dir" bundle create "$out/repo.bundle" --all >/dev/null 2>&1; then
          log "bundle failed for $rel"
          return 1
        fi
      fi
      if ! git -C "$dir" diff --binary HEAD >"$out/wip.patch" 2>/dev/null; then
        log "WIP diff failed for $rel"
        return 1
      fi
    else
      if ! git -C "$dir" diff --binary >"$out/wip.patch" 2>/dev/null; then
        log "unborn-repository diff failed for $rel"
        return 1
      fi
    fi
    [ -s "$out/wip.patch" ] || rm -f "$out/wip.patch"
    if ! ( cd "$dir" && git ls-files --others --exclude-standard -z 2>/dev/null \
        | while IFS= read -r -d '' f; do skip_regenerable "$f" || printf '%s\0' "$f"; done \
        | tar --null -T - -czf "$out/untracked.tar.gz" 2>/dev/null ); then
      log "untracked archive failed for $rel"
      return 1
    fi
    [ -s "$out/untracked.tar.gz" ] || rm -f "$out/untracked.tar.gz"
    if ! python3 - "$dir" "$rel" "$out/meta.json" <<'PY' 2>/dev/null
import json, os, subprocess, sys
d, rel, path = sys.argv[1], sys.argv[2], sys.argv[3]
def run(c):
    try: return subprocess.check_output(c, cwd=d, shell=True, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception: return ""
shallow = run("git rev-parse --is-shallow-repository 2>/dev/null") == "true"
boundary = ""
if shallow:
    try:
        with open(os.path.join(subprocess.check_output(["git", "-C", d, "rev-parse", "--git-dir"], text=True).strip(), "shallow"), encoding="utf-8") as f:
            boundary = f.read().strip()
    except Exception:
        boundary = ""
json.dump({
    "rel": rel, "path": d, "name": os.path.basename(os.path.realpath(d)),
    "branch": run("git branch --show-current") or run("git rev-parse --abbrev-ref HEAD"),
    "head": run("git rev-parse HEAD"),
    "remote": run("git remote get-url origin 2>/dev/null"),
    "dirty": bool(run("git status --porcelain")),
    "shallow": shallow, "shallowBoundary": boundary,
}, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
    then
      log "metadata failed for $rel"
      return 1
    fi
    sz="$(du -sb "$out" 2>/dev/null | cut -f1)"; total_bytes=$(( total_bytes + ${sz:-0} ))
    if [ "$total_bytes" -gt "$budget" ]; then
      log "budget ${MAX_TOTAL_MB}MB exceeded; remaining repos not packed this round"
      break
    fi
  done < <(find_repos)

  loose_listing > "$stage/tree.txt" 2>/dev/null || return 1
  loose_predicates
  if ! ( cd "$ROOT" || exit 1
    find . -mindepth 1 -type f ${LOOSE_PREDICATES[@]+"${LOOSE_PREDICATES[@]}"} \
      ! -size +"${MAX_FILE_MB}"M -print0 2>/dev/null \
      | tar --null -T - -czf "$stage/files.tar.gz" 2>/dev/null ); then
    log "loose-file archive failed"
    return 1
  fi
  [ -s "$stage/files.tar.gz" ] || rm -f "$stage/files.tar.gz"
  if ! collect_big_files "$stage"; then
    log "big-file chunking failed"
    return 1
  fi
  if [ -d "$ROOT/.npm-hub/sessions" ]; then
    mkdir -p "$stage/descriptors" || return 1
    cp -a "$ROOT/.npm-hub/sessions/." "$stage/descriptors/" || return 1
  fi
  # Last thing before publishing: make sure every file in the stage is
  # something GitHub will actually accept. One oversized blob and the whole
  # snapshot is refused - silently, as far as the branch is concerned.
  local split
  split="$(split_big_blobs "$stage" | tail -1)"
  case "$split" in
    ''|*[!0-9]*) split=0 ;;
  esac
  if [ "$split" -gt 0 ]; then
    log "split $split oversized snapshot file(s) into ${CHUNK_MB}MB parts (GitHub refuses blobs over 100 MB)"
  fi
  log "left out by design: node_modules, caches, toolchains, build outputs (build/, .gradle/, target/), APKs and downloaded tool stores - all of them are rebuilt or re-downloaded on the next runner"
}

backup_run_is_stale() {
  [ -f latest.json ] || return 1
  python3 - <<'PY'
import json, os
try:
    current = int(os.environ.get("GITHUB_RUN_NUMBER") or 0)
    latest = int(json.load(open("latest.json", encoding="utf-8")).get("runNumber") or 0)
except Exception:
    raise SystemExit(1)
raise SystemExit(0 if current and latest and current < latest else 1)
PY
}

publish() {
  local stage="$1" stamp="$2" work
  if ! work="$(mktemp -d)"; then
    log "cannot create publish directory"
    return 1
  fi
  ( cd "$work" || exit 1
    if ! git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" state 2>/dev/null; then
      git clone -q "$REMOTE" state 2>/dev/null || exit 1
      ( cd state && git checkout -q --orphan "$BRANCH" 2>/dev/null; git rm -rqf . 2>/dev/null ) || true
    fi
  ) || { rm -rf "$work"; return 1; }
  cd "$work/state" || { rm -rf "$work"; return 1; }
  if backup_run_is_stale; then
    log "newer work-backup run already owns $BRANCH; left alone"
    rm -rf "$work"
    return 2
  fi
  materialize_snapshot() {
    local source="$1" name="$2" python_status
    mkdir -p snapshots || return 1
    rm -rf "snapshots/$name" || return 1
    cp -a "$source" "snapshots/$name" || return 1
    touch "snapshots/$name" || return 1
    if [ -f "$source/tree.txt" ]; then
      cp "$source/tree.txt" "snapshots/$name/tree.txt" || return 1
    fi
    python3 - "$source" "latest.json" "$name" <<'PY'
import json, os, sys
snap, latest, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
repos = []
rroot = os.path.join(snap, "repos")
if os.path.isdir(rroot):
    for base, dirs, files in os.walk(rroot):
        dirs.sort()
        if "meta.json" not in files:
            continue
        rel = os.path.relpath(base, rroot).replace(os.sep, "/")
        try:
            meta = json.load(open(os.path.join(base, "meta.json"), encoding="utf-8"))
        except Exception:
            meta = {"rel": rel}
        meta["files"] = sorted(os.listdir(base))
        repos.append(meta)
repos.sort(key=lambda x: str(x.get("rel", "")))
data = {"kind": "work-backup", "stamp": stamp, "snapshot": snap, "repos": repos,
        "runId": os.environ.get("GITHUB_RUN_ID", ""),
        "runNumber": int(os.environ.get("GITHUB_RUN_NUMBER", 0)),
        "tree": os.path.exists(os.path.join(snap, "tree.txt")),
        "files": os.path.exists(os.path.join(snap, "files.tar.gz")),
        "blobs": len(json.load(open(os.path.join(snap, "big-blobs.json"), encoding="utf-8")).get("blobs") or [])
                 if os.path.exists(os.path.join(snap, "big-blobs.json")) else 0,
        "big": os.path.isdir(os.path.join(snap, "big")),
        "descriptors": os.path.isdir(os.path.join(snap, "descriptors"))}
for p in (os.path.join(snap, "manifest.json"), latest):
    json.dump(data, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
    python_status=$?
    [ "$python_status" -eq 0 ] || return 1
    if [ "$KEEP" -gt 0 ]; then
      ls -1d snapshots/*/ 2>/dev/null | LC_ALL=C sort -r | tail -n +$((KEEP + 1)) | xargs -r rm -rf || return 1
    fi
  }
  if ! materialize_snapshot "$stage" "$stamp"; then
    rm -rf "$work"
    return 1
  fi
  git config user.email "work-backup@symbiosis" || { rm -rf "$work"; return 1; }
  git config user.name  "Work backup" || { rm -rf "$work"; return 1; }
  git add -A || { rm -rf "$work"; return 1; }
  if git diff --cached --quiet; then
    log "no changes to publish"; rm -rf "$work"; return 0
  fi
  git commit -q -m "work-backup $stamp" || { rm -rf "$work"; return 1; }
  local pushed=0 delay
  for attempt in $(seq 1 12); do
    if git push -q origin "HEAD:$BRANCH" 2>/dev/null; then
      pushed=1
      break
    fi
    echo "work-backup: push attempt $attempt failed; refreshing $BRANCH" >&2
    if git fetch -q origin "$BRANCH" 2>/dev/null; then
      git reset -q --hard FETCH_HEAD || { rm -rf "$work"; return 1; }
      if backup_run_is_stale; then
        log "newer work-backup run already owns $BRANCH; left alone"
        rm -rf "$work"
        return 2
      fi
      if ! materialize_snapshot "$stage" "$stamp"; then
        rm -rf "$work"
        return 1
      fi
      git add -A || { rm -rf "$work"; return 1; }
      git commit -q -m "work-backup $stamp" 2>/dev/null || { rm -rf "$work"; return 1; }
    fi
    delay=$((attempt * 2))
    [ "$delay" -gt 30 ] && delay=30
    sleep "$delay"
  done
  # Verified from INSIDE the clone: this is the only place where the objects we
  # just pushed can be inspected (and the working directory is the clone, not
  # whatever the daemon started in). Return code 3 = pushed, but empty.
  if [ "$pushed" = 1 ] && ! verify_published "$stamp"; then
    rm -rf "$work"
    return 3
  fi
  rm -rf "$work"
  [ "$pushed" = 1 ]
}

# Did the snapshot really land? `git push` returning 0 only means the branch
# moved; it does NOT mean the snapshot is in it. A branch that quietly collects
# latest.json updates while every snapshot is refused (an oversized blob, a
# protected branch, a shallow-clone race) looks exactly like success from the
# log - and then the next runner restores nothing. So: after a push, ask both
# the commit we pushed and the remote what they actually have, and shout if the
# answer is "no snapshot".
verify_published() {
  local name="$1" sha=""
  if ! git ls-tree -d --name-only HEAD "snapshots/$name" 2>/dev/null | grep -qx "snapshots/$name"; then
    log "PUBLISH VERIFIED AS EMPTY: snapshots/$name is not even in the commit we pushed"
    return 1
  fi
  sha="$(git ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1)"
  if [ -z "$sha" ]; then
    log "PUBLISH VERIFIED AS EMPTY: $BRANCH does not exist on the remote after the push"
    return 1
  fi
  # The first publish onto an empty branch creates it as an orphan, so there is
  # no origin/$BRANCH to look at until a fetch - ask the remote by sha.
  if ! git ls-tree -d --name-only "$sha" "snapshots/$name" 2>/dev/null | grep -qx "snapshots/$name"; then
    log "PUBLISH VERIFIED AS EMPTY: $BRANCH has no snapshots/$name after a successful push"
    log "  the snapshot was refused (a file over 100 MB is the usual reason) or the branch moved under us"
    log "  latest.json now points at a snapshot that is not there - the next runner would restore nothing"
    return 1
  fi
  return 0
}

do_backup() (
  local locked=0
  if acquire_backup_lock; then
    locked=1
  elif [ "$ONCE" -eq 1 ]; then
    local waited=0
    while [ "$waited" -lt 300 ]; do
      sleep 10
      waited=$((waited + 10))
      if acquire_backup_lock; then locked=1; break; fi
    done
    if [ "$locked" -ne 1 ]; then
      log "backup lock stayed busy; final snapshot was not published"
      exit 1
    fi
  else
    log "another backup is already running"
    exit 0
  fi
  trap 'release_backup_lock' EXIT
  local sig; sig="$(compute_sig)"
  if [ "$ONCE" -eq 0 ] && [ -f "$STATE_DIR/global.sig" ] && [ "$(cat "$STATE_DIR/global.sig" 2>/dev/null)" = "$sig" ]; then
    log "nothing changed; skipping"
    return 0
  fi
  local stamp; stamp="$(date -u '+%Y%m%dT%H%M%S')"
  local stage
  if ! stage="$(mktemp -d)"; then
    log "cannot create snapshot directory"
    return 1
  fi
  if ! collect "$stage"; then
    log "snapshot collection failed"
    rm -rf "$stage"
    return 1
  fi
  local repos; repos="$(find "$stage/repos" -type f -name meta.json 2>/dev/null | wc -l | tr -d ' ')"
  local bigs; bigs="$(find "$stage/big" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  [ -n "$repos" ] || repos=0
  [ -n "$bigs" ] || bigs=0
  if [ "$repos" = 0 ] && [ "$bigs" = 0 ] && [ ! -s "$stage/files.tar.gz" ]; then
    log "nothing to publish"; rm -rf "$stage"; printf '%s' "$sig" > "$STATE_DIR/global.sig"; return 0
  fi
  local result=0
  if publish "$stage" "$stamp"; then
    printf '%s' "$sig" > "$STATE_DIR/global.sig"
    log "published snapshot $stamp ($(du -sh "$stage" 2>/dev/null | cut -f1), $repos repo(s)) -> $BRANCH"
  else
    local publish_status=$?
    if [ "$publish_status" -eq 2 ]; then
      log "snapshot skipped because a newer run owns $BRANCH"
    elif [ "$publish_status" -eq 3 ]; then
      # The push went through and carried no snapshot. That is not a backup,
      # and treating it as one is how two days of "published" hid an empty
      # branch. Do not advance the signature: the next cycle must try again.
      log "NOTHING LANDED: the push carried no snapshot - the next run must retry"
      result=1
    else
      log "publish failed (will retry next cycle)"
      result=1
    fi
  fi
  rm -rf "$stage"
  return "$result"
)

if [ "${1:-}" = "--once" ]; then
  do_backup || exit 1
  exit 0
fi
log "daemon started root=$ROOT branch=$BRANCH interval=${INTERVAL}s"
do_backup || true
while true; do sleep "$INTERVAL"; do_backup || log "backup failed, retrying"; done
