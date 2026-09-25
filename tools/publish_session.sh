#!/usr/bin/env bash
# Publish the live session's connection details so the panel can show them.
#
# The job summary already prints the address, user and password, but it is
# prose meant for a human with a browser: not machine-readable, and on a phone
# it is several taps behind the Actions UI. The panel is where the session is
# started, so it is where the credentials belong.
#
# They go to an orphan branch, session-state, as session.json. An orphan branch
# keeps this churn out of the history of main and lets the file be replaced
# wholesale every time without ever conflicting.
#
# WHO CAN READ THIS
#   On a public repository the branch is public, and so is the password in it.
#   That is the same exposure as the run summary, which is also public - but it
#   is worth being explicit, because a password on a web page feels different
#   from one in a log. Everything here dies with the runner within six hours,
#   and any secret in it is regenerated per run. If that is not acceptable,
#   make the repository private; the panel reads it with the same token either
#   way.
#
# TWO DESKS AT ONCE
#   Pass slot=linux, slot=windows or slot=agent and the entry lands in its own
#   file - session-linux.json, session-windows.json, session-agent.json,
#   session-opencode.json and session-hub.json - so
#   agent/opencode/hub take an -linux/-windows suffix (one file per OS, so two
#   runners stop overwriting each other); the bare slot stays for old runs.
#   the two desks and the agent never overwrite each other. Without a slot the
#   old single session.json is used, which keeps the older workflows working
#   unchanged.
#
#   The panel reads all three and shows whichever are live.
#
# MODELS AND SAVED SNAPSHOTS
#   Sessions alone do not survive usefully: which model answered, which died,
#   which recovered - that roster lives in ~/.zen_free_models.json on the
#   runner and dies with it. So every session also publishes its models:
#
#     publish_session.sh slot=agent file=models-agent.json \
#       kind=CLI-агент json=$HOME/.zen_free_models.json
#   file= overrides the target on the branch (validated: only the known
#   mailboxes are accepted, so a typo cannot spray files across the branch).
#   json= merges a local JSON file into the payload - with secrets scrubbed:
#   any key looking like a key/token/secret/password is dropped, because
#   opencode.json holds API keys and this branch may be public. Pass scrub=0
#   to disable.
#
# LAYOUT OF THE BRANCH (it used to be one pile in the root)
#   live/session-<slot>.json      the live descriptor, one per slot
#   live/handoff.json             the relay limits + the relay's live status
#   models/models-<slot>.json     the model roster of that session
#   snapshots/audit.json          the audit trail (was audit.json)
#   snapshots/code.json           the code snapshot (was code.json)
#   chats/<repo>.json             OpenCode chat bundles (unchanged)
#   history/<YYYY-MM-DD>/<Wd>/    everything historical, by day and weekday:
#       run-<runNumber>.json         one record per run: success or failure
#       saved-<slot>-<stamp>.json    the «Сохранить» snapshots
#       audit-<slot>-<stamp>.json
#       opencode-<stamp>.json
#   artifacts/<file>              files the user pushed from the hub
#   Every reader tries the new path first and falls back to the old root name,
#   so a branch that was never migrated keeps working.
#
#   publish_session.sh journal=1 writes the run record:
#     publish_session.sh journal=1 slot=hub-linux conclusion=success \
#       startedAt=... endedAt=...
#
# Usage: publish_session.sh key=value ...
#   Recognised keys are passed straight through to JSON, so a new session type
#   can add a field without touching this script.

set -uo pipefail

BRANCH="session-state"
FILE="live/session.json"
JOURNAL=0
# journal_date can come as an argument or from the environment; without it the
# record is filed under today (UTC).
JOURNAL_DATE="${JOURNAL_DATE:-}"

