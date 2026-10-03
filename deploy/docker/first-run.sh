#!/usr/bin/env bash
# Llamenos First-Run Setup
#
# Generates .env secrets and starts the Docker Compose stack.
# Run from the deploy/docker/ directory:
#   cd deploy/docker && bash first-run.sh
#
# Prerequisites: docker, docker compose, openssl

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Llamenos First-Run Setup ==="
echo ""

# Check prerequisites
for cmd in docker openssl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is required but not found in PATH."
    exit 1
  fi
done

if ! docker compose version &>/dev/null; then
  echo "ERROR: 'docker compose' plugin is required."
  exit 1
fi

# Generate .env from template if missing
if [ -f .env ]; then
  echo ".env already exists — skipping secret generation."
  echo "To regenerate, remove .env and re-run this script."
  echo ""
else
  if [ ! -f .env.example ]; then
    echo "ERROR: .env.example not found. Are you in deploy/docker/?"
    exit 1
  fi

  cp .env.example .env

  # Auto-generate all secrets
  PG_PASS="$(openssl rand -base64 24)"
  HMAC="$(openssl rand -hex 32)"
  STORAGE_AK="$(openssl rand -base64 16 | tr -d '=/+')"
  STORAGE_SK="$(openssl rand -base64 24)"
  SERVER_SECRET_VAL="$(openssl rand -hex 32)"

  # Use sed to fill in generated values
  sed -i "s|^PG_PASSWORD=.*|PG_PASSWORD=${PG_PASS}|" .env
  sed -i "s|^HMAC_SECRET=.*|HMAC_SECRET=${HMAC}|" .env
  sed -i "s|^STORAGE_ACCESS_KEY=.*|STORAGE_ACCESS_KEY=${STORAGE_AK}|" .env
  sed -i "s|^STORAGE_SECRET_KEY=.*|STORAGE_SECRET_KEY=${STORAGE_SK}|" .env
  sed -i "s|^SERVER_SECRET=.*|SERVER_SECRET=${SERVER_SECRET_VAL}|" .env

  echo "Generated .env with random secrets."
  echo ""
  echo "IMPORTANT: You still need to set these manually:"
  echo "  - ADMIN_PUBKEY  (run 'bun run bootstrap-admin' to generate)"
  echo "  - ADMIN_DECRYPTION_PUBKEY (the SECOND key that same command prints —"
  echo "                   the admin's X25519 HPKE recipient. Required whenever"
  echo "                   ADMIN_PUBKEY is set, and a different value from it.)"
  echo "  - DOMAIN        (your domain name, default: localhost)"
  echo "  - ACME_EMAIL    (for Let's Encrypt TLS certificates)"
  echo ""
  echo "Edit .env now, then press Enter to continue (or Ctrl-C to abort)."
  read -r
fi

# Validate required fields
source .env 2>/dev/null || true
if [ -z "${ADMIN_PUBKEY:-}" ]; then
  echo "WARNING: ADMIN_PUBKEY is not set in .env."
  echo "You will need to set it before the app is fully functional."
  echo "Generate one with: bun run bootstrap-admin"
  echo ""
elif [ -z "${ADMIN_DECRYPTION_PUBKEY:-}" ]; then
  # Not a warning: the app refuses to boot in this state, on purpose. Sealing
  # admin envelopes to ADMIN_PUBKEY (an Ed25519 signing key) succeeds and makes
  # every note permanently undecryptable, so a server that cannot name a real
  # X25519 recipient must not start (#1283).
  echo "ERROR: ADMIN_PUBKEY is set but ADMIN_DECRYPTION_PUBKEY is not."
  echo ""
  echo "These are two different keys. ADMIN_PUBKEY is Ed25519 (it verifies the"
  echo "admin's signatures); ADMIN_DECRYPTION_PUBKEY is X25519 (it is the HPKE"
  echo "recipient every note, message and hub key is encrypted to). The app will"
  echo "refuse to start without it rather than encrypt notes to a key that cannot"
  echo "decrypt them."
  echo ""
  echo "Run 'bun run bootstrap-admin' and copy BOTH printed public keys into .env."
  exit 1
fi

# Start stack
echo "Starting Docker Compose stack..."
docker compose up -d

# Wait for health
echo ""
echo "Waiting for services to become ready..."
MAX_WAIT=120
ELAPSED=0
until curl -sf http://localhost:3000/api/health/ready >/dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo ""
    echo "ERROR: Services did not become healthy within ${MAX_WAIT}s."
    echo "Check logs with: docker compose logs"
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf "."
done

echo ""
echo ""
echo "=== Llamenos is running ==="
echo ""
echo "Health check: curl http://localhost:3000/api/health/ready"
echo ""
echo "Next steps:"
echo "  1. Set ADMIN_PUBKEY and ADMIN_DECRYPTION_PUBKEY in .env (if not already done)"
echo "  2. Restart with: docker compose restart app"
echo "  3. Open https://${DOMAIN:-localhost} in your browser"
echo "  4. Download the desktop app and log in with your admin key"
echo ""
