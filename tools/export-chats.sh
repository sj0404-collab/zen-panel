#!/usr/bin/env bash
# Export the opencode chat sessions that belong to a repository into one
# bundle, and (unless PUBLISH=0) publish it to the session-state branch as
#   chats/<repoName>.json
# The bundle carries the full `opencode export` payload of every session, so
# restore-chats.sh can import them back - into the same repository.
#
# Why a folder of its own: saved/ is a rolling mailbox of {session, models}
# snapshots and is confusing to read as history. chats/ holds one stable file
# per repo, always the current set, easy to fetch back by name.
#
# By default it exports for ONE repository (the one given by CHAT_REPO_DIR or
# the current directory). With `--all` (or CHAT_ALL_ROOT=<root>) it walks every
# git repository under the root - the hub's fork clone plus everything cloned
# from the Files tab into hub-work/ - and publishes chats/<name>.json for each,
# so a runner that dies with unpushed sessions loses none of them.
#
# Env:
#   CHAT_REPO_DIR   repo working tree (default GITHUB_WORKSPACE or cwd)
#   CHAT_REPO       owner/name (default GITHUB_REPOSITORY or git origin)
#   CHAT_MAX        max sessions to keep, newest first (default 30)
#   CHAT_MAX_BYTES  size budget for the bundle (default 40 MiB)
#   CHAT_BUNDLE_OUT local output path (default under ~/.local/share/opencode/history)
#   CHAT_ALL_ROOT   root to scan for repos in --all mode (default $HOME)
#   PUBLISH=0       build the bundle only, do not push
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
export DB

ALL=""
if [ "${1:-}" = "--all" ] || [ "${1:-}" = "--all=true" ] || [ "${1:-}" = "--all=1" ]; then ALL=1; fi
[ -n "${CHAT_ALL_ROOT:-}" ] && ALL=1

export CHAT_MAX="${CHAT_MAX:-30}"
export CHAT_MAX_BYTES="${CHAT_MAX_BYTES:-41943040}"

# Heavy/generated dirs to skip while scanning for repos (same spirit as
# backup-work.sh). node_modules and the toolchain caches are huge and slow.
find_repos() {
  local root="$1" args=() e
  for e in .cache .nvm .npm .gradle .m2 .cargo .rustup .local/share/opencode .zen-agent node_modules .venv venv; do
    args+=( -path "*/$e/*" -prune -o )
  done
  find "$root" -maxdepth 8 "${args[@]}" -type d -name .git -print 2>/dev/null
}

# Export + publish the sessions of ONE repository. Everything a later runner
# needs (import into the same directory) is rebuilt on the other side from this
# bundle.
export_one() {
  local repo_dir="$1"
  [ -d "$repo_dir/.git" ] || [ -f "$repo_dir/.git" ] || return 0
  local repo_full
  repo_full="$(git -C "$repo_dir" remote get-url origin 2>/dev/null || true)"
  [ -n "$repo_full" ] || repo_full="$repo_dir"
  local repo_name
  repo_name="${repo_full##*/}"; repo_name="${repo_name%.git}"
  [ -n "$repo_name" ] || repo_name="$(basename "$repo_dir")"
  repo_name="$(printf '%s' "$repo_name" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-80)"

  local stamp out
  stamp="$(date -u '+%Y%m%dT%H%M%S')"
  out="${CHAT_BUNDLE_OUT:-$HOME/.local/share/opencode/history/chats-$repo_name-$stamp.json}"

  if [ ! -f "$DB" ]; then
    echo "export-chats: no opencode.db at $DB" >&2
    return 0
  fi
  if ! command -v opencode >/dev/null 2>&1; then
    echo "export-chats: opencode CLI not on PATH" >&2
    return 1
  fi

  mkdir -p "$(dirname "$out")"

  REPO_DIR="$repo_dir" REPO_NAME="$repo_name" REPO_FULL="$repo_full" \
  OUT="$out" python3 - <<'PY'
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
    return rp == repo_dir or rp.startswith(repo_dir + os.sep) or repo_name in rp.split(os.sep)

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
failed = 0
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
        failed += 1
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
        failed += 1
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
if failed:
    sys.exit(1)
PY
  python_status=$?
  if [ "$python_status" -ne 0 ]; then
    rm -f "$out"
    return 1
  fi

  [ -s "$out" ] || { echo "export-chats: bundle empty" >&2; return 0; }
  # Skip empty bundles: no sessions in this repo, nothing worth publishing.
  if ! grep -q '"count": *[1-9]' "$out" 2>/dev/null; then
    echo "export-chats: no sessions for $repo_name; nothing published"
    rm -f "$out"
    return 0
  fi

  if [ "${PUBLISH:-1}" = "1" ] && [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
    export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
    local publish_output publish_status
    publish_output="$(bash "$SCRIPT_DIR/publish_session.sh" \
      file="chats/$repo_name.json" \
      json="$out" \
      kind=opencode-chats \
      state=updated \
      stamp="$stamp" 2>&1)"
    publish_status=$?
    printf '%s\n' "$publish_output"
    return "$publish_status"
  fi
}

if [ "$ALL" = 1 ]; then
  root="${CHAT_ALL_ROOT:-$HOME}"
  mkdir -p "$HOME/.local/share/opencode/history" 2>/dev/null || true
  failed=0
  while IFS= read -r gitdir; do
    [ -n "$gitdir" ] || continue
    dir="$(dirname "$gitdir")"
    echo "export-chats: --- $dir"
    if ! export_one "$dir"; then failed=1; fi
  done < <(find_repos "$root")
  [ "$failed" -eq 0 ]
else
  export_one "${CHAT_REPO_DIR:-${GITHUB_WORKSPACE:-$(pwd)}}"
fi
