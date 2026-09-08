#!/usr/bin/env bash
# Stop the OpenCode LAN stack started by tools/oc_lan_start.sh.
set -u
for f in /tmp/oc-gateway.pid /tmp/oc-serve.pid; do
  if [ -f "$f" ]; then
    PID="$(cat "$f" 2>/dev/null || true)"
    if [ -n "${PID}" ]; then
      kill "${PID}" 2>/dev/null && echo "stopped pid ${PID} (${f})" || echo "pid ${PID} already gone (${f})"
    fi
    rm -f "$f"
  fi
done
echo "done."
