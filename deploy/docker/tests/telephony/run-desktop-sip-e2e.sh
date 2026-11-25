#!/usr/bin/env bash
# Tier 2 (spec §8): the desktop voice stack answers a REAL inbound call with
# two-way audio through our TURN relay — measured, not mocked (#1770).
#
#   carrier ──INVITE──▶ Kamailio ──▶ Asterisk ──▶ bridge ──▶ worker
#     worker: scheduled ∩ clocked-in → reachable at the PBX → /ring appTargets
#   Asterisk ──INVITE/TLS via Kamailio──▶ llamenos-voice (examples/sip_e2e)
#   llamenos-voice ──DTLS-SRTP over the TURN relay (forced)──▶ Asterisk
#
# What this does:
#   1. Boots the telephony stack (app built from this tree, Postgres, RustFS,
#      Kamailio's TLS edge on 127.0.0.1:5061, Asterisk, sip-bridge, simulated
#      carrier), then CoTURN with its relay on this stack's bridge gateway and
#      Asterisk as its ONE permitted peer.
#   2. Builds the headless client against the vendored, sha256-verified
#      liblinphone SDK (scripts/fetch-linphone-sdk.sh linux-x86_64).
#   3. Runs desktop-sip.e2e.ts, which provisions a hub + volunteer through the
#      API, fetches a REAL /api/telephony/sip-token, and:
#        - crash mode: registers, abort()s with no shutdown, and searches every
#          file under the client's HOME for the SIP password and TURN credential;
#        - answer mode: registers, clocks in, receives a real carrier call,
#          answers it, and measures audio BOTH ways — the caller's recording
#          of the client's tone, and the client's recording of the caller's —
#          plus the client's own RTP counters, the ICE pair type (relay), and
#          Asterisk's own SIP trace (DTLS-SRTP profile, a real fingerprint).
#
# Usage: deploy/docker/tests/telephony/run-desktop-sip-e2e.sh [--keep] [playwright args…]
#
# Needs: Docker, bun, a Rust toolchain, and the linux-x86_64 SDK — fetched from
# its pinned URL, or with LLAMENOS_LINPHONE_SDK_TARBALL=<path> installed from a
# local build through the same digest gate (see apps/desktop/linphone-sdk-checksums.txt).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

KEEP=false
[[ "${1:-}" == "--keep" ]] && { KEEP=true; shift; }

PROJECT=ll-desktop-sip-e2e
PORT="${E2E_WORKER_PORT:-3934}"
SIP_TLS_PORT=5061
EVIDENCE_DIR="${E2E_EVIDENCE_DIR:-$ROOT/.desktop-sip-evidence}"

export E2E_WORKER_PORT="$PORT"
export E2E_SIP_TLS_PORT="$SIP_TLS_PORT"
export SIP_TLS_SANS=127.0.0.1
export E2E_REGISTRAR_DOMAIN=127.0.0.1
export E2E_PBX_ARI_PORT="${E2E_PBX_ARI_PORT:-38089}"
export E2E_ARI_REST_URL="http://127.0.0.1:$E2E_PBX_ARI_PORT/ari"
export E2E_ASTERISK_CONTAINER="$PROJECT-asterisk-1"
export E2E_CARRIER_CONTAINER="$PROJECT-sip-carrier-1"
export E2E_KAMAILIO_CONTAINER="$PROJECT-kamailio-1"

