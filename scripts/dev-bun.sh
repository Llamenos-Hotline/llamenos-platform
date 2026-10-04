#!/usr/bin/env bash
# Local Bun development server
#
# Starts backing services (PostgreSQL, RustFS) via Docker Compose,
# then runs the server directly with Bun's --watch mode (single process).
#
# Usage:
#   ./scripts/dev-bun.sh          # Start everything
#   ./scripts/dev-bun.sh stop     # Stop backing services
#   ./scripts/dev-bun.sh logs     # Show Docker Compose logs
set -euo pipefail

COMPOSE_FILE="deploy/docker/docker-compose.dev.yml"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Source root .env for PG_PASSWORD, ADMIN_PUBKEY, and other config (skip comments and blanks)
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -v '^\s*#' "$PROJECT_DIR/.env" | grep -v '^\s*$')
  set +a
fi

source "$PROJECT_DIR/scripts/lib/worktree-db.sh"

COMPOSE="docker compose --project-directory $PROJECT_DIR -f $COMPOSE_FILE"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[dev:server]${NC} $*"; }
warn() { echo -e "${YELLOW}[dev:server]${NC} $*"; }

cmd_stop() {
  log "Stopping backing services..."
  $COMPOSE down
  log "Services stopped"
}

cmd_logs() {
  $COMPOSE logs -f
}

cmd_start() {
  # Ensure Docker Compose services are running
  if ! $COMPOSE ps --status running 2>/dev/null | grep -q postgres; then
    log "Starting backing services (PostgreSQL, RustFS)..."
    $COMPOSE up -d --wait
    log "Backing services ready"
  else
    log "Backing services already running"
  fi

  # Set environment variables for local development
  export PLATFORM=bun
  # Overridable so worktrees can each run a server against their own database
  # (then point the tests at it: TEST_HUB_URL and TEST_RELAY_URL).
  export PORT="${PORT:-3000}"
  # This worktree's own database (created / migrated here if needed), or an
  # explicit DATABASE_URL. scripts/test-backend-bdd.sh resolves it through the
  # same function, so the server and TestDB cannot end up on different databases.
  worktree_db_export --ensure
  # 10 = the app's own default (apps/worker/db/index.ts) and production's.
  # Not CI's 40: CI's Postgres serves one server, while this one serves every
  # worktree's server within max_connections=100. 5 wedged full BDD runs (#1264).
  export PG_POOL_SIZE="${PG_POOL_SIZE:-10}"
  # ADMIN_PUBKEY: use .env value if set (skips setup wizard); otherwise leave unset
  # so the admin bootstrap / setup wizard is exercisable in dev.
  [ -n "${ADMIN_PUBKEY:-}" ] && export ADMIN_PUBKEY
  # Required whenever ADMIN_PUBKEY is set: the server refuses to boot rather than
  # seal admin envelopes to the Ed25519 signing key, which succeeds and makes every
  # note permanently undecryptable (#1283). Defaults to the X25519 key derived from
  # the committed test seed so a .env carrying only the test ADMIN_PUBKEY still boots.
  if [ -n "${ADMIN_PUBKEY:-}" ]; then
    export ADMIN_DECRYPTION_PUBKEY="${ADMIN_DECRYPTION_PUBKEY:-27f9c3be4b64aa793509386bc20da41a1ce70df8f360d574f20035a17726a177}"
  fi
  export HOTLINE_NAME="${HOTLINE_NAME:-Llámenos (Dev)}"
  # ENVIRONMENT is required unconditionally by apps/worker/lib/config.ts and gates the
  # dev-only test-reset/test-promote-admin routes the admin bootstrap flow relies on —
  # it must always be set for local dev, regardless of whether ADMIN_PUBKEY is set.
  # needsBootstrap depends only on whether an admin exists in the DB, not on ENVIRONMENT,
  # so this does not affect whether the setup wizard is shown.
  export ENVIRONMENT="${ENVIRONMENT:-development}"
  export DEV_RESET_SECRET="${DEV_RESET_SECRET:-test-reset-secret}"
  # No real reverse proxy in front of local dev, but the backend BDD suite
  # simulates one (CF-Connecting-IP) to test per-client rate-limit buckets —
  # same trust posture as docker-compose.production.yml.
  export TRUST_PROXY_HEADERS="${TRUST_PROXY_HEADERS:-true}"
  if [ -z "${HMAC_SECRET:-}" ]; then
    warn "HMAC_SECRET not set. Generating random value for this session."
    export HMAC_SECRET=$(openssl rand -hex 32)
  fi
  export STORAGE_ENDPOINT=http://localhost:9000
  # Must match the RustFS container's actual credentials — docker-compose.dev.yml
  # takes these from the same root .env (RUSTFS_ACCESS_KEY: ${STORAGE_ACCESS_KEY:-rustfsadmin}),
  # so a hardcoded value here silently drifts from the container once .env sets one.
  export STORAGE_ACCESS_KEY="${STORAGE_ACCESS_KEY:-rustfsadmin}"
  export STORAGE_SECRET_KEY="${STORAGE_SECRET_KEY:-rustfsadmin}"
  export STORAGE_BUCKET=llamenos-files
  export SERVER_SECRET="${SERVER_SECRET:-0000000000000000000000000000000000000000000000000000000000000001}"

  log "Starting Bun server on http://localhost:${PORT}..."
  log "Bun watches source files directly — single process, no build step"
  log "Press Ctrl+C to stop"
  echo ""

  # Bun --watch restarts on any imported .ts file change
  exec bun --watch src/server/index.ts
}

ACTION="${1:-start}"
case "$ACTION" in
  start) cmd_start ;;
  stop)  cmd_stop ;;
  logs)  cmd_logs ;;
  *)
    echo "Usage: $0 {start|stop|logs}"
    exit 1
    ;;
esac
