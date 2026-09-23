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
  [ -d "$repo_dir" ] || { echo "restore-chats: missing repo dir $repo_dir, skip" >&2; return 0; }
  [ -s "$bundle" ] || { echo "restore-chats: empty bundle $bundle, skip" >&2; return 0; }
  CHAT_ONLY="${CHAT_ONLY:-}" CHAT_REPO_DIR="$repo_dir" BUNDLE="$bundle" python3 - <<'PY'
import json, os, subprocess, sys, tempfile

bundle_path = os.environ["BUNDLE"]
repo_dir = os.environ["CHAT_REPO_DIR"]
only = os.environ.get("CHAT_ONLY") or ""

try:
    bundle = json.load(open(bundle_path, encoding="utf-8"))
except Exception as e:
    print("restore-chats: bad bundle: %s" % e, file=sys.stderr)
    sys.exit(0)

sessions = bundle.get("sessions") or []
if only:
    sessions = [s for s in sessions if s.get("id") == only]

ok = 0
for s in sessions:
    data = s.get("export")
    if not isinstance(data, dict):
        print("restore-chats: %s has no export payload, skip" % s.get("id"), file=sys.stderr)
        continue
    sid = s.get("id") or (data.get("info") or {}).get("id")
    fd, path = tempfile.mkstemp(suffix=".json", prefix="chat-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        proc = subprocess.run(["opencode", "import", path], cwd=repo_dir,
                              capture_output=True, timeout=180)
        out = (proc.stdout or b"").decode("utf-8", "replace").strip()
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        if proc.returncode == 0:
            ok += 1
            print("restore-chats: imported %s" % (sid or "?"))
        else:
            print("restore-chats: %s import failed: %s" % (sid, (err or out)[:200]), file=sys.stderr)
    except Exception as e:
        print("restore-chats: %s import error: %s" % (sid, e), file=sys.stderr)
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass

print("restore-chats: %d/%d sessions imported from %s" % (ok, len(sessions), bundle_path))
PY
}

# Find the local repo that matches a chats/<name>.json bundle: same basename,
# or same remote owner/name. First exact basename hit wins; otherwise an origin
# whose path ends with /<name> or /<name>.git.
find_repo_for() {
  local root="$1" name="$2"
  python3 - "$root" "$name" <<'PY'
import os, subprocess, sys
root, name = sys.argv[1:]
SKIP_DIRS = {'node_modules', '.cache', '.npm', '.gradle', '.m2', '.cargo',
             '.rustup', '.venv', 'venv', '__pycache__', '.tox', '.git', '.local'}
first = None
for base, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.endswith('.git')]
    is_repo = '.git' in dirs or os.path.exists(os.path.join(base, '.git'))
    if not is_repo:
        continue
    if os.path.basename(base.rstrip('/')) == name:
        print(base)
        raise SystemExit(0)
    try:
        remote = subprocess.check_output(
            ['git', '-C', base, 'remote', 'get-url', 'origin'],
            text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        remote = ''
    if remote:
        tail = remote.rstrip('/')
        if tail.endswith('/' + name) or tail.endswith('/' + name + '.git'):
            if first is None:
                first = base
if first:
    print(first)
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
    exit 0
  fi
  processed=0
  shopt -s nullglob
  for bundle in "$STATE"/chats/*.json; do
    [ -s "$bundle" ] || continue
    name="$(basename "$bundle" .json)"
    match=""
    for root in $roots; do
      match="$(find_repo_for "$root" "$name")"
      [ -n "$match" ] && break
    done
    if [ -z "$match" ]; then
      echo "restore-chats: no local repo for $name; skipped"
      continue
    fi
    echo "restore-chats: --- import $name -> $match"
    import_bundle "$match" "$bundle"
    processed=$((processed + 1))
  done
  echo "restore-chats: done, $processed bundle(s) processed"
  exit 0
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
  exit 0
fi

import_bundle "$REPO_DIR" "$BUNDLE"