#!/usr/bin/env bash
# Regressions for the hub restore path, which is what the user waits through
# before the hub publishes an address.
#
# Three things are pinned here, each of them a measured slowdown:
#
#   1. restore_audit_code.sh must restore from a tree the caller already cloned
#      (STATE_DIR). The session-state branch passed 70 MB, and the hub workflow
#      cloned all of it twice per start, ~150 MB, before anything was published.
#   2. It must find audit.json where the branch actually keeps it. Reading the
#      bare leaf name looked in the root of the clone, where it stopped living
#      when the branch moved under snapshots/, so the audit trail was never
#      restored and every start logged a failure.
#   3. restore-chats.sh must import sessions side by side and walk $HOME once.
#      38 sessions one at a time, each paying a node start-up, is what turned a
#      two-minute start into six - and it grows with every session saved.
#
# Runs on Linux in CI: the fake `opencode` is a shell script there, and the
# timings are the assertion (a row of 8 x 2s imports cannot finish in less than
# half the time a pool of 4 takes, and must).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT

fails=0
ok()   { echo "  ok   - $1"; }
bad()  { echo "  FAIL - $1"; fails=$((fails + 1)); }

mkdir -p "$W/bin" "$W/state/snapshots" "$W/state/chats" "$W/home/zen-panel" "$W/bare"

# A fake opencode: records the bundle, then sits there for two seconds. The
# wall clock of an import is therefore "2s per session / pool size".
cat > "$W/bin/opencode" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
sleep 2
exit 0
SH
chmod +x "$W/bin/opencode"
export PATH="$W/bin:$PATH"
export FAKE_LOG="$W/opencode.log"
: > "$FAKE_LOG"

# The local repo the bundle is imported into. Its origin is what the mapping
# has to match on, not its folder name.
( cd "$W/home/zen-panel" && git init -q . \
  && git remote add origin "https://github.com/o/zen-panel.git" ) >/dev/null 2>&1

# On Windows a shell stub is not an option: CreateProcess only ever starts a
# real .exe, so the shell script above would never run and every import would
# "fail" for a reason that has nothing to do with this test. opencode.exe
# becomes a copy of python.exe instead, and the two arguments it is then given
# ("import <bundle>") make it run a script called `import` out of the working
# directory - which is the repo, exactly what the real `opencode import` uses.
if uname -s 2>/dev/null | grep -qiE 'mingw|msys|cygwin'; then
  PYEXE="$(python -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
  if [ -n "$PYEXE" ]; then
    rm -f "$W/bin/opencode"
    cp "$PYEXE" "$W/bin/opencode.exe"
    # python.exe needs python3xx.dll beside it, or it dies before main() with
    # an empty stderr - which looks exactly like an import failure.
    cp "$(dirname "$PYEXE")"/python3*.dll "$W/bin/" 2>/dev/null
    cat > "$W/home/zen-panel/import" <<'SH'
import os, sys, time
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(sys.argv[-1] + "\n")
time.sleep(2)
SH
  fi
fi

# 8 sessions: in a row that is ~16s, in a pool of 4 about ~4s.
python3 - "$W/state" <<'PY'
import json, os, sys
root = sys.argv[1]
json.dump({"audit": [{"at": "2026-01-01T00:00:00Z", "event": "test"}],
           "opencodeMessages": []},
          open(os.path.join(root, "snapshots", "audit.json"), "w"))
json.dump({"code": []}, open(os.path.join(root, "snapshots", "code.json"), "w"))
sessions = [{"id": "ses_%02d" % i, "export": {"info": {"id": "ses_%02d" % i},
                                               "messages": []}} for i in range(8)]
json.dump({"sessions": sessions}, open(os.path.join(root, "chats", "zen-panel.json"), "w"))
PY

# A session-state branch to clone from: a local bare repo, so the whole test
# runs without github.com.
git init -q --bare "$W/bare"
( cd "$W/state" && git init -q . \
  && git add -A \
  && git -c user.email=t@t -c user.name=t commit -qm init \
  && git branch -M session-state \
  && git push -q "$W/bare" session-state ) >/dev/null 2>&1

STATE="$W/cloned"
if ! git clone -q --depth 1 --filter=blob:limit=1m --branch session-state \
       "file://$W/bare" "$STATE" 2>/dev/null; then
  git clone -q --depth 1 --branch session-state "file://$W/bare" "$STATE"
