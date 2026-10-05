#!/usr/bin/env bash
# Autopilot for the fork: commit, push, open a PR, merge it, come back to main.
#
# WHY THIS EXISTS
#   The agent works for hours while nobody is watching. Every step of shipping
#   used to be a step somebody had to be awake for: someone had to notice the
#   changes were done, commit them, push, wait for CI, and merge. The existing
#   autosave in agent.yml only did `git add -A && git push` onto the working
#   branch - durable, yes, but nothing ever reached main, so the next runner
#   started from main and did not see the day's work.
#
# WHAT IT DOES, every tick
#   1. If the tree is dirty: commit it (message from AUTOSHIP_MESSAGE or a
#      summary of what changed).
#   2. Push the working branch.
#   3. Open a PR into main if there is none for this branch.
#   4. Merge it once CI is green.
#   5. Return to main and pull, so the next change starts from the merged state.
#
# THE ONE RULE THAT MATTERS
#   Never merge red. Tests run first; a failing suite ends the tick with the
#   branch pushed but the PR left open. The user asked for hands-off, not for
#   hands-off into a broken main - a broken main is a bug that costs a whole
#   morning, which is exactly the loss this script exists to prevent.
#
# USAGE
#   auto-ship.sh --once     one full tick, then exit (tests use this)
#   auto-ship.sh            daemon: a tick every AUTOSHIP_INTERVAL seconds
#
# ENV
#   AUTOSHIP_INTERVAL       seconds between ticks        (default 120)
#   AUTOSHIP_TEST_CMD       test command, empty = npm test (the default below)
#   AUTOSHIP_INNER=1        set by this script when it runs the suite; guards
#                          against the suite running this script again
#   AUTOSHIP_BRANCH         working branch               (default: current)
#   AUTOSHIP_BASE           target branch for the PR      (default main)
#   AUTOSHIP_MESSAGE        commit message prefix
#   AUTOSHIP_NO_MERGE=1     push and open the PR, never merge
#   GH_TOKEN / GITHUB_TOKEN token for push and PR
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_LOGS="${HUB_LOGS:-$HOME/.npm-hub/logs}"
mkdir -p "$HUB_LOGS" 2>/dev/null || true
LOG="$HUB_LOGS/auto-ship.log"
log() { echo "[auto-ship $(date -u '+%H:%M:%S')] $*" | tee -a "$LOG" >&2; }

REPO="${AUTOSHIP_REPO:-$PWD}"
BASE="${AUTOSHIP_BASE:-main}"
BRANCH="${AUTOSHIP_BRANCH:-}"
INTERVAL="${AUTOSHIP_INTERVAL:-120}"
MESSAGE="${AUTOSHIP_MESSAGE:-}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

command -v git >/dev/null 2>&1 || { log "no git"; exit 1; }
cd "$REPO" || { log "no such repo: $REPO"; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { log "not a git repo: $REPO"; exit 1; }

# The work branch is never the base branch. Shipping straight to main would
# skip the one thing this script is built around: main must only ever receive
# something CI has seen. So if we are sitting on main, step onto a work branch
# and let the PR do the moving.
[ -n "$BRANCH" ] || BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "$BASE" ] || [ "$BRANCH" = "HEAD" ]; then
  BRANCH="${AUTOSHIP_WORK_BRANCH:-autoship}"
  if ! git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null 2>&1; then
    git checkout -q -b "$BRANCH" 2>/dev/null || true
  else
    git checkout -q "$BRANCH" 2>/dev/null || true
  fi
  log "working on $BRANCH (shipping to $BASE through a PR, never straight to it)"
fi

# gh is how the PR and the merge happen. Without it we can still commit and
# push, which is the part that must never be skipped.
# AUTOSHIP_GH=0 pretends gh is missing, which is also how the test suite checks
# the degraded path without removing gh from the machine.
HAS_GH=0
if [ "${AUTOSHIP_GH:-1}" != "0" ] && command -v gh >/dev/null 2>&1; then HAS_GH=1; fi

