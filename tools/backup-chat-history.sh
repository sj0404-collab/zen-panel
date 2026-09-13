#!/usr/bin/env bash
# Backup opencode chat history so it survives /tmp cleanups and reboot.
#
# opencode stores everything in ~/.local/share/opencode/opencode.db (already
# a stable, non-/tmp location). This script additionally:
#   1. dumps a readable copy of every session + message into
#      ~/.local/share/opencode/history/<YYYY-MM-DDTHHMMSS>/ as JSONL so it can
#      be grepped/read long after the machine is gone, and
#   2. publishes one bundle to the session-state branch as
#      saved/opencode-<YYYYMMDDTHHMMSS>.json (same channel the zen-panel
#      «Сохранить» button uses), so a fresh clone already contains the chats.
set -uo pipefail

DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
STAMP="$(date -u '+%Y%m%dT%H%M%S')"
OUT_DIR="$HOME/.local/share/opencode/history/$STAMP"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$DB" ]; then
  echo "backup-chat-history: no opencode.db at $DB" >&2
  exit 0
fi

mkdir -p "$OUT_DIR"
: > "$OUT_DIR/sessions.jsonl"

sqlite3 -json "$DB" \
  "SELECT id, title, slug, directory, path, parent_id,
          datetime(time_created/1000,'unixepoch') AS created_utc
     FROM session ORDER BY time_created;" \
  | python3 -c "import json,sys
for o in json.load(sys.stdin):
    print(json.dumps(o, ensure_ascii=False))" \
  >> "$OUT_DIR/sessions.jsonl"

sqlite3 -noheader -separator $'\x1f' "$DB" \
  "SELECT m.session_id, m.id, m.time_created, m.data
     FROM message m ORDER BY m.time_created;" \
  | while IFS=$'\x1f' read -r sid mid tc data; do
      python3 -c "
import json,sys
ms=json.loads('''${data//\'/\\\'}''')
part=ms.get('part') or ms.get('parts') or []
text=[]
for p in part:
    if isinstance(p,dict):
        t=p.get('type')
        c=p.get('text') if t=='text' else ('(tool: %s)'%t if t else '')
        if c: text.append(str(c))
    elif isinstance(p,str): text.append(p)
print(json.dumps({'session_id':'$sid','message_id':'$mid','time_ms':'$tc','role':ms.get('role',''),'message':' '.join(text)},ensure_ascii=False))"
    done >> "$OUT_DIR/messages.jsonl"

echo "backup-chat-history: wrote $(wc -l < "$OUT_DIR/sessions.jsonl") sessions, $(wc -l < "$OUT_DIR/messages.jsonl") messages to $OUT_DIR"

# Optional: publish one bundle to the session-state branch (saved/ slot).
# Slot name = 'opencode'. Disable with PUBLISH=0.
if [ "${PUBLISH:-1}" = "1" ] && [ -n "${GH_TOKEN:-}" ]; then
  python3 - "$OUT_DIR" "$STAMP" <<'PY'
import json, os, sys, glob
out_dir, stamp = sys.argv[1], sys.argv[2]
bundle = {"sz_tip": "saved", "kind": "opencode-chat-history", "stamp": stamp,
          "sessions": [], "countMessages": 0, "countSessions": 0}
for line in open(glob.glob(out_dir + "/sessions.jsonl")[0], encoding="utf-8"):
    try: bundle["sessions"].append(json.loads(line))
    except Exception: pass
bundle["countSessions"] = len(bundle["sessions"])
try:
    bundle["countMessages"] = sum(1 for _ in open(glob.glob(out_dir + "/messages.jsonl")[0], encoding="utf-8"))
except Exception:
    pass
json.dump(bundle, open(out_dir + "/bundle.json", "w", encoding="utf-8"), ensure_ascii=False)
print(os.path.realpath(out_dir + "/bundle.json"))
PY
  BUNDLE="$OUT_DIR/bundle.json"
  [ -s "$BUNDLE" ] || { echo "backup-chat-history: bundle build failed" >&2; exit 0; }
  bash "$SCRIPT_DIR/publish_session.sh" \
    file="saved/opencode-$STAMP.json" \
    json="$BUNDLE" \
    kind=opencode-chat-history \
    stamp="$STAMP" \
    state=ended 2>&1 | sed 's/^/  /'
fi