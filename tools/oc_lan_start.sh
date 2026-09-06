#!/usr/bin/env bash
# Start the OpenCode stack so a PHONE on the same LAN can connect to it.
#
# Why this exists: `opencode serve` is started on 127.0.0.1 in the workflow,
# so its port (4096) is localhost-only and unreachable from the phone. The
# phone endpoint must be the oc-gateway (agent/oc-gateway.js), which binds
# 0.0.0.0 and serves the mobile chat at / while proxying the OpenCode API.
#
# Usage:
#   tools/oc_lan_start.sh            # starts serve (localhost) + gateway (0.0.0.0)
#   OC_LAN_PORT=4101 tools/oc_lan_start.sh   # custom gateway port
#   tools/oc_lan_stop.sh             # stop both
#
# Then in the OpenCode Mobile client, add a server with the GATEWAY URL:
#   http://<LAN-IP>:4100/
# Do NOT use port 4096 — that is the localhost-only opencode serve.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/bin:$PATH"

SERVE_PORT="${OC_SERVE_PORT:-4096}"
GW_PORT="${OC_LAN_PORT:-4100}"
if [ -n "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  export OPENCODE_SERVER_PASSWORD
fi

# opencode serve: localhost only, we expose it through the gateway.
if curl -sf -o /dev/null -m 4 "http://127.0.0.1:${SERVE_PORT}/global/health" 2>/dev/null; then
  echo "opencode serve already up on :${SERVE_PORT}"
else
  echo "Starting opencode serve (127.0.0.1:${SERVE_PORT}) ..."
  nohup opencode serve --port "${SERVE_PORT}" --hostname 127.0.0.1 --cors '*' \
    >/tmp/oc-serve.log 2>&1 &
  echo $! >/tmp/oc-serve.pid
fi

# oc-gateway: 0.0.0.0 so the phone can reach it on the LAN. Prefer an existing
# healthy gateway over starting a duplicate on a busy port.
if curl -sf -o /dev/null -m 3 "http://127.0.0.1:${GW_PORT}/" 2>/dev/null; then
  echo "oc-gateway already up on :${GW_PORT}"
else
  echo "Starting oc-gateway (0.0.0.0:${GW_PORT}) -> 127.0.0.1:${SERVE_PORT} ..."
  OC_PORT="${GW_PORT}" OC_UP_PORT="${SERVE_PORT}" \
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
echo
echo "================================================================"
echo "  OpenCode для телефона"
echo "  ------------------------------------------------------------"
echo "  Вставь ЭТОТ адрес в OpenCode Mobile <Client> (Добавить сервер):"
echo "      http://${IP}:${GW_PORT}/"
echo "  НЕ используй порт ${SERVE_PORT} (opencode serve) — он слушает"
echo "  только 127.0.0.1 и с телефона не доступен."
echo "  ------------------------------------------------------------"
echo "  Остановить: tools/oc_lan_stop.sh"
echo "================================================================"
if ! curl -sf -o /dev/null -m 3 "http://127.0.0.1:${GW_PORT}/" 2>/dev/null; then
  echo "::error:: oc-gateway не отвечает."; tail -20 /tmp/oc-gateway.log
fi
