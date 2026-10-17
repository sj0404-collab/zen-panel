#!/usr/bin/env bash
# tools/localrun_keeper.sh with no network, no account and no ssh anywhere near
# the machine.
#
# What matters here, and what is actually verified:
#   - the leg needs no credential of any kind. That is the entire point of it,
#     so a test that could only pass with a secret would be testing the wrong
#     thing: the harness never sets a key, a password or a token for the tunnel
#     itself, and the address still has to arrive.
#   - it refuses to half-start. No GitHub token or no ssh client must each end
#     with a reason, never with a published address.
#   - a REACHABLE address is published as `lr=` inside the FULL descriptor
#     (url/url2/ngrok/tgg included), never as a partial write that would erase
#     another leg.
#   - the notice-page case is treated as dead: an address that answers with an
#     HTML notice instead of the app must not reach the panel.
#   - the downstream readers know about the key at all: publish_session.sh
#     carries it, the panel offers it as a door, the hub falls back to it for
#     the desk, the workflow starts the leg AND kills it on cleanup.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TOOLS="$REPO/tools"
TMP="$(mktemp -d)"
trap 'cd /; rm -rf "$TMP"' EXIT
pass=0; fail=0
check() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }

export HUB_LOGS="$TMP/logs"
mkdir -p "$HUB_LOGS"

# ── stubs (PATH prepend, never a PATH rewrite) ───────────────────────────────
# The keeper needs sh/grep/curl itself, and a stubs-only PATH breaks this
# harness too - so the directory is prepended.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/ssh" <<'STUB'
#!/usr/bin/env bash
# Pretends the remote forward succeeded and prints an address in the shape
# localhost.run actually uses. Records its own pid so the test can reap it: a
# leftover daemon holding the harness's stdout open makes the suite look hung.
echo "$$" > "$TS_TEST_SSH_PIDFILE"
echo "1.2.3.4 1.2.3.4:22"
echo "forwarding https://abc123.localhost.run -> localhost:${TS_TEST_PORT:-8090}" >&2
exec sleep 600
STUB
chmod +x "$TMP/bin/ssh"
export PATH="$TMP/bin:$PATH"

# The keeper reads its helper from LR_TOOLS_DIR, so a stub publish_session.sh
# (records argv) makes the publish observable without touching the real
# session-state branch.
mkdir -p "$TMP/faketools"
cp "$TOOLS/localrun_keeper.sh" "$TMP/faketools/"
cat > "$TMP/faketools/publish_session.sh" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do printf '%s\n' "$a"; done >> "$TS_TEST_PUBLISH_LOG"
exit 0
STUB
chmod +x "$TMP/faketools/publish_session.sh"

cleanup_ssh() {
  [ -f "$TMP/ssh.pid" ] && kill "$(tr -dc '0-9' < "$TMP/ssh.pid")" 2>/dev/null
  return 0
}
trap 'cleanup_ssh; cd /; rm -rf "$TMP"' EXIT

# ── 1. the gates ─────────────────────────────────────────────────────────────
run_gate() {  # run_gate <name> <expected-substring> [VAR=val ...]
  local name="$1" want="$2"; shift 2
  : > "$HUB_LOGS/localrun-keeper.log"
  env -u GITHUB_TOKEN "$@" bash "$TOOLS/localrun_keeper.sh" hub >"$TMP/out" 2>"$TMP/err"
  echo "$?" > "$TMP/rc"
  local blob
  blob="$(cat "$TMP/err" "$HUB_LOGS/localrun-keeper.log" 2>/dev/null)"
  check "$name" "$(printf '%s' "$blob" | grep -qi -- "$want" && echo 1 || echo 0)"
}

# No GitHub token -> the leg stays off instead of publishing nothing silently.
run_gate "no GitHub token keeps the leg off" "no GitHub token" \
  GH_TOKEN=
check "no GitHub token exits non-zero" "$([ "$(cat "$TMP/rc")" != 0 ] && echo 1 || echo 0)"

# A PATH with no ssh client must be refused with the reason, not by hanging.
: > "$HUB_LOGS/localrun-keeper.log"
env -u GITHUB_TOKEN PATH="/usr/bin:/bin" GH_TOKEN=ghp_fake \
  bash "$TOOLS/localrun_keeper.sh" hub >"$TMP/out" 2>"$TMP/err"
check "no ssh client keeps the leg off with the reason" \
  "$(cat "$TMP/err" "$HUB_LOGS/localrun-keeper.log" 2>/dev/null | grep -qi 'no ssh client' && echo 1 || echo 0)"

# ── 2. happy path: an address with no credential behind it ───────────────────
echo "https://main.trycloudflare.com" > "$HUB_LOGS/hub-url"
echo "https://reserve.trycloudflare.com" > "$HUB_LOGS/hub-url2"
echo "https://ngrok.example" > "$HUB_LOGS/hub-ngrok.url"
echo "https://tunnl.example" > "$HUB_LOGS/hub-tgg.url"
: > "$TMP/publish.log"

# The keeper's healthy() really curls the public address, so curl is stubbed -
# no test of a tunnel may depend on the public internet answering.
mkdir -p "$TMP/curl_ok"
cat > "$TMP/curl_ok/curl" <<'STUB'
#!/usr/bin/env bash
# What the hub actually returns to an anonymous caller.
printf '%s' '{"success":false,"error":"unauthorized"}'
STUB
chmod +x "$TMP/curl_ok/curl"

