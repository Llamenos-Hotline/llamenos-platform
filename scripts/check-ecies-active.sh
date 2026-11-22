#!/usr/bin/env bash
# check-ecies-active.sh — Fail if ECIES/nsec/secp256k1 pseudocode appears in
# the active (non-appendix, non-legacy) sections of the protocol specification.
#
# The specification is an index (docs/protocol/PROTOCOL.md) plus one file per
# domain. The scan runs over the index followed by every file it links, in the
# order the index lists them — which is the original reading order, so the
# "allowed until the next section" state below carries across file boundaries
# exactly as it did when the specification was one file.
#
# Allowed: Section 2.2.1, Appendix A/B/C, Section 2.6 (marked Legacy),
#          Section 2.13 Legacy V1, any block after a "> **Legacy" or
#          "> **Historical" or "> **Deprecated" notice.
#
# Forbidden: eciesWrapKey / eciesUnwrapKey / secp256k1.getSharedSecret
#            / nsec_bech32 / NIP-44 in active algorithm pseudocode blocks.
#
# Exit code: 0 = pass, 1 = violations found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTOCOL_DIR="$SCRIPT_DIR/../docs/protocol"
PROTOCOL="$PROTOCOL_DIR/PROTOCOL.md"

if [ ! -f "$PROTOCOL" ]; then
  echo "❌ PROTOCOL.md not found at $PROTOCOL"
  exit 1
fi

# Files named by the index's table rows, in index order. (The deprecated v1
# document is linked outside the table, so it is not scanned.)
FILES=("$PROTOCOL")
while IFS= read -r rel; do
  if [ ! -f "$PROTOCOL_DIR/$rel" ]; then
    echo "❌ PROTOCOL.md links $rel, which does not exist"
    exit 1
  fi
  FILES+=("$PROTOCOL_DIR/$rel")
done < <(grep -E '^\|' "$PROTOCOL" | grep -oE '\]\([^)]+\.md\)' | sed -E 's/^\]\(//; s/\)$//')

# A scan of the index alone would pass vacuously. The set has dozens of files.
if [ "${#FILES[@]}" -lt 10 ]; then
  echo "❌ Found only ${#FILES[@]} protocol file(s) via the PROTOCOL.md index; expected the full document set"
  exit 1
fi

VIOLATIONS=()

IN_ALLOWED_SECTION=0

while IFS= read -r line; do
  # Enter allowed sections when hitting legacy/appendix markers
  if echo "$line" | grep -qE "^### 2\.2\.1|^## Appendix|^> \*\*Legacy|^> \*\*Historical|^> \*\*Deprecated|^> \*\*Migration Note|^### 2\.13 Legacy"; then
    IN_ALLOWED_SECTION=1
  fi

  # Return to active-doc mode only on non-appendix main sections (## 1. through ## 7.)
  if echo "$line" | grep -qE "^## [1-7]\." && ! echo "$line" | grep -qE "^## Appendix"; then
    IN_ALLOWED_SECTION=0
  fi

  # Subsections 2.3 onward exit the legacy section 2.2.1
  if echo "$line" | grep -qE "^### 2\.[3-9]|^### 2\.(1[0-9])"; then
    IN_ALLOWED_SECTION=0
  fi

  # Section 2.13 Transcription (not "Legacy") is outside allowed sections
  if echo "$line" | grep -qE "^### 2\.13 Transcription"; then
    IN_ALLOWED_SECTION=0
  fi

  if [ "$IN_ALLOWED_SECTION" -eq 1 ]; then
    continue
  fi

  # Check for forbidden patterns (legacy ECIES function calls/names in pseudocode)
  if echo "$line" | grep -qiE "eciesWrapKey|eciesUnwrapKey|secp256k1\.getSharedSecret|nsec_bech32|NIP-44"; then
    VIOLATIONS+=("$line")
  fi
done < <(cat "${FILES[@]}")

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  echo "❌ Legacy crypto primitives found in active protocol sections:"
  echo "   Move ECIES/nsec/NIP-44 references to Appendix C or add a Legacy notice."
  echo ""
  for v in "${VIOLATIONS[@]}"; do
    echo "  $v"
  done
  exit 1
fi

echo "✅ No legacy crypto primitives in active protocol sections (${#FILES[@]} files scanned)."
exit 0
