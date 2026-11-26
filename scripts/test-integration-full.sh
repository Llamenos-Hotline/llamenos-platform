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

# Its OWN compose project. Merged with docker-compose.dev.yml the stack would
# otherwise take that file's `name: llamenos-dev` — the shared dev stack — so it
# ran on the dev Postgres volume, and the teardown's `down -v` deleted every
# checkout's database with it. It still publishes the dev ports, so the dev stack
# must be stopped first; that is checked below rather than discovered as a bind error.
PROJECT="llamenos-integration-full"
COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_BASE}" -f "${COMPOSE_DEV}")
# Not the dev cluster: `worktree-db.ts secure-shared` must never convert this one,
# whose app owns its database as the single `llamenos` role (#2705).
export LLAMENOS_PG_CLUSTER_NAME="${PROJECT}"
# And so its signal-notifier shares the app's database, as in production.
export SIGNAL_NOTIFIER_DATABASE=llamenos

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
    "${COMPOSE[@]}" down -v --remove-orphans || true
  else
    log "Skipping teardown (--no-teardown). Services still running."
  fi
}

# ── Main ──────────────────────────────────────────────────────
cd "${REPO_ROOT}"

# The base compose's `app` service mounts the ban-list and messaging-thread hash
# keys from these files and refuses to start without them; create development keys
# if absent (gitignored, never printed).
source "${SCRIPT_DIR}/lib/server-hash-keys.sh"
ensure_hash_key_files "${REPO_ROOT}/deploy/docker/secrets" 0444

if [[ -n "$(docker compose -p llamenos-dev ps -q 2>/dev/null)" ]]; then
  err "the dev stack (compose project llamenos-dev) is running and holds the ports this stack"
  err "publishes. Stop it first — 'docker compose -f deploy/docker/docker-compose.dev.yml stop' —"
  err "never 'down -v', which deletes every checkout's database."
  exit 1
fi

log "Starting ALL services (signal + telephony + inference profiles)..."
"${COMPOSE[@]}" \
  --profile signal \
  --profile telephony \
  --profile inference \
  up -d --wait --timeout "${TIMEOUT_SECONDS}"

log "All services healthy."

if [[ "${RUN_TESTS}" == "true" ]]; then
  # The server under test here is the containerised app, which uses its own
  # stack's `llamenos` database — point TestDB at that, not at this worktree's own.
  source "${SCRIPT_DIR}/lib/worktree-db.sh"
  worktree_db_export --shared

  log "Running backend BDD tests..."
  bun run test:backend:bdd ${BDD_TAGS:+--tags "${BDD_TAGS}"}

  log "Running worker integration tests..."
  bun run test:worker:integration

  log "All tests passed."
fi

teardown
