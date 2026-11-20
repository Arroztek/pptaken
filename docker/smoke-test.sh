#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Smoke test for a PPTaken image. Runs one container with the same hardening as docker/compose.yaml (read-only root
# filesystem, tmpfs /tmp, all capabilities dropped, no-new-privileges, a throwaway named volume) and checks that it
# starts, reports healthy and serves the essentials. Uses no secrets: the owner password is generated for this run.
#
# Usage:   sh docker/smoke-test.sh IMAGE
# Example: sh docker/smoke-test.sh pptaken:local
# Needs:   docker and curl on the PATH (works in GitHub-hosted Linux runners and in Git Bash on Windows).
# Env:     SMOKE_PORT (default 18080; published on 127.0.0.1 only), SMOKE_TIMEOUT (seconds to wait for the
#          healthcheck, default 90).
# Exit:    0 when every check passes, 1 otherwise (2 for a usage or environment problem). The container and the
#          volume are always removed.

set -u

# Git Bash on Windows rewrites arguments that look like POSIX paths (/tmp, /data); keep them as they are.
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  echo "usage: sh docker/smoke-test.sh IMAGE" >&2
  exit 2
fi
for tool in docker curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "smoke test: '$tool' is required but was not found" >&2
    exit 2
  fi
done

PORT="${SMOKE_PORT:-18080}"
TIMEOUT="${SMOKE_TIMEOUT:-90}"
NAME="pptaken-smoke-$$"
VOLUME="pptaken-smoke-data-$$"
BASE="http://127.0.0.1:$PORT"
PASSED=0
FAILED=0

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm -f "$VOLUME" >/dev/null 2>&1
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

pass() {
  PASSED=$((PASSED + 1))
  echo "PASS  $1"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "FAIL  $1"
}

# expect_status LABEL URL EXPECTED_CODE
expect_status() {
  got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$2" 2>/dev/null)"
  if [ "$got" = "$3" ]; then pass "$1 (HTTP $got)"; else fail "$1 (expected HTTP $3, got ${got:-none})"; fi
}

# A throwaway password: random when the system offers it, otherwise derived from the clock and the process id.
PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24)"
if [ "${#PASSWORD}" -lt 16 ]; then
  PASSWORD="smoke-$$-$(date +%s)-throwaway-password"
fi

echo "== PPTaken smoke test: $IMAGE (container $NAME, $BASE)"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "smoke test: image '$IMAGE' not found locally (build or pull it first)" >&2
  exit 2
fi
if ! docker volume create "$VOLUME" >/dev/null; then
  echo "smoke test: could not create the temporary volume" >&2
  exit 2
fi

# The image's own HEALTHCHECK command is what is tested; only its timing is shortened so the run does not wait 30 s.
if ! docker run -d --name "$NAME" \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$VOLUME:/data" \
  -e "PPTAKEN_ADMIN_PASSWORD=$PASSWORD" \
  -e "PPTAKEN_PUBLIC_URL=$BASE" \
  -p "127.0.0.1:$PORT:8080" \
  --health-interval 2s --health-timeout 3s --health-start-period 2s --health-retries 5 \
  "$IMAGE" >/dev/null; then
  echo "FAIL  container starts"
  echo "SMOKE TEST FAILED"
  exit 1
fi

# Is a HEALTHCHECK defined at all?
if [ "$(docker image inspect -f '{{if .Config.Healthcheck}}yes{{end}}' "$IMAGE")" = "yes" ]; then
  pass "image defines a HEALTHCHECK"
else
  fail "image defines a HEALTHCHECK"
fi

# Wait for "healthy" (or give up when the container exits or the timeout is reached).
waited=0
health="starting"
while [ "$waited" -lt "$TIMEOUT" ]; do
  health="$(docker inspect -f '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}{{else}}exited{{end}}' "$NAME" 2>/dev/null)"
  case "$health" in
    healthy | exited | nohealth) break ;;
  esac
  sleep 2
  waited=$((waited + 2))
done
if [ "$health" = "healthy" ]; then
  pass "container becomes healthy (${waited}s)"
else
  fail "container becomes healthy (state: ${health:-unknown} after ${waited}s)"
  echo "---- container logs (last 40 lines) ----"
  docker logs --tail 40 "$NAME" 2>&1
  echo "----------------------------------------"
  echo "SMOKE TEST FAILED ($PASSED passed, $FAILED failed)"
  exit 1
fi

expect_status "/healthz" "$BASE/healthz" 200
expect_status "/_rt/qr.js" "$BASE/_rt/qr.js" 200
expect_status "/r" "$BASE/r" 200
expect_status "/p/sw.js" "$BASE/p/sw.js" 200

# WebSocket handshake on /ws. A valid upgrade answers 101 and then keeps the socket open, so curl is stopped by
# --max-time (its exit code is ignored) and only the status code matters. A foreign Origin must be refused.
ws_status() {
  curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 3 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: c21va2UtdGVzdC1rZXkxMg==' \
    -H "Origin: $1" "$BASE/ws" 2>/dev/null
}
got="$(ws_status "$BASE")"
if [ "$got" = "101" ]; then pass "WebSocket upgrade on /ws with the right Origin (HTTP 101)"; else fail "WebSocket upgrade on /ws with the right Origin (expected 101, got ${got:-none})"; fi
got="$(ws_status "http://attacker.invalid")"
if [ "$got" = "403" ]; then pass "WebSocket upgrade refused for a foreign Origin (HTTP 403)"; else fail "WebSocket upgrade refused for a foreign Origin (expected 403, got ${got:-none})"; fi

# Not root.
uid="$(docker exec "$NAME" id -u 2>/dev/null)"
if [ -n "$uid" ] && [ "$uid" != "0" ]; then pass "process runs as a non-root user (uid $uid)"; else fail "process runs as a non-root user (uid ${uid:-unknown})"; fi

# The data directory is writable, the root filesystem is not.
if docker exec "$NAME" sh -c 'touch /data/.smoke-write && rm -f /data/.smoke-write' >/dev/null 2>&1; then
  pass "/data is writable"
else
  fail "/data is writable"
fi
if docker exec "$NAME" sh -c 'touch /app/.smoke-write' >/dev/null 2>&1; then
  fail "root filesystem is read-only"
else
  pass "root filesystem is read-only"
fi

if [ "$FAILED" -eq 0 ]; then
  echo "SMOKE TEST PASSED ($PASSED checks)"
  exit 0
fi
echo "---- container logs (last 40 lines) ----"
docker logs --tail 40 "$NAME" 2>&1
echo "----------------------------------------"
echo "SMOKE TEST FAILED ($PASSED passed, $FAILED failed)"
exit 1
