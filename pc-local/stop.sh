#!/usr/bin/env bash
# Stops the hub started by start.sh.
HUB_LOGS="$HOME/.npm-hub/logs"
if [ -f "$HUB_LOGS/zen-hub.pid" ]; then
  kill "$(cat "$HUB_LOGS/zen-hub.pid")" 2>/dev/null && echo "hub stopped" || echo "hub already dead"
  rm -f "$HUB_LOGS/zen-hub.pid"
else
  pkill -f "npm-hub/src/server" && echo "hub stopped" || echo "no hub running"
fi