# ── tests ────────────────────────────────────────────────────────────────────
# Returns 0 green, 1 red, 2 "could not tell" (no test command, deps missing).
# 2 must NOT be read as green: an unrunnable suite is not a passing suite, and
# the difference is exactly the broken main this script is meant to prevent.
run_tests() {
  local cmd="${AUTOSHIP_TEST_CMD-}"
  if [ -z "$cmd" ]; then
    if [ -f "$REPO/tests/package.json" ] && [ -d "$REPO/tests/node_modules" ]; then
      cmd="npm test"
    else
      log "no test command and no installed deps: skipping"
      return 2
    fi
  fi
  # The suite now includes auto-ship-test.sh, which runs this script. Without
  # the guard the default "npm test" would call this script, which would call
  # the suite again - each level waiting on the level below it, until something
  # times out. One level of recursion is the design; two is a hang.
  if [ "${AUTOSHIP_INNER:-0}" = "1" ] && [ "$cmd" = "npm test" ]; then
    log "already inside the suite: not re-running npm test"
    return 2
  fi
  log "tests: $cmd"
  # The suites live in tests/, but a repo without that directory must not be
  # reported as a failing suite just because `cd` could not happen: that reads
  # as "red" on a green tree and stops every merge for no reason.
  local where="$REPO/tests"
  [ -d "$where" ] || where="$REPO"
  if ( cd "$where" && AUTOSHIP_INNER=1 eval "$cmd" ) >"$LOG.tests" 2>&1; then
    log "tests green"
    rm -f "$LOG.tests"
    return 0
  fi
  local bad
  bad="$(grep -Ei '[0-9]+ (failed|checks?, [1-9][0-9]* failed)|FAIL ' "$LOG.tests" 2>/dev/null | tail -3 | tr '\n' ' ')"
  log "tests RED: ${bad:-see $LOG.tests}"
  return 1
}

# ── commit ───────────────────────────────────────────────────────────────────
# Only tracked-intent files. `git add -A` in a repo that carries a build/ or a
# node_modules/ would commit hundreds of megabytes of output; the ignore file is
# the contract, and this is where it is honoured.
commit_changes() {
  [ -n "$(git status --porcelain)" ] || return 1
  local what summary
  what="$(git status --porcelain | wc -l | tr -d ' ')"
  summary="$(git status --porcelain | awk '{print $NF}' | head -6 | tr '\n' ' ')"
  git add -A || { log "git add failed"; return 1; }
  local msg="${MESSAGE:-agent $(date -u '+%Y-%m-%d %H:%M')}"
  [ -n "$MESSAGE" ] || msg="$msg

$what file(s): $summary"
  if git commit -q -m "$msg"; then
    log "committed $what file(s): $summary"
    return 0
  fi
  log "nothing to commit after add (ignored everything?)"
  return 1
}

push_branch() {
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    git push -q -u origin "$BRANCH" 2>&1 | tee -a "$LOG" && return 0
  fi
  git push -q -u origin "$BRANCH" 2>&1 | tee -a "$LOG"
}

# ── PR ───────────────────────────────────────────────────────────────────────
pr_number() { gh pr list --head "$BRANCH" --base "$BASE" --state open \
                --json number --jq '.[0].number' 2>/dev/null; }

open_pr() {
  [ "$HAS_GH" = 1 ] || { log "no gh: cannot open a PR"; return 1; }
  if [ -n "$(pr_number)" ]; then return 0; fi
  local title body
  title="$(git log -1 --pretty=%s)"
  body="$(git log --pretty='- %s' "origin/$BASE..$BRANCH" 2>/dev/null | head -30)"
  if gh pr create --base "$BASE" --head "$BRANCH" \
      --title "$title" --body "$body" >>"$LOG" 2>&1; then
    log "PR opened into $BASE: $(pr_number)"
    return 0
  fi
  log "gh pr create failed (see $LOG)"
  return 1
}

