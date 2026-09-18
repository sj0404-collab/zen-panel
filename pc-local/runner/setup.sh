#!/usr/bin/env bash
# Registers this PC as a self-hosted GitHub Actions runner for the repo.
# Needs a one-time registration token: repo Settings -> Actions -> Runners ->
# New self-hosted runner (it is consumed by config.sh, not stored here).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$DIR/actions-runner"

REPO_URL="${REPO_URL:-}"
REG_TOKEN="${REG_TOKEN:-}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname)-zen}"
RUNNER_LABELS="${RUNNER_LABELS:-}"
RUNNER_VERSION="${RUNNER_VERSION:-}"

if [ -z "$REPO_URL" ] && git -C "$DIR/../.." rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  origin=$(git -C "$DIR/../.." config --get remote.origin.url || true)
  case "$origin" in
    git@github.com:*) REPO_URL="https://github.com/${origin#git@github.com:}" ;;
    https://github.com/*) REPO_URL="$origin" ;;
  esac
  REPO_URL="${REPO_URL%.git}"
fi
[ -n "$REPO_URL" ] || { read -r -p "Repo URL (https://github.com/owner/repo): " REPO_URL; }
[ -n "$REG_TOKEN" ] || { read -r -s -p "Registration token: " REG_TOKEN; echo; }
if [ -z "$RUNNER_VERSION" ]; then
  RUNNER_VERSION=$(curl -s "https://api.github.com/repos/actions/runner/releases/latest" \
    | grep -o '"tag_name": "v[^"]*"' | head -1 | grep -o '[0-9][0-9.]*' || true)
fi
[ -n "$RUNNER_VERSION" ] || { read -r -p "Runner version (e.g. 2.329.0, API unreachable): " RUNNER_VERSION; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PKG="actions-runner-linux-x64" ;;
  Linux-aarch64) PKG="actions-runner-linux-arm64" ;;
  Darwin-arm64) PKG="actions-runner-osx-arm64" ;;
  Darwin-x86_64) PKG="actions-runner-osx-x64" ;;
  *) echo "unsupported: $(uname -s)-$(uname -m) (Windows: use setup.bat)"; exit 1 ;;
esac

mkdir -p "$TARGET" && cd "$TARGET"
if [ ! -f "config.sh" ]; then
  echo "== downloading $PKG $RUNNER_VERSION =="
  curl -sSL -o runner.tgz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${PKG}-${RUNNER_VERSION}.tar.gz"
  tar xzf runner.tgz && rm runner.tgz
fi
echo "== configuring =="
LABELS_ARG=()
[ -n "$RUNNER_LABELS" ] && LABELS_ARG=(--labels "$RUNNER_LABELS")
./config.sh --unattended --replace --url "$REPO_URL" --token "$REG_TOKEN" --name "$RUNNER_NAME" "${LABELS_ARG[@]}"
echo "done."
echo "  run foreground: $TARGET/run.sh"
echo "  run as service: cd $TARGET && sudo ./svc.sh install && sudo ./svc.sh start"
echo "then pick 'self-hosted' in the panel's launch dialog."
