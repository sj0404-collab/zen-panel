#!/usr/bin/env bash
# tools/auto-ship.sh against a local bare repo standing in for GitHub.
# No network. What is verified here is the behaviour that matters: it merges,
# it does not merge red, and it refuses to report green for a suite that never
# ran.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HERE/../tools"
TMP="$(mktemp -d)"
trap 'cd /; rm -rf "$TMP"' EXIT
pass=0; fail=0
check() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }

# ── a bare "origin" and a working clone ──────────────────────────────────────
git init -q --bare "$TMP/origin.git"
mkdir -p "$TMP/w"
git clone -q "$TMP/origin.git" "$TMP/w"
( cd "$TMP/w"
  git config user.email t@t; git config user.name t
  git checkout -q -b main 2>/dev/null || git checkout -q main
  echo base > base.txt; printf 'build/\nnode_modules/\n' > .gitignore
  git add -A; git commit -qm base; git push -q -u origin main )

export HUB_LOGS="$TMP/logs"
export AUTOSHIP_REPO="$TMP/w"
# No AUTOSHIP_BRANCH on purpose: the script must never ship straight to main.
# gh is absent in this sandbox too - it must degrade to commit+push and say so,
# rather than silently claiming a PR exists.
unset AUTOSHIP_BRANCH

# gh is pretended away with AUTOSHIP_GH=0. Rewriting PATH would have been the
# obvious way and it breaks the test itself: the script needs sh, grep, git and
# the rest, and a PATH with only those in it breaks this harness too.
export AUTOSHIP_GH=0

# ── 1. red suite: the change is still pushed and committed, nothing claims green
( cd "$TMP/w" && echo change >> base.txt && mkdir -p build node_modules && echo built > build/out.o && echo big > node_modules/pkg.js )
AUTOSHIP_TEST_CMD='sh -c "echo 3 passed, 1 failed; exit 1"' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "red tests still commit" "$([ "$(git -C "$TMP/w" rev-list --count HEAD)" -gt 1 ] && echo 1 || echo 0)"
check "the work is pushed to its branch, not to main" "$(git -C "$TMP/origin.git" rev-parse --verify -q autoship >/dev/null && echo 1 || echo 0)"
check "main was never pushed to directly" "$([ "$(git -C "$TMP/origin.git" rev-list --count main)" = 1 ] && echo 1 || echo 0)"
check "red run does not claim green" "$(grep -q 'tests RED' "$HUB_LOGS/auto-ship.log" && echo 1 || echo 0)"
check "build output is not committed" "$(git -C "$TMP/w" ls-files | grep -qv 'build/out.o' && echo 1 || echo 0)"
check "node_modules is not committed" "$(git -C "$TMP/w" ls-files | grep -qv 'node_modules' && echo 1 || echo 0)"

# ── 2. an unrunnable suite is not a passing suite ───────────────────────────
# AUTOSHIP_TEST_CMD pointing at a missing binary: exit code is 127, which is
# neither the green nor the red path, and must not be read as green.
: > "$HUB_LOGS/auto-ship.log"
( cd "$TMP/w" && echo more >> base.txt )
AUTOSHIP_TEST_CMD='definitely-not-a-command-xyz' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "missing test binary is not reported green" "$(grep -q 'tests RED' "$HUB_LOGS/auto-ship.log" && echo 1 || echo 0)"
check "missing test binary does not print tests green" "$(grep -q 'tests green' "$HUB_LOGS/auto-ship.log" && echo 0 || echo 1)"

# ── 3. green suite with no gh: commit+push happen, PR is honestly skipped ────
: > "$HUB_LOGS/auto-ship.log"
( cd "$TMP/w" && echo green-change >> base.txt )
AUTOSHIP_TEST_CMD='sh -c "echo 9 passed, 0 failed"' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "green suite passes" "$(grep -q 'tests green' "$HUB_LOGS/auto-ship.log" && echo 1 || echo 0)"
check "without gh it says so instead of faking a PR" "$(grep -q 'no gh: cannot open a PR' "$HUB_LOGS/auto-ship.log" && echo 1 || echo 0)"

