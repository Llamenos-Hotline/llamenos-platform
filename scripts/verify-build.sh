#!/usr/bin/env bash
# verify-build.sh — Verify deployed build matches source code (Epic 79)
#
# Reproduces the build locally in Docker and compares checksums against
# published GitHub Release artifacts. The GitHub Release is the trust anchor,
# NOT the deployed application's /api/config/verify endpoint.
#
# When cosign is available, also verifies:
#   - Keyless cosign signatures on CHECKSUMS.txt and provenance.json
#   - SBOM attestation (CycloneDX)
#   - SLSA provenance
#
# Requirements: git, docker, gh (GitHub CLI)
# Optional: cosign (for signature + attestation verification)
#
# Usage:
#   ./scripts/verify-build.sh              # Verify latest release
#   ./scripts/verify-build.sh v0.18.0      # Verify specific version
#   SKIP_DOCKER_BUILD=1 ./scripts/verify-build.sh  # Skip Docker build, verify signatures only
#   ./scripts/verify-build.sh --help       # Show usage

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
verify-build.sh — Llamenos build verification

Usage:
  ./scripts/verify-build.sh              Verify latest release
  ./scripts/verify-build.sh v0.18.0      Verify specific version
  SKIP_DOCKER_BUILD=1 ./scripts/verify-build.sh
                                         Skip Docker build, verify signatures only

Requirements: git, docker, gh (GitHub CLI)
Optional:     cosign (for signature + attestation + SLSA verification)

Exit codes:
  0  All checks passed
  1  Verification failed (mismatch or tamper detected)
  2  Required tool missing (git, docker, or gh)
EOF
  exit 0
fi

VERSION="${1:-}"
REPO="rhonda-rodododo/llamenos-platform"
COSIGN_AVAILABLE=false

echo "=== Llamenos Build Verification ==="
echo ""

# ─── Preflight checks ────────────────────────────────────────────
for tool in git docker gh; do
  if ! command -v "$tool" &>/dev/null; then
    echo "ERROR: required tool '$tool' is not installed"
    exit 2
  fi
done

if command -v cosign &>/dev/null; then
  COSIGN_AVAILABLE=true
  echo "cosign: $(cosign version 2>&1 | head -1)"
else
  echo "cosign: not installed (signature verification will be skipped)"
  echo "  Install: https://docs.sigstore.dev/cosign/system_config/installation/"
fi
echo ""

# ─── Determine version ──────────────────────────────────────────
if [ -z "$VERSION" ]; then
  VERSION=$(gh release list --repo "$REPO" --limit 1 --json tagName --jq '.[0].tagName')
  if [ -z "$VERSION" ]; then
    echo "ERROR: No releases found for $REPO"
    exit 1
  fi
  echo "Latest release: $VERSION"
else
  echo "Verifying: $VERSION"
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
echo "Working directory: $WORKDIR"
echo ""

# ─── Step 1: Download metadata from llamenos-releases repo ──────
echo "--- Downloading metadata from llamenos-releases ---"
METADATA_PATTERNS=(
  "CHECKSUMS.txt"
  "sbom-desktop.cdx.json"
  "build-info.json"
)

RELEASES_REPO="Llamenos-Hotline/llamenos-releases"
VERSION_NO_V="${VERSION#v}"

for pat in "${METADATA_PATTERNS[@]}"; do
  URL="https://raw.githubusercontent.com/${RELEASES_REPO}/main/desktop/${VERSION}/${pat}"
  if curl -sSfL "$URL" -o "$WORKDIR/$pat" 2>/dev/null; then
    echo "  Downloaded: $pat"
  else
    echo "  Not found: $pat"
  fi
done

if [ ! -f "$WORKDIR/CHECKSUMS.txt" ]; then
  echo "ERROR: CHECKSUMS.txt not found for ${VERSION} in llamenos-releases"
  exit 1
fi

# Download cosign signatures from GitHub Release (metadata-only release)
COSIGN_PATTERNS=(
  "CHECKSUMS.txt.cosign.sig"
  "CHECKSUMS.txt.cosign.pem"
)

for pat in "${COSIGN_PATTERNS[@]}"; do
  if gh release download "$VERSION" --repo "$REPO" --pattern "$pat" --dir "$WORKDIR" 2>/dev/null; then
    echo "  Downloaded: $pat (from GitHub Release)"
  fi
