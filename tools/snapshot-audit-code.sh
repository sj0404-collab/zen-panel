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

log() { echo "[snapshot $SLOT] $*" | tee -a "$HUB_LOGS/snapshot-$SLOT.log"; }

do_snapshot() {
  local stamp
  stamp="$(date -u '+%Y%m%dT%H%M%S')"
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

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
        cur.execute("SELECT id, title, datetime(time_created/1000,'unixepoch') as created FROM session ORDER BY time_created DESC LIMIT 20")
        for r in cur.fetchall():
            out["opencode"].append(dict(r))
        con.close()
except Exception:
    pass
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

  local ok=0
  for f in audit.json code.json; do
    local base="${f%.json}"
    local src="$tmpdir/$f"
    local dst="$f"
    if bash "$SCRIPT_DIR/publish_session.sh" "slot=$SLOT" "file=$dst" "json=$src" "kind=snapshot-$f" 2>&1 | tee -a "$HUB_LOGS/snapshot-$SLOT.log"; then
      ok=$((ok+1))
    fi
    local hist="saved/${base}-${SLOT}-${stamp}.json"
    if bash "$SCRIPT_DIR/publish_session.sh" "file=$hist" "json=$src" "kind=snapshot-$f" 2>&1 | tee -a "$HUB_LOGS/snapshot-$SLOT.log"; then
      : # ok
    fi
  done
  log "snapshot $stamp: audit $(wc -c < "$audit_json" 2>/dev/null | tr -d ' ')B code $(wc -c < "$code_json" 2>/dev/null | tr -d ' ')B published"
}

if [ "${1:-}" = "--once" ] || [ "${SNAPSHOT_ONCE:-}" = "1" ]; then
  SLOT="${2:-agent}"
  WORK="${3:-$WORK}"
  if [ ! -d "$WORK" ]; then WORK="$(pwd)"; fi
  if [ ! -d "$WORK/.git" ] && [ -d "$WORK/../fork/.git" ]; then WORK="$WORK/../fork"; fi
  do_snapshot
  exit 0
fi

log "snapshot daemon started slot=$SLOT work=$WORK interval=${INTERVAL}s (audit.json + code.json every ${INTERVAL}s)"
do_snapshot || true
while true; do
  sleep "$INTERVAL"
  do_snapshot || log "snapshot failed, retrying"
done
