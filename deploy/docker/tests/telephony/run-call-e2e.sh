#!/usr/bin/env bash
# Drive a real SIP call through self-hosted Asterisk, end to end.
#
# Starts, in its own compose project: the app (the shipped image, built from
# this tree) with its own Postgres and RustFS, Asterisk (the hotline PBX, with
# no SIP trunk), the sip-bridge image, and a simulated PSTN carrier — all on
# one Docker network, as in production. Then runs asterisk-call.e2e.ts, which
# provisions a hub and the SIP trunk through the API, places calls from the
# carrier and asserts the worker and PBX state, and what the caller heard.
#
# Usage: deploy/docker/tests/telephony/run-call-e2e.sh [--keep] [playwright args…]
#   --keep          leave the containers running afterwards (for poking at them)
#   e.g. -g 'hears the prompt'  run only the scenarios matching a title
#   E2E_ARI_DEBUG=1 log every ARI event in the Asterisk container's output
#
# Needs: Docker. Nothing else: the stack shares no database, port or volume
# with the dev stack (docker-compose.dev.yml) beyond the PBX's SIP/ARI ports.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PORT="${E2E_WORKER_PORT:-3931}"
PROJECT=ll-telephony-e2e
KEEP=false
[[ "${1:-}" == "--keep" ]] && { KEEP=true; shift; }

export E2E_WORKER_PORT="$PORT"
export E2E_CARRIER_CONTAINER="$PROJECT-sip-carrier-1"
export E2E_ASTERISK_CONTAINER="$PROJECT-asterisk-1"
# The app reaches ARI and the bridge by their names on the compose network,
# exactly as in production.
export E2E_WORKER_ARI_URL=http://asterisk:8088
export E2E_WORKER_BRIDGE_URL=http://sip-bridge:3000
# Exercise the credential encoding: generated passwords contain + and /.
export ARI_PASSWORD="${ARI_PASSWORD:-e2e+ari/pass=$(openssl rand -hex 4)}"
export BRIDGE_SECRET="${BRIDGE_SECRET:-$(openssl rand -hex 32)}"
export HMAC_SECRET="$(openssl rand -hex 32)"
export SERVER_SECRET="$(openssl rand -hex 32)"
export ADMIN_PUBKEY="$(bun -e "import { seedHexToPubkey, ADMIN_SEED } from './tests/api-helpers'; console.log(seedHexToPubkey(ADMIN_SEED))")"
export TEST_HUB_URL="http://127.0.0.1:$PORT"

COMPOSE=(docker compose -p "$PROJECT"
  -f deploy/docker/docker-compose.dev.yml
  -f deploy/docker/tests/telephony/docker-compose.carrier.yml
  --profile telephony)

cleanup() {
  if [[ "$KEEP" == false ]]; then
    "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Always a fresh stack: credentials and secrets are generated per run, and
# Asterisk only reads the ARI password when it starts. Drop this project's own
# volumes — its database, and the astdb where a previous run's provisioned
# trunk lives — so the PBX starts with no trunk and the app with no hubs.
"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
# Compose claims the PBX ports itself; the app's host port is published by
# this project, so check it only once a stack kept by --keep is gone.
if ss -ltnH "( sport = :$PORT )" | grep -q .; then
  echo "port $PORT is already in use — set E2E_WORKER_PORT or stop whatever holds it" >&2
  exit 1
fi
docker volume rm -f "${PROJECT}_asterisk-db" "${PROJECT}_pgdata" "${PROJECT}_rustfsdata" >/dev/null
"${COMPOSE[@]}" up -d --build --wait app asterisk sip-carrier sip-bridge
if [[ -n "${E2E_ARI_DEBUG:-}" ]]; then
  # Log every ARI event sent to the bridge in the Asterisk container's output.
  docker exec "$PROJECT-asterisk-1" asterisk -rx "ari set debug llamenos on"
fi

status=0
bunx playwright test --config deploy/docker/tests/telephony/playwright.config.ts "$@" || status=$?

if [[ $status -ne 0 ]]; then
  for service in sip-bridge app; do
    echo "── $service ──" >&2; "${COMPOSE[@]}" logs --no-color --tail 80 "$service" >&2 || true
  done
fi
exit $status
