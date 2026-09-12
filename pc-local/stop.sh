#!/usr/bin/env bash
# Stops the hub started by start.sh.
if [ -f /tmp/zen-hub.pid ]; then
  kill "$(cat /tmp/zen-hub.pid)" 2>/dev/null && echo "hub stopped" || echo "hub already dead"
  rm -f /tmp/zen-hub.pid
else
  pkill -f "npm-hub/src/server" && echo "hub stopped" || echo "no hub running"
fi
