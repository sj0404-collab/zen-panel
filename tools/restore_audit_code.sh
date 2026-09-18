#!/usr/bin/env bash
# Restore audit.json / code.json from session-state branch into workspace
set -uo pipefail
WORK="${1:-${GITHUB_WORKSPACE:-$(pwd)}/fork}"
if [ ! -d "$WORK" ]; then WORK="$(pwd)"; fi
if [ -d "$WORK/.git" ]; then :; elif [ -d "$WORK/../fork/.git" ]; then WORK="$WORK/../fork"; fi
BRANCH="session-state"
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true

if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "restore_audit_code: no GH_TOKEN, skip" >&2
  exit 0
fi
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
REMOTE="${SESSION_STATE_URL:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY:-}.git}"
TMP="$(mktemp -d)"
cleanup(){ rm -rf "$TMP"; }
trap cleanup EXIT
if ! git clone -q --depth 1 --branch "$BRANCH" "$REMOTE" "$TMP/state" 2>/dev/null; then
  echo "restore_audit_code: no $BRANCH branch yet"
  exit 0
fi
for f in audit.json code.json; do
  if [ -f "$TMP/state/$f" ]; then
    cp -f "$TMP/state/$f" "$WORK/$f" 2>/dev/null || true
    if [ "$f" = "audit.json" ] && [ ! -s "$WORK/.zen-agent/audit.jsonl" ]; then
      mkdir -p "$WORK/.zen-agent"
      python3 - "$TMP/state/$f" "$WORK/.zen-agent/audit.jsonl" <<'PY'
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
PY
    fi
    echo "restore_audit_code: restored $f ($(wc -c < "$TMP/state/$f" | tr -d ' ')B) -> $WORK/$f"
  fi
done
mkdir -p "$WORK/.zen-agent/restored" 2>/dev/null || true
if ls "$TMP/state/saved"/audit-*.json >/dev/null 2>&1; then
  cp -f "$TMP/state"/saved/audit-*.json "$WORK/.zen-agent/restored/" 2>/dev/null || true
  echo "restore_audit_code: saved audit snapshots copied"
fi
if ls "$TMP/state"/saved/code-*.json >/dev/null 2>&1; then
  cp -f "$TMP/state"/saved/code-*.json "$WORK/.zen-agent/restored/" 2>/dev/null || true
  echo "restore_audit_code: saved code snapshots copied"
fi
