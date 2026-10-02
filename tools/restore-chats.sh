#!/usr/bin/env bash
# Restore opencode chat sessions for a repository from
#   chats/<repoName>.json
# on the session-state branch (or from a local bundle via CHAT_BUNDLE).
#
# `opencode import` assigns each session's directory from the current working
# directory, so imports run with CWD set to the repo: the sessions come back
# into the SAME repository they were exported from, regardless of the old
# absolute path.
#
# Usage:
#   restore-chats.sh [--state <cloned session-state dir>]
#   restore-chats.sh --all [--state <dir>]      import every chats/*.json into
#                                               a matching local repo
# Env:
#   CHAT_REPO_DIR  repo working tree (default GITHUB_WORKSPACE or cwd)
#   CHAT_REPO      owner/name (default GITHUB_REPOSITORY or git origin)
#   CHAT_BUNDLE    path to a local bundle (skips cloning)
#   CHAT_ALL_ROOT  root to look up local repos in --all mode (default $HOME)
#   CHAT_ONLY      import only this session id
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE=""
STATE_GIVEN=""
ALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all)     ALL=1; shift ;;
    --state)   STATE="${2:-}"; STATE_GIVEN=1; shift 2 ;;
    --state=*) STATE="${1#--state=}"; STATE_GIVEN=1; shift ;;
    *)         shift ;;
  esac
done

TMP_STATE=""
cleanup() { [ -n "$TMP_STATE" ] && rm -rf "$TMP_STATE"; }
trap cleanup EXIT

# Make sure $STATE points at a cloned session-state branch: the caller's dir
# (--state), or a fresh shallow clone (removed on exit).
ensure_state() {
  if [ -n "$STATE" ]; then
    [ -d "$STATE" ] && return 0
    return 1
  fi
  if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then return 1; fi
  export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY:-}.git}"
  TMP_STATE="$(mktemp -d)"
  if git clone -q --depth 1 --branch session-state "$REMOTE" "$TMP_STATE/state" 2>/dev/null; then
    STATE="$TMP_STATE/state"
    return 0
  fi
  rm -rf "$TMP_STATE"; TMP_STATE=""
  return 1
}

# Import every session of one bundle into one repository (CWD = the repo).
import_bundle() {
  local repo_dir="$1" bundle="$2"
  [ -d "$repo_dir" ] || { echo "restore-chats: missing repo dir $repo_dir" >&2; return 1; }
  [ -s "$bundle" ] || { echo "restore-chats: empty bundle $bundle" >&2; return 1; }
  CHAT_ONLY="${CHAT_ONLY:-}" CHAT_REPO_DIR="$repo_dir" BUNDLE="$bundle" python3 - <<'PY'
import json, os, re, subprocess, sys, tempfile, time
import threading
from concurrent.futures import ThreadPoolExecutor

bundle_path = os.environ["BUNDLE"]
repo_dir = os.environ["CHAT_REPO_DIR"]
only = os.environ.get("CHAT_ONLY") or ""

try:
    bundle = json.load(open(bundle_path, encoding="utf-8"))
except Exception as e:
    print("restore-chats: bad bundle: %s" % e, file=sys.stderr)
    sys.exit(1)

sessions = bundle.get("sessions") or []
if only:
    sessions = [s for s in sessions if s.get("id") == only]

say_lock = threading.Lock()

def say(msg, err=False):
    with say_lock:
        print(msg, file=sys.stderr if err else sys.stdout, flush=True)

# The imports run side by side.
#
# `opencode import` is a node CLI: every call pays the node start-up before it
# does any work, and the bundles only ever grow - 38 sessions across 6 repos
# the day this was measured. One at a time is what turned a two-minute restore
# into six, and it gets worse with every session saved from here on. Each
# import writes its own session directory, so they are independent and go in a
# small pool. CHAT_IMPORT_JOBS=1 puts them back in a row when something needs
# to be watched one by one.
def import_one(s):
    data = s.get("export")
    if not isinstance(data, dict):
        say("restore-chats: %s has no export payload, skip" % s.get("id"), err=True)
        return False
    sid = s.get("id") or (data.get("info") or {}).get("id")
    fd, path = tempfile.mkstemp(suffix=".json", prefix="chat-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        # Every import writes into the SAME opencode sqlite database, so the
        # pool above can lose a race for the write lock. That is not a broken
        # bundle: the retry below only fires on a lock/busy error, where the
        # session was NOT written - retrying an import that actually succeeded
        # would duplicate the session in the panel.
        transient = re.compile(r"database is locked|database table is locked|"
                               r"SQLITE_BUSY|busy|try again", re.I)
        for attempt in range(2):
            proc = subprocess.run(["opencode", "import", path], cwd=repo_dir,
                                  capture_output=True, timeout=180)
            out = (proc.stdout or b"").decode("utf-8", "replace").strip()
            err = (proc.stderr or b"").decode("utf-8", "replace").strip()
            if proc.returncode == 0:
                say("restore-chats: imported %s" % (sid or "?"))
                return True
            detail = err or out
            if attempt == 0 and transient.search(detail):
                say("restore-chats: %s hit the db lock, retrying once" % sid, err=True)
                time.sleep(2)
                continue
            say("restore-chats: %s import failed: %s" % (sid, detail[:200]), err=True)
            return False
        return False
    except Exception as e:
        say("restore-chats: %s import error: %s" % (sid, e), err=True)
        return False
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass

try:
    jobs = int(os.environ.get("CHAT_IMPORT_JOBS") or "4")
except ValueError:
    jobs = 4
jobs = max(1, min(jobs, 16))

if jobs > 1 and len(sessions) > 1:
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        results = list(pool.map(import_one, sessions))
else:
    results = [import_one(s) for s in sessions]
ok = sum(1 for r in results if r)

print("restore-chats: %d/%d sessions imported from %s" % (ok, len(sessions), bundle_path))
if sessions and ok < len(sessions):
    sys.exit(1)
PY
  local python_status=$?
  return "$python_status"
}

# Map every chats/<name>.json to the local repo that matches, in ONE walk of
# the root.
#
# This used to be one full walk per bundle (find_repo_for), and a walk here is
# not cheap: it stats every directory under $HOME and shells out to
# `git remote get-url` for every repository it meets. With six bundles that was
# six identical walks before a single chat was imported. One walk now, all the
# names answered from it.
#
# Matching rules, unchanged: a remote whose path ends in /<name> or /<name>.git
# wins; a directory whose basename is <name> is the fallback.
map_repos_for() {
  local root="$1"; shift
  python3 - "$root" "$@" <<'PY'
import os, subprocess, sys

root = sys.argv[1]
want = sys.argv[2:]

SKIP_DIRS = {'node_modules', '.cache', '.npm', '.gradle', '.m2', '.cargo',
             '.rustup', '.venv', 'venv', '__pycache__', '.tox', '.git', '.local'}
basename_match = {}
remote_match = {}

for base, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.endswith('.git')]
    is_repo = '.git' in dirs or os.path.exists(os.path.join(base, '.git'))
    if not is_repo:
        continue
    name = os.path.basename(base.rstrip('/'))
    if name in want and name not in basename_match:
        basename_match[name] = base
    for target in want:
        if target in remote_match:
            continue
        try:
            remote = subprocess.check_output(
                ['git', '-C', base, 'remote', 'get-url', 'origin'],
                text=True, stderr=subprocess.DEVNULL).strip()
        except Exception:
            remote = ''
        tail = remote.rstrip('/')
        if tail.endswith('/' + target) or tail.endswith('/' + target + '.git'):
            remote_match[target] = base

for name in want:
    hit = remote_match.get(name) or basename_match.get(name)
    if hit:
        print("%s\t%s" % (name, hit))
PY
}

