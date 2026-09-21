#!/usr/bin/env bash
# Return success only when a public tunnel reaches the local service.
# Cloudflare can resolve a quick-tunnel hostname before a connector is ready;
# that page is HTTP 530 / Error 1033 and must not be treated as healthy.
set -uo pipefail

URL="${1:?usage: tunnel_health.sh <url> [path]}"
PATH_SUFFIX="${2:-/}"
case "$PATH_SUFFIX" in
  /*) ;;
  *) PATH_SUFFIX="/$PATH_SUFFIX" ;;
esac

TMP_DIR="${HUB_TMP:-${HOME:-/tmp}/.npm-hub/tmp}"
mkdir -p "$TMP_DIR" 2>/dev/null || TMP_DIR="${TMPDIR:-/tmp}"
BODY="$TMP_DIR/tunnel-probe.$$"
trap 'rm -f "$BODY"' EXIT

code=$(curl -sS -L --max-time "${TUNNEL_PROBE_TIMEOUT:-15}" \
  -A 'zen-panel-tunnel-health/1' -o "$BODY" -w '%{http_code}' \
  "${URL%/}${PATH_SUFFIX}" 2>/dev/null || true)

# A 401/403/404 proves that the request crossed the tunnel and reached the
# application. A 5xx, or a page mentioning 1033, means the connector is dead.
if grep -Eqi '(^|[^0-9])1033([^0-9]|$)|error[[:space:]]*code[[:space:]]*:[[:space:]]*1033' "$BODY" 2>/dev/null; then
  exit 1
fi
case "$code" in
  2*|3*|4*) exit 0 ;;
  *) exit 1 ;;
esac
