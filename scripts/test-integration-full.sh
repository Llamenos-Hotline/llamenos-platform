#!/usr/bin/env bash
# test-integration-full.sh
#
# Start ALL services for full integration testing, run the test suites,
# then tear everything down.
#
# Usage:
#   ./scripts/test-integration-full.sh [--help] [--no-teardown] [--skip-tests]
#
# Options:
#   --help         Print this message and exit without starting services
#   --no-teardown  Leave services running after tests (useful for debugging)
#   --skip-tests   Start services and verify health, but do not run test suites
#
# Environment:
#   COMPOSE_PROFILES   Additional profiles (default: signal telephony inference)
#   BDD_TAGS           Cucumber tag filter for BDD tests (default: all)
#   TIMEOUT_SECONDS    Seconds to wait for all services to become healthy (default: 120)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_BASE="${REPO_ROOT}/deploy/docker/docker-compose.yml"
COMPOSE_DEV="${REPO_ROOT}/deploy/docker/docker-compose.dev.yml"

TEARDOWN=true
RUN_TESTS=true
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-120}"

# ── Argument parsing ──────────────────────────────────────────
for arg in "$@"; do
  case "${arg}" in
    --help)
      sed -n '2,/^[^#]/{ /^#/s/^# \{0,1\}//p; /^[^#]/q }' "$0"
      exit 0
      ;;
    --no-teardown)
      TEARDOWN=false
      ;;
    --skip-tests)
      RUN_TESTS=false
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────
log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

teardown() {
  if [[ "${TEARDOWN}" == "true" ]]; then
    log "Tearing down services..."
    docker compose \
      -f "${COMPOSE_BASE}" \
      -f "${COMPOSE_DEV}" \
      down -v --remove-orphans || true
  else
    log "Skipping teardown (--no-teardown). Services still running."
  fi
}

# ── Main ──────────────────────────────────────────────────────
cd "${REPO_ROOT}"

log "Starting ALL services (signal + telephony + inference profiles)..."
docker compose \
  -f "${COMPOSE_BASE}" \
  -f "${COMPOSE_DEV}" \
  --profile signal \
  --profile telephony \
  --profile inference \
  up -d --wait --timeout "${TIMEOUT_SECONDS}"

log "All services healthy."

if [[ "${RUN_TESTS}" == "true" ]]; then
  # The server under test here is the containerised app, which always uses the
  # shared `llamenos` database — point TestDB at that, not at this worktree's own.
    source "${SCRIPT_DIR}/lib/worktree-db.sh"
  worktree_db_export --shared

  log "Running backend BDD tests..."
  bun run test:backend:bdd ${BDD_TAGS:+--tags "${BDD_TAGS}"}

  log "Running worker integration tests..."
  bun run test:worker:integration

  log "All tests passed."
fi

teardown
