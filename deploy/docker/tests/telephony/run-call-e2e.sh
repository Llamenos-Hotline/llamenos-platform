#!/usr/bin/env bash
# Drive a real SIP call through self-hosted Asterisk, end to end.
#
# Starts, in its own compose project: Asterisk (the hotline PBX), the sip-bridge
# image, and a simulated PSTN carrier. Starts an isolated worker on its own port
# and database. Then runs asterisk-call.e2e.ts, which provisions a hub through
# the API, places a call from the carrier and asserts the worker and PBX state.
#
# Usage: deploy/docker/tests/telephony/run-call-e2e.sh [--keep]
#   --keep          leave the PBX containers running afterwards (for poking at them)
#   E2E_ARI_DEBUG=1 log every ARI event in the Asterisk container's output
#
# Needs: Docker, the dev Postgres/RustFS (docker-compose.dev.yml up -d), this
# worktree's own database (bun scripts/worktree-db.ts use-isolated && ensure),
# and the server crypto library (packages/crypto/dist/server).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PORT="${E2E_WORKER_PORT:-3931}"
PROJECT=ll-telephony-e2e
KEEP=false
[[ "${1:-}" == "--keep" ]] && KEEP=true

export E2E_WORKER_PORT="$PORT"
export E2E_CARRIER_CONTAINER="$PROJECT-sip-carrier-1"
# Exercise the credential encoding: generated passwords contain + and /.
export ARI_PASSWORD="${ARI_PASSWORD:-e2e+ari/pass=$(openssl rand -hex 4)}"
export BRIDGE_SECRET="${BRIDGE_SECRET:-$(openssl rand -hex 32)}"
export TEST_HUB_URL="http://127.0.0.1:$PORT"

COMPOSE=(docker compose -p "$PROJECT"
  -f deploy/docker/docker-compose.dev.yml
  -f deploy/docker/tests/telephony/docker-compose.carrier.yml
  --profile telephony)

# The PBX ports are claimed by compose itself (and a stack kept by --keep is
# reused); the worker port is ours to check.
if ss -ltnH "( sport = :$PORT )" | grep -q .; then
  echo "port $PORT is already in use — set E2E_WORKER_PORT or stop whatever holds it" >&2
  exit 1
fi

server_pgid=""
cleanup() {
  if [[ -n "$server_pgid" ]]; then
    kill -TERM -- "-$server_pgid" 2>/dev/null || true
  fi
  if [[ "$KEEP" == false ]]; then
    "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Always a fresh stack: credentials are generated per run, and Asterisk only
# reads the ARI password when it starts.
"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build --wait asterisk sip-carrier sip-bridge
if [[ -n "${E2E_ARI_DEBUG:-}" ]]; then
  # Log every ARI event sent to the bridge in the Asterisk container's output.
  docker exec "$PROJECT-asterisk-1" asterisk -rx "ari set debug llamenos on"
fi

# The worker, like scripts/dev-bun.sh but on its own port and database.
source scripts/lib/worktree-db.sh
PG_PASSWORD="${PG_PASSWORD:-dev}" worktree_db_export --ensure
admin_pubkey="$(bun -e "import { seedHexToPubkey, ADMIN_SEED } from './tests/api-helpers'; console.log(seedHexToPubkey(ADMIN_SEED))")"
log="$(mktemp -t llamenos-telephony-e2e-server.XXXXXX.log)"
PLATFORM=bun PORT="$PORT" PG_POOL_SIZE=10 ENVIRONMENT=development \
  ADMIN_PUBKEY="$admin_pubkey" HOTLINE_NAME="Llámenos (E2E)" \
  DEV_RESET_SECRET=test-reset-secret TRUST_PROXY_HEADERS=true \
  HMAC_SECRET="$(openssl rand -hex 32)" \
  SERVER_SECRET=0000000000000000000000000000000000000000000000000000000000000001 \
  STORAGE_ENDPOINT=http://localhost:9000 STORAGE_ACCESS_KEY=rustfsadmin \
  STORAGE_SECRET_KEY=rustfsadmin STORAGE_BUCKET=llamenos-files \
  setsid bun src/server/index.ts >"$log" 2>&1 &
server_pgid=$!
echo "worker log: $log"

for _ in $(seq 1 60); do
  curl -sf "$TEST_HUB_URL/api/health/ready" >/dev/null && break
  sleep 1
done
curl -sf "$TEST_HUB_URL/api/health/ready" >/dev/null || { echo "worker did not become ready" >&2; tail -40 "$log" >&2; exit 1; }

status=0
bunx playwright test --config deploy/docker/tests/telephony/playwright.config.ts || status=$?

if [[ $status -ne 0 ]]; then
  echo "── sip-bridge ──" >&2; "${COMPOSE[@]}" logs --no-color --tail 80 sip-bridge >&2 || true
  echo "── worker ──" >&2; tail -80 "$log" >&2
fi
exit $status
