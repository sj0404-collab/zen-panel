#!/usr/bin/env bash
# Start the OpenCode stack so a PHONE (or any device) on the same LAN can
# connect to it.
#
# Why this exists: `opencode serve` is started on 127.0.0.1 in the workflow,
# so its port (4096) is localhost-only and unreachable from a phone on the
# LAN. The gateway (agent/oc-gateway.js) binds 0.0.0.0 and proxies to the
# server, exposing ONE origin (UI + API) that is reachable on the network.
#
# UI mode:
#   OC_UI=web     (default) — the ORIGINAL OpenCode web SPA. `opencode serve`
#                  already serves it at /, so this is the real web UI.
#   OC_UI=mobile  — the lightweight one-file mobile chat (oc-mobile.html).
#
# Usage:
#   tools/oc_lan_start.sh                    # serve(localhost) + gateway(0.0.0.0), web UI
#   OC_UI=mobile tools/oc_lan_start.sh       # lightweight mobile chat instead
#   OC_LAN_PORT=4101 tools/oc_lan_start.sh   # custom gateway port
#   tools/oc_lan_stop.sh                     # stop both
#
# Then open the printed URL in a browser (original web) or paste it into the
# OpenCode Mobile <Client> (mobile). Do NOT use port 4096 — that is the
# localhost-only opencode serve.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/bin:$PATH"

SERVE_PORT="${OC_SERVE_PORT:-4096}"
GW_PORT="${OC_LAN_PORT:-4100}"
UI="${OC_UI:-web}"
if [ -n "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  export OPENCODE_SERVER_PASSWORD
fi

# Make any provided GitHub token available to the agent: it exports
# GITHUB_TOKEN/GH_TOKEN (which auto-registers GitHub providers in opencode) and
# configures git so the agent can clone/push the repo. Set ZEN_GH_TOKEN (or
# GITHUB_TOKEN/GH_TOKEN) before running.
if [ -n "${ZEN_GH_TOKEN:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}" ]; then
  bash "${HERE}/tools/oc_gh_auth.sh" 2>&1 | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' || true
fi

# If OC_REPO=owner/repo is given, work inside that repo: clone it (or reuse it)
# into OC_WORKSPACE (default $HERE/.zen-open/<repo>) and start the server from
# there, so the agent actually operates on your repository.
WORKSPACE_DIR="${OC_WORKSPACE:-$HERE}"
if [ -n "${OC_REPO:-}" ]; then
  REPO_NAME="$(echo "${OC_REPO}" | tr '/' '_')"
  WORKSPACE_DIR="${OC_WORKSPACE:-$HERE/.zen-open/${REPO_NAME}}"
  if [ ! -d "$WORKSPACE_DIR/.git" ]; then
    mkdir -p "$WORKSPACE_DIR"
    git clone -q --depth 1 "https://github.com/${OC_REPO}.git" "$WORKSPACE_DIR" \
      && echo "oc_lan_start: cloned ${OC_REPO} into ${WORKSPACE_DIR}" \
      || echo "oc_lan_start: clone failed; continuing in ${WORKSPACE_DIR}"
  else
    echo "oc_lan_start: using existing repo at ${WORKSPACE_DIR}"
  fi
fi
mkdir -p "$WORKSPACE_DIR" 2>/dev/null || true

# opencode serve: localhost only, we expose it through the gateway.
if curl -sf -o /dev/null -m 4 "http://127.0.0.1:${SERVE_PORT}/global/health" 2>/dev/null; then
  echo "opencode serve already up on :${SERVE_PORT}"
else
  echo "Starting opencode serve (127.0.0.1:${SERVE_PORT}, workdir ${WORKSPACE_DIR}) ..."
  (cd "${WORKSPACE_DIR}" && nohup opencode serve --port "${SERVE_PORT}" --hostname 127.0.0.1 --cors '*' \
    >/tmp/oc-serve.log 2>&1 & echo $! >/tmp/oc-serve.pid)
  # If the server was already running, record that it may not use our workdir.
  [ -s /tmp/oc-serve.pid ] || echo "$$" >/tmp/oc-serve.pid
fi

# oc-gateway: 0.0.0.0 so the phone can reach it on the LAN. Prefer an existing
# healthy gateway over starting a duplicate on a busy port.
if curl -sf -o /dev/null -m 3 "http://127.0.0.1:${GW_PORT}/" 2>/dev/null; then
  echo "oc-gateway already up on :${GW_PORT}"
else
  echo "Starting oc-gateway (0.0.0.0:${GW_PORT}, UI=${UI}) -> 127.0.0.1:${SERVE_PORT} ..."
  OC_PORT="${GW_PORT}" OC_UP_PORT="${SERVE_PORT}" OC_UI="${UI}" \
    nohup node "${HERE}/agent/oc-gateway.js" >/tmp/oc-gateway.log 2>&1 &
  echo $! >/tmp/oc-gateway.pid
fi

# Wait for both to answer.
for i in $(seq 1 20); do
  if curl -sf -o /dev/null -m 3 "http://127.0.0.1:${SERVE_PORT}/global/health" \
     && curl -sf -o /dev/null -m 3 "http://127.0.0.1:${GW_PORT}/"; then
    break
  fi
  sleep 1
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "${UI}" = "mobile" ]; then
  UI_LABEL="лёгкий мобильный чат"
else
  UI_LABEL="оригинальный веб OpenCode"
fi
echo
echo "=================================================================="
echo "  OpenCode (${UI_LABEL})"
echo "  ---------------------------------------------------------------"
echo "  Открой на устройстве в ТОЙ ЖЕ сети:"
echo "      http://${IP}:${GW_PORT}/"
echo "  НЕ используй порт ${SERVE_PORT} (opencode serve) — он слушает"
echo "  только 127.0.0.1 и по сети недоступен."
echo "  ---------------------------------------------------------------"
echo "  Остановить: tools/oc_lan_stop.sh"
echo "=================================================================="
if ! curl -sf -o /dev/null -m 3 "http://127.0.0.1:${GW_PORT}/" 2>/dev/null; then
  echo "::error:: oc-gateway не отвечает."; tail -20 /tmp/oc-gateway.log
fi
