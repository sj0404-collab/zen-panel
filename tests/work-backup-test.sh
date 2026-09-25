#!/usr/bin/env bash
# Round-trip test for tools/backup-work.sh + tools/restore-work.sh, using a
# local bare repo as the "work-backup" remote. No network, no GitHub.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HERE/../tools"
TMP="$(mktemp -d)"
trap 'cd /; rm -rf "$TMP"' EXIT
pass=0; fail=0
check() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }

git init -q --bare "$TMP/remote.git"
mkdir -p "$TMP/home/proj/sub" "$TMP/home/loose"
( cd "$TMP/home/proj"
  git init -q; git config user.email t@t; git config user.name t
  echo base > committed.txt; printf 'build/\n' > .gitignore
  git add -A; git commit -qm base
  echo "wip change" >> committed.txt
  echo "staged" > newfile.txt; git add newfile.txt
  echo "untracked" > sub/scratch.txt
  echo "manifest" > MANIFEST.md
  mkdir -p build; echo junk > build/out.o )

echo "hello loose" > "$TMP/home/loose/note.txt"

REPO_COUNT=$(find "$TMP/home" -type d -name .git | wc -l | tr -d ' ')
CHAT_REPOS=$(CHAT_ALL_ROOT="$TMP/home" OPENCODE_DB="$TMP/missing.db" PUBLISH=0 bash "$TOOLS/export-chats.sh" --all 2>&1 | grep -c '^export-chats: --- ' || true)
check "chat export finds every repo" "$([ "$REPO_COUNT" = "$CHAT_REPOS" ] && echo 1 || echo 0)"

export SESSION_STATE_URL="$TMP/remote.git" WORK_BACKUP_ROOT="$TMP/home"
export WORK_BACKUP_STATE="$TMP/home/.npm-hub/work-backup-state" HUB_LOGS="$TMP/logs"
bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
check "snapshot published" "$([ -n "$(git -C "$TMP/remote.git" ls-tree -r --name-only work-backup)" ] && echo 1 || echo 0)"
check "manifest lists proj" "$(git -C "$TMP/remote.git" show work-backup:latest.json | grep -q '"rel": "proj"' && echo 1 || echo 0)"
before="$(git -C "$TMP/remote.git" rev-parse work-backup)"
sleep 1
bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
check "final once always publishes" "$([ "$before" != "$(git -C "$TMP/remote.git" rev-parse work-backup)" ] && echo 1 || echo 0)"

echo "second distinct edit" >> "$TMP/home/proj/committed.txt"
mkdir -p "$TMP/home/.npm-hub/sessions"
printf '%s\n' '{"id":"term_1","toolId":"opencode"}' > "$TMP/home/.npm-hub/sessions/npmhub-term_1.meta.json"
sleep 1
bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1

export WORK_BACKUP_KEEP=2
for i in 1 2 3; do
  sleep 1
  bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
done
check "prune keeps newest snapshots" "$([ "$(git -C "$TMP/remote.git" ls-tree -d --name-only work-backup snapshots/ | wc -l | tr -d ' ')" = 2 ] && echo 1 || echo 0)"
LATEST_STAMP=$(git -C "$TMP/remote.git" show work-backup:latest.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["stamp"])')
check "latest manifest points at a live snapshot" "$(git -C "$TMP/remote.git" cat-file -e "work-backup:snapshots/$LATEST_STAMP" 2>/dev/null && echo 1 || echo 0)"

echo "newer-run-marker" >> "$TMP/home/proj/committed.txt"
sleep 1
GITHUB_RUN_ID=300000 GITHUB_RUN_NUMBER=300000 bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1

# A file over the single-file cap is too big to be one git blob (GitHub
# refuses >100 MB), so it is split into chunks and glued back on restore. The
# caps are lowered to 1 MB here to keep the test quick, and this snapshot is
# the newest one, so it is the one restore-work.sh picks up.
dd if=/dev/urandom of="$TMP/home/loose/big.bin" bs=1M count=3 status=none
BIG_SHA="$(sha256sum "$TMP/home/loose/big.bin" | cut -d' ' -f1)"
sleep 1
WORK_BACKUP_MAX_FILE_MB=1 WORK_BACKUP_CHUNK_MB=1 GITHUB_RUN_ID=400 GITHUB_RUN_NUMBER=400000 bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
BIG_SNAP="$(git --git-dir="$TMP/remote.git" show work-backup:latest.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["stamp"])')"
check "big file published as chunks" "$([ "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only "work-backup:snapshots/$BIG_SNAP/big" | grep -c 'part\.')" -ge 3 ] && echo 1 || echo 0)"
check "big file manifest records the size" "$(git --git-dir="$TMP/remote.git" show "work-backup:snapshots/$BIG_SNAP/big/1/meta.json" | grep -q '"size": 3145728' && echo 1 || echo 0)"
check "latest manifest marks big files" "$(git --git-dir="$TMP/remote.git" show work-backup:latest.json | grep -q '"big": true' && echo 1 || echo 0)"