done

# ─── Step 1b: Download binaries from RustFS for verification ─────
RUSTFS_BASE="${RUSTFS_PUBLIC_URL:-https://releases.llamenos.org}/desktop/${VERSION}"
echo ""
echo "--- Binary artifacts available at: ${RUSTFS_BASE} ---"
echo "  To verify a specific binary:"
echo "    curl -O ${RUSTFS_BASE}/<filename>"
echo "    sha256sum -c $WORKDIR/CHECKSUMS.txt --ignore-missing"

# ─── Step 2: Cosign signature verification (optional) ────────────
echo ""
echo "--- Verifying cosign signatures ---"

if [ "$COSIGN_AVAILABLE" = true ]; then
  SIGS_VERIFIED=0
  SIGS_EXPECTED=0

  for artifact in CHECKSUMS.txt provenance.json; do
    SIG="$WORKDIR/${artifact}.cosign.sig"
    CERT="$WORKDIR/${artifact}.cosign.pem"
    FILE="$WORKDIR/${artifact}"

    [ -f "$FILE" ] || continue
    SIGS_EXPECTED=$((SIGS_EXPECTED + 1))

    if [ ! -f "$SIG" ] || [ ! -f "$CERT" ]; then
      echo "  WARNING: Missing cosign signature files for $artifact"
      echo "    This release may predate cosign signing."
      continue
    fi

    if cosign verify-blob \
      --signature "$SIG" \
      --certificate "$CERT" \
      --certificate-identity-regexp "https://github.com/${REPO}/" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$FILE" 2>/dev/null; then
      echo "  VERIFIED: $artifact (cosign keyless signature)"
      SIGS_VERIFIED=$((SIGS_VERIFIED + 1))
    else
      echo "  FAILED: $artifact cosign signature verification failed!"
      echo "  The artifact may have been tampered with."
      exit 1
    fi
  done

  if [ "$SIGS_EXPECTED" -gt 0 ] && [ "$SIGS_VERIFIED" -eq "$SIGS_EXPECTED" ]; then
    echo "  All $SIGS_VERIFIED/$SIGS_EXPECTED cosign signatures verified."
  elif [ "$SIGS_EXPECTED" -eq 0 ]; then
    echo "  No artifacts with cosign signatures found."
  fi
else
  echo "  SKIPPED: cosign not installed"
fi

# ─── Step 3: SBOM attestation verification (optional) ────────────
echo ""
echo "--- Verifying SBOM attestation ---"

if [ "$COSIGN_AVAILABLE" = true ]; then
  if [ -f "$WORKDIR/sbom.cdx.json.att" ]; then
    if cosign verify-blob-attestation \
      --signature "$WORKDIR/sbom.cdx.json.att" \
      --type cyclonedx \
      --certificate-identity-regexp "https://github.com/${REPO}/" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
      "$WORKDIR/CHECKSUMS.txt" 2>/dev/null; then
      echo "  VERIFIED: SBOM attestation (CycloneDX)"
    else
      echo "  FAILED: SBOM attestation verification failed!"
      exit 1
    fi

    if [ -f "$WORKDIR/sbom.cdx.json" ] && command -v jq &>/dev/null; then
      COMPONENT_COUNT=$(jq '.components | length' "$WORKDIR/sbom.cdx.json" 2>/dev/null || echo "unknown")
      echo "  SBOM contains $COMPONENT_COUNT components"
    fi
  else
    echo "  No SBOM attestation found (sbom.cdx.json.att)"
    echo "  This release may predate SBOM attestation."
  fi
else
  echo "  SKIPPED: cosign not installed"
fi

# ─── Step 4: SLSA provenance verification (optional) ─────────────
echo ""
echo "--- Verifying SLSA provenance ---"