if [ "$ALL" = 1 ]; then
  if ! ensure_state; then
    echo "restore-chats: no session-state branch or --state, skip" >&2
    exit 0
  fi
  roots="${CHAT_ALL_ROOT:-$HOME}"
  if ! command -v opencode >/dev/null 2>&1; then
    echo "restore-chats: opencode CLI not on PATH" >&2
    exit 1
  fi
  processed=0
  failed=0
  shopt -s nullglob
  bundles=()
  names=()
  for bundle in "$STATE"/chats/*.json; do
    [ -s "$bundle" ] || continue
    bundles+=("$bundle")
    names+=("$(basename "$bundle" .json)")
  done

  # One walk per root, not one per bundle: the first root that matches a name
  # wins, which is the order the old per-bundle loop had. Skipped entirely when
  # there is nothing to look up - the walk is not free, and asking it for no
  # names is exactly the case where it would be pure waste.
  declare -A REPO_MAP=()
  if [ "${#names[@]}" -gt 0 ]; then
    for root in $roots; do
      while IFS=$'\t' read -r n p; do
        [ -n "$n" ] || continue
        [ -n "${REPO_MAP[$n]:-}" ] && continue
        REPO_MAP["$n"]="$p"
      done < <(map_repos_for "$root" "${names[@]}")
    done
  fi

  for i in "${!bundles[@]}"; do
    bundle="${bundles[$i]}"
    name="${names[$i]}"
    match="${REPO_MAP[$name]:-}"
    if [ -z "$match" ]; then
      echo "restore-chats: no local repo for $name; skipped"
      failed=1
      continue
    fi
    echo "restore-chats: --- import $name -> $match"
    if ! import_bundle "$match" "$bundle"; then failed=1; fi
    processed=$((processed + 1))
  done
  echo "restore-chats: done, $processed bundle(s) processed"
  [ "$failed" -eq 0 ]
  exit $?
fi

REPO_DIR="${CHAT_REPO_DIR:-${GITHUB_WORKSPACE:-$(pwd)}}"
REPO_FULL="${CHAT_REPO:-${GITHUB_REPOSITORY:-}}"
if [ -z "$REPO_FULL" ] && command -v git >/dev/null 2>&1; then
  REPO_FULL="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
fi
REPO_NAME="${REPO_FULL##*/}"; REPO_NAME="${REPO_NAME%.git}"
REPO_NAME="$(printf '%s' "${REPO_NAME:-repo}" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-80)"

BUNDLE=""
if [ -n "${CHAT_BUNDLE:-}" ]; then
  BUNDLE="$CHAT_BUNDLE"
elif ensure_state && [ -f "$STATE/chats/$REPO_NAME.json" ]; then
  BUNDLE="$STATE/chats/$REPO_NAME.json"
else
  echo "restore-chats: no chats bundle for $REPO_NAME"
  exit 0
fi

[ -s "$BUNDLE" ] || { echo "restore-chats: no chats bundle for $REPO_NAME"; exit 0; }
if ! command -v opencode >/dev/null 2>&1; then
  echo "restore-chats: opencode CLI not on PATH" >&2
  exit 1
fi

import_bundle "$REPO_DIR" "$BUNDLE"