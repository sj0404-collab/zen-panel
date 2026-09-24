#!/usr/bin/env bash
# Snapshot audit + code to session-state branch as audit.json / code.json
set -uo pipefail

SLOT="${1:-agent}"
WORK="${2:-${GITHUB_WORKSPACE:-$(pwd)}/fork}"
if [ ! -d "$WORK" ]; then
  WORK="$(pwd)"
fi
if [ ! -d "$WORK/.git" ] && [ -d "$WORK/../fork/.git" ]; then
  WORK="$WORK/../fork"
fi

HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true

INTERVAL="${SNAPSHOT_INTERVAL:-120}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SLOT WORK

log() { echo "[snapshot $SLOT] $*" | tee -a "$HUB_LOGS/snapshot-$SLOT.log"; }
publish_snapshot() {
  local output status
  output="$(bash "$SCRIPT_DIR/publish_session.sh" "$@" 2>&1)"
  status=$?
  printf '%s\n' "$output" | tee -a "$HUB_LOGS/snapshot-$SLOT.log"
  return "$status"
}
snapshot_lock_dir() { printf '%s/snapshot-%s.lock' "$HUB_LOGS" "$SLOT"; }
acquire_snapshot_lock() {
  local lock owner now mtime
  lock="$(snapshot_lock_dir)"
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock/pid"
    printf '%s\n' "$(date +%s)" > "$lock/started"
    return 0
  fi
  owner=""
  [ -f "$lock/pid" ] && owner="$(tr -dc '0-9' < "$lock/pid")"
  now="$(date +%s)"
  mtime="$(stat -c %Y "$lock" 2>/dev/null || printf '0')"
  if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } \
    || { [ -z "$owner" ] && [ "$mtime" -gt 0 ] && [ $((now - mtime)) -gt 120 ]; }; then
    rm -rf "$lock"
    if mkdir "$lock" 2>/dev/null; then
      printf '%s\n' "$$" > "$lock/pid"
      printf '%s\n' "$now" > "$lock/started"
      return 0
    fi
  fi
  return 1
}
release_snapshot_lock() { rm -rf "$(snapshot_lock_dir)"; }

# Daemon cycle counter for the throttled per-repo chat export below.
CHATCYCLE=0

