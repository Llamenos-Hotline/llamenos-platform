#!/usr/bin/env bash
# scripts/update-image-digests.sh
#
# Usage: ./scripts/update-image-digests.sh
#
# Prints current sha256 digests for all third-party images used in compose files.
# Copy/paste the output into the relevant compose file image lines.
#
# This is a documentation and convenience tool — it does NOT auto-patch files.
# Operators verify digests match expected values before committing.
#
# After running, update the image lines in:
#   - deploy/docker/docker-compose.dev.yml
#   - deploy/docker/docker-compose.yml
#   - deploy/docker/docker-compose.production.yml
#   - signal-notifier/Dockerfile (oven/bun:1.4.4-slim), sip-bridge/Dockerfile (oven/bun:1.4.4)
#   - deploy/docker/Dockerfile.nodejs (node:26-slim + bun zip)
set -euo pipefail

images=(
  "postgres:17-alpine"
  "caddy:2.9-alpine"
  "rustfs/rustfs:latest"
  "fedirz/faster-whisper-server:0.4.1"
  "andrius/asterisk:latest"
  "kamailio/kamailio:5.7"
  "coturn/coturn:4"
  "glitchtip/glitchtip:v4.1"
  "redis:7-alpine"
  "bbernhard/signal-cli-rest-api:0.92"
  "ollama/ollama:latest"
  "containrrr/watchtower:1.7.1"
  "tecnativa/docker-socket-proxy:latest"
  "oven/bun:1.4.4-slim"
  "oven/bun:1.4.4"
  "node:26-slim"
)

for img in "${images[@]}"; do
  echo "Pulling $img..."
  docker pull "$img" --quiet
  digest=$(docker inspect --format='{{index .RepoDigests 0}}' "$img" 2>/dev/null || echo "NOT_FOUND")
  echo "  $img → $digest"
done

echo ""
echo "--- Bun binary SHA-256 (for Dockerfile.nodejs) ---"
echo "Run the following to get the SHA-256 for a specific Bun version:"
echo "  BUN_VERSION=1.3.5"
echo "  curl -fsSL \"https://github.com/oven-sh/bun/releases/download/bun-v\${BUN_VERSION}/bun-linux-x64.zip\" -o /tmp/bun.zip"
echo "  sha256sum /tmp/bun.zip"
