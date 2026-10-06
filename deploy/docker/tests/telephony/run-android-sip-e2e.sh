#!/usr/bin/env bash
# Prove the Android SIP transport and media layer against a real PBX (#1188).
#
# Three defects, each only observable where liblinphone meets Asterisk:
#
#   1. TLS registration failed with `tlsv1 alert unknown ca` — no root CA on the
#      client, a self-signed certificate on the PBX.
#   2. The client mandated SRTP while the PJSIP endpoint is provisioned
#      `media_encryption: dtls` — nothing could negotiate.
#   3. `iceServers` was parsed and dropped — no STUN, no TURN, no natPolicy.
#
# What this does:
#   1. Boots the telephony stack (app, Postgres, RustFS, Asterisk + CoTURN +
#      simulated carrier), with Asterisk's TLS port on the host and its
#      certificate covering 10.0.2.2 — the emulator's alias for the host.
#   2. Enrols a volunteer through the API and fetches a REAL per-volunteer
#      credential from /api/telephony/sip-token (android-sip-params.e2e.ts).
#   3. Boots an emulator, installs the app, and runs LiveSipRegistrationTest:
#      the production LinphoneService registers over TLS with that credential
#      and places an INVITE at the harness's echo target.
#   4. Reads the evidence off ASTERISK'S OWN LOG: a 200 OK REGISTER on a TLS
#      transport, the SDP answer's agreed media encryption, and the ICE
#      candidates in the client's offer.
#
# Receiving-end evidence, not a client-side assertion — that is the whole point:
# every one of the three defects produced a client that believed it was
# configured correctly.
#
# Usage:
#   deploy/docker/tests/telephony/run-android-sip-e2e.sh [--keep] [--no-emulator]
#
#   --keep          leave the stack and emulator up afterwards
#   --no-emulator   use the device/emulator already on adb
#
# Needs: Docker, the Android SDK (ANDROID_HOME), an AVD, bun.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

KEEP=false
START_EMULATOR=true
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=true ;;
    --no-emulator) START_EMULATOR=false ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

PROJECT=ll-android-sip-e2e
PORT="${E2E_WORKER_PORT:-3933}"
SIP_TLS_PORT="${E2E_SIP_TLS_PORT:-5061}"
AVD="${E2E_AVD:-test-emu-0}"
EMULATOR_PORT="${E2E_EMULATOR_PORT:-5586}"
SERIAL="emulator-$EMULATOR_PORT"
APP_ID=org.llamenos.hotline
RUNNER="$APP_ID/org.llamenos.hotline.CucumberHiltRunner"
EVIDENCE_DIR="${E2E_EVIDENCE_DIR:-$ROOT/.android-sip-evidence}"
PARAMS_FILE="$EVIDENCE_DIR/sip-params.json"

# The emulator reaches the host, and only the host, at 10.0.2.2 — so that is the
# SIP domain, the TURN host, and a mandatory SAN on the PBX certificate (the
# client verifies the hostname as well as the chain).
EMULATOR_HOST_ALIAS=10.0.2.2

export E2E_WORKER_PORT="$PORT"
export E2E_SIP_TLS_PORT="$SIP_TLS_PORT"
export E2E_SIP_TLS_SANS="$EMULATOR_HOST_ALIAS"
export E2E_REGISTRAR_DOMAIN="$EMULATOR_HOST_ALIAS"
export E2E_SIP_PARAMS_FILE="$PARAMS_FILE"
export E2E_WORKER_ARI_URL=http://asterisk:8088
export E2E_WORKER_BRIDGE_URL=http://sip-bridge:3000
export TEST_HUB_URL="http://127.0.0.1:$PORT"
export SIP_REGISTRAR_SECRET="${SIP_REGISTRAR_SECRET:-registrar-$(openssl rand -hex 16)}"
export TURN_HOST="$EMULATOR_HOST_ALIAS"
export TURN_SECRET="${TURN_SECRET:-$(openssl rand -hex 32)}"
export TURN_REALM="$EMULATOR_HOST_ALIAS"
export ARI_PASSWORD="${ARI_PASSWORD:-ari-$(openssl rand -hex 8)}"
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
  -f deploy/docker/tests/telephony/docker-compose.android-sip.yml
  --profile telephony)