# A slot is a routing instruction, not data: pull it out of the arguments
# before they become JSON.
ARGS=()
JSON_FILES=()
FILE_OVERRIDE=""
SCRUB=1
EXPLICIT_STARTED_AT=0
for arg in "$@"; do
  case "$arg" in
    startedAt=*)   EXPLICIT_STARTED_AT=1; ARGS+=("$arg") ;;
    journal_date=*) JOURNAL_DATE="${arg#journal_date=}" ;;
    slot=linux)    FILE="live/session-linux.json" ;;
    slot=windows)  FILE="live/session-windows.json" ;;
    slot=agent)    FILE="live/session-agent.json" ;;
    slot=agent-linux)    FILE="live/session-agent-linux.json" ;;
    slot=agent-windows)  FILE="live/session-agent-windows.json" ;;
    slot=opencode) FILE="live/session-opencode.json" ;;
    slot=opencode-linux) FILE="live/session-opencode-linux.json" ;;
    slot=opencode-windows) FILE="live/session-opencode-windows.json" ;;
    slot=hub)      FILE="live/session-hub.json" ;;
    slot=hub-linux)      FILE="live/session-hub-linux.json" ;;
    slot=hub-windows)    FILE="live/session-hub-windows.json" ;;
    slot=phone)    FILE="live/session-phone.json" ;;
    slot=vnc)      FILE="live/session-vnc.json" ;;
    slot=*)        ;;   # unknown slot: ignore rather than write a stray file
    file=*)        FILE_OVERRIDE="$arg" ;;
    journal=1)     JOURNAL=1 ;;
    scrub=0)       SCRUB=0 ;;
    json=*)        # A Windows path (C:\Users\..) breaks mingw python; slashes
                   # work for both Windows and mingw python, so normalise.
                   _jv="${arg#json=}"; _jv="${_jv//\\//}"; JSON_FILES+=("$_jv") ;;
    *)            ARGS+=("$arg") ;;
  esac
done
set -- ${ARGS+"${ARGS[@]}"}

# A file= override that is not one of the known names is refused outright -
# the branch is a fixed set of mailboxes, not a scratch disk. The caller keeps
# using the old flat names; the layout below turns them into the new folders.
if [ -n "$FILE_OVERRIDE" ]; then
  _f="${FILE_OVERRIDE#file=}"
  if [[ "$_f" =~ ^models-(linux|windows|agent(-linux|-windows)?|opencode(-linux|-windows)?|hub(-linux|-windows)?)\.json$ ]] || \
     [[ "$_f" =~ ^(audit|code)\.json$ ]] || \
     [[ "$_f" =~ ^chats/[A-Za-z0-9._-]{1,80}\.json$ ]] || \
     [[ "$_f" =~ ^saved/(audit|code)(-[a-z0-9-]+)?-[0-9]{8}T[0-9]{6}\.json$ ]] || \
     [[ "$_f" =~ ^saved/opencode-[0-9]{8}T[0-9]{6}\.json$ ]] || \
     [[ "$_f" =~ ^saved/(linux|windows|agent(-linux|-windows)?|opencode(-linux|-windows)?|hub(-linux|-windows)?)-[0-9]{8}T[0-9]{6}\.json$ ]] || \
     [[ "$_f" =~ ^history/[0-9]{4}-[0-9]{2}-[0-9]{2}/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/[A-Za-z0-9._-]{1,90}\.json$ ]]; then
    FILE="$_f"
  else
    echo "publish_session: rejected file override: $_f" >&2
    exit 1
  fi
fi

# ── the layout: one flat pile sorted into folders ─────────────────────────
# Everything used to sit in the branch root, which made "what is this file and
# when is it from" a guessing game. Now: live/ for what is alive right now,
# models/ for the roster, snapshots/ for the audit/code pair, and history/ for
# everything historical, filed under the day and the weekday it belongs to.
#
# date_of_day <YYYYMMDD or YYYY-MM-DD> -> "YYYY-MM-DD/Tue"
history_bucket() {
  local raw="$1" d=""
  if [[ "$raw" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})$ ]]; then
    d="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
  elif [[ "$raw" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})$ ]]; then
    d="$raw"
  else
    d="$(date -u '+%Y-%m-%d')"
  fi
  local wd
  wd="$(date -u -d "$d" '+%a' 2>/dev/null || true)"
  case "$wd" in
    Mon|Tue|Wed|Thu|Fri|Sat|Sun) : ;;
    *) wd="$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1]).strftime('%a'))" "$d" 2>/dev/null || echo "")" ;;
  esac
  [ -n "$wd" ] || wd="---"
  printf '%s/%s' "$d" "$wd"
}

# A date out of a <name>-YYYYMMDDTHHMMSS.json stamp; today when there is none.
stamp_bucket() {
  local name="$1" raw=""
  if [[ "$name" =~ ([0-9]{8})T[0-9]{6} ]]; then raw="${BASH_REMATCH[1]}"; fi
  history_bucket "$raw"
}

