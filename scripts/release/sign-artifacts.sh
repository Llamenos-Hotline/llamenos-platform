#!/usr/bin/env bash
# sign-artifacts.sh — Sign release artifacts with minisign.
#
# Usage: ./scripts/release/sign-artifacts.sh <work-dir> <minisign-key-path>
# Example: ./scripts/release/sign-artifacts.sh /tmp/llamenos-release-v0.19.0 /media/usb/llamenos-release.key
#
# Signs all release artifacts (not CI .sig files) and verifies each signature.
# Exits non-zero if any signature fails verification.

set -euo pipefail

RELEASE_WORK="${1:?Usage: sign-artifacts.sh <work-dir> <minisign-key-path>}"
MINISIGN_KEY="${2:?Usage: sign-artifacts.sh <work-dir> <minisign-key-path>}"

if ! command -v minisign &>/dev/null; then
  echo "FATAL: minisign not installed."
  echo "  Install: apt install minisign / brew install minisign"
  exit 2
fi

if [ ! -f "${MINISIGN_KEY}" ]; then
  echo "FATAL: Minisign key not found at: ${MINISIGN_KEY}"
  exit 1
fi

# Extract version from directory name
VERSION=$(basename "${RELEASE_WORK}" | sed 's/llamenos-release-v//')

# A changed TLS trust snapshot (pins, ATS, cleartext policy, an unpinned client, a widened loopback
# exemption) must not be signed into a release without a recorded sign-off naming its digest (#3069).
# CI never publishes, so THIS is the release boundary: the check reads the release tag, not the
# working tree, so what is checked is what was built. Fetch tags first: git fetch --tags
SCRIPT_DIR_TRUST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun "${SCRIPT_DIR_TRUST}/../../packages/protocol/tools/trust-snapshot-cli.ts" release-check --candidate "v${VERSION}" || {
  echo "FATAL: refusing to sign — the TLS trust snapshot changed since the last release and no sign-off names it."
  exit 3
}

echo "=== Signing artifacts for v${VERSION} ==="
echo "  Key: ${MINISIGN_KEY}"
echo "  Dir: ${RELEASE_WORK}"
echo ""

cd "${RELEASE_WORK}"

SIGNED=0
for artifact in *.app.tar.gz *.AppImage *.nsis.zip *.deb *.flatpak *.dmg CHECKSUMS.txt; do
  [ -f "$artifact" ] || continue
  # Skip CI-generated Tauri updater .sig files (they're base64 Ed25519, not minisign)
  echo "Signing: ${artifact}"
  minisign -S -s "${MINISIGN_KEY}" -m "${artifact}" \
    -t "llamenos v${VERSION} — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SIGNED=$((SIGNED + 1))
done

echo ""
echo "Signed ${SIGNED} artifacts."
echo ""

# Verify all signatures
echo "=== Verifying signatures ==="

# Extract public key from tauri.conf.json
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PUBKEY_B64=$(jq -r '.plugins.updater.pubkey' "${REPO_ROOT}/apps/desktop/tauri.conf.json")
echo "${PUBKEY_B64}" | base64 -d > "${RELEASE_WORK}/llamenos-release.pub"

VERIFY_FAILED=0
for sig in *.minisig; do
  artifact="${sig%.minisig}"
  if [ ! -f "${artifact}" ]; then
    echo "  SKIP: ${artifact} (artifact not found for signature)"
    continue
  fi
  if minisign -V -p "${RELEASE_WORK}/llamenos-release.pub" -m "${artifact}" 2>/dev/null; then
    echo "  VERIFIED: ${artifact}"
  else
    echo "  FAILED: ${artifact}"
    VERIFY_FAILED=1
  fi
done

if [ "${VERIFY_FAILED}" -ne 0 ]; then
  echo ""
  echo "FATAL: One or more signatures failed verification."
  echo "  Check that the minisign key matches the pubkey in tauri.conf.json."
  exit 1
fi

echo ""
echo "All ${SIGNED} signatures verified successfully."
