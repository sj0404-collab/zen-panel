#!/usr/bin/env bash
# Give the OpenCode agent real access to GitHub, authenticated by a token.
#
# What this does:
#   1. Exposes GITHUB_TOKEN / GH_TOKEN so `opencode serve` auto-registers the
#      GitHub providers (GitHub Models, Copilot) — no manual login needed.
#   2. Configures git's http.extraheader so ANY `git clone/push/ls-remote`
#      against github.com authenticates with the token automatically, without
#      embedding it in every URL. This is what lets the agent clone, read,
#      write, push and open PRs on your repo.
#   3. Optionally clones the target repo into the session workspace so the
#      agent literally works on your repository (OC_REPO=owner/repo).
#
# Token source, in order of precedence: $ZEN_GH_TOKEN, then $GITHUB_TOKEN,
# then $GH_TOKEN. On a GitHub Actions runner, GITHUB_TOKEN is already set, so
# this is a no-op for that case unless you pass your own PAT via ZEN_GH_TOKEN.
#
# Usage (LAN):  export ZEN_GH_TOKEN=ghp_... ; tools/oc_gh_auth.sh
# Optional repo: OC_REPO=owner/repo tools/oc_gh_auth.sh [clone-into-workspace]
#
# Safe to run repeatedly; it only writes git config in ~/.gitconfig and prints
# where the token went. It never echoes the token.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/bin:$PATH"

TOKEN="${ZEN_GH_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}"
if [ -z "$TOKEN" ]; then
  echo "oc_gh_auth: no token. Set ZEN_GH_TOKEN (or GITHUB_TOKEN / GH_TOKEN)."
  echo "  export ZEN_GH_TOKEN=ghp_xxxx"
  exit 1
fi

# 1) Export for the OpenCode server process (so providers auto-register).
export GITHUB_TOKEN="$TOKEN"
export GH_TOKEN="$TOKEN"

# 2) Git auth via http.extraheader (base64 basic; never stores the raw token).
B64="$(printf 'x-access-token:%s' "$TOKEN" | base64)"
git config --global --replace-all "http.https://github.com/.extraheader" "AUTHORIZATION: basic ${B64}"
git config --global --unset-all "credential.helper" 2>/dev/null || true

# 3) Optional: clone the repo into the session workspace so the agent works on it.
REPO="${OC_REPO:-}"
if [ -n "$REPO" ]; then
  TARGET="${2:-$HERE}"
  if [ -d "$TARGET/.git" ]; then
    echo "oc_gh_auth: $TARGET is already a git repo (no clone needed)."
  elif [ -d "$TARGET" ] && [ -z "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    git clone -q --depth 1 "https://github.com/${REPO}.git" "$TARGET" \
      && echo "oc_gh_auth: cloned ${REPO} into $TARGET" \
      || echo "oc_gh_auth: clone failed (see above)."
  else
    echo "oc_gh_auth: $TARGET is not empty and not a repo; leave it to the agent."
  fi
fi

echo "oc_gh_auth: GitHub token configured for OpenCode (providers + git auth)."
echo "  providers exposed: github-copilot (models) when the token has access."
