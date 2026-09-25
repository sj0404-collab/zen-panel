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
check "session publish bootstraps staging" "$(git --git-dir="$TMP/remote.git" show session-state:live/session-hub-linux.json >/dev/null 2>&1 && echo 1 || echo 0)"
GITHUB_RUN_ID=200 GITHUB_RUN_NUMBER=20 bash "$TOOLS/publish_session.sh" slot=hub-linux state=live url=https://hub-new.example >/dev/null 2>&1
check "same run republish keeps startedAt" "$(git --git-dir="$TMP/remote.git" show session-state:live/session-hub-linux.json | grep -q '2026-01-01T00:00:00Z' && echo 1 || echo 0)"
GITHUB_RUN_ID=100 GITHUB_RUN_NUMBER=10 bash "$TOOLS/publish_session.sh" slot=hub-linux state=live url=https://hub-old.example >/dev/null 2>&1
check "older run cannot reclaim live session" "$(git --git-dir="$TMP/remote.git" show session-state:live/session-hub-linux.json | grep -q 'https://hub-new.example' && echo 1 || echo 0)"
GITHUB_RUN_ID=100 GITHUB_RUN_NUMBER=10 bash "$TOOLS/publish_session.sh" slot=hub-linux state=ended >/dev/null 2>&1
check "older run cannot end newer session" "$(git --git-dir="$TMP/remote.git" show session-state:live/session-hub-linux.json | grep -q '"state": "live"' && echo 1 || echo 0)"
GITHUB_RUN_ID=300 GITHUB_RUN_NUMBER=30 bash "$TOOLS/publish_session.sh" slot=hub-linux state=live url=https://hub-third.example >/dev/null 2>&1
check "newer run replaces live session" "$(git --git-dir="$TMP/remote.git" show session-state:live/session-hub-linux.json | grep -q 'https://hub-third.example' && echo 1 || echo 0)"

# ── the branch is sorted into folders: live/, models/, snapshots/, history/ ──
check "live descriptor moved into live/" "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only session-state | grep -qx 'live/session-hub-linux.json' && echo 1 || echo 0)"
check "root is free of flat session files" "$([ "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only session-state | grep -c '^session-')" = 0 ] && echo 1 || echo 0)"
GITHUB_RUN_ID=300 GITHUB_RUN_NUMBER=30 bash "$TOOLS/publish_session.sh" slot=hub-linux file=models-hub-linux.json kind=NPM-Hub json=/dev/null >/dev/null 2>&1
check "models roster goes to models/" "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only session-state | grep -qx 'models/models-hub-linux.json' && echo 1 || echo 0)"
GITHUB_RUN_ID=300 GITHUB_RUN_NUMBER=30 bash "$TOOLS/publish_session.sh" file=audit.json json=/dev/null kind=snapshot-audit.json >/dev/null 2>&1
check "audit snapshot goes to snapshots/" "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only session-state | grep -qx 'snapshots/audit.json' && echo 1 || echo 0)"
GITHUB_RUN_ID=300 GITHUB_RUN_NUMBER=30 bash "$TOOLS/publish_session.sh" "file=saved/hub-linux-20260102T030405.json" json=/dev/null kind=save >/dev/null 2>&1
check "saved bundle is filed under its day" "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only session-state | grep -q '^history/2026-01-02/Fri/saved-hub-linux-20260102T030405.json$' && echo 1 || echo 0)"
GITHUB_RUN_ID=300 GITHUB_RUN_NUMBER=30 bash "$TOOLS/publish_session.sh" journal_date=2026-01-02 journal=1 slot=hub-linux kind=NPM-Hub os=linux conclusion=success handoff=false >/dev/null 2>&1
check "run journal lands in history by day" "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only session-state | grep -q '^history/2026-01-02/Fri/run-30.json$' && echo 1 || echo 0)"
check "run journal keeps the outcome" "$(git --git-dir="$TMP/remote.git" show session-state:history/2026-01-02/Fri/run-30.json | grep -q '"conclusion": "success"' && echo 1 || echo 0)"
check "stray file override is still refused" "$(GITHUB_RUN_ID=300 GITHUB_RUN_NUMBER=30 bash "$TOOLS/publish_session.sh" file=evil/payload.json >/dev/null 2>&1; [ $? -ne 0 ] && echo 1 || echo 0)"