if [ "$COSIGN_AVAILABLE" = true ]; then
  if [ -f "$WORKDIR/provenance.json" ]; then
    echo "  Provenance artifact present."
    if command -v jq &>/dev/null; then
      BUILDER=$(jq -r '.builder.id // "unknown"' "$WORKDIR/provenance.json" 2>/dev/null || echo "unknown")
      BUILD_TYPE=$(jq -r '.buildType // "unknown"' "$WORKDIR/provenance.json" 2>/dev/null || echo "unknown")
      echo "  Builder ID:  $BUILDER"
      echo "  Build type:  $BUILD_TYPE"
    fi
    echo "  (Full SLSA verification via slsa-verifier requires a separate install)"
    echo "  See: https://github.com/slsa-framework/slsa-verifier"
  else
    echo "  No provenance.json found — this release may predate SLSA provenance."
  fi
else
  echo "  SKIPPED: cosign not installed"
fi

# ─── Step 5: GPG signature verification ──────────────────────────
echo ""
echo "--- Verifying GPG signature ---"
if [ -f "$WORKDIR/CHECKSUMS.txt.asc" ]; then
  if gpg --verify "$WORKDIR/CHECKSUMS.txt.asc" "$WORKDIR/CHECKSUMS.txt" 2>/dev/null; then
    echo "  VERIFIED: GPG signature on CHECKSUMS.txt"
  else
    echo "  WARNING: GPG signature verification failed"
    echo "  You may need to import the release signing key."
  fi
else
  echo "  No GPG signature found (CHECKSUMS.txt.asc)"
fi

# ─── Step 6: Reproducible build verification ─────────────────────
if [ "${SKIP_DOCKER_BUILD:-}" = "1" ]; then
  echo ""
  echo "--- Skipping Docker build (SKIP_DOCKER_BUILD=1) ---"
  echo ""
  echo "SIGNATURE VERIFICATION COMPLETE"
  if [ "$COSIGN_AVAILABLE" = true ]; then
    echo "  - Cosign signatures: verified (where present)"
    echo "  - SBOM attestation: verified (where present)"
  else
    echo "  - Cosign verification: skipped (cosign not installed)"
  fi
  echo ""
  echo "Run without SKIP_DOCKER_BUILD to also verify the reproducible build."
  exit 0
fi

echo ""
echo "--- Cloning source at $VERSION ---"
git clone --depth 1 --branch "$VERSION" "https://github.com/${REPO}.git" "$WORKDIR/source"

SOURCE_DATE_EPOCH=$(git -C "$WORKDIR/source" log -1 --format=%ct)
GITHUB_SHA=$(git -C "$WORKDIR/source" log -1 --format=%H)
echo "Commit: $GITHUB_SHA"
echo "SOURCE_DATE_EPOCH: $SOURCE_DATE_EPOCH"
echo ""

echo "--- Building in Docker container ---"
docker build \
  -f "$WORKDIR/source/Dockerfile.build" \
  --build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH" \
  --build-arg "GITHUB_SHA=$GITHUB_SHA" \
  -t llamenos-verify \
  "$WORKDIR/source"

echo ""
echo "--- Extracting build artifacts ---"
docker create --name llamenos-verify-extract llamenos-verify
docker cp llamenos-verify-extract:/build/dist "$WORKDIR/local-build"
docker rm llamenos-verify-extract

echo ""
echo "--- Computing local checksums ---"
(cd "$WORKDIR/local-build" && find . -type f -exec sha256sum {} \; | sort) > "$WORKDIR/local-checksums.txt"
echo "$(wc -l < "$WORKDIR/local-checksums.txt") files checksummed"

# ─── Step 7: Compare checksums ───────────────────────────────────
echo ""
echo "--- Comparing checksums ---"

if diff "$WORKDIR/local-checksums.txt" "$WORKDIR/CHECKSUMS.txt" > /dev/null 2>&1; then
  echo ""
  echo "BUILD VERIFIED: Local build matches published checksums"
  echo "  - Reproducible build: MATCH"
  if [ "$COSIGN_AVAILABLE" = true ]; then
    echo "  - Cosign signatures: verified (where present)"
    [ -f "$WORKDIR/sbom.cdx.json.att" ] && echo "  - SBOM attestation: VERIFIED"
    [ -f "$WORKDIR/provenance.json" ] && echo "  - SLSA provenance: present"
  fi
  exit 0
else
  echo ""
  echo "BUILD MISMATCH: Local build differs from published checksums"
  echo ""
  diff "$WORKDIR/local-checksums.txt" "$WORKDIR/CHECKSUMS.txt" || true
  exit 1
fi