# ── 4. the merge gate is what CI decides, not the local test run ─────────────
# A local suite that passes must NOT be enough to merge: pr_green is the gate,
# and it returns non-zero when it cannot read a green CI state. So no merge.
check "a green local suite alone cannot merge" "$(grep -q 'merged into' "$HUB_LOGS/auto-ship.log" && echo 0 || echo 1)"

# ── 5. a real gh, and CI green: the whole chain runs ─────────────────────────
# A stub gh on PATH records the calls, so the merge path is exercised without
# the network and without merging anything real.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "pr list")
    # No file = no PR yet, and it must print NOTHING. Echoing "[]" would look
    # like a non-empty PR number to the caller and the script would think a PR
    # already exists, so it would never create one.
    [ -f "$GH_STUB_PR" ] && cat "$GH_STUB_PR"; exit 0 ;;
  "pr view")
    echo '{"mergeable":"MERGEABLE"}'; exit 0 ;;
  "pr create")
    n=77; echo "$n" > "$GH_STUB_PR"; echo "https://example/pr/$n"; exit 0 ;;
  "pr merge")
    # A real squash-merge on the bare origin, not just a note in a file. Without
    # it main never moves, the work branch keeps diverging from it, and the
    # fixture starts failing for reasons that have nothing to do with the script.
    echo "merged $3" >> "$GH_STUB_CALLS"
    pr="$3"; base="main"
    head_sha=$(git -C "$GH_STUB_W" rev-parse "refs/remotes/origin/$base" 2>/dev/null)
    br_sha=$(git -C "$GH_STUB_W" rev-parse HEAD 2>/dev/null)
    if [ -n "$br_sha" ]; then
      ( cd "$GH_STUB_BARE" &&
        git update-ref "refs/heads/$base" "$br_sha" &&
        git symbolic-ref HEAD "refs/heads/$base" ) >/dev/null 2>&1
    fi
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/gh"
: > "$TMP/calls"
: > "$HUB_LOGS/auto-ship.log"
export AUTOSHIP_GH=1   # the stub gh on PATH is real for this case
( cd "$TMP/w" && echo ci-green >> base.txt )
# statusCheckRollup empty => a repo with no CI configured: green by default,
# otherwise a repo without workflows could never merge anything.
PATH="$TMP/bin:$PATH" GH_STUB_PR="$TMP/prnum" GH_STUB_CALLS="$TMP/calls" \
GH_STUB_W="$TMP/w" GH_STUB_BARE="$TMP/origin.git" \
AUTOSHIP_TEST_CMD='sh -c "echo 9 passed, 0 failed"' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "green CI merges the PR" "$(grep -q 'merged 77' "$TMP/calls" && echo 1 || echo 0)"
check "the no-gh cases really ran without gh" "$(grep -qc 'no gh: cannot open a PR' "$HUB_LOGS/auto-ship.log" >/dev/null && echo 0 || echo 1)"
check "it returns to main afterwards" "$([ "$(git -C "$TMP/w" rev-parse --abbrev-ref HEAD)" = main ] && echo 1 || echo 0)"

# ── 6. AUTOSHIP_NO_MERGE stops after the PR ─────────────────────────────────
: > "$TMP/calls"; : > "$HUB_LOGS/auto-ship.log"
export AUTOSHIP_GH=1   # the stub gh below is real for this case
( cd "$TMP/w" && echo no-merge >> base.txt )
PATH="$TMP/bin:$PATH" GH_STUB_PR="$TMP/prnum" GH_STUB_CALLS="$TMP/calls" \
GH_STUB_W="$TMP/w" GH_STUB_BARE="$TMP/origin.git" \
AUTOSHIP_NO_MERGE=1 AUTOSHIP_TEST_CMD='sh -c "echo 9 passed, 0 failed"' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "AUTOSHIP_NO_MERGE=1 never merges" "$(grep -q 'merged' "$TMP/calls" && echo 0 || echo 1)"

