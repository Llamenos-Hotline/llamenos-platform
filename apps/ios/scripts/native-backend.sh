#!/usr/bin/env bash
# Run the Llámenos backend natively on macOS, for the iOS XCUITest suite.
#
# Why this exists (#661): GitHub-hosted macOS runners have no Docker, so the
# compose-based .github/actions/bootstrap-backend exits 125 before a single
# test runs. The Mac mini used for local iOS work has no Docker either. This
# starts the same server the compose `app` service runs — same source, the
# same migration runner the Docker image uses (scripts/run-migrations.ts), the
# same dev-route gates as deploy/docker/docker-compose.test.yml — against a
# Homebrew PostgreSQL 17 (the major version compose pins).
#
# What it deliberately does NOT start, and why that is safe for this suite:
#   - S3 storage (RustFS). No iOS UI test uploads or downloads a file, and a
#     failed hub bucket provisioning is logged and non-fatal
#     (apps/worker/routes/hubs.ts). The server refuses to boot without storage
#     credentials but only connects on use, so they are set and pointed at a
#     port nothing listens on: any storage call fails loudly instead of
#     silently. A test that needs storage must add a real S3 service here.
#   - signal-notifier / sip-bridge sidecars. No iOS UI test exercises them.
#
# Usage (from the repo root):
#   apps/ios/scripts/native-backend.sh start   # returns once /api/health/live answers
#   apps/ios/scripts/native-backend.sh stop
#
# Requires Homebrew, bun (with `bun install` already run), and the server
# crypto library at packages/crypto/dist/server/libllamenos_core.dylib
# (packages/crypto/scripts/build-server.sh builds it).
#
# Environment:
#   NATIVE_BACKEND_PORT  HTTP port (default 3000 — BaseUITest's default TEST_HUB_URL)
#   NATIVE_BACKEND_PGPORT  PostgreSQL port (default 5432)
#   NATIVE_BACKEND_DIR   State directory: pgdata, logs, pid (default $RUNNER_TEMP or /tmp)
#   ADMIN_PUBKEY         Admin signing pubkey the server seeds (default: the CI test admin)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${NATIVE_BACKEND_PORT:-3000}"
PGPORT="${NATIVE_BACKEND_PGPORT:-5432}"
STATE_DIR="${NATIVE_BACKEND_DIR:-${RUNNER_TEMP:-/tmp}/llamenos-native-backend}"
PGDATA="$STATE_DIR/pgdata"
SERVER_LOG="$STATE_DIR/server.log"
SERVER_PID="$STATE_DIR/server.pid"
PG_FORMULA="postgresql@17"
CRYPTO_LIB="$ROOT/packages/crypto/dist/server/libllamenos_core.dylib"
DATABASE_URL="postgresql://llamenos@127.0.0.1:${PGPORT}/llamenos"
# Same value as TEST_ADMIN_PUBKEY in ci.yml / desktop-e2e.yml.
ADMIN_PUBKEY="${ADMIN_PUBKEY:-79215a4c04f08fcd817c6f820c87169beb8cddf96dfa590a1315556b78af9183}"

log() { echo "[native-backend] $*"; }
die() { echo "[native-backend] ERROR: $*" >&2; exit 1; }

pg_bin() {
  echo "$(brew --prefix "$PG_FORMULA")/bin"
}

port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

cmd_start() {
  [[ "$(uname -s)" == "Darwin" ]] || die "macOS only — on Linux use deploy/docker/docker-compose.dev.yml"
  [[ -f "$CRYPTO_LIB" ]] || die "missing $CRYPTO_LIB — run packages/crypto/scripts/build-server.sh"
  # Refuse an occupied port rather than health-checking someone else's server
  # and running the suite against the wrong database.
  port_in_use "$PORT" && die "port $PORT is already listening — stop that server or set NATIVE_BACKEND_PORT"
  port_in_use "$PGPORT" && die "port $PGPORT is already listening — stop that server or set NATIVE_BACKEND_PGPORT"

  mkdir -p "$STATE_DIR"

  if ! brew list --versions "$PG_FORMULA" >/dev/null 2>&1; then
    log "Installing $PG_FORMULA..."
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install "$PG_FORMULA"
  fi
  local bin
  bin="$(pg_bin)"

  if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    log "Initialising $PGDATA"
    "$bin/initdb" -D "$PGDATA" -U llamenos --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi
  log "Starting PostgreSQL on 127.0.0.1:$PGPORT"
  "$bin/pg_ctl" -D "$PGDATA" -l "$STATE_DIR/postgres.log" \
    -o "-p $PGPORT -k $STATE_DIR -c listen_addresses=127.0.0.1 -c max_connections=200" -w start
  if ! "$bin/psql" -h 127.0.0.1 -p "$PGPORT" -U llamenos -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = 'llamenos'" | grep -q 1; then
    "$bin/createdb" -h 127.0.0.1 -p "$PGPORT" -U llamenos llamenos
  fi

  log "Applying migrations"
  (cd "$ROOT" && DATABASE_URL="$DATABASE_URL" bun scripts/run-migrations.ts)

  log "Starting server on 127.0.0.1:$PORT (log: $SERVER_LOG)"
  # Env mirrors the compose `app` service under docker-compose.test.yml.
  (
    cd "$ROOT"
    export PLATFORM=bun
    export PORT
    export DATABASE_URL
    export PG_POOL_SIZE=10
    export ADMIN_PUBKEY
    export HOTLINE_NAME="Llámenos"
    export ENVIRONMENT=development
    export DEV_ROUTES_ENABLED=true
    export DEV_RESET_SECRET=test-reset-secret
    export TOKEN_MAX_AGE_MS=3600000
    export TRUST_PROXY_HEADERS=true
    HMAC_SECRET="$(openssl rand -hex 32)"
    export HMAC_SECRET
    export SERVER_SECRET=0000000000000000000000000000000000000000000000000000000000000001
    export LLAMENOS_CRYPTO_LIB="$CRYPTO_LIB"
    export STORAGE_ENDPOINT=http://127.0.0.1:9
    export STORAGE_ACCESS_KEY=ios-e2e-no-storage
    export STORAGE_SECRET_KEY=ios-e2e-no-storage
    export STORAGE_BUCKET=llamenos-files
    nohup bun src/server/index.ts >"$SERVER_LOG" 2>&1 &
    echo $! >"$SERVER_PID"
  )

  local pid
  pid="$(cat "$SERVER_PID")"
  for _ in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:$PORT/api/health/live" >/dev/null 2>&1; then
      log "Server is live (pid $pid)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$SERVER_LOG" >&2 || true
      die "server exited during startup"
    fi
    sleep 1
  done
  cat "$SERVER_LOG" >&2 || true
  die "server did not answer /api/health/live within 90s"
}

cmd_stop() {
  if [[ -f "$SERVER_PID" ]]; then
    local pid
    pid="$(cat "$SERVER_PID")"
    if kill -0 "$pid" 2>/dev/null; then
      log "Stopping server (pid $pid)"
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$SERVER_PID"
  fi
  if [[ -f "$PGDATA/postmaster.pid" ]]; then
    log "Stopping PostgreSQL"
    "$(pg_bin)/pg_ctl" -D "$PGDATA" -m fast -w stop || true
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  *) die "usage: $0 start|stop" ;;
esac
