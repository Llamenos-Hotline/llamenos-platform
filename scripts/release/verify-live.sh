#!/usr/bin/env bash
# verify-live.sh — Verify the live updater endpoint serves the correct manifest.
#
# Usage: ./scripts/release/verify-live.sh <version> [local-manifest-path]
# Example: ./scripts/release/verify-live.sh 0.19.0 /tmp/llamenos-release-v0.19.0/latest.json
#
# Checks:
#   1. https://updates.llamenos.org/desktop/latest.json is reachable
#   2. The version field matches the expected version
#   3. Content matches the local manifest (if provided)
#   4. GitHub Releases fallback endpoint (informational)

set -euo pipefail

VERSION="${1:?Usage: verify-live.sh <version> [local-manifest-path]}"
LOCAL_MANIFEST="${2:-}"

UPDATER_URL="https://updates.llamenos.org/desktop/latest.json"
# Informational fallback only — never fatal (see the soft check near the end
# of this script). The owner/repo was `rhonda-rodododo/llamenos`, which is
# not this repository at all: it redirects to the v1 hotline repo, which has
# never held a v2 desktop manifest. Corrected to this repository, where
# tauri-release.yml does create the release (`gh release create --repo
# "${GITHUB_REPOSITORY}"`).
#
# KNOWN GAP, deliberately not guessed at here: desktop releases are tagged
# `desktop-v<version>` and published with `--latest=false`, so
# `/releases/latest/download/...` will not resolve to them and this check
# still reports "not available". Fixing that means deciding what the fallback
# should point at (the tagged asset URL, or marking desktop releases latest),
# which is a release-policy question rather than a rename — see #1218.
GITHUB_URL="https://github.com/Llamenos-Hotline/llamenos-platform/releases/latest/download/latest.json"

echo "=== Verifying live updater endpoint ==="
echo "  Expected version: ${VERSION}"
echo "  URL: ${UPDATER_URL}"
echo ""

# Fetch live manifest
LIVE_MANIFEST=$(curl -sSf "${UPDATER_URL}" 2>&1) || {
  echo "FATAL: Could not fetch ${UPDATER_URL}"
  echo "  Check: DNS resolution, Caddy config, RustFS proxy"
  echo "  Debug: curl -v ${UPDATER_URL}"
  exit 1
}

echo "Live manifest fetched successfully."

# Check version
LIVE_VERSION=$(echo "${LIVE_MANIFEST}" | jq -r '.version')
if [ "${LIVE_VERSION}" != "${VERSION}" ]; then
  echo "FATAL: Live version '${LIVE_VERSION}' != expected '${VERSION}'"
  echo ""
  echo "Possible causes:"
  echo "  - Upload hasn't propagated (try again in 30 seconds)"
  echo "  - Caddy is serving a cached response"
  echo "  - Wrong bucket or path"
  exit 1
fi
echo "  Version: ${LIVE_VERSION} ✓"

# Check platform entries
for platform in darwin-aarch64 darwin-x86_64 linux-x86_64 windows-x86_64; do
  SIG=$(echo "${LIVE_MANIFEST}" | jq -r ".platforms[\"${platform}\"].signature // empty")
  URL=$(echo "${LIVE_MANIFEST}" | jq -r ".platforms[\"${platform}\"].url // empty")
  if [ -n "$SIG" ] && [ -n "$URL" ]; then
    echo "  ${platform}: present (sig ${#SIG} chars)"
  else
    echo "  ${platform}: MISSING"
  fi
done

# Compare with local manifest if provided
if [ -n "${LOCAL_MANIFEST}" ] && [ -f "${LOCAL_MANIFEST}" ]; then
  echo ""
  LOCAL_HASH=$(jq -cS 'del(.pub_date)' "${LOCAL_MANIFEST}" | sha256sum | cut -d' ' -f1)
  LIVE_HASH=$(echo "${LIVE_MANIFEST}" | jq -cS 'del(.pub_date)' | sha256sum | cut -d' ' -f1)

  if [ "${LOCAL_HASH}" = "${LIVE_HASH}" ]; then
    echo "  Content match: EXACT (excluding pub_date)"
  else
    echo "  Content match: DIFFERS"
    echo "  Diff (local vs live):"
    diff <(jq -cS 'del(.pub_date)' "${LOCAL_MANIFEST}") \
         <(echo "${LIVE_MANIFEST}" | jq -cS 'del(.pub_date)') || true
  fi
fi

# Check GitHub fallback (informational, not a gate)
echo ""
echo "--- GitHub Releases fallback ---"
GH_MANIFEST=$(curl -sSfL "${GITHUB_URL}" 2>/dev/null || echo "")
if [ -n "${GH_MANIFEST}" ]; then
  GH_VERSION=$(echo "${GH_MANIFEST}" | jq -r '.version // empty')
  if [ "${GH_VERSION}" = "${VERSION}" ]; then
    echo "  GitHub fallback: v${GH_VERSION} (matches)"
  else
    echo "  GitHub fallback: v${GH_VERSION:-unavailable} (does not match — upload with gh release upload)"
  fi
else
  echo "  GitHub fallback: not available"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  RELEASE v${VERSION} VERIFIED LIVE"
echo "═══════════════════════════════════════════════════"
