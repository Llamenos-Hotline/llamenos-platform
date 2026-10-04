#!/usr/bin/env bash
# generate-update-manifest.sh — Build the latest.json manifest for Tauri auto-updater.
#
# Run in CI after all platform builds complete. Expects:
#   - VERSION env var (e.g., "0.19.8") set by the release job
#   - Platform-specific .sig files in the artifacts directory
#
# Usage: VERSION=0.19.8 ./scripts/generate-update-manifest.sh [artifacts-dir]
#
# Epic 87: Desktop Auto-Updater & Distribution.

set -euo pipefail

# ── Determine version ─────────────────────────────────────────────
# Prefer explicit VERSION env var (set by CI from workflow_dispatch input).
# Fall back to GITHUB_REF_NAME only if VERSION is unset (manual tag push).
if [[ -n "${VERSION:-}" ]]; then
  : # already set
elif [[ "${GITHUB_REF_NAME:-}" =~ ^v(.+)$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
else
  echo "Error: VERSION env var is not set and cannot determine version from GITHUB_REF_NAME=${GITHUB_REF_NAME:-unset}" >&2
  echo "Set VERSION=x.y.z or push a v* tag." >&2
  exit 1
fi

REPO="${GITHUB_REPOSITORY:-Llamenos-Hotline/llamenos-platform}"
RUSTFS_PUBLIC_URL="${RUSTFS_PUBLIC_URL:-https://releases.llamenos-hotline.org}"
BASE_URL="${RUSTFS_PUBLIC_URL}/desktop/v${VERSION}"
ARTIFACTS_DIR="${1:-artifacts}"

echo "Generating update manifest for version ${VERSION}..."
echo "  Artifacts dir: ${ARTIFACTS_DIR}"

# ── Read signature from .sig file ─────────────────────────────────
read_sig() {
  local path="${ARTIFACTS_DIR}/$1"
  if [[ -f "$path" ]]; then
    cat "$path"
  else
    echo "Warning: signature file not found: ${path}" >&2
    echo ""
  fi
}

# ── Try multiple filename patterns for a signature ────────────────
# Tauri v2 artifact naming depends on productName in tauri.conf.json.
# With productName "Hotline", macOS universal produces "Hotline.app.tar.gz".
# Try the expected name first, then fallback patterns.
find_sig() {
  local result=""
  for pattern in "$@"; do
    result=$(read_sig "$pattern")
    if [[ -n "$result" ]]; then
      echo "$result"
      return
    fi
  done
  echo ""
}

# ── Get release notes ─────────────────────────────────────────────
NOTES=""
if command -v gh &>/dev/null; then
  NOTES=$(gh release view "v${VERSION}" --repo "${REPO}" --json body -q .body 2>/dev/null | head -500 || echo "")
fi
if [[ -z "$NOTES" ]]; then
  NOTES="Desktop v${VERSION}"
fi

# Escape notes for JSON
NOTES_ESCAPED=$(echo -n "$NOTES" | jq -Rs . 2>/dev/null || printf '%s' "$NOTES" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')

# ── Build platform entries ────────────────────────────────────────
#
# CI builds a universal macOS binary (--target universal-apple-darwin).
# Tauri v2 produces a single .app.tar.gz for universal builds — both
# darwin-aarch64 and darwin-x86_64 updater keys must point to the same file.
PLATFORMS=""

# macOS universal — single file serves both architectures.
# Tauri names the updater artifact after productName: "Hotline.app.tar.gz"
MAC_UNIVERSAL_SIG=$(find_sig \
  "Hotline.app.tar.gz.sig" \
  "llamenos_${VERSION}_universal.app.tar.gz.sig" \
  "llamenos_${VERSION}_aarch64.app.tar.gz.sig" \
  "llamenos_${VERSION}_x64.app.tar.gz.sig")

# Determine the actual macOS artifact filename
MAC_ARTIFACT=""
for candidate in \
  "Hotline.app.tar.gz" \
  "llamenos_${VERSION}_universal.app.tar.gz" \
  "llamenos_${VERSION}_aarch64.app.tar.gz" \
  "llamenos_${VERSION}_x64.app.tar.gz"; do
  if [[ -f "${ARTIFACTS_DIR}/${candidate}" ]]; then
    MAC_ARTIFACT="$candidate"
    break
  fi
done
# Default if file not found locally (CI may have already uploaded)
MAC_ARTIFACT="${MAC_ARTIFACT:-Hotline.app.tar.gz}"

if [[ -n "$MAC_UNIVERSAL_SIG" ]]; then
  # Both arch keys point to the same universal binary
  PLATFORMS="${PLATFORMS}
    \"darwin-aarch64\": {
      \"signature\": \"${MAC_UNIVERSAL_SIG}\",
      \"url\": \"${BASE_URL}/${MAC_ARTIFACT}\"
    },
    \"darwin-x86_64\": {
      \"signature\": \"${MAC_UNIVERSAL_SIG}\",
      \"url\": \"${BASE_URL}/${MAC_ARTIFACT}\"
    },"
fi

# Windows x86_64
WIN_SIG=$(find_sig \
  "Hotline_${VERSION}_x64-setup.nsis.zip.sig" \
  "Hotline_x64_en-US.msi.zip.sig" \
  "llamenos_${VERSION}_x64-setup.nsis.zip.sig")
WIN_ARTIFACT=""
for candidate in \
  "Hotline_${VERSION}_x64-setup.nsis.zip" \
  "Hotline_x64_en-US.msi.zip" \
  "llamenos_${VERSION}_x64-setup.nsis.zip"; do
  if [[ -f "${ARTIFACTS_DIR}/${candidate}" ]]; then
    WIN_ARTIFACT="$candidate"
    break
  fi
done
WIN_ARTIFACT="${WIN_ARTIFACT:-Hotline_${VERSION}_x64-setup.nsis.zip}"

if [[ -n "$WIN_SIG" ]]; then
  PLATFORMS="${PLATFORMS}
    \"windows-x86_64\": {
      \"signature\": \"${WIN_SIG}\",
      \"url\": \"${BASE_URL}/${WIN_ARTIFACT}\"
    },"
fi

# Linux x86_64
LINUX_SIG=$(find_sig \
  "hotline_${VERSION}_amd64.AppImage.tar.gz.sig" \
  "hotline_amd64.AppImage.tar.gz.sig" \
  "llamenos_${VERSION}_amd64.AppImage.sig")
LINUX_ARTIFACT=""
for candidate in \
  "hotline_${VERSION}_amd64.AppImage.tar.gz" \
  "hotline_amd64.AppImage.tar.gz" \
  "llamenos_${VERSION}_amd64.AppImage"; do
  if [[ -f "${ARTIFACTS_DIR}/${candidate}" ]]; then
    LINUX_ARTIFACT="$candidate"
    break
  fi
done
LINUX_ARTIFACT="${LINUX_ARTIFACT:-hotline_${VERSION}_amd64.AppImage.tar.gz}"

if [[ -n "$LINUX_SIG" ]]; then
  PLATFORMS="${PLATFORMS}
    \"linux-x86_64\": {
      \"signature\": \"${LINUX_SIG}\",
      \"url\": \"${BASE_URL}/${LINUX_ARTIFACT}\"
    },"
fi

# Remove trailing comma from last platform entry
PLATFORMS=$(echo "$PLATFORMS" | sed '$ s/,$//')

cat > latest.json << MANIFEST
{
  "version": "${VERSION}",
  "notes": ${NOTES_ESCAPED},
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {${PLATFORMS}
  }
}
MANIFEST

echo "Generated latest.json:"
cat latest.json
echo ""
echo "Done."