# ── 7. "no verdict" is not a green light ─────────────────────────────────────
# No suite installed: run_tests cannot produce a verdict. It must not merge,
# because merging on a verdict nobody produced is the broken main this script
# exists to prevent.
: > "$TMP/calls"; rm -f "$TMP/prnum"; : > "$HUB_LOGS/auto-ship.log"
( cd "$TMP/w" && echo no-verdict >> base.txt )
# An empty AUTOSHIP_TEST_CMD with no tests/ directory in the repo is exactly the
# "cannot tell" case; the log line is asserted too, so a future change that made
# this merge would have to also rewrite the log to keep passing.
PATH="$TMP/bin:$PATH" GH_STUB_PR="$TMP/prnum" GH_STUB_CALLS="$TMP/calls" \
GH_STUB_W="$TMP/w" GH_STUB_BARE="$TMP/origin.git" \
AUTOSHIP_TEST_CMD='' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
# A repo cloned from GitHub often has no local suite at all, and an autopilot
# that never merges for that reason is worse than useless - it is exactly what
# the user reported. So the verdict falls through to CI, which is the real gate.
check "no local suite still merges on a green CI" "$(grep -q 'merged 77' "$TMP/calls" && echo 1 || echo 0)"
check "and the log says what it merged on" "$(grep -q 'merge rests on CI/git state alone' "$HUB_LOGS/auto-ship.log" && echo 1 || echo 0)"

# AUTOSHIP_MERGE_UNVERIFIED=1 is the strict setting: with no local suite and no
# verdict from anywhere, refuse. The default is permissive on purpose, but the
# switch has to actually work or it is decoration.
: > "$TMP/calls"; rm -f "$TMP/prnum"
( cd "$TMP/w" && echo strict >> base.txt )
PATH="$TMP/bin:$PATH" GH_STUB_PR="$TMP/prnum" GH_STUB_CALLS="$TMP/calls" \
GH_STUB_W="$TMP/w" GH_STUB_BARE="$TMP/origin.git" \
AUTOSHIP_TEST_CMD='' AUTOSHIP_MERGE_UNVERIFIED=1 \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "AUTOSHIP_MERGE_UNVERIFIED=1 forbids the unverified merge" "$(grep -q 'merged' "$TMP/calls" && echo 0 || echo 1)"

# ── 8. a clean tree is a no-op, not a spurious commit ────────────────────────
# Counted on the work branch, and the tick is pinned to that same branch: the
# previous case left the repo on main, and a tick is allowed to move it, so
# counting HEAD across the two would compare different branches and fail for a
# reason that has nothing to do with committing.
before="$(git -C "$TMP/w" rev-list --count autoship)"
( cd "$TMP/w" && git checkout -q autoship )
AUTOSHIP_BRANCH=autoship AUTOSHIP_GH=0 \
AUTOSHIP_TEST_CMD='sh -c "echo 9 passed, 0 failed"' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "clean tree makes no commit" "$([ "$before" = "$(git -C "$TMP/w" rev-list --count autoship)" ] && echo 1 || echo 0)"
check "clean tree leaves nothing uncommitted" "$([ -z "$(git -C "$TMP/w" status --porcelain)" ] && echo 1 || echo 0)"

# ── 9. the base branch is this repo's own, not a guess ───────────────────────
# One of the user's own repositories is on `master`. A hardcoded `main` opens
# the PR into a branch that does not exist there, so the default branch is
# detected: origin/HEAD first, then gh, then whichever of main/master exists.
M="$(mktemp -d)"
git init -q --bare "$M/origin.git"
git clone -q "$M/origin.git" "$M/w" 2>/dev/null
( cd "$M/w"
  git config user.email t@t; git config user.name t
  git checkout -q -b master
  printf 'node_modules/\n' > .gitignore; echo hi > a.js
  git add -A; git commit -qm init; git push -q -u origin master )