ASTERISK="$PROJECT-asterisk-1"
ASTERISK_LOG="$EVIDENCE_DIR/asterisk.log"

cleanup() {
  if [[ "$KEEP" == false ]]; then
    "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
    if [[ "$START_EMULATOR" == true ]]; then
      adb -s "$SERIAL" emu kill >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

mkdir -p "$EVIDENCE_DIR"
rm -f "$PARAMS_FILE" "$ASTERISK_LOG"

for port in "$PORT" "$SIP_TLS_PORT" 3478; do
  if ss -lntuH "( sport = :$port )" | grep -q .; then
    echo "port $port is already in use — stop whatever holds it (a dev telephony stack?)" >&2
    exit 1
  fi
done

echo "── booting the telephony stack ─────────────────────────────────────────"
"${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
docker volume rm -f \
  "${PROJECT}_asterisk-db" "${PROJECT}_asterisk-keys" "${PROJECT}_sip-tls-anchor" \
  "${PROJECT}_pgdata" "${PROJECT}_rustfsdata" >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build --wait app asterisk coturn sip-carrier sip-bridge

echo "── PBX TLS transport and certificate ───────────────────────────────────"
docker exec "$ASTERISK" asterisk -rx "pjsip show transports"
docker exec "$ASTERISK" sh -c \
  'openssl x509 -in /var/lib/asterisk/keys/asterisk.pem -noout -subject -ext subjectAltName'
# The anchor the app will publish — certificates only, never key material.
docker exec "$ASTERISK" sh -c 'grep -c "BEGIN CERTIFICATE" /var/lib/llamenos/sip-tls/asterisk.pem'
if docker exec "$ASTERISK" sh -c 'grep -q "PRIVATE KEY" /var/lib/llamenos/sip-tls/asterisk.pem'; then
  echo "FATAL: the published trust anchor contains a private key" >&2
  exit 1
fi

# Every SIP message in the log from here on: this is the receiving end.
docker exec "$ASTERISK" asterisk -rx "pjsip set logger on"

echo "── issuing a real per-volunteer credential ─────────────────────────────"
bunx playwright test \
  --config deploy/docker/tests/telephony/playwright.config.ts \
  android-sip-params.e2e.ts
test -s "$PARAMS_FILE" || { echo "no SIP params were written" >&2; exit 1; }

SIP_PARAMS_B64="$(base64 -w0 < "$PARAMS_FILE")"

if [[ "$START_EMULATOR" == true ]]; then
  echo "── booting the emulator ($AVD on port $EMULATOR_PORT) ──────────────────"
  "${ANDROID_HOME:?ANDROID_HOME is not set}/emulator/emulator" -avd "$AVD" \
    -port "$EMULATOR_PORT" -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -no-snapshot \
    >"$EVIDENCE_DIR/emulator.log" 2>&1 &
  adb -s "$SERIAL" wait-for-device
  until [[ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do
    sleep 3
  done
fi
adb -s "$SERIAL" wait-for-device

echo "── installing the app and its instrumentation ──────────────────────────"
(cd apps/android && ANDROID_SERIAL="$SERIAL" ./gradlew --console=plain \
  :app:installDebug :app:installDebugAndroidTest)

echo "── driving the production LinphoneService ──────────────────────────────"
status=0
adb -s "$SERIAL" shell am instrument -w \
  -e cucumberUseAndroidJUnitRunner true \
  -e class org.llamenos.hotline.telephony.LiveSipRegistrationTest \
  -e sipParamsB64 "$SIP_PARAMS_B64" \
  -e echoTarget e2eecho \
  "$RUNNER" 2>&1 | tee "$EVIDENCE_DIR/instrumentation.log" || status=$?
# `am instrument` exits 0 even when a test fails; the report is the only truth.
if grep -qE "^(FAILURES|Error in)" "$EVIDENCE_DIR/instrumentation.log"; then
  status=1
fi

adb -s "$SERIAL" logcat -d -s LinphoneService:* LiveSipRegistrationTest:* \
  >"$EVIDENCE_DIR/logcat.log" 2>&1 || true
# `docker logs`, not `compose logs`: the latter prefixes every line with
# "asterisk-1  | ", so nothing anchored with ^ can ever match — which silently
# zeroed the counts below the first time.
docker logs "$ASTERISK" >"$ASTERISK_LOG" 2>&1 || true
# Normalise the log to the SIP content itself: strip the colour escapes, the
# CRLF of SIP bodies, and Asterisk's own "[timestamp] " prefix — which it puts
# on EVERY line including SDP, so `^m=audio` could never match without this.
sed -i -e 's/\x1b\[[0-9;]*m//g' -e 's/\r$//' \
  -e 's/^\[[0-9][0-9-]* [0-9][0-9:.]*\] //' "$ASTERISK_LOG"

echo
echo "════════ RECEIVING-END EVIDENCE (Asterisk's own log) ════════"
# This section reports; it does not gate. A grep that matches nothing exits 1
# and, under `set -e -o pipefail`, would abandon the rest of the evidence —
# which is exactly the output needed to understand why it matched nothing.
set +e
set +o pipefail

# Each receiving-end fact below is a GATE, not a printout. The evidence the
# brief asks for lives in Asterisk's log, not in the client's own opinion of
# itself, so this is where the run can fail; `status` already carries the
# instrumented test's verdict.
failures=0
check() {
  if eval "$2"; then
    echo "   PASS  $1"
  else
    echo "   FAIL  $1"
    failures=$((failures + 1))
  fi
}

# Asterisk's pjsip logger prints each message under a header naming the
# transport, e.g. "Transmitting SIP response (…) to TLS:10.0.2.16:41234".
# sip-blocks.awk cuts the log into whole messages on those markers, so each
# claim below is about ONE message rather than greps that might be about
# different ones.
BLOCKS="$ROOT/deploy/docker/tests/telephony/sip-blocks.awk"
block() { awk -v dir="$1" -v want="$2" -v also="${3:-}" -f "$BLOCKS" "$ASTERISK_LOG"; }

TLS_REGISTER_200="$(block "to TLS:" "200 OK" "REGISTER" | grep -c '^SIP/2.0 200 OK')"

echo
echo "── 1. REGISTER answered 200 OK over TLS ────────────────────────────────"
echo "   200 OK responses to a REGISTER, transmitted over TLS: $TLS_REGISTER_200"
# The exchange itself, so the claim is checkable and not just counted.
block "from TLS:" "REGISTER sip:" | head -24
block "to TLS:" "200 OK" "REGISTER" | head -16
CA_BUFFER_ERRORS="$(grep -c 'Error reading CA certificates from buffer' "$ASTERISK_LOG")"
echo "   pjproject empty-CA-buffer errors (expected 0): $CA_BUFFER_ERRORS"
UNKNOWN_CA_ALERTS="$(grep -ci 'alert unknown ca' "$ASTERISK_LOG")"
echo "   TLS alerts from the client (expected 0):       $UNKNOWN_CA_ALERTS"
check "a REGISTER was answered 200 OK over TLS" '[ "$TLS_REGISTER_200" -ge 1 ]'
check "no pjproject empty-CA-buffer errors" '[ "$CA_BUFFER_ERRORS" -eq 0 ]'
check "no TLS alert unknown ca from the client" '[ "$UNKNOWN_CA_ALERTS" -eq 0 ]'

echo
echo "── 2. Agreed media encryption, from the PBX's own SDP answer ───────────"
# The SDP Asterisk SENDS. m=audio's profile, a=fingerprint and a=setup are the
# PBX stating what it agreed to — not the client stating what it asked for.
# An empty a=fingerprint here means the endpoint has no DTLS key material and
# no handshake can ever complete, which is how that defect was found.
block "to TLS:" "200 OK" "m=audio" \
  | grep -E "^(SIP/2.0|CSeq:|c=IN|m=audio|a=fingerprint|a=setup|a=crypto|a=ice-ufrag)" | head -14
SAVP_LINES="$(grep -cE '^m=audio .*SAVPF?' "$ASTERISK_LOG")"
echo "   SAVP/SAVPF audio lines (encrypted profiles):  $SAVP_LINES"
PLAIN_RTP_LINES="$(grep -cE '^m=audio .*RTP/AVPF? ' "$ASTERISK_LOG")"
echo "   plain RTP/AVP audio lines (expected 0):       $PLAIN_RTP_LINES"
NOT_ACCEPTABLE="$(grep -c '488 Not Acceptable Here' "$ASTERISK_LOG")"
# An answer whose fingerprint is EMPTY is the signature of an endpoint with no
# DTLS key material: the SDP looks right and no handshake can ever run. That is
# how that defect was found, so it is checked and not merely printed.
ANSWER_FINGERPRINTS="$(block "to TLS:" "200 OK" "m=audio" | grep -cE '^a=fingerprint:SHA-256 [0-9A-F][0-9A-F]:')"
echo "   488 Not Acceptable Here (expected 0):        $NOT_ACCEPTABLE"
echo "   non-empty DTLS fingerprints in PBX answers:  $ANSWER_FINGERPRINTS"
check "the PBX answered with an encrypted media profile" '[ "$SAVP_LINES" -ge 1 ]'
check "the PBX never answered with plain RTP/AVP" '[ "$PLAIN_RTP_LINES" -eq 0 ]'
check "the PBX never refused the offer with 488" '[ "$NOT_ACCEPTABLE" -eq 0 ]'
check "the PBX answer carries a real DTLS fingerprint" '[ "$ANSWER_FINGERPRINTS" -ge 1 ]'

echo
echo "── 3. ICE candidates in the offer Asterisk received ────────────────────"
grep -E "^a=candidate" "$ASTERISK_LOG" | sed -E 's/.*(typ [a-z]+).*/\1/' | sort | uniq -c || true
CANDIDATE_LINES="$(grep -cE '^a=candidate' "$ASTERISK_LOG")"
SRFLX="$(grep -E '^a=candidate' "$ASTERISK_LOG" | grep -c 'typ srflx')"
RELAY="$(grep -E '^a=candidate' "$ASTERISK_LOG" | grep -c 'typ relay')"
echo "   total a=candidate lines:        $CANDIDATE_LINES"
echo "   server-reflexive (STUN worked): $SRFLX"
echo "   relay (TURN allocated):         $RELAY"
check "the client offered server-reflexive candidates (STUN applied)" '[ "$SRFLX" -ge 1 ]'
check "the client offered relay candidates (TURN applied)" '[ "$RELAY" -ge 1 ]'
echo "   the PBX's own candidates (it does ICE too):"
block "to TLS:" "200 OK" "m=audio" | grep -E "^a=candidate" | sed 's/^/     /' | head -4

echo
echo "── Channel the echo target answered ────────────────────────────────────"
grep -E "E2E: echoing|Executing .*(Answer|Echo)" "$ASTERISK_LOG" | head -5 || true

echo
if [[ $failures -gt 0 ]]; then
  echo "════════ $failures receiving-end check(s) FAILED ════════"
  status=1
else
  echo "════════ every receiving-end check passed ════════"
fi
echo
echo "Full logs: $EVIDENCE_DIR"
exit $status
