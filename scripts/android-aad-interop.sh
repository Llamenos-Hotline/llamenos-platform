#!/usr/bin/env bash
# Open, on a real Android build, an envelope a real server wrote.
#
# `apps/android/.../crypto/EnvelopeAadInteropTest.kt` cannot run in the normal
# suite: it needs the server to seal an inbound message to *this device's*
# X25519 key, which means the server has to be started with a pubkey the device
# only produces at runtime. So it runs in two instrumentation passes with a
# server restart between them, which is what this script orchestrates.
#
#   phase 1  device generates its keys, logs the X25519 pubkey
#   restart  server comes back with ADMIN_DECRYPTION_PUBKEY = that pubkey
#   phase 2  server writes an inbound message; the device opens it, then every
#            wrong AAD is tried and must fail
#
# Usage:  scripts/android-aad-interop.sh [-s <adb serial>] [-p <port>]
#
# Requires: a booted emulator or device, this worktree opted in to its own
# database (`bun scripts/worktree-db.ts use-isolated`) — never the shared
# `llamenos`, which is the operator's running server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERIAL="${ANDROID_SERIAL:-}"
PORT=3085
while getopts "s:p:" opt; do
  case "$opt" in
    s) SERIAL="$OPTARG" ;;
    p) PORT="$OPTARG" ;;
    *) echo "usage: $0 [-s serial] [-p port]" >&2; exit 2 ;;
  esac
done
if [[ -z "$SERIAL" ]]; then
  SERIAL="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
fi
[[ -n "$SERIAL" ]] || { echo "no adb device"; exit 1; }
export ANDROID_SERIAL="$SERIAL"

# A server already on this port is someone else's; never reuse it and never
# kill it. Picking a different port silently is how two runs end up talking to
# one database.
if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health/live" >/dev/null 2>&1; then
  echo "port ${PORT} is already serving — pass -p with a free port" >&2
  exit 1
fi

# Refuse the shared database outright.
if [[ "$(bun scripts/worktree-db.ts resolve 2>/dev/null | head -1)" == *"llamenos_wt_"* ]]; then
  :
else
  echo "this worktree is not on its own database — run: bun scripts/worktree-db.ts use-isolated" >&2
  exit 1
fi

# The dev simulation routes check `X-Test-Secret` against DEV_RESET_SECRET,
# which scripts/dev-bun.sh takes from this checkout's .env. A hardcoded
# "test-reset-secret" 404s against any checkout that set its own — and the 404
# is indistinguishable from the devGuard's, which cost #1277 a misdiagnosis.
# Read the configured value; never print it.
TEST_SECRET="test-reset-secret"
if [[ -f "$ROOT/.env" ]]; then
  env_secret="$(sed -n 's/^DEV_RESET_SECRET=//p' "$ROOT/.env" | tail -1 | tr -d '"'"'"'"')"
  [[ -n "$env_secret" ]] && TEST_SECRET="$env_secret"
fi

LOG_DIR="$(mktemp -d)"
SERVER_PGID=""

# `kill $!` only kills the bun shim; the server survives in its own group.
start_server() {
  local pubkey="${1:-}"
  local log="$LOG_DIR/server-${2:-boot}.log"
  if [[ -n "$pubkey" ]]; then
    ADMIN_DECRYPTION_PUBKEY="$pubkey" PORT="$PORT" DEV_ROUTES_ENABLED=true \
      setsid bash scripts/dev-bun.sh > "$log" 2>&1 &
  else
    PORT="$PORT" DEV_ROUTES_ENABLED=true setsid bash scripts/dev-bun.sh > "$log" 2>&1 &
  fi
  SERVER_PGID="$!"
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health/live" >/dev/null 2>&1; then
      echo "[harness] server up on ${PORT} (log: $log)"
      return 0
    fi
    sleep 1
  done
  echo "[harness] server did not come up; tail of $log:" >&2
  tail -40 "$log" >&2
  return 1
}

stop_server() {
  [[ -n "$SERVER_PGID" ]] || return 0
  kill -TERM -- "-$SERVER_PGID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/api/health/live" >/dev/null 2>&1 || return 0
    sleep 1
  done
  kill -KILL -- "-$SERVER_PGID" 2>/dev/null || true
}
trap 'stop_server' EXIT

INSTR="org.llamenos.hotline/org.llamenos.hotline.CucumberHiltRunner"
CLASS="org.llamenos.hotline.crypto.EnvelopeAadInteropTest"

run_phase() {
  local method="$1"
  adb shell am instrument -w \
    -e cucumberUseAndroidJUnitRunner true \
    -e class "${CLASS}#${method}" \
    -e testHubUrl "http://localhost:${PORT}" \
    -e testSecret "$TEST_SECRET" \
    "$INSTR" 2>&1 | tee "$LOG_DIR/${method}.txt"
  grep -q "^OK (" "$LOG_DIR/${method}.txt" || {
    echo "[harness] ${method} FAILED" >&2
    return 1
  }
}

echo "[harness] building APKs"
(cd apps/android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest -q)
# `apps/android/app/build.gradle.kts` relocates the build directory off this
# (ecryptfs) home, keyed by a digest of the checkout path. Globbing for it picks
# up every *other* worktree's output too, and installing one of those would test
# someone else's code — so derive this worktree's digest the same way Gradle does.
ANDROID_ROOT="$ROOT/apps/android"
DIGEST="$(printf %s "$ANDROID_ROOT" | sha256sum | cut -c1-8)"
APK_DIR="${ANDROID_BUILD_DIR:-${RUNNER_TEMP:-/tmp}/llamenos-android-build-$DIGEST/app}/outputs/apk"
[[ -f "$APK_DIR/debug/app-debug.apk" ]] || {
  echo "no app-debug.apk under $APK_DIR" >&2; exit 1; }
adb install -r -t "$APK_DIR/debug/app-debug.apk" >/dev/null
adb install -r -t "$APK_DIR/androidTest/debug/app-debug-androidTest.apk" >/dev/null
adb reverse "tcp:${PORT}" "tcp:${PORT}" >/dev/null

echo "[harness] phase 1 — publish the device pubkey"
start_server "" boot
run_phase phase1PublishDevicePubkey
PUBKEY="$(adb logcat -d -s EnvelopeAadInterop | sed -n 's/.*DEVICE_X25519_PUBKEY=\([0-9a-f]\{64\}\).*/\1/p' | tail -1)"
[[ -n "$PUBKEY" ]] || { echo "[harness] no pubkey in logcat" >&2; exit 1; }
echo "[harness] device X25519 pubkey: ${PUBKEY}"

echo "[harness] restarting the server sealed to that device"
stop_server
start_server "$PUBKEY" sealed

echo "[harness] phase 2 — round trip, then every wrong AAD"
run_phase phase2ServerEnvelopeOpensAndEveryWrongAadDoesNot
echo "[harness] PASS — logs in $LOG_DIR"