# Publish chats/<name>.json for EVERY git repo under $HOME (the hub clone plus
# everything cloned from the Files tab), so the next runner re-imports each
# repo's opencode sessions by name instead of starting from an empty db.
export_all_chats() {
  [ "${SNAPSHOT_EXPORT_ALL_CHATS:-0}" = "1" ] || return 0
  [ -f "$SCRIPT_DIR/export-chats.sh" ] || return 0
  [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || return 0
  GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" PUBLISH=1 \
    bash "$SCRIPT_DIR/export-chats.sh" --all >> "$HUB_LOGS/snapshot-$SLOT.log" 2>&1
}

do_snapshot() {
  if ! acquire_snapshot_lock; then
    log "another snapshot is already running"
    return 0
  fi
  local stamp
  local chat_ok=1
  stamp="$(date -u '+%Y%m%dT%H%M%S')"
  local tmpdir
  if ! tmpdir="$(mktemp -d)"; then
    log "cannot create snapshot directory"
    release_snapshot_lock
    return 1
  fi

  local audit_src="$WORK/.zen-agent/audit.jsonl"
  local audit_json="$tmpdir/audit.json"
  local code_json="$tmpdir/code.json"

  python3 - "$audit_src" "$WORK" "$tmpdir" <<'PY'
import json, os, sys, glob, sqlite3
audit_src, work, tmpdir = sys.argv[1], sys.argv[2], sys.argv[3]
out = {"kind":"audit","slot": os.environ.get("SLOT",""), "stamp": os.popen("date -u +%Y-%m-%dT%H:%M:%SZ").read().strip(),
       "audit": [], "sessions": [], "opencode": [], "chat": []}
try:
    if os.path.exists(audit_src):
        lines = open(audit_src, encoding="utf-8").read().splitlines()
        for l in lines[-500:]:
            l=l.strip()
            if not l: continue
            try:
                j=json.loads(l)
                out["audit"].append(j)
                if j.get("event") in ("task_started","model_response","tool_finished","task_finished","user_message","agent_message"):
                    out["chat"].append(j)
            except: pass
except Exception as e:
    out["audit_error"]=str(e)
try:
    sess_dir = os.path.join(work, ".zen-agent", "sessions")
    if os.path.isdir(sess_dir):
        for p in glob.glob(os.path.join(sess_dir, "*.json"))[:50]:
            try: out["sessions"].append(json.load(open(p, encoding="utf-8")))
            except: pass
except Exception as e:
    out["sessions_error"]=str(e)
try:
    db = os.path.expanduser("~/.local/share/opencode/opencode.db")
    if os.path.exists(db):
        import sqlite3
        con = sqlite3.connect(db)
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        cur.execute("SELECT id, title, slug, directory, parent_id, datetime(time_created/1000,'unixepoch') as created FROM session ORDER BY time_created DESC LIMIT 50")
        for r in cur.fetchall():
            out["opencode"].append(dict(r))
        try:
            cur.execute("SELECT session_id, id as message_id, time_created, json_extract(data,'$.role') as role, substr(json_extract(data,'$.parts'),1,2000) as parts FROM message ORDER BY time_created DESC LIMIT 200")
            out["opencodeMessages"] = [dict(r) for r in cur.fetchall()]
            out["opencodeMessageCount"] = len(out["opencodeMessages"])
        except Exception:
            pass
        con.close()
except Exception as e:
    out["opencode_error"] = str(e)
out["chatCount"] = len(out["chat"])
out["auditCount"] = len(out["audit"])
# Если chat пустой (неизвестные event names), дублируем audit как chat
if out["chatCount"] == 0 and out["audit"]:
    out["chat"] = out["audit"]
    out["chatCount"] = len(out["chat"])
with open(os.path.join(tmpdir, "audit.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
PY
  if [ ! -s "$audit_json" ]; then echo "{}" > "$audit_json"; fi
  # Обновляем saved/opencode-*.json каждые 120с (не раз в сутки) чтобы сессии были свежими
  if [ -f "$SCRIPT_DIR/backup-chat-history.sh" ] && [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    if ! GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" PUBLISH=1 bash "$SCRIPT_DIR/backup-chat-history.sh" >> "$HUB_LOGS/snapshot-$SLOT.log" 2>&1; then
      log "chat history backup failed"
      chat_ok=0
    fi
  fi
  # Per-repo chat bundles: on the 120s daemon only every 10th cycle (~20 min,
  # export is heavier than the light audit/code snapshot), always on the final
  # --once. The final run covers cross-run continuity; the periodic one guards
  # against a runner that is killed before the graceful final step.
  CHATCYCLE=$((CHATCYCLE + 1))
   if [ $((CHATCYCLE % 10)) -eq 1 ] || [ "${SNAPSHOT_ONCE:-}" = "1" ]; then
     if ! export_all_chats; then
       log "chat export failed"
       chat_ok=0
     fi
   fi


  python3 - "$WORK" "$tmpdir" <<'PY'
import json, os, sys, subprocess, glob
work, tmpdir = sys.argv[1], sys.argv[2]
out = {"kind":"code","slot": os.environ.get("SLOT",""), "stamp": os.popen("date -u +%Y-%m-%dT%H:%M:%SZ").read().strip(),
       "changedFiles": [], "gitStatus": "", "gitDiffStat": "", "gitDiff": "", "gitLog": [], "sessions": []}
def run(cmd):
    try: return subprocess.check_output(cmd, cwd=work, shell=True, text=True, stderr=subprocess.DEVNULL)
    except: return ""
out["gitStatus"] = run("git status --porcelain=v1 2>/dev/null | head -n 200")
out["gitDiffStat"] = run("git diff --stat HEAD 2>/dev/null | head -n 200")
diff = run("git diff HEAD 2>/dev/null | head -c 400000")
out["gitDiff"] = diff
try:
    for l in out["gitStatus"].splitlines():
        if len(l) >= 3:
            out["changedFiles"].append({"code": l[:2], "path": l[3:]})
        elif l:
            out["changedFiles"].append({"code": l[:2].strip() if len(l)>=2 else l, "path": l[3:] if len(l)>=3 else ""})
except: pass
out["gitLog"] = [x for x in run("git log --oneline -20 2>/dev/null").strip().splitlines() if x][:20]
try:
    sess_dir = os.path.join(work, ".zen-agent", "sessions")
    if os.path.isdir(sess_dir):
        for p in glob.glob(os.path.join(sess_dir, "*.json"))[:20]:
            try: out["sessions"].append({"file": os.path.basename(p), "data": json.load(open(p, encoding="utf-8"))})
            except: pass
except: pass
try: out["topFiles"] = [x for x in run("ls -1 2>/dev/null | head -n 50").strip().splitlines() if x]
except: pass
out["changedCount"] = len(out["changedFiles"])
with open(os.path.join(tmpdir, "code.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
PY
  if [ ! -s "$code_json" ]; then echo "{}" > "$code_json"; fi

  local published=0
  for f in audit.json code.json; do
    local base="${f%.json}"
    local src="$tmpdir/$f"
    local dst="$f"
    if publish_snapshot "slot=$SLOT" "file=$dst" "json=$src" "kind=snapshot-$f"; then
      published=$((published+1))
    else
      log "publish failed for $dst"
    fi
    local hist="saved/${base}-${SLOT}-${stamp}.json"
    if publish_snapshot "file=$hist" "json=$src" "kind=snapshot-$f"; then
      published=$((published+1))
    else
      log "publish failed for $hist"
    fi
  done
  log "snapshot $stamp: audit $(wc -c < "$audit_json" 2>/dev/null | tr -d ' ')B code $(wc -c < "$code_json" 2>/dev/null | tr -d ' ')B published=$published/4"
  rm -rf "$tmpdir"
  release_snapshot_lock
  [ "$published" -eq 4 ] && [ "$chat_ok" -eq 1 ]
}

if [ "${1:-}" = "--once" ] || [ "${SNAPSHOT_ONCE:-}" = "1" ]; then
  SLOT="${2:-agent}"
  WORK="${3:-$WORK}"
  if [ ! -d "$WORK" ]; then WORK="$(pwd)"; fi
  if [ ! -d "$WORK/.git" ] && [ -d "$WORK/../fork/.git" ]; then WORK="$WORK/../fork"; fi
  export SLOT WORK
  # Full chat transcripts (chats/<repo>.json): this repo's bundle is always
  # exported at shutdown; with SNAPSHOT_EXPORT_ALL_CHATS=1 every repo under
  # $HOME is exported too (see export_all_chats inside do_snapshot).
  if [ "${EXPORT_CHATS:-1}" != "0" ] && [ -f "$SCRIPT_DIR/export-chats.sh" ] \
    && [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    CHAT_REPO_DIR="$WORK" PUBLISH="${PUBLISH:-1}" \
      bash "$SCRIPT_DIR/export-chats.sh" 2>&1 | tee -a "$HUB_LOGS/snapshot-$SLOT.log"
    export_status=${PIPESTATUS[0]}
    if [ "$export_status" -ne 0 ]; then
      log "one-shot chat export failed"
      exit 1
    fi
  fi
  do_snapshot || exit 1
  exit 0
fi

log "snapshot daemon started slot=$SLOT work=$WORK interval=${INTERVAL}s (audit.json + code.json every ${INTERVAL}s)"
do_snapshot || true
while true; do
  sleep "$INTERVAL"
  do_snapshot || log "snapshot failed, retrying"
done
