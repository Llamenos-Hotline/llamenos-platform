#!/usr/bin/env bash
# Prove a call RINGS a volunteer's registered in-app endpoint, end to end.
#
# Boots the same stack as run-register-e2e.sh (app built from this tree,
# Postgres, RustFS, Asterisk, sip-bridge, simulated carrier) and runs
# asterisk-inapp-ring.e2e.ts, which:
#   1. provisions a hub, the SIP trunk and a volunteer who takes both phone
#      and in-app calls,
#   2. REGISTERs a minimal SIP UA with the credential /sip-token issued, and
#      waits for the PBX to report the endpoint online,
#   3. places a real call from the carrier and asserts the INVITE arrives at
#      the volunteer's AOR — at the receiving end, and in the PBX's own SIP
#      trace — alongside the phone leg, with the losing leg cancelled,
#   4. asserts the shift rule in-app: scheduled-but-not-clocked-in gets no
#      INVITE, and the same volunteer gets one once they clock in.
#
# Usage: deploy/docker/tests/telephony/run-inapp-ring-e2e.sh [--keep] [playwright args…]
#
# Needs: Docker. Nothing else.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PORT="${E2E_WORKER_PORT:-3933}"
PROJECT=ll-telephony-inapp-e2e
KEEP=false
[[ "${1:-}" == "--keep" ]] && { KEEP=true; shift; }

export E2E_WORKER_PORT="$PORT"
export E2E_ASTERISK_CONTAINER="$PROJECT-asterisk-1"
export E2E_CARRIER_CONTAINER="$PROJECT-sip-carrier-1"
export E2E_APP_CONTAINER="$PROJECT-app-1"
export E2E_WORKER_ARI_URL=http://asterisk:8088
# The shared dev telephony stack usually holds 5060/8088, so this stack
# publishes the PBX elsewhere (docker-compose.ports.yml) and the test is
# pointed at the same ports.
export E2E_PBX_SIP_PORT="${E2E_PBX_SIP_PORT:-35060}"
export E2E_PBX_TLS_PORT="${E2E_PBX_TLS_PORT:-35061}"
export E2E_PBX_ARI_PORT="${E2E_PBX_ARI_PORT:-38088}"
export E2E_BRIDGE_PORT="${E2E_BRIDGE_PORT:-33200}"
export E2E_PBX_PORT="$E2E_PBX_SIP_PORT"
export E2E_ARI_REST_URL="http://127.0.0.1:$E2E_PBX_ARI_PORT/ari"
export E2E_WORKER_BRIDGE_URL=http://sip-bridge:3000
export TEST_HUB_URL="http://127.0.0.1:$PORT"
export SIP_REGISTRAR_SECRET="${SIP_REGISTRAR_SECRET:-registrar-inapp-$(openssl rand -hex 16)}"
export ARI_PASSWORD="${ARI_PASSWORD:-e2e+ari/pass=$(openssl rand -hex 4)}"
export BRIDGE_SECRET="${BRIDGE_SECRET:-$(openssl rand -hex 32)}"
export HMAC_SECRET="$(openssl rand -hex 32)"
export SERVER_SECRET="$(openssl rand -hex 32)"
export STORAGE_ACCESS_KEY="${STORAGE_ACCESS_KEY:-rustfsadmin}"
export STORAGE_SECRET_KEY="${STORAGE_SECRET_KEY:-rustfsadmin}"
export ADMIN_PUBKEY="$(bun -e "import { seedHexToPubkey, ADMIN_SEED } from './tests/api-helpers'; console.log(seedHexToPubkey(ADMIN_SEED))")"
export ADMIN_DECRYPTION_PUBKEY="$(bun -e "import { deriveAdminKeys } from './scripts/bootstrap-admin'; import { ADMIN_SEED } from './tests/api-helpers'; import { hexToBytes } from '@noble/hashes/utils.js'; console.log(deriveAdminKeys(hexToBytes(ADMIN_SEED)).decryptionPubkey)")"

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

"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
if ss -ltnH "( sport = :$PORT )" | grep -q .; then
  echo "port $PORT is already in use — set E2E_WORKER_PORT or stop whatever holds it" >&2
  exit 1
fi
docker volume rm -f "${PROJECT}_asterisk-db" "${PROJECT}_pgdata" "${PROJECT}_rustfsdata" >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build --wait app asterisk sip-carrier sip-bridge

status=0
bunx playwright test --config deploy/docker/tests/telephony/playwright.config.ts asterisk-inapp-ring.e2e.ts "$@" || status=$?

if [[ $status -ne 0 ]]; then
  for service in app sip-bridge asterisk; do
    echo "── $service ──" >&2; "${COMPOSE[@]}" logs --no-color --tail 120 "$service" >&2 || true
  done
fi
exit $status
