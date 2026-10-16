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
# with the dev stack (docker-compose.dev.yml).
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
export E2E_APP_CONTAINER="$PROJECT-app-1"
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
# The X25519 HPKE recipient derived from the same seed — a different key from
# ADMIN_PUBKEY, and required whenever it is set (#1283).
export ADMIN_DECRYPTION_PUBKEY="$(bun -e "import { deriveAdminKeys } from './scripts/bootstrap-admin'; import { ADMIN_SEED } from './tests/api-helpers'; import { hexToBytes } from '@noble/hashes/utils.js'; console.log(deriveAdminKeys(hexToBytes(ADMIN_SEED)).decryptionPubkey)")"
export TEST_HUB_URL="http://127.0.0.1:$PORT"
# The client-facing ports belong to Kamailio, never Asterisk. Use isolated
# host ports so this suite can run beside a shared dev telephony profile.
export E2E_SIP_EDGE_PORT="${E2E_SIP_EDGE_PORT:-35060}"
export E2E_SIP_EDGE_TLS_PORT="${E2E_SIP_EDGE_TLS_PORT:-35061}"
export E2E_PBX_ARI_PORT="${E2E_PBX_ARI_PORT:-38088}"
export E2E_BRIDGE_PORT="${E2E_BRIDGE_PORT:-33200}"
export SIP_UDP_PORT="$E2E_SIP_EDGE_PORT"
export SIP_TCP_PORT="$E2E_SIP_EDGE_PORT"
export SIPS_PORT="$E2E_SIP_EDGE_TLS_PORT"
export E2E_ARI_REST_URL="http://127.0.0.1:$E2E_PBX_ARI_PORT/ari"
export E2E_BRIDGE_URL="http://127.0.0.1:$E2E_BRIDGE_PORT"

COMPOSE=(docker compose -p "$PROJECT"
  -f deploy/docker/docker-compose.dev.yml
  -f deploy/docker/tests/telephony/docker-compose.carrier.yml
  -f deploy/docker/tests/telephony/docker-compose.ports.yml
  --profile telephony)

cleanup() {
  if [[ "$KEEP" == false ]]; then
    "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Always a fresh stack: credentials and secrets are generated per run, and
# Asterisk only reads the ARI password when it starts. Drop this project's own
# volumes — its database, Asterisk astdb, and SIP edge certificate — so the PBX
# starts with no trunk and the app with no hubs.
"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
# Compose claims the edge and ARI ports itself; the app's host port is published
# by this project, so check it only once a stack kept by --keep is gone.
if ss -ltnH "( sport = :$PORT )" | grep -q .; then
  echo "port $PORT is already in use — set E2E_WORKER_PORT or stop whatever holds it" >&2
  exit 1
fi
docker volume rm -f "${PROJECT}_asterisk-db" "${PROJECT}_asterisk-keys" "${PROJECT}_kamailio-keys" "${PROJECT}_sip-tls-anchor" "${PROJECT}_pgdata" "${PROJECT}_rustfsdata" >/dev/null
"${COMPOSE[@]}" up -d --build --wait app asterisk kamailio sip-carrier sip-bridge
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