layout_file() {
  local f="$1" bucket
  case "$f" in
    live/*|chats/*|history/*|artifacts/*) printf '%s' "$f"; return 0 ;;
  esac
  case "$f" in
    session*.json) printf 'live/%s' "$f"; return 0 ;;
    models-*.json) printf 'models/%s' "$f"; return 0 ;;
    audit.json|code.json) printf 'snapshots/%s' "$f"; return 0 ;;
    handoff.json) printf 'live/handoff.json'; return 0 ;;
  esac
  if [[ "$f" == saved/* ]]; then
    # saved/audit-hub-20260102T030405.json -> history/2026-01-02/Fri/saved-audit-hub-...
    bucket="$(stamp_bucket "${f#saved/}")"
    printf 'history/%s/saved-%s' "$bucket" "${f#saved/}"
    return 0
  fi
  printf '%s' "$f"
}

if [ "$JOURNAL" = "1" ]; then
  _num="${GITHUB_RUN_NUMBER:-0}"
  [ -n "$_num" ] || _num=0
  bucket="$(history_bucket "$JOURNAL_DATE")"
  FILE="history/$bucket/run-$_num.json"
fi
FILE="$(layout_file "$FILE")"
export SCRUB
export JSON_MERGE="$(printf '%s\n' "${JSON_FILES[@]}")" 

# A unique staging file per invocation. A fixed /tmp/session.json is shared by
# every caller on the machine, and two publishes running at once overwrote each
# other's payload - caught by a local race test, where the Windows entry ended
# up carrying the Linux address. Staged under ~/.npm-hub/tmp, never /tmp.
WORK=""
mkdir -p "$HOME/.npm-hub/tmp" || exit 1
if ! STAGE="$(TMPDIR="$HOME/.npm-hub/tmp" mktemp -t session.XXXXXX.json)"; then
  echo "publish_session: cannot create staging file" >&2
  exit 1
fi
cleanup_publish() {
  cd / 2>/dev/null || true
  [ -n "$STAGE" ] && rm -f "$STAGE"
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap cleanup_publish EXIT

python3 - "$@" <<'PY' > "$STAGE"
import json, os, re, sys, datetime

SECRET_RE = re.compile(r'key|token|secret|passw|auth|credential|private|bearer', re.I)

def scrub(o):
    if isinstance(o, dict):
        return {k: scrub(v) for k, v in o.items() if not SECRET_RE.search(str(k))}
    if isinstance(o, list):
        return [scrub(v) for v in o]
    return o

data = {}
# Local JSON files first, so explicit key=value arguments win over them.
for path in (os.environ.get('JSON_MERGE') or '').splitlines():
    path = path.strip()
    if not path:
        continue
    try:
        with open(path, encoding='utf-8') as f:
            merged = json.load(f)
    except Exception as e:
        sys.stderr.write('publish_session: json=%s skipped (%s)\n' % (path, e))
        continue
    if not isinstance(merged, dict):
        sys.stderr.write('publish_session: json=%s skipped (not an object)\n' % path)
        continue
    if os.environ.get('SCRUB', '1') != '0':
        merged = scrub(merged)
    data.update(merged)
for arg in sys.argv[1:]:
    if '=' not in arg:
        continue
    key, value = arg.split('=', 1)
    if value != '':
        data[key] = value

data.setdefault('startedAt', datetime.datetime.now(datetime.timezone.utc)
                .replace(microsecond=0).isoformat().replace('+00:00', 'Z'))
data.setdefault('state', 'live')
data['runId'] = os.environ.get('GITHUB_RUN_ID', '')
data['runNumber'] = os.environ.get('GITHUB_RUN_NUMBER', '')
data['repo'] = os.environ.get('GITHUB_REPOSITORY', '')
# Write bytes, not text.
#
# Python on the Windows runner defaults stdout to cp1252, and the moment a
# value contains Cyrillic - "Стол Windows" - print() raises UnicodeEncodeError,
# the staging file ends up empty and the script reports "nothing to publish"
# and exits 0. The step goes green and no address is ever published. That is
# exactly what happened: the Windows desk was up and reachable, and the panel
# showed nothing. Measured in the run log, not guessed.
sys.stdout.buffer.write(
    json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8'))
sys.stdout.buffer.write(b"\n")
PY

if [ ! -s "$STAGE" ]; then
  echo "publish_session: staging file is empty" >&2
  exit 1
fi

# SESSION_STATE_URL exists for local tests: point it at a file:// bare
# repo and the whole publish runs without touching github.com.
REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN:-${GITHUB_TOKEN:-}}@github.com/${GITHUB_REPOSITORY:-}.git}"
if [ -z "${SESSION_STATE_URL:-}" ] && [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
  echo "publish_session: no GitHub token" >&2
  exit 1
fi

if ! WORK="$(mktemp -d)"; then
  echo "publish_session: cannot create work directory" >&2
  exit 1
fi
cd "$WORK" || exit 1

# A shallow clone of one branch, or a fresh orphan when it does not exist yet.
if git clone -q --depth 1 --branch "$BRANCH" \
    "${REMOTE}" state 2>/dev/null; then
  cd state || exit 1
else
  git clone -q --depth 1 \
    "${REMOTE}" state || exit 1
  cd state || exit 1
  git checkout -q --orphan "$BRANCH"
  git rm -rqf . 2>/dev/null || true
fi

IS_SESSION_FILE=0
case "$FILE" in
  live/session.json|live/session-*.json) IS_SESSION_FILE=1 ;;
esac

session_publish_blocked() {
  [ -f "$FILE" ] || return 1
  python3 - "$FILE" "$STAGE" "${GITHUB_RUN_ID:-}" <<'PY'
import json, os, re, sys
file_path, stage_path, run_id = sys.argv[1:]

def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

old = read(file_path)
new = read(stage_path)
if not old:
    raise SystemExit(1)
is_session = os.path.basename(file_path).startswith("session")
old_state = str(old.get("state", ""))
new_state = str(new.get("state", ""))
old_run = str(old.get("runId", ""))
new_run = str(new.get("runId", "")) or run_id
if is_session and new_state == "ended":
    if old_state != "ended" and (not old_run or old_run != new_run):
        raise SystemExit(0)
    raise SystemExit(1)
if is_session and new_state != "live":
    raise SystemExit(1)
if not is_session and old_state == "ended":
    raise SystemExit(1)
if not old_run or not new_run or old_run == new_run:
    raise SystemExit(1)
old_number = str(old.get("runNumber", ""))
new_number = str(new.get("runNumber", ""))
if not (re.fullmatch(r"\d+", old_number) and re.fullmatch(r"\d+", new_number)):
    raise SystemExit(0)
raise SystemExit(1 if int(new_number) > int(old_number) else 0)
PY
}

if session_publish_blocked; then
  echo "publish_session: $FILE is owned by a newer run; left alone"
  exit 0
fi

if [ "$IS_SESSION_FILE" = 1 ] && [ "$EXPLICIT_STARTED_AT" -eq 0 ] && [ -f "$FILE" ]; then
  EXISTING_RUN=$(python3 - "$FILE" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding='utf-8')).get('runId', ''))
except Exception:
    print('')
PY
)
  if [ -z "${GITHUB_RUN_ID:-}" ] || [ "$EXISTING_RUN" = "${GITHUB_RUN_ID:-}" ]; then
    EXISTING_STARTED_AT=$(python3 - "$FILE" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1], encoding='utf-8')).get('startedAt', ''))
except Exception:
    print('')
PY
)
    if [ -n "$EXISTING_STARTED_AT" ]; then
      python3 - "$STAGE" "$EXISTING_STARTED_AT" <<'PY'
import json, sys
path, started = sys.argv[1:]
try:
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    data['startedAt'] = started
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
except Exception as e:
    print('publish_session: could not preserve startedAt: %s' % e, file=sys.stderr)
    raise SystemExit(1)
PY
    fi
  fi
fi

mkdir -p "$(dirname "$FILE")"
cp "$STAGE" "$FILE"
git config user.email "session@symbiosis"
git config user.name  "Session state"
git add "$FILE"

if git diff --cached --quiet; then
  echo "publish_session: unchanged"
  exit 0
fi

git commit -q -m "session $(date -u '+%Y-%m-%d %H:%M:%S')"

# NOT a force push any more.
#
# Two desks publish to this branch at the same time, and -f made the second
# writer erase the first: the Linux desk cloned the branch before the Windows
# desk existed, then force-pushed its own single-file tree over it. Measured -
# session-windows.json was written by a step that reported success, and the
# branch afterwards held only session-linux.json.
#
# So: fetch, replay this one file on top of whatever is there now, push
# normally, and retry if someone else got in between. Each desk only ever
# touches its own file, so the merge is trivial and cannot conflict.
pushed=0
for attempt in $(seq 1 12); do
  if git push -q origin "HEAD:$BRANCH" 2>/dev/null; then
    pushed=1
    break
  fi
  echo "publish_session: push attempt $attempt failed; refreshing $BRANCH" >&2
  if git fetch -q origin "$BRANCH" 2>/dev/null; then
    git reset -q --hard FETCH_HEAD
    if session_publish_blocked; then
      echo "publish_session: $FILE is owned by a newer run; left alone"
      exit 0
    fi
    mkdir -p "$(dirname "$FILE")"
    cp "$STAGE" "$FILE"
    git add "$FILE"
    git commit -q -m "session $(date -u '+%Y-%m-%d %H:%M:%S')" 2>/dev/null || true
  fi
  delay=$((attempt * 2))
  [ "$delay" -gt 30 ] && delay=30
  sleep "$delay"
done

if [ "$pushed" = 1 ]; then
  echo "publish_session: published $FILE to $BRANCH"
else
  echo "publish_session: push failed after retries" >&2
  exit 1
fi
