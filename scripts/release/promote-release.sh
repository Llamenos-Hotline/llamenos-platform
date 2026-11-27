#!/usr/bin/env bash
# promote-release.sh — Upload signed artifacts to the RustFS release path.
#
# Usage: ./scripts/release/promote-release.sh <version> <work-dir>
# Example: ./scripts/release/promote-release.sh 0.19.0 /tmp/llamenos-release-v0.19.0
#
# Uploads all artifacts and signatures to s3://RUSTFS_BUCKET/releases/vX.Y.Z/
# Then generates and uploads latest.json for the Tauri updater.
#
# Environment (or ~/.llamenos-release.env):
#   RUSTFS_ENDPOINT, RUSTFS_ACCESS_KEY, RUSTFS_SECRET_KEY, RUSTFS_BUCKET

set -euo pipefail

VERSION="${1:?Usage: promote-release.sh <version> <work-dir>}"
RELEASE_WORK="${2:?Usage: promote-release.sh <version> <work-dir>}"

# Source credentials
if [ -f ~/.llamenos-release.env ]; then
  # shellcheck source=/dev/null
  source ~/.llamenos-release.env
fi

: "${RUSTFS_ENDPOINT:?Set RUSTFS_ENDPOINT}"
: "${RUSTFS_ACCESS_KEY:?Set RUSTFS_ACCESS_KEY}"
: "${RUSTFS_SECRET_KEY:?Set RUSTFS_SECRET_KEY}"
RUSTFS_BUCKET="${RUSTFS_BUCKET:-llamenos-releases}"

export AWS_ACCESS_KEY_ID="${RUSTFS_ACCESS_KEY}"
export AWS_SECRET_ACCESS_KEY="${RUSTFS_SECRET_KEY}"
export AWS_DEFAULT_REGION="us-east-1"

# The same release boundary as sign-artifacts.sh, checked again here because promotion is the step
# that makes an artifact reachable by installed clients (#3069).
SCRIPT_DIR_TRUST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun "${SCRIPT_DIR_TRUST}/../../packages/protocol/tools/trust-snapshot-cli.ts" release-check --candidate "v${VERSION}" || {
  echo "FATAL: refusing to promote — the TLS trust snapshot changed since the last release and no sign-off names it."
  exit 3
}

echo "=== Promoting v${VERSION} to release bucket ==="
echo "  From: ${RELEASE_WORK}/"
echo "  To:   s3://${RUSTFS_BUCKET}/releases/v${VERSION}/"
echo ""

# Upload everything except temp files
aws s3 cp "${RELEASE_WORK}/" "s3://${RUSTFS_BUCKET}/releases/v${VERSION}/" \
  --endpoint-url "${RUSTFS_ENDPOINT}" \
  --recursive \
  --exclude "*.pub" \
  --exclude ".DS_Store" \
  --exclude "*.tmp"

echo ""
echo "Uploaded. Listing release path:"
aws s3 ls "s3://${RUSTFS_BUCKET}/releases/v${VERSION}/" \
  --endpoint-url "${RUSTFS_ENDPOINT}"

echo ""

# Generate latest.json using existing TypeScript generator
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "=== Generating latest.json ==="
cd "${REPO_ROOT}"
bun run scripts/generate-update-manifest.ts \
  --version "${VERSION}" \
  --notes "Desktop v${VERSION}" \
  --output "${RELEASE_WORK}/latest.json" \
  --sig-dir "${RELEASE_WORK}" \
  --url-base "https://updates.llamenos.org/desktop/releases/v${VERSION}"

# Validate manifest
MANIFEST_VERSION=$(jq -r '.version' "${RELEASE_WORK}/latest.json")
if [ "${MANIFEST_VERSION}" != "${VERSION}" ]; then
  echo "FATAL: Generated manifest version '${MANIFEST_VERSION}' != '${VERSION}'"
  exit 1
fi

echo ""
echo "Generated latest.json:"
cat "${RELEASE_WORK}/latest.json"
echo ""

# Upload manifest to both release-specific and canonical paths
aws s3 cp "${RELEASE_WORK}/latest.json" \
  "s3://${RUSTFS_BUCKET}/releases/v${VERSION}/latest.json" \
  --endpoint-url "${RUSTFS_ENDPOINT}" \
  --content-type "application/json"

aws s3 cp "${RELEASE_WORK}/latest.json" \
  "s3://${RUSTFS_BUCKET}/releases/latest.json" \
  --endpoint-url "${RUSTFS_ENDPOINT}" \
  --content-type "application/json"

echo ""
echo "latest.json uploaded to:"
echo "  s3://${RUSTFS_BUCKET}/releases/v${VERSION}/latest.json"
echo "  s3://${RUSTFS_BUCKET}/releases/latest.json (canonical)"
