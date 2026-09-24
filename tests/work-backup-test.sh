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

export SESSION_STATE_URL="$TMP/remote.git" WORK_BACKUP_ROOT="$TMP/home"
export WORK_BACKUP_STATE="$TMP/home/.npm-hub/work-backup-state" HUB_LOGS="$TMP/logs"
bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
check "snapshot published" "$([ -n "$(git -C "$TMP/remote.git" ls-tree -r --name-only work-backup)" ] && echo 1 || echo 0)"
check "manifest lists proj" "$(git -C "$TMP/remote.git" show work-backup:latest.json | grep -q '"rel": "proj"' && echo 1 || echo 0)"
# Idle run must not create another snapshot.
before="$(git -C "$TMP/remote.git" rev-parse work-backup)"
bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
check "idle run is a no-op" "$([ "$before" = "$(git -C "$TMP/remote.git" rev-parse work-backup)" ] && echo 1 || echo 0)"

rm -rf "$TMP/home/.npm-hub"
bash "$TOOLS/publish_session.sh" slot=hub-linux state=live url=https://hub.example >/dev/null 2>&1
check "session publish bootstraps staging" "$(git --git-dir="$TMP/remote.git" show session-state:session-hub-linux.json >/dev/null 2>&1 && echo 1 || echo 0)"

# Wipe and rebuild.
cd /
rm -rf "$TMP/home"; mkdir -p "$TMP/home"
bash "$TOOLS/restore-work.sh" >/dev/null 2>&1
check "committed content restored" "$(grep -q '^base$' "$TMP/home/proj/committed.txt" 2>/dev/null && echo 1 || echo 0)"
check "uncommitted change restored" "$(grep -q 'wip change' "$TMP/home/proj/committed.txt" 2>/dev/null && echo 1 || echo 0)"
check "untracked file restored" "$([ -f "$TMP/home/proj/sub/scratch.txt" ] && echo 1 || echo 0)"
check "manifest restored" "$([ -f "$TMP/home/proj/MANIFEST.md" ] && echo 1 || echo 0)"
check "ignored file not restored" "$([ ! -f "$TMP/home/proj/build/out.o" ] && echo 1 || echo 0)"
check "loose file restored" "$([ -f "$TMP/home/loose/note.txt" ] && echo 1 || echo 0)"

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
