#!/usr/bin/env bash
# Restore opencode chat sessions for THIS repository from
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
# Env:
#   CHAT_REPO_DIR  repo working tree (default GITHUB_WORKSPACE or cwd)
#   CHAT_REPO      owner/name (default GITHUB_REPOSITORY or git origin)
#   CHAT_BUNDLE    path to a local bundle (skips cloning)
#   CHAT_ONLY      import only this session id
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --state)   STATE="${2:-}"; shift 2 ;;
    --state=*) STATE="${1#--state=}"; shift ;;
    *)         shift ;;
  esac
done

REPO_DIR="${CHAT_REPO_DIR:-${GITHUB_WORKSPACE:-$(pwd)}}"
REPO_FULL="${CHAT_REPO:-${GITHUB_REPOSITORY:-}}"
if [ -z "$REPO_FULL" ] && command -v git >/dev/null 2>&1; then
  REPO_FULL="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
fi
REPO_NAME="${REPO_FULL##*/}"; REPO_NAME="${REPO_NAME%.git}"
REPO_NAME="$(printf '%s' "${REPO_NAME:-repo}" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-80)"

TMP=""
cleanup(){ [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

if [ -n "${CHAT_BUNDLE:-}" ]; then
  BUNDLE="$CHAT_BUNDLE"
elif [ -n "$STATE" ] && [ -f "$STATE/chats/$REPO_NAME.json" ]; then
  BUNDLE="$STATE/chats/$REPO_NAME.json"
else
  if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
    echo "restore-chats: no token and no --state bundle, skip" >&2
    exit 0
  fi
  export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY:-}.git}"
  TMP="$(mktemp -d)"
  if ! git clone -q --depth 1 --branch session-state "$REMOTE" "$TMP/state" 2>/dev/null; then
    echo "restore-chats: no session-state branch yet"
    exit 0
  fi
  BUNDLE="$TMP/state/chats/$REPO_NAME.json"
fi

if [ ! -s "$BUNDLE" ]; then
  echo "restore-chats: no chats bundle for $REPO_NAME"
  exit 0
fi
if ! command -v opencode >/dev/null 2>&1; then
  echo "restore-chats: opencode CLI not on PATH" >&2
  exit 0
fi

CHAT_ONLY="${CHAT_ONLY:-}" CHAT_REPO_DIR="$REPO_DIR" BUNDLE="$BUNDLE" python3 - <<'PY'
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