fi

# ── 1 + 2: STATE_DIR is used, and audit.json is found under snapshots/ ──────
: > "$FAKE_LOG"
start=$(date +%s)
GH_TOKEN=x SESSION_STATE_URL="file://$W/bare" STATE_DIR="$STATE" \
  bash "$REPO/tools/restore_audit_code.sh" "$W/home/zen-panel" > "$W/out.log" 2>&1
rc=$?
pool=$(( $(date +%s) - start ))

if [ "$rc" = 0 ]; then ok "restore from a handed-over clone exits 0"
else bad "restore from a handed-over clone exited $rc"; tail -5 "$W/out.log"; fi

if [ -s "$W/home/zen-panel/audit.json" ]; then ok "audit.json restored"
else bad "audit.json missing"; fi

# The regression: this line used to look for <clone>/audit.json and fail on
# every start, leaving .zen-agent/audit.jsonl empty.
if [ -s "$W/home/zen-panel/.zen-agent/audit.jsonl" ]; then
  ok "audit.jsonl rebuilt from snapshots/audit.json"
else
  bad ".zen-agent/audit.jsonl not rebuilt (audit read from the wrong path)"
  grep -i "audit" "$W/out.log" | head -3
fi

imports=$(wc -l < "$FAKE_LOG" | tr -d ' ')
if [ "$imports" = "8" ]; then ok "all 8 sessions imported"
else bad "imported $imports of 8 sessions"; fi

# ── 3: the same import in one row has to be clearly slower ─────────────────
: > "$FAKE_LOG"
start=$(date +%s)
CHAT_IMPORT_JOBS=1 GH_TOKEN=x SESSION_STATE_URL="file://$W/bare" STATE_DIR="$STATE" \
  bash "$REPO/tools/restore_audit_code.sh" "$W/home/zen-panel" >/dev/null 2>&1
serial=$(( $(date +%s) - start ))

# 8 x 2s is 16s of sleeping; a pool of 4 cannot finish in under 8s, and if the
# pool were not working this would be the same number as the serial run.
if [ "$pool" -lt "$serial" ]; then
  ok "imports run in a pool: ${pool}s against ${serial}s one at a time"
else
  bad "imports did not get faster in a pool: ${pool}s vs ${serial}s"
fi

# ── 4: the bundle -> repo mapping, one walk instead of one per bundle ───────
# --all is the mode that used to walk $HOME once per bundle, running `git
# remote get-url` in every repository it passed. Skipped on Windows: os.walk
# hands back C:/... paths there, which the shell test then cannot stat, and
# that has nothing to do with the mapping under test.
if uname -s 2>/dev/null | grep -qiE 'mingw|msys|cygwin'; then
  echo "  skip - bundle mapping (POSIX paths only)"
else
  python3 - "$W/state" <<'PY'
import json, os, sys
root = sys.argv[1]
for name in ("apk-launcher", "comic2film"):
    json.dump({"sessions": []}, open(os.path.join(root, "chats", name + ".json"), "w"))
PY
  ( cd "$W/state" && git add -A \
    && git -c user.email=t@t -c user.name=t commit -qm bundles \
    && git push -q "$W/bare" session-state ) >/dev/null 2>&1
  STATE2="$W/cloned2"
  git clone -q --depth 1 --branch session-state "file://$W/bare" "$STATE2" 2>/dev/null
  # Two more bundles, and only one of them has a repo on this machine. The
  # second bundle is what the old per-bundle walk paid a whole extra pass of
  # $HOME for.
  out=$(CHAT_ALL_ROOT="$W/home" bash "$REPO/tools/restore-chats.sh" --all \
          --state "$STATE2" 2>&1 || true)
  if echo "$out" | grep -q "no local repo for comic2film"; then
    ok "a bundle with no repo is reported, not silently dropped"
  else
    bad "missing-repo bundle not reported"; echo "$out" | tail -4
  fi
  if echo "$out" | grep -q "done, 1 bundle(s) processed"; then
    ok "three bundles, one processed, one walk"
  else
    bad "unexpected --all result"; echo "$out" | tail -4
  fi
fi

echo
if [ "$fails" = 0 ]; then
  echo "restore-chats-test: all checks passed"
  exit 0
fi
echo "restore-chats-test: $fails check(s) failed"
exit 1
