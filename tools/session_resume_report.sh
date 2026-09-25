#!/usr/bin/env bash
# Where did I stop? A resume report for every live OpenCode session.
#
# WHY
#   A session is only useful if you can come back to it. Two things have to be
#   true for that: the conversation is still there, and the WORK is still there.
#   This prints both, per session, from the live database - plus the one-line
#   "next step" each project left for itself in AGENT_SESSION.md.
#
#   The database is opened READ-ONLY (mode=ro) on purpose: this runs next to a
#   live OpenCode, and a report must never take the writer's lock or see a torn
#   write.
#
# USAGE
#   session_resume_report.sh              human-readable report
#   session_resume_report.sh --json       the same, as JSON (for tests/tools)
#
# ENV
#   OPENCODE_DB   path to the database (default ~/.local/share/opencode/opencode.db)
#   RESUME_LIMIT  main sessions to show  (default 10)
set -uo pipefail

DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
LIMIT="${RESUME_LIMIT:-10}"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

if [ ! -f "$DB" ]; then
  if [ "$JSON" = 1 ]; then echo '{"sessions":[],"error":"no opencode database"}'; else
    echo "session_resume_report: no OpenCode database at $DB"
  fi
  exit 0
fi
command -v sqlite3 >/dev/null 2>&1 || { echo "session_resume_report: sqlite3 is not installed" >&2; exit 1; }

q() { sqlite3 -readonly "$DB" "$1" 2>/dev/null; }

esc() { printf '%s' "$1" | tr '\n\r\t' '   ' | cut -c1-200; }

sessions=$(q "SELECT id || char(9) || title || char(9) || directory || char(9) || datetime(time_updated/1000,'unixepoch') || char(9) || (SELECT count(*) FROM message m WHERE m.session_id = session.id)
FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT $LIMIT;")

[ -z "$sessions" ] && { [ "$JSON" = 1 ] && echo '{"sessions":[]}' || echo "нет сессий"; exit 0; }

emit_json=0
[ "$JSON" = 1 ] && emit_json=1
[ "$emit_json" = 1 ] && printf '{"sessions":['

first=1
while IFS=$'\t' read -r id title dir updated msgs; do
  [ -n "$id" ] || continue
  # Todos: what the agent itself thinks is left to do.
  todos=$(q "SELECT status || ' ' || content FROM todo WHERE session_id = '$id' ORDER BY position;")
  inprog=$(printf '%s\n' "$todos" | grep -c '^in_progress' || true)
  pending=$(printf '%s\n' "$todos" | grep -c '^pending' || true)
  done_n=$(printf '%s\n' "$todos" | grep -c '^completed' || true)
  # The last thing the user said and the last thing that was actually done.
  last_user=$(q "SELECT replace(substr(json_extract(p.data,'\$.text'),1,220), char(10), ' ')
               FROM message m JOIN part p ON p.message_id = m.id
               WHERE m.session_id = '$id' AND json_extract(m.data,'\$.role') = 'user'
                 AND json_extract(p.data,'\$.type') = 'text'
               ORDER BY m.time_created DESC, p.time_created DESC LIMIT 1;")
  last_tool=$(q "SELECT coalesce(json_extract(data,'\$.tool'),'?') || ': ' ||
                      substr(replace(coalesce(json_extract(data,'\$.state.input.command'),
                                              json_extract(data,'\$.state.input.filePath'),
                                              json_extract(data,'\$.state.input.description'),''), char(10), ' '),1,120)
               FROM part WHERE session_id = '$id' AND json_extract(data,'\$.type') = 'tool'
               ORDER BY time_created DESC LIMIT 1;")
  # The work itself: is the tree dirty, is there a continuity note, is CI green.
  branch=""; dirty="?"; head_sha=""; note=""
  if [ -d "$dir/.git" ]; then
    branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
    dirty=$(git -C "$dir" status --porcelain 2>/dev/null | grep -c . || true)
    head_sha=$(git -C "$dir" log -1 --format='%h %s' 2>/dev/null | cut -c1-90)
    [ -f "$dir/AGENT_SESSION.md" ] && note="AGENT_SESSION.md"
  fi
  ci=""
  if [ -n "$branch" ] && command -v gh >/dev/null 2>&1 && [ -f "$dir/.git" ]; then
    ci=$(cd "$dir" 2>/dev/null && gh run list -L 1 --json conclusion,status 2>/dev/null |
         python3 -c "import json,sys
try:
  r=json.load(sys.stdin)[0]
  print((r.get('conclusion') or r.get('status') or '?'))
except Exception:
  print('')" 2>/dev/null)
  fi

  if [ "$emit_json" = 1 ]; then
    [ "$first" = 1 ] || printf ','
    first=0
    python3 - "$id" "$title" "$dir" "$updated" "$msgs" "$done_n" "$inprog" "$pending" \
             "$last_user" "$last_tool" "$branch" "$dirty" "$head_sha" "$note" "$ci" <<'PY'
import json, sys
keys = ['id','title','directory','updated','messages','todosDone','todosInProgress',
        'todosPending','lastUser','lastAction','branch','dirtyFiles','head','note','ci']
vals = sys.argv[1:]
print(json.dumps({k: (v if k not in ('messages','todosDone','todosInProgress','todosPending','dirtyFiles') else int(v or 0))
                  for k, v in zip(keys, vals)}, ensure_ascii=False))
PY
  else
    echo "────────────────────────────────────────────────────────────"
    echo "▸ $title"
    echo "  id        $id"
    echo "  где       $dir"
    echo "  обновлена $updated · сообщений: $msgs"
    [ -n "$branch" ] && echo "  git       $branch · несохранённых файлов: $dirty · ${head_sha:-без коммитов}"
    [ -n "$ci" ] && echo "  CI        $ci"
    echo "  задачи    сделано $done_n · в работе $inprog · в очереди $pending"
    [ -n "$todos" ] && printf '%s\n' "$todos" | sed 's/^/             /'
    [ -n "$last_user" ] && echo "  ты писал  $(esc "$last_user")"
    [ -n "$last_tool" ] && echo "  последнее $last_tool"
    [ -n "$note" ] && echo "  заметка   $dir/$note — там «следующий шаг»"
  fi
done <<< "$sessions"

[ "$emit_json" = 1 ] && echo ']}'
exit 0
