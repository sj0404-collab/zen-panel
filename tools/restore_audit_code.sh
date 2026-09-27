#!/usr/bin/env bash
# Restore audit.json / code.json from session-state branch into workspace
set -uo pipefail
WORK="${1:-${GITHUB_WORKSPACE:-$(pwd)}/fork}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -d "$WORK" ]; then WORK="$(pwd)"; fi
if [ -d "$WORK/.git" ]; then :; elif [ -d "$WORK/../fork/.git" ]; then WORK="$WORK/../fork"; fi
BRANCH="session-state"
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
if ! mkdir -p "$HUB_LOGS" 2>/dev/null; then
  echo "restore_audit_code: cannot create log directory" >&2
  exit 1
fi

if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "restore_audit_code: no GH_TOKEN, skip" >&2
  exit 0
fi
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY:-}.git}"

# STATE_DIR hands in a session-state tree the caller already cloned, so a
# second restore of the same branch does not pay for a second clone.
#
# This branch had grown past 70 MB, almost half of it one uploaded APK under
# artifacts/ that nothing here ever reads. The hub workflow called this script
# twice, so every single hub start downloaded the whole thing twice (~150 MB)
# before the hub could publish its address - measured: the step took 1:51 on
# one run and 5:52 on the next with no code change in between. The blob filter
# drops everything over 1 MB (that APK and any other future upload) and leaves
# every JSON this script actually reads, and the caller reuses one clone for
# both calls. The fallback clone without the filter is for remotes that do not
# speak partial clone (a local file:// repo in the tests, for one).
STATE_DIR="${STATE_DIR:-}"
TMP=""
STATE=""
if [ -n "$STATE_DIR" ] && [ -d "$STATE_DIR" ]; then
  STATE="$STATE_DIR"
else
  if ! TMP="$(mktemp -d)"; then
    echo "restore_audit_code: cannot create restore directory" >&2
    exit 1
  fi
  # cleanup() only ever removes a directory this script created: a STATE_DIR
  # belongs to the caller and outlives us.
  cleanup(){ rm -rf "$TMP"; }
  trap cleanup EXIT
  CLONE_DIR="$TMP/state"
  if ! git clone -q --depth 1 --filter=blob:limit=1m --branch "$BRANCH" "$REMOTE" "$CLONE_DIR" 2>/dev/null; then
    if ! git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" "$CLONE_DIR" 2>/dev/null; then
      echo "restore_audit_code: no $BRANCH branch yet"
      exit 0
    fi
  fi
  STATE="$CLONE_DIR"
fi
status=0
# The branch was reorganised: audit/code now live under snapshots/, and the
# historical bundles under history/<date>/<weekday>/. Both layouts are read, so
# a branch that was never migrated restores exactly as before.
pick_state_file() {
  # $1 = leaf name; prints the first existing candidate.
  local leaf="$1" cand
  for cand in "snapshots/$leaf" "$leaf" "live/$leaf" "models/$leaf"; do
    if [ -f "$STATE/$cand" ]; then printf '%s' "$cand"; return 0; fi
  done
  # history/<date>/<weekday>/<leaf>
  cand="$(find "$STATE/history" -type f -name "$leaf" 2>/dev/null | LC_ALL=C sort | tail -n1)"
  [ -n "$cand" ] || return 1
  printf '%s' "${cand#"$STATE"/}"
}
history_files() {
  # $1 = glob name (e.g. audit-*.json); prints matching files, new layout first.
  find "$STATE/history" -type f -name "$1" 2>/dev/null | LC_ALL=C sort
  ls "$STATE"/saved/"$1" 2>/dev/null
}
for f in audit.json code.json; do
  rel="$(pick_state_file "$f")" || rel=""
  if [ -n "$rel" ] && [ -f "$STATE/$rel" ]; then
    if ! cp -f "$STATE/$rel" "$WORK/$f" 2>/dev/null; then
      echo "restore_audit_code: could not restore $f" >&2
      status=1
      continue
    fi
    if [ "$f" = "audit.json" ] && [ ! -s "$WORK/.zen-agent/audit.jsonl" ]; then
      mkdir -p "$WORK/.zen-agent" || status=1
      # $rel, not $f: the branch moved audit.json under snapshots/, and reading
      # the bare leaf name looked in the root of the clone, where it has not
      # been since the layout change. It failed on every single start ("No such
      # file or directory: .../cloned/audit.json"), set status=1, and left
      # .zen-agent/audit.jsonl empty - so the audit trail the hub reads was
      # never restored at all.
      if ! python3 - "$STATE/$rel" "$WORK/.zen-agent/audit.jsonl" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
try:
    data=json.load(open(src, encoding="utf-8"))
    audit=data.get("audit",[]) or data.get("chat",[])
    with open(dst,"w",encoding="utf-8") as out:
        for ev in audit:
            out.write(json.dumps(ev, ensure_ascii=False)+"\n")
    print(f"restored {len(audit)} audit events to {dst}")
except Exception as e:
    print(f"restore audit failed: {e}", file=sys.stderr)
    sys.exit(1)
PY
      then
        status=1
      fi
    fi
    echo "restore_audit_code: restored $rel ($(wc -c < "$STATE/$rel" | tr -d ' ')B) -> $WORK/$f"
  fi
done
mkdir -p "$WORK/.zen-agent/restored" 2>/dev/null || status=1
for kind in audit code; do
  files="$(history_files "*$kind-*.json")"
  if [ -n "$files" ]; then
    # shellcheck disable=SC2086
    if ! printf '%s\n' "$files" | xargs -r cp -f -t "$WORK/.zen-agent/restored/" 2>/dev/null; then status=1; fi
    echo "restore_audit_code: saved $kind snapshots copied"
  fi
done
mkdir -p "$HOME/.local/share/opencode/history" 2>/dev/null || status=1
opencode_bundles="$(history_files '*opencode-*.json')"
if [ -n "$opencode_bundles" ]; then
  for f in $opencode_bundles; do
    STAMP="$(basename "$f" .json | sed 's/^opencode-//')"
    DEST="$HOME/.local/share/opencode/history/$STAMP"
    mkdir -p "$DEST" 2>/dev/null || status=1
    if ! cp -f "$f" "$DEST/bundle.json" 2>/dev/null; then status=1; fi
    echo "restore_audit_code: opencode bundle $STAMP restored"
  done
  audit_rel="$(pick_state_file audit.json || true)"
  if [ -n "$audit_rel" ] && [ -f "$STATE/$audit_rel" ]; then
    if ! python3 - "$STATE/$audit_rel" "$HOME/.local/share/opencode/history" <<'PY2'
import json, os, sys, glob
audit_path, hist_root = sys.argv[1], sys.argv[2]
try:
    data=json.load(open(audit_path, encoding="utf-8"))
    msgs=data.get("opencodeMessages",[])
    if msgs:
        import glob as g
        dirs=sorted(g.glob(hist_root+"/*"))
        dest=dirs[-1] if dirs else hist_root+"/restored"
        os.makedirs(dest, exist_ok=True)
        with open(dest+"/messages_restored.jsonl","w",encoding="utf-8") as out:
            for m in msgs:
                out.write(json.dumps(m, ensure_ascii=False)+"\n")
        print(f"restored {len(msgs)} opencode messages to {dest}/messages_restored.jsonl")
except Exception as e:
    print(f"opencode restore failed: {e}", file=sys.stderr)
    sys.exit(1)
PY2
    then
      status=1
    fi
  fi
fi

# Chat transcripts live in their own folder: chats/<repo>.json holds the full
# export of every session for this repo. Import them back into the repo (the
# CWD determines the session directory). opencode import is idempotent, so a
# re-run just reports the session again. Disable with RESTORE_CHATS=0.
#
# RESTORE_CHATS_ALL=1 imports EVERY chats/<name>.json bundle into whatever
# local repo matches (the hub clone + everything the Files tab cloned into
# hub-work/), so sessions come back for all repos, not just this $WORK.
if [ "${RESTORE_CHATS_ALL:-0}" = "1" ] && [ -f "$SCRIPT_DIR/restore-chats.sh" ]; then
  CHAT_ALL_ROOT="${RESTORE_CHATS_ROOT:-$HOME}" \
    bash "$SCRIPT_DIR/restore-chats.sh" --all --state "$STATE" 2>&1 | sed 's/^/  /'
  chat_status=${PIPESTATUS[0]}
  [ "$chat_status" -eq 0 ] || status=1
elif [ "${RESTORE_CHATS:-1}" != "0" ] && [ -f "$SCRIPT_DIR/restore-chats.sh" ]; then
  CHAT_REPO_DIR="$WORK" bash "$SCRIPT_DIR/restore-chats.sh" --state "$STATE" 2>&1 | sed 's/^/  /'
  chat_status=${PIPESTATUS[0]}
  [ "$chat_status" -eq 0 ] || status=1
fi
[ "$status" -eq 0 ]
