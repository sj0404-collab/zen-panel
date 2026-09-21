#!/usr/bin/env bash
# Export the opencode chat sessions that belong to THIS repository into one
# bundle, and (unless PUBLISH=0) publish it to the session-state branch as
#   chats/<repoName>.json
# The bundle carries the full `opencode export` payload of every session, so
# restore-chats.sh can import them back - into the same repository.
#
# Why a folder of its own: saved/ is a rolling mailbox of {session, models}
# snapshots and is confusing to read as history. chats/ holds one stable file
# per repo, always the current set, easy to fetch back by name.
#
# Env:
#   CHAT_REPO_DIR   repo working tree (default GITHUB_WORKSPACE or cwd)
#   CHAT_REPO       owner/name (default GITHUB_REPOSITORY or git origin)
#   CHAT_MAX        max sessions to keep, newest first (default 30)
#   CHAT_MAX_BYTES  size budget for the bundle (default 40 MiB)
#   CHAT_BUNDLE_OUT local output path (default under ~/.local/share/opencode/history)
#   PUBLISH=0       build the bundle only, do not push
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${CHAT_REPO_DIR:-${GITHUB_WORKSPACE:-$(pwd)}}"
REPO_FULL="${CHAT_REPO:-${GITHUB_REPOSITORY:-}}"
if [ -z "$REPO_FULL" ] && command -v git >/dev/null 2>&1; then
  REPO_FULL="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
fi
REPO_NAME="${REPO_FULL##*/}"; REPO_NAME="${REPO_NAME%.git}"
REPO_NAME="$(printf '%s' "${REPO_NAME:-repo}" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-80)"
STAMP="$(date -u '+%Y%m%dT%H%M%S')"
OUT="${CHAT_BUNDLE_OUT:-$HOME/.local/share/opencode/history/chats-$REPO_NAME-$STAMP.json}"
DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"

if [ ! -f "$DB" ]; then
  echo "export-chats: no opencode.db at $DB" >&2
  exit 0
fi
if ! command -v opencode >/dev/null 2>&1; then
  echo "export-chats: opencode CLI not on PATH" >&2
  exit 0
fi

mkdir -p "$(dirname "$OUT")"

REPO_DIR="$REPO_DIR" REPO_NAME="$REPO_NAME" REPO_FULL="$REPO_FULL" \
CHAT_MAX="${CHAT_MAX:-30}" CHAT_MAX_BYTES="${CHAT_MAX_BYTES:-41943040}" \
OUT="$OUT" DB="$DB" python3 - <<'PY'
import datetime, json, os, sqlite3, subprocess, sys, tempfile

repo_dir = os.path.realpath(os.environ["REPO_DIR"])
repo_name = os.environ["REPO_NAME"]
repo_full = os.environ["REPO_FULL"]
max_sessions = int(os.environ.get("CHAT_MAX") or 30)
max_bytes = int(os.environ.get("CHAT_MAX_BYTES") or 40 * 1024 * 1024)
db = os.environ["DB"]
out = os.environ["OUT"]

def belongs(directory):
    if not directory:
        return False
    try:
        rp = os.path.realpath(directory)
    except Exception:
        return False
    # The session ran in this repo if its directory is the repo (or below it).
    # The name test is a fallback for machines where the checkout moved.
    return rp == repo_dir or rp.startswith(repo_dir + os.sep) or repo_name in rp

try:
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, title, slug, directory, path, time_updated"
        " FROM session ORDER BY time_updated DESC").fetchall()
except Exception as e:
    print("export-chats: db read failed: %s" % e, file=sys.stderr)
    sys.exit(0)

picked = [r for r in rows if belongs(r["directory"])][:max_sessions]
bundle = {
    "kind": "opencode-chats",
    "sz_tip": "chats",
    "repo": repo_full,
    "repoName": repo_name,
    "workdir": repo_dir,
    "updatedAt": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "count": 0,
    "sessions": [],
}

total = 0
for r in picked:
    sid = r["id"]
    # Capture stdout through a real file, not a pipe: the opencode CLI is a
    # Node process and truncates large stdout when its output is a pipe (it
    # exits before the pipe drains). A regular file gets the whole export.
    fd, exp_path = tempfile.mkstemp(suffix=".json", prefix="oc-export-")
    try:
        with os.fdopen(fd, "wb") as sink:
            proc = subprocess.run(["opencode", "export", sid], stdout=sink,
                                  stderr=subprocess.PIPE, timeout=120)
        with open(exp_path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read().strip()
    except Exception as e:
        print("export-chats: %s export failed: %s" % (sid, e), file=sys.stderr)
        continue
    finally:
        try:
            os.unlink(exp_path)
        except Exception:
            pass
    start = raw.find("{")
    if start > 0:
        raw = raw[start:]
    try:
        data = json.loads(raw)
    except Exception as e:
        print("export-chats: %s is not JSON: %s" % (sid, e), file=sys.stderr)
        continue
    entry = {
        "id": sid,
        "title": r["title"],
        "slug": r["slug"],
        "directory": r["directory"],
        "timeUpdated": r["time_updated"],
        "export": data,
    }
    size = len(json.dumps(entry, ensure_ascii=False))
    if bundle["sessions"] and total + size > max_bytes:
        print("export-chats: size budget reached, dropping older sessions", file=sys.stderr)
        break
    bundle["sessions"].append(entry)
    total += size

bundle["count"] = len(bundle["sessions"])
with open(out, "w", encoding="utf-8") as f:
    json.dump(bundle, f, ensure_ascii=False)
print("export-chats: %d sessions, %.1f MiB -> %s" % (bundle["count"], total / 1048576.0, out))
PY

[ -s "$OUT" ] || { echo "export-chats: bundle empty" >&2; exit 0; }

if [ "${PUBLISH:-1}" = "1" ] && [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  bash "$SCRIPT_DIR/publish_session.sh" \
    file="chats/$REPO_NAME.json" \
    json="$OUT" \
    kind=opencode-chats \
    state=updated \
    stamp="$STAMP" 2>&1 | sed 's/^/  /'
fi