# The one-time migration: a branch that still has the old flat layout must end
# up in the folders, with every file intact. Its own bare repo, so the pushed
# branch is exactly what this scenario builds.
git init -q --bare "$TMP/old.git"
OLD_CLONE="$TMP/old"
git clone -q "$TMP/old.git" "$OLD_CLONE" 2>/dev/null
cd "$OLD_CLONE"
# A hand-made flat branch, exactly as it looked before this change.
git checkout -q --orphan session-state
git rm -rqf . 2>/dev/null || true
mkdir -p saved
printf '{"state":"live","runId":"7","url":"https://old.example","startedAt":"2026-01-01T00:00:00Z"}\n' > session-hub-linux.json
printf '{"models":[]}\n' > models-hub-linux.json
printf '{"audit":[]}\n' > audit.json
printf '{"code":[]}\n' > code.json
printf '{"handoff":1}\n' > handoff.json
printf '{"saved":1}\n' > saved/hub-linux-20260101T101010.json
git add -A >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -q -m "old flat layout"
git push -q origin HEAD:session-state
SESSION_STATE_URL="$TMP/old.git" bash "$TOOLS/migrate_session_state.sh" >/dev/null 2>&1
check "migrated live descriptor" "$(git --git-dir="$TMP/old.git" ls-tree -r --name-only session-state | grep -qx 'live/session-hub-linux.json' && echo 1 || echo 0)"
check "migrated models + handoff" "$(git --git-dir="$TMP/old.git" ls-tree -r --name-only session-state | grep -qx 'models/models-hub-linux.json' && git --git-dir="$TMP/old.git" ls-tree -r --name-only session-state | grep -qx 'live/handoff.json' && echo 1 || echo 0)"
check "migrated audit and code" "$(git --git-dir="$TMP/old.git" ls-tree -r --name-only session-state | grep -qx 'snapshots/audit.json' && git --git-dir="$TMP/old.git" ls-tree -r --name-only session-state | grep -qx 'snapshots/code.json' && echo 1 || echo 0)"
check "migrated saved bundle by its day" "$(git --git-dir="$TMP/old.git" ls-tree -r --name-only session-state | grep -qx 'history/2026-01-01/Thu/saved-hub-linux-20260101T101010.json' && echo 1 || echo 0)"
check "migrated the old live url" "$(git --git-dir="$TMP/old.git" show session-state:live/session-hub-linux.json | grep -q 'https://old.example' && echo 1 || echo 0)"
check "no flat files left after the migration" "$([ "$(git --git-dir="$TMP/old.git" ls-tree -r --name-only session-state | grep -cE '^(session-|models-|audit|code|handoff|saved/)')" = 0 ] && echo 1 || echo 0)"
check "migration is idempotent" "$(SESSION_STATE_URL="$TMP/old.git" bash "$TOOLS/migrate_session_state.sh" >/dev/null 2>&1 && echo 1 || echo 0)"

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

# A build product in the tree is not the user's work: the APK, the Gradle
# build directories and the tool's own payload stay out of the snapshot, and
# the tool re-creates them on the next runner.
printf 'android apk payload\n' > /dev/null
dd if=/dev/urandom of="$TMP/home/bigcode/app-release.apk" bs=1M count=2 status=none
mkdir -p "$TMP/home/bigcode/app/build/outputs"
dd if=/dev/urandom of="$TMP/home/bigcode/app/build/outputs/apk/output.apk" bs=1M count=2 status=none

# ── A shallow clone has no usable bundle ───────────────────────────────
# The Files tab clones with --depth 1, and a restore clones shallow too. On
# such a repository `git bundle create --all` still writes a bundle - and it
# cannot be cloned ("Failed to traverse parents of commit ..."), so the repo was
# captured and then unrestorable. Measured on a live runner: both big
# repositories. Now the committed tree travels as an archive instead.
SHALLOW_SRC="$TMP/shallow-src"
git init -q "$SHALLOW_SRC"
(
  cd "$SHALLOW_SRC"
  git config user.email t@t; git config user.name t
  echo "first" > history.txt
  for i in 1 2 3; do echo "line $i" >> history.txt; git add -A; git commit -qm "c$i"; done
)
rm -rf "$TMP/home/shallow-code"
git clone -q --depth 1 "file://$SHALLOW_SRC" "$TMP/home/shallow-code" 2>/dev/null
echo "shallow edit" >> "$TMP/home/shallow-code/history.txt"
echo "shallow untracked" > "$TMP/home/shallow-code/scratch.txt"
sleep 1
GITHUB_RUN_ID=600 GITHUB_RUN_NUMBER=600000 WORK_BACKUP_KEEP=4 bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
# Find the snapshot that actually carries the shallow repository rather than
# trusting latest.json: several publishes happen in this test, and the point of
# the check is the content, not which run won.
SHALLOW_SNAP="$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only work-backup \
  | grep -E '^snapshots/[0-9]{8}T[0-9]{6}/repos/shallow-code/worktree\.tar\.gz$' \
  | sed 's|^snapshots/||; s|/repos/.*||' | LC_ALL=C sort -r | head -1)"
SHALLOW_META="$(git --git-dir="$TMP/remote.git" show "work-backup:snapshots/$SHALLOW_SNAP/repos/shallow-code/meta.json" 2>/dev/null)"
check "shallow repo is marked as such" "$(printf '%s' "$SHALLOW_META" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(1 if d.get("shallow") else 0)' 2>/dev/null || echo 0)"
check "build products stay out of the loose set" "$([ "$(git --git-dir="$TMP/remote.git" show "work-backup:snapshots/$SHALLOW_SNAP/tree.txt" 2>/dev/null | grep -c '\.apk')" = 0 ] && echo 1 || echo 0)"
check "shallow repo ships an archive, not a bundle" "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only "work-backup:snapshots/$SHALLOW_SNAP/repos/shallow-code" | grep -qx 'worktree.tar.gz' && [ -z "$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only "work-backup:snapshots/$SHALLOW_SNAP/repos/shallow-code" | grep 'repo.bundle')" ] && echo 1 || echo 0)"