# Green means the required checks are done and passing. `gh pr checks` exits 8
# when checks are still pending, non-zero on failure, 0 when all pass; the empty
# case (no checks configured) counts as green, otherwise nothing would ever
# merge on a repo without CI.
pr_green() {
  [ "$HAS_GH" = 1 ] || return 1
  local pr; pr="$(pr_number)"; [ -n "$pr" ] || return 1
  local state
  state="$(gh pr view "$pr" --json mergeable,reviewDecision,statusCheckRollup \
            --jq '[.mergeable, (.statusCheckRollup | if length == 0 then "none"
                      else ([.[] | select(.conclusion != "SUCCESS" and
                                          .conclusion != "NEUTRAL" and
                                          .conclusion != "SKIPPED")] | length)
                      | tostring + ":" + (if . == 0 then "green" else "notgreen" end)
                      end)] | join(" ")' 2>/dev/null)"
  case "$state" in
    *"MERGEABLE"*"notgreen"*) log "CI not green yet"; return 1 ;;
    *notgreen*) log "CI not green yet"; return 1 ;;
    *CONFLICTING*|*MERGEABLE=*UNKNOWN*) log "merge conflict"; return 1 ;;
    "") log "could not read PR state"; return 1 ;;
    *) return 0 ;;
  esac
}

merge_pr() {
  [ "$HAS_GH" = 1 ] || return 1
  local pr; pr="$(pr_number)"; [ -n "$pr" ] || return 1
  if gh pr merge "$pr" --squash --delete-branch >>"$LOG" 2>&1; then
    log "PR #$pr merged into $BASE"
    return 0
  fi
  log "merge failed for #$pr (see $LOG)"
  return 1
}

return_to_base() {
  # Off the branch is what we want: the next commit starts from what main now
  # contains, so the next PR is a diff of new work rather than a replay.
  git checkout -q "$BASE" 2>/dev/null || return 1
  git pull -q --ff-only origin "$BASE" >>"$LOG" 2>&1
}

tick() {
  git fetch -q origin "$BASE" 2>>"$LOG" || log "fetch failed (offline? will retry)"

  commit_changes || true
  [ -n "$(git status --porcelain --untracked-files=no)" ] && {
    log "still dirty after commit; skipping this tick"
    return 1
  }

  if ! push_branch; then
    log "push failed: keeping the commit local and retrying next tick"
    return 1
  fi

  # Not on base = there is something to propose. On base = nothing new yet.
  git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null 2>&1 || return 0
  if [ "$(git rev-list --count "origin/$BASE..$BRANCH" 2>/dev/null || echo 0)" = 0 ]; then
    return_to_base && log "up to date with $BASE"
    return 0
  fi

  # Tests run on every tick that has something to ship, before the PR gate, so a
  # red suite is on record even when gh is missing and no PR can be opened.
  local rc=0
  run_tests || rc=$?

  open_pr || return 1

  # rc=2 is "could not tell", not green. It happens when there is no test
  # command, no installed deps, or the suite is already running this script.
  # Merging on a verdict nobody produced is exactly the broken main this script
  # exists to prevent, so it blocks exactly like red does - only the reason in
  # the log differs.
  if [ "$rc" = 2 ]; then
    log "PR left open: no test verdict to merge on (is the suite installed?)"
    return 1
  fi
  if [ "$rc" = 1 ]; then
    log "PR left open: tests are red"
    return 1
  fi
  if [ "${AUTOSHIP_NO_MERGE:-0}" = "1" ]; then
    log "PR left open: AUTOSHIP_NO_MERGE=1"
    return 0
  fi
  pr_green || { log "PR left open until CI is green"; return 1; }
  merge_pr || return 1
  return_to_base
  log "merged and back on $BASE"
}

if [ "$ONCE" = 1 ]; then
  tick
  exit $?
fi

log "autopilot on $BRANCH -> $BASE every ${INTERVAL}s (tests: ${AUTOSHIP_TEST_CMD:-auto})"
while true; do
  tick || true
  sleep "$INTERVAL"
done