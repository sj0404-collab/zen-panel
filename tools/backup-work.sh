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
#   SESSION_STATE_URL       git remote override for local tests
set -uo pipefail

ROOT="${WORK_BACKUP_ROOT:-$HOME}"
BRANCH="${WORK_BACKUP_BRANCH:-work-backup}"
INTERVAL="${WORK_BACKUP_INTERVAL:-300}"
KEEP="${WORK_BACKUP_KEEP:-4}"
MAX_FILE_MB="${WORK_BACKUP_MAX_FILE_MB:-25}"
MAX_TOTAL_MB="${WORK_BACKUP_MAX_TOTAL_MB:-400}"
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
STATE_DIR="${WORK_BACKUP_STATE:-$HOME/.npm-hub/work-backup-state}"

mkdir -p "$HUB_LOGS" "$STATE_DIR" 2>/dev/null || true
log() { echo "[work-backup $(date -u '+%H:%M:%S')] $*" | tee -a "$HUB_LOGS/work-backup.log"; }

REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN:-${GITHUB_TOKEN:-}}@github.com/${GITHUB_REPOSITORY:-}.git}"

EXCLUDES=(
  '*/actions-runner/*' '*/.nvm/*' '*/.cache/*' '*/.npm/*' '*/.gradle/*'
  '*/.m2/*' '*/.cargo/*' '*/.rustup/*' '*/.local/share/opencode/*'
  '*/.local/share/Trash/*' '*/.zen-agent/*' '*/node_modules/*'
  '*/.venv/*' '*/venv/*' '*/__pycache__/*' '*/.tox/*' '*/.pytest_cache/*'
  '*/.config/gh/*' '*/.npm-hub/tmp/*' '*/.npm-hub/logs/*' '*/.ssh/*'
  '*/.docker/*' '*/.oh-my-zsh/*' '*/.opencode/*' '*/work/*'
  '*/hub-work/*/node_modules/*' '*/.git/lfs/*' '*/.local/share/Code/*'
  '*/.vscode-server/*' '*/.java/*' '*/.sonar/*'
)

find_repos() {
  local args=()
  for e in "${EXCLUDES[@]}"; do args+=( -path "$e" -prune -o ); done
  find "$ROOT" -maxdepth 6 "${args[@]}" -type d -name .git -print 2>/dev/null
}

# HEAD + a digest of the porcelain status (which already lists untracked files).
repo_sig() {
  local dir="$1" head status
  head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)"
  status="$(git -C "$dir" status --porcelain=v1 2>/dev/null | sha1sum | cut -d' ' -f1)"
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
    printf 'LOOSE\n'
    loose_listing | sha1sum
  } | sha1sum | cut -d' ' -f1
}

collect() {
  local stage="$1"
  mkdir -p "$stage/repos"
  local total_bytes=0 budget=$(( MAX_TOTAL_MB * 1024 * 1024 )) gitdir dir rel out sz

  while IFS= read -r gitdir; do
    [ -n "$gitdir" ] || continue
    dir="$(dirname "$gitdir")"
    rel="${dir#"$ROOT"/}"; [ "$rel" = "$dir" ] && rel="$(basename "$dir")"
    out="$stage/repos/$rel"
    mkdir -p "$out"
    if git -C "$dir" rev-parse HEAD >/dev/null 2>&1; then
      git -C "$dir" bundle create "$out/repo.bundle" --all >/dev/null 2>&1 \
        || rm -f "$out/repo.bundle"
    fi
    git -C "$dir" diff --binary HEAD >"$out/wip.patch" 2>/dev/null || : >"$out/wip.patch"
    [ -s "$out/wip.patch" ] || rm -f "$out/wip.patch"
    ( cd "$dir" && git ls-files --others --exclude-standard -z 2>/dev/null \
        | tar --null -T - --exclude='.git' -czf "$out/untracked.tar.gz" 2>/dev/null ) || true
    [ -s "$out/untracked.tar.gz" ] || rm -f "$out/untracked.tar.gz"
    python3 - "$dir" "$rel" "$out/meta.json" <<'PY' 2>/dev/null || true
import json, subprocess, sys
d, rel, path = sys.argv[1], sys.argv[2], sys.argv[3]
def run(c):
    try: return subprocess.check_output(c, cwd=d, shell=True, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception: return ""
json.dump({
    "rel": rel, "path": d,
    "branch": run("git branch --show-current") or run("git rev-parse --abbrev-ref HEAD"),
    "head": run("git rev-parse HEAD"),
    "remote": run("git remote get-url origin 2>/dev/null"),
    "dirty": bool(run("git status --porcelain")),
}, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
    sz="$(du -sb "$out" 2>/dev/null | cut -f1)"; total_bytes=$(( total_bytes + ${sz:-0} ))
    if [ "$total_bytes" -gt "$budget" ]; then
      log "budget ${MAX_TOTAL_MB}MB exceeded; remaining repos not packed this round"
      break
    fi
  done < <(find_repos)

  loose_listing > "$stage/tree.txt" 2>/dev/null || true
  loose_predicates
  ( cd "$ROOT" || exit 0
    find . -mindepth 1 -type f ${LOOSE_PREDICATES[@]+"${LOOSE_PREDICATES[@]}"} \
      ! -size +"${MAX_FILE_MB}"M -print0 2>/dev/null \
      | tar --null -T - -czf "$stage/files.tar.gz" 2>/dev/null )
  [ -s "$stage/files.tar.gz" ] || rm -f "$stage/files.tar.gz"
}

publish() {
  local stage="$1" stamp="$2" work
  work="$(mktemp -d)"
  ( cd "$work" || exit 1
    if ! git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" state 2>/dev/null; then
      git clone -q "$REMOTE" state 2>/dev/null || exit 1
      ( cd state && git checkout -q --orphan "$BRANCH" 2>/dev/null; git rm -rqf . 2>/dev/null ) || true
    fi
  ) || { rm -rf "$work"; return 1; }
  cd "$work/state" || { rm -rf "$work"; return 1; }
  mkdir -p snapshots
  cp -a "$stage" "snapshots/$stamp"
  cp "$stage/tree.txt" "snapshots/$stamp/tree.txt" 2>/dev/null || true
  python3 - "snapshots/$stamp" "latest.json" "$stamp" <<'PY'
import json, os, sys
snap, latest, stamp = sys.argv[1], sys.argv[2], sys.argv[3]
repos = []
rroot = os.path.join(snap, "repos")
for rel in sorted(os.listdir(rroot)) if os.path.isdir(rroot) else []:
    try: meta = json.load(open(os.path.join(rroot, rel, "meta.json"), encoding="utf-8"))
    except Exception: meta = {"rel": rel}
    meta["files"] = sorted(os.listdir(os.path.join(rroot, rel)))
    repos.append(meta)
data = {"kind": "work-backup", "stamp": stamp, "snapshot": snap, "repos": repos,
        "tree": os.path.exists(os.path.join(snap, "tree.txt")),
        "files": os.path.exists(os.path.join(snap, "files.tar.gz"))}
for p in (os.path.join(snap, "manifest.json"), latest):
    json.dump(data, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
  if [ "$KEEP" -gt 0 ]; then
    ls -1dt snapshots/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
  fi
  git config user.email "work-backup@symbiosis"
  git config user.name  "Work backup"
  git add -A
  if git diff --cached --quiet; then
    log "no changes to publish"; rm -rf "$work"; return 0
  fi
  git commit -q -m "work-backup $stamp"
  local pushed=0
  for attempt in 1 2 3 4 5; do
    if git push -q origin "HEAD:$BRANCH" 2>/dev/null; then pushed=1; break; fi
    git fetch -q origin "$BRANCH" 2>/dev/null && git reset -q --hard FETCH_HEAD
    git add -A
    git commit -q -m "work-backup $stamp" 2>/dev/null || true
    sleep $((attempt * 2))
  done
  rm -rf "$work"
  [ "$pushed" = 1 ]
}

do_backup() {
  local sig; sig="$(compute_sig)"
  if [ -f "$STATE_DIR/global.sig" ] && [ "$(cat "$STATE_DIR/global.sig" 2>/dev/null)" = "$sig" ]; then
    log "nothing changed; skipping"
    return 0
  fi
  local stamp; stamp="$(date -u '+%Y%m%dT%H%M%S')"
  local stage; stage="$(mktemp -d)"
  collect "$stage"
  local repos; repos="$(ls -1 "$stage/repos" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$repos" = 0 ] && [ ! -s "$stage/files.tar.gz" ]; then
    log "nothing to publish"; rm -rf "$stage"; printf '%s' "$sig" > "$STATE_DIR/global.sig"; return 0
  fi
  if publish "$stage" "$stamp"; then
    printf '%s' "$sig" > "$STATE_DIR/global.sig"
    log "published snapshot $stamp ($(du -sh "$stage" 2>/dev/null | cut -f1), $repos repo(s)) -> $BRANCH"
  else
    log "publish failed (will retry next cycle)"
  fi
  rm -rf "$stage"
}

if [ "${1:-}" = "--once" ]; then do_backup; exit 0; fi
log "daemon started root=$ROOT branch=$BRANCH interval=${INTERVAL}s"
do_backup || true
while true; do sleep "$INTERVAL"; do_backup || log "backup failed, retrying"; done