# ── The oversized blob that broke the live backup ──────────────────────
# files.tar.gz and a big repo.bundle outgrew GitHub's 100 MB blob limit, so the
# whole snapshot was refused and the branch collected nothing but latest.json
# for two days. Everything over WORK_BACKUP_MAX_BLOB_MB is now split into
# blobs/<n>/part.NNN with a manifest, and restore glues it back.
dd if=/dev/urandom of="$TMP/home/loose/blob.bin" bs=1M count=3 status=none
sleep 1
WORK_BACKUP_MAX_BLOB_MB=1 WORK_BACKUP_CHUNK_MB=1 GITHUB_RUN_ID=700 GITHUB_RUN_NUMBER=700000 WORK_BACKUP_KEEP=4 \
  bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
SPLIT_SNAP="$(git --git-dir="$TMP/remote.git" show work-backup:latest.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["stamp"])')"
SPLIT_PARTS="$(git --git-dir="$TMP/remote.git" ls-tree -r --name-only "work-backup:snapshots/$SPLIT_SNAP/blobs" 2>/dev/null | grep -c 'part\.' || true)"
check "oversized snapshot files are split" "$([ "${SPLIT_PARTS:-0}" -ge 2 ] && echo 1 || echo 0)"
check "no oversized file is left in the snapshot" "$(git --git-dir="$TMP/remote.git" ls-tree -r -l "work-backup:snapshots/$SPLIT_SNAP" | awk '$4 > 2000000 && $4 != 0 {print $4, $5}' | wc -l | tr -d ' ' | grep -qx 0 && echo 1 || echo 0)"
check "the split manifest lists the file and its size" "$(git --git-dir="$TMP/remote.git" show "work-backup:snapshots/$SPLIT_SNAP/big-blobs.json" | python3 -c '
import json,sys
b=json.load(sys.stdin)["blobs"]
print(1 if b and b[0]["size"] > 0 and b[0]["sha256"] and b[0]["parts"] else 0)')"
check "the manifest reports the split count" "$(git --git-dir="$TMP/remote.git" show work-backup:latest.json | python3 -c '
import json,sys
print(1 if json.load(sys.stdin).get("blobs", 0) > 0 else 0)')"

# And the guard: a push that carries no snapshot must NOT pass for success.
git init -q --bare "$TMP/refuse.git"
cat > "$TMP/refuse.git/hooks/pre-receive" <<'HOOK'
#!/usr/bin/env bash
echo "remote: error: refusing this push" >&2
exit 1
HOOK
chmod +x "$TMP/refuse.git/hooks/pre-receive"
before_refuse="$(git --git-dir="$TMP/refuse.git" rev-parse --verify work-backup 2>/dev/null || echo none)"
SESSION_STATE_URL="$TMP/refuse.git" WORK_BACKUP_ROOT="$TMP/home" WORK_BACKUP_STATE="$TMP/home/.npm-hub/work-backup-state" \
  HUB_LOGS="$TMP/logs" bash "$TOOLS/backup-work.sh" --once >/dev/null 2>&1
refuse_rc=$?
after_refuse="$(git --git-dir="$TMP/refuse.git" rev-parse --verify work-backup 2>/dev/null || echo none)"
check "a refused publish is not reported as success" "$([ "$refuse_rc" -ne 0 ] && echo 1 || echo 0)"
check "a refused publish leaves latest.json alone" "$([ "$before_refuse" = "$after_refuse" ] && echo 1 || echo 0)"

# Wipe and rebuild: the split loose-file archive must come back byte for byte.
cd /
rm -rf "$TMP/home"; mkdir -p "$TMP/home"
bash "$TOOLS/restore-work.sh" >/dev/null 2>&1
restore_rc=$?
check "a complete restore exits cleanly" "$([ "$restore_rc" -eq 0 ] && echo 1 || echo 0)"
check "split snapshot restored and rebuilt" "$([ -f "$TMP/home/loose/blob.bin" ] && echo 1 || echo 0)"
check "shallow repo restored from its archive" "$([ -d "$TMP/home/shallow-code/.git" ] && echo 1 || echo 0)"
check "shallow repo committed content restored" "$(grep -q '^line 3$' "$TMP/home/shallow-code/history.txt" 2>/dev/null && echo 1 || echo 0)"
check "shallow repo uncommitted change restored" "$(grep -q 'shallow edit' "$TMP/home/shallow-code/history.txt" 2>/dev/null && echo 1 || echo 0)"
check "shallow repo untracked file restored" "$([ -f "$TMP/home/shallow-code/scratch.txt" ] && echo 1 || echo 0)"

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