echo "older-run-marker" >> "$TMP/home/proj/committed.txt"
sleep 1
GITHUB_RUN_ID=100 GITHUB_RUN_NUMBER=10 bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1

rm -rf "$TMP/home/.npm-hub"
GITHUB_RUN_ID=200 GITHUB_RUN_NUMBER=20 bash "$TOOLS/publish_session.sh" slot=hub-linux state=live url=https://hub.example startedAt=2026-01-01T00:00:00Z >/dev/null 2>&1
check "session publish bootstraps staging" "$(git --git-dir="$TMP/remote.git" show session-state:session-hub-linux.json >/dev/null 2>&1 && echo 1 || echo 0)"
GITHUB_RUN_ID=200 GITHUB_RUN_NUMBER=20 bash "$TOOLS/publish_session.sh" slot=hub-linux state=live url=https://hub-new.example >/dev/null 2>&1
check "same run republish keeps startedAt" "$(git --git-dir="$TMP/remote.git" show session-state:session-hub-linux.json | grep -q '2026-01-01T00:00:00Z' && echo 1 || echo 0)"
GITHUB_RUN_ID=100 GITHUB_RUN_NUMBER=10 bash "$TOOLS/publish_session.sh" slot=hub-linux state=live url=https://hub-old.example >/dev/null 2>&1
check "older run cannot reclaim live session" "$(git --git-dir="$TMP/remote.git" show session-state:session-hub-linux.json | grep -q 'https://hub-new.example' && echo 1 || echo 0)"
GITHUB_RUN_ID=100 GITHUB_RUN_NUMBER=10 bash "$TOOLS/publish_session.sh" slot=hub-linux state=ended >/dev/null 2>&1
check "older run cannot end newer session" "$(git --git-dir="$TMP/remote.git" show session-state:session-hub-linux.json | grep -q '"state": "live"' && echo 1 || echo 0)"
GITHUB_RUN_ID=300 GITHUB_RUN_NUMBER=30 bash "$TOOLS/publish_session.sh" slot=hub-linux state=live url=https://hub-third.example >/dev/null 2>&1
check "newer run replaces live session" "$(git --git-dir="$TMP/remote.git" show session-state:session-hub-linux.json | grep -q 'https://hub-third.example' && echo 1 || echo 0)"

# Wipe and rebuild.
cd /
rm -rf "$TMP/home"; mkdir -p "$TMP/home"
bash "$TOOLS/restore-work.sh" >/dev/null 2>&1
check "committed content restored" "$(grep -q '^base$' "$TMP/home/proj/committed.txt" 2>/dev/null && echo 1 || echo 0)"
check "uncommitted change restored" "$(grep -q 'wip change' "$TMP/home/proj/committed.txt" 2>/dev/null && echo 1 || echo 0)"
check "untracked file restored" "$([ -f "$TMP/home/proj/sub/scratch.txt" ] && echo 1 || echo 0)"
check "manifest restored" "$([ -f "$TMP/home/proj/MANIFEST.md" ] && echo 1 || echo 0)"
check "latest content edit restored" "$(grep -q 'second distinct edit' "$TMP/home/proj/committed.txt" 2>/dev/null && echo 1 || echo 0)"
check "newer run backup survives old runner" "$(grep -q 'newer-run-marker' "$TMP/home/proj/committed.txt" 2>/dev/null && echo 1 || echo 0)"
check "older run cannot overwrite backup" "$(! grep -q 'older-run-marker' "$TMP/home/proj/committed.txt" 2>/dev/null && echo 1 || echo 0)"
check "session descriptor restored" "$([ -f "$TMP/home/.npm-hub/sessions/npmhub-term_1.meta.json" ] && echo 1 || echo 0)"
check "ignored file not restored" "$([ ! -f "$TMP/home/proj/build/out.o" ] && echo 1 || echo 0)"
check "loose file restored" "$([ -f "$TMP/home/loose/note.txt" ] && echo 1 || echo 0)"
check "chunked big file restored byte for byte" "$([ "$(sha256sum "$TMP/home/loose/big.bin" 2>/dev/null | cut -d' ' -f1)" = "$BIG_SHA" ] && echo 1 || echo 0)"

# A partial clone must not block restoring the real repository.
rm -rf "$TMP/home/proj"
mkdir -p "$TMP/home/proj"
echo partial > "$TMP/home/proj/partial.txt"
bash "$TOOLS/restore-work.sh" >/dev/null 2>&1
check "partial clone replaced" "$([ -f "$TMP/home/proj/committed.txt" ] && echo 1 || echo 0)"

# A repo that already exists must be left alone.
echo "newer local work" > "$TMP/home/proj/committed.txt"
bash "$TOOLS/restore-work.sh" >/dev/null 2>&1
check "existing repo untouched" "$(grep -q 'newer local work' "$TMP/home/proj/committed.txt" && echo 1 || echo 0)"

echo "work-backup: $pass passed, $fail failed"
[ "$fail" = 0 ]