export E2E_WORKER_ARI_URL=http://asterisk:8088
export E2E_WORKER_BRIDGE_URL=http://sip-bridge:3000
export E2E_EVIDENCE_DIR="$EVIDENCE_DIR"
export TEST_HUB_URL="http://127.0.0.1:$PORT"
export SIP_REGISTRAR_SECRET="${SIP_REGISTRAR_SECRET:-registrar-desktop-$(openssl rand -hex 16)}"
# The client reaches the relay on loopback; the relay's own address is set
# once the stack's network exists (below).
export TURN_HOST=127.0.0.1
export TURN_LISTENING_IP=127.0.0.1
export TURN_SECRET="${TURN_SECRET:-$(openssl rand -hex 32)}"
export TURN_REALM=127.0.0.1
export ARI_PASSWORD="${ARI_PASSWORD:-ari-$(openssl rand -hex 8)}"
export BRIDGE_SECRET="${BRIDGE_SECRET:-$(openssl rand -hex 32)}"
export HMAC_SECRET="$(openssl rand -hex 32)"
export SERVER_SECRET="$(openssl rand -hex 32)"
export SERVER_KEK="$(openssl rand -hex 32)"
# BAN_HASH_KEY and MESSAGING_HASH_KEY are secret files the app mounts, never env vars.
source "$ROOT/scripts/lib/server-hash-keys.sh"
ensure_hash_key_files "$ROOT/deploy/docker/secrets" 0444
export STORAGE_ACCESS_KEY="${STORAGE_ACCESS_KEY:-rustfsadmin}"
export STORAGE_SECRET_KEY="${STORAGE_SECRET_KEY:-rustfsadmin}"
export ADMIN_PUBKEY="$(bun -e "import { seedHexToPubkey, ADMIN_SEED } from './tests/api-helpers'; console.log(seedHexToPubkey(ADMIN_SEED))")"
export ADMIN_DECRYPTION_PUBKEY="$(bun -e "import { deriveAdminKeys } from './scripts/bootstrap-admin'; import { ADMIN_SEED } from './tests/api-helpers'; import { hexToBytes } from '@noble/hashes/utils.js'; console.log(deriveAdminKeys(hexToBytes(ADMIN_SEED)).decryptionPubkey)")"

COMPOSE=(docker compose -p "$PROJECT"
  -f deploy/docker/docker-compose.dev.yml
  -f deploy/docker/tests/telephony/docker-compose.carrier.yml
  -f deploy/docker/tests/telephony/docker-compose.desktop-sip.yml
  --profile telephony)

cleanup() {
  if [[ "$KEEP" == false ]]; then
    "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# This project's own stack first (a --keep run leaves it up), THEN the ports:
# anything still holding one is someone else's.
"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
for port in "$PORT" "$SIP_TLS_PORT" "$E2E_PBX_ARI_PORT" 3478; do
  if ss -lntuH "( sport = :$port )" | grep -q .; then
    echo "port $port is already in use — stop whatever holds it (a dev telephony stack?)" >&2
    exit 1
  fi
done

echo "── the client, against the pinned SDK ──────────────────────────────────"
if [[ -n "${LLAMENOS_LINPHONE_SDK_TARBALL:-}" ]]; then
  scripts/fetch-linphone-sdk.sh linux-x86_64 --local "$LLAMENOS_LINPHONE_SDK_TARBALL"
else
  scripts/fetch-linphone-sdk.sh linux-x86_64
fi
cargo build --manifest-path apps/desktop/Cargo.toml -p llamenos-voice --features e2e --example sip_e2e
export E2E_SIP_CLIENT="$ROOT/apps/desktop/target/debug/examples/sip_e2e"
export E2E_SIP_CLIENT_LIB="$ROOT/apps/desktop/vendor/linphone-sdk/linux-x86_64/lib"

echo "── booting the telephony stack ─────────────────────────────────────────"
mkdir -p "$EVIDENCE_DIR"
docker volume rm -f \
  "${PROJECT}_asterisk-db" "${PROJECT}_asterisk-keys" "${PROJECT}_kamailio-keys" "${PROJECT}_sip-tls-anchor" \
  "${PROJECT}_pgdata" "${PROJECT}_rustfsdata" >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build --wait app asterisk kamailio sip-carrier sip-bridge

# The relay: listening on loopback (where the client reaches it), relaying from
# this stack's bridge gateway (an address the host owns and Asterisk can
# answer), with Asterisk's container address as the one permitted peer — the
# shipped peer ACL otherwise denies every private range, as it should.
NETWORK="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$E2E_ASTERISK_CONTAINER")"
export TURN_RELAY_IP="$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK")"
export TURN_MEDIA_PEER_IP="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$E2E_ASTERISK_CONTAINER")"
echo "relay ip $TURN_RELAY_IP → permitted peer (Asterisk) $TURN_MEDIA_PEER_IP"
"${COMPOSE[@]}" up -d --wait coturn

status=0
bunx playwright test --config deploy/docker/tests/telephony/playwright.config.ts desktop-sip.e2e.ts "$@" || status=$?

docker logs "$PROJECT-coturn-1" >"$EVIDENCE_DIR/coturn.log" 2>&1 || true
if [[ $status -ne 0 ]]; then
  for service in app sip-bridge asterisk kamailio coturn; do
    echo "── $service ──" >&2; "${COMPOSE[@]}" logs --no-color --tail 80 "$service" >&2 || true
  done
fi
echo "Evidence: $EVIDENCE_DIR"
exit $status