: > "$M/calls"; : > "$M/prnum"
echo '// change' >> "$M/w/a.js"
PATH="$TMP/bin:$PATH" GH_STUB_PR="$M/prnum" GH_STUB_CALLS="$M/calls" \
HUB_LOGS="$M/logs" AUTOSHIP_REPO="$M/w" AUTOSHIP_GH=1 AUTOSHIP_TEST_CMD='' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "a master repo is shipped to master, not main" "$(grep -q 'merged 77' "$M/calls" && echo 1 || echo 0)"
check "the PR names master as its base" "$(grep -q 'PR opened into master' "$M/logs/auto-ship.log" && echo 1 || echo 0)"
check "and the script ends up back on master" "$([ "$(git -C "$M/w" rev-parse --abbrev-ref HEAD)" = master ] && echo 1 || echo 0)"
rm -rf "$M"

# ── 10. the first push of a brand-new branch still opens a PR ────────────────
# This is the bug the user actually reported: the tick used to ask whether
# refs/remotes/origin/<branch> existed, and right after pushing a new branch it
# does not, so the tick returned quietly and no PR was ever opened. The
# repository looked alive and shipped nothing, run after run.
N="$(mktemp -d)"
git init -q --bare "$N/origin.git"
git clone -q "$N/origin.git" "$N/w" 2>/dev/null
( cd "$N/w"
  git config user.email t@t; git config user.name t
  git checkout -q -b main; echo hi > a.js; git add -A; git commit -qm init
  git push -q -u origin main )
: > "$N/calls"; : > "$N/prnum"
echo '// first ever push' >> "$N/w/a.js"
PATH="$TMP/bin:$PATH" GH_STUB_PR="$N/prnum" GH_STUB_CALLS="$N/calls" \
GH_STUB_W="$N/w" GH_STUB_BARE="$N/origin.git" \
HUB_LOGS="$N/logs" AUTOSHIP_REPO="$N/w" AUTOSHIP_GH=1 AUTOSHIP_TEST_CMD='' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "a brand-new branch still gets a PR" "$(grep -q 'merged 77' "$N/calls" && echo 1 || echo 0)"
check "the tick says what it was shipping" "$(grep -q 'commit(s) on autoship that main does not have' "$N/logs/auto-ship.log" && echo 1 || echo 0)"
rm -rf "$N"

# ── 11. a clone with no git identity can still commit ────────────────────────
# The clones the Files tab makes have no global git config on a runner, so every
# commit failed with "Author identity unknown", the tree stayed dirty and the
# tick skipped forever - looking perfectly healthy.
I="$(mktemp -d)"
git init -q --bare "$I/origin.git"
git clone -q "$I/origin.git" "$I/w" 2>/dev/null
( cd "$I/w"
  git config user.email t@t; git config user.name t
  git checkout -q -b main; echo hi > a.js; git add -A; git commit -qm init
  git push -q -u origin main
  # Now remove the identity, which is the state a real fresh clone is in.
  git config --unset user.name; git config --unset user.email )
echo '// work' >> "$I/w/a.js"
PATH="$TMP/bin:$PATH" GH_STUB_PR="$I/prnum" GH_STUB_CALLS="$I/calls" \
GH_STUB_W="$I/w" GH_STUB_BARE="$I/origin.git" \
HUB_LOGS="$I/logs" AUTOSHIP_REPO="$I/w" AUTOSHIP_GH=1 AUTOSHIP_TEST_CMD='' \
  bash "$TOOLS/auto-ship.sh" --once >/dev/null 2>&1
check "no git identity does not block the commit" "$(grep -q 'commit(s) on autoship' "$I/logs/auto-ship.log" && echo 1 || echo 0)"
check "and the author it picked is not raw env" "$(grep -qE 'set git identity for this repo: [^<]*[}\]][^ ]* <' "$I/logs/auto-ship.log" && echo 0 || echo 1)"
rm -rf "$I"

echo "auto-ship: $pass passed, $fail failed"
[ "$fail" = 0 ]