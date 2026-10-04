#!/usr/bin/env bash
# Prove the per-volunteer SIP registrar against the real PBX, end to end.
#
# Boots the same stack as run-call-e2e.sh (app built from this tree, Postgres,
# RustFS, Asterisk, sip-bridge, simulated carrier) and runs
# asterisk-register.e2e.ts, which:
#   1. configures the Asterisk provider through the API,
#   2. fetches /api/telephony/sip-token as a volunteer and checks the issued
#      per-volunteer credential + time-limited TURN credentials,
#   3. REGISTERs over TCP against the live PBX with the issued credential
#      (200 OK), with a wrong password (401), and after account deletion (401),
#   4. checks the PJSIP objects exist in ARI before and are gone after.
#
# Usage: deploy/docker/tests/telephony/run-register-e2e.sh [--keep] [playwright args…]
#
# Needs: Docker. Nothing else.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PORT="${E2E_WORKER_PORT:-3932}"
PROJECT=ll-telephony-register-e2e
KEEP=false
[[ "${1:-}" == "--keep" ]] && { KEEP=true; shift; }

export E2E_WORKER_PORT="$PORT"
export E2E_ASTERISK_CONTAINER="$PROJECT-asterisk-1"
export E2E_APP_CONTAINER="$PROJECT-app-1"
export E2E_WORKER_ARI_URL=http://asterisk:8088
export E2E_WORKER_BRIDGE_URL=http://sip-bridge:3000
export TEST_HUB_URL="http://127.0.0.1:$PORT"
# The registrar machinery under test: an explicit master secret (the compose
# fallback to HMAC_SECRET is exercised by the unit suite), and a TURN secret
# so the e2e can verify the minted RFC 8489 credentials against it.
export SIP_REGISTRAR_SECRET="${SIP_REGISTRAR_SECRET:-registrar-e2e-$(openssl rand -hex 16)}"
export E2E_TURN_HOST="${E2E_TURN_HOST:-turn.example.org}"
export TURN_HOST="$E2E_TURN_HOST"
export E2E_TURN_SECRET="${E2E_TURN_SECRET:-$(openssl rand -hex 32)}"
export TURN_SECRET="$E2E_TURN_SECRET"
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
bunx playwright test --config deploy/docker/tests/telephony/playwright.config.ts asterisk-register.e2e.ts "$@" || status=$?

if [[ $status -ne 0 ]]; then
  for service in app asterisk; do
    echo "── $service ──" >&2; "${COMPOSE[@]}" logs --no-color --tail 80 "$service" >&2 || true
  done
fi
exit $status