env -u GITHUB_TOKEN \
PATH="$TMP/curl_ok:$PATH" \
GH_TOKEN=ghp_fake \
LR_TOOLS_DIR="$TMP/faketools" \
TS_TEST_PUBLISH_LOG="$TMP/publish.log" \
TS_TEST_SSH_PIDFILE="$TMP/ssh.pid" \
TS_TEST_PORT=8090 \
LR_KEEPER_INTERVAL=1 \
LR_KEEPER_COOLDOWN=1 \
  bash "$TMP/faketools/localrun_keeper.sh" hub >"$TMP/out2" 2>&1 &
KEEPER_PID=$!
for _ in $(seq 1 30); do
  grep -q 'lr=' "$TMP/publish.log" 2>/dev/null && break
  sleep 1
done
kill "$KEEPER_PID" 2>/dev/null || true
cleanup_ssh
wait "$KEEPER_PID" 2>/dev/null || true

PUB="$(cat "$TMP/publish.log" 2>/dev/null || true)"
check "an address with no credential is published as lr=" \
  "$(printf '%s' "$PUB" | grep -qx 'lr=https://abc123.localhost.run' && echo 1 || echo 0)"
check "the publish keeps the cloudflare main leg" \
  "$(printf '%s' "$PUB" | grep -qx 'url=https://main.trycloudflare.com' && echo 1 || echo 0)"
check "the publish keeps the cloudflare reserve leg" \
  "$(printf '%s' "$PUB" | grep -qx 'url2=https://reserve.trycloudflare.com' && echo 1 || echo 0)"
check "the publish keeps the ngrok leg" \
  "$(printf '%s' "$PUB" | grep -qx 'ngrok=https://ngrok.example' && echo 1 || echo 0)"
check "the publish keeps the tunnl.gg leg" \
  "$(printf '%s' "$PUB" | grep -qx 'tgg=https://tunnl.example' && echo 1 || echo 0)"
check "the desktop/mobile links are still sent" \
  "$(printf '%s' "$PUB" | grep -qx 'desktop=https://main.trycloudflare.com/d' && echo 1 || echo 0)"
check "the log says the tunnel came up" \
  "$(grep -q 'localhost.run tunnel up' "$HUB_LOGS/localrun-keeper.log" 2>/dev/null && echo 1 || echo 0)"

# ── 3. the notice-page address is never published ────────────────────────────
# Same setup, but the address is the service's HTML notice instead of the app.
# The keeper must refuse it, so nothing lands in the publish log.
: > "$TMP/publish2.log"
: > "$HUB_LOGS/localrun-keeper.log"
rm -f "$TMP/ssh.pid"
# The stub health target is the real keeper's healthy(): the address answers
# with the service's own HTML notice instead of the app.
mkdir -p "$TMP/curl_notice"
cat > "$TMP/curl_notice/curl" <<'STUB'
#!/usr/bin/env bash
cat <<'PAGE'
<html><body>Tunneling through localhost.run</body></html>
PAGE
STUB
chmod +x "$TMP/curl_notice/curl"
env -u GITHUB_TOKEN \
PATH="$TMP/curl_notice:$PATH" \
GH_TOKEN=ghp_fake \
LR_TOOLS_DIR="$TMP/faketools" \
TS_TEST_PUBLISH_LOG="$TMP/publish2.log" \
TS_TEST_SSH_PIDFILE="$TMP/ssh2.pid" \
TS_TEST_PORT=8090 \
LR_KEEPER_INTERVAL=1 \
LR_KEEPER_COOLDOWN=1 \
  bash "$TMP/faketools/localrun_keeper.sh" hub >"$TMP/out3" 2>&1 &
KEEPER_PID=$!
sleep 12
kill "$KEEPER_PID" 2>/dev/null || true
[ -f "$TMP/ssh2.pid" ] && kill "$(tr -dc '0-9' < "$TMP/ssh2.pid")" 2>/dev/null
wait "$KEEPER_PID" 2>/dev/null || true
check "a notice-page address is not published" \
  "$([ ! -s "$TMP/publish2.log" ] && echo 1 || echo 0)"
check "the notice-page case is logged" \
  "$(grep -q 'not usable yet' "$HUB_LOGS/localrun-keeper.log" 2>/dev/null && echo 1 || echo 0)"

# ── 4. the readers know about the key ────────────────────────────────────────
check "publish_session.sh carries lr over a foreign republish" \
  "$(grep -q "for key in ('url2', 'ngrok', 'tgg', 'lr')" "$TOOLS/publish_session.sh" && echo 1 || echo 0)"
check "the panel offers the lr door" \
  "$(grep -q 's && s.lr' "$REPO/hub/src/main/assets/hub/index.html" && echo 1 || echo 0)"
check "the panel treats lr as an address at all" \
  "$(grep -q 's.lr || s.ngrok' "$REPO/hub/src/main/assets/hub/index.html" && echo 1 || echo 0)"
check "the hub falls back to lr for the desktop" \
  "$(grep -q 'd.tgg || d.lr' "$REPO/npm-hub/src/server.js" && echo 1 || echo 0)"
check "the workflow starts the leg for the hub" \
  "$(grep -q 'localrun_keeper.sh" hub' "$REPO/.github/workflows/hub.yml" && echo 1 || echo 0)"
check "the workflow starts the leg for the desktop" \
  "$(grep -q 'localrun_keeper.sh" vnc' "$REPO/.github/workflows/hub.yml" && echo 1 || echo 0)"
check "the workflow kills the leg on cleanup (both jobs)" \
  "$([ "$(grep -c 'pkill -f "\[l\]ocalrun_keeper.sh"' "$REPO/.github/workflows/hub.yml")" -ge 2 ] && echo 1 || echo 0)"

echo "----"
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]