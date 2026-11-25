#!/usr/bin/env bash
# Fetch the pinned prebuilt liblinphone SDK for one desktop target and verify it
# against apps/desktop/linphone-sdk-checksums.txt (#1770, plan Task 1).
#
# The checksums file is a GATE here, not a record (unlike the iOS precedent,
# whose header explains why a record alone was accepted there): an artifact
# whose sha256 differs from the pinned line is never extracted, and an existing
# vendored tree is left exactly as it was.
#
# Usage: scripts/fetch-linphone-sdk.sh <target> [--local <artifact>]
#   <target> is a line name in the checksums file (linux-x86_64, macos-arm64,
#   windows-x86_64).
#   --local <artifact> reads the artifact from a local file instead of the
#   pinned URL — for the linux-x86_64 tarball built by
#   scripts/build-linphone-sdk-linux.sh before (or instead of) it being fetched
#   from the release origin. It changes WHERE the bytes come from, never what
#   they are checked against: the same pinned sha256 gates both paths.
#
# Installs into apps/desktop/vendor/linphone-sdk/<target>/ (gitignored) and
# writes <that dir>/.sdk-sha256 holding the verified digest, so a build can tell
# a vendored tree that matches the current pin from a stale one.
#
# Exit codes: 0 installed; 1 the artifact failed verification (digest mismatch
# or unexpected layout); 2 usage error / no pin for that target.
#
# Test seams (scripts/fetch-linphone-sdk.test.ts): LLAMENOS_LINPHONE_CHECKSUMS
# and LLAMENOS_LINPHONE_VENDOR_ROOT relocate the pin file and the install root.
# They move WHERE the gate reads and writes; nothing skips the comparison.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
CHECKSUMS="${LLAMENOS_LINPHONE_CHECKSUMS:-$ROOT/apps/desktop/linphone-sdk-checksums.txt}"
VENDOR_ROOT="${LLAMENOS_LINPHONE_VENDOR_ROOT:-$ROOT/apps/desktop/vendor/linphone-sdk}"

die() { local code="$1"; shift; printf 'fetch-linphone-sdk: %s\n' "$*" >&2; exit "$code"; }

LOCAL=""
case "$#" in
  1) ;;
  3) [ "$2" = "--local" ] || die 2 "usage: fetch-linphone-sdk.sh <target> [--local <artifact>]"
     LOCAL="$3"
     [ -f "$LOCAL" ] || die 2 "local artifact not found: $LOCAL" ;;
  *) die 2 "usage: fetch-linphone-sdk.sh <target> [--local <artifact>]" ;;
esac
TARGET="$1"
[[ "$TARGET" =~ ^[a-z0-9_-]+$ ]] || die 2 "invalid target name '$TARGET'"
[ -f "$CHECKSUMS" ] || die 2 "checksums file not found: $CHECKSUMS"

# The directory INSIDE the upstream zip that is the SDK root for each target,
# and a file that must exist under it. Upstream lays the platforms out
# differently (headers in include/ on Windows, inside the framework on macOS),
# so the expected shape is stated per target rather than assumed.
case "$TARGET" in
  linux-x86_64)
    # Built from apps/desktop/linphone-sdk-linux-x86_64.Dockerfile (upstream
    # publishes no Linux SDK). The two backends are checked by that build; the
    # layout is checked here, including the belr grammars liblinphone aborts
    # without at Core creation.
    FORMAT="tar.gz"
    INNER="linphone-sdk/linux-x86_64"
    REQUIRED=("include/linphone/core.h" "lib/liblinphone.so" "lib/libmediastreamer2.so" "share/belr/grammars/sip_grammar.belr")
    ;;
  macos-arm64)
    FORMAT="zip"
    INNER="linphone-sdk/macos"
    REQUIRED=("Frameworks/linphone.framework/Headers/core.h")
    ;;
  windows-x86_64)
    FORMAT="zip"
    INNER="linphone-sdk/win64"
    REQUIRED=("include/linphone/core.h" "bin/liblinphone.dll" "lib/liblinphone.lib")
    ;;
  *)
    # A layout this script does not know cannot be checked, so it is refused
    # even if someone adds a pin line for it.
    die 2 "unknown target '$TARGET' (known: linux-x86_64, macos-arm64, windows-x86_64)"
    ;;
esac

# Exactly one non-comment line whose first field is the target, with exactly
# three fields and a lowercase 64-hex digest. Anything else is refused: a gate
# that guesses at a malformed pin is not a gate.
# (awk, not mapfile: macOS still ships bash 3.2 as /bin/bash.)
count="$(awk -v t="$TARGET" '!/^[[:space:]]*#/ && $1 == t { n++ } END { print n + 0 }' "$CHECKSUMS")"
[ "$count" -ge 1 ] || die 2 "no checksum entry for target '$TARGET' in $CHECKSUMS"
[ "$count" -eq 1 ] || die 2 "more than one checksum entry for target '$TARGET' in $CHECKSUMS"
line="$(awk -v t="$TARGET" '!/^[[:space:]]*#/ && $1 == t' "$CHECKSUMS")"
read -r -a fields <<<"$line"
[ "${#fields[@]}" -eq 3 ] || die 2 "malformed entry for '$TARGET' (want: <target> <url> <sha256>)"
url="${fields[1]}"
expected="${fields[2]}"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die 2 "entry for '$TARGET' has no valid sha256"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

artifact="$tmp/sdk.$FORMAT"
if [ -n "$LOCAL" ]; then
  cp "$LOCAL" "$artifact"
else
  # https only for real pins (file:// exists solely so the gate's own test can
  # serve a fixture); no redirect may downgrade the scheme.
  curl -fsSL --retry 3 --proto '=https,file' --proto-redir '=https' "$url" -o "$artifact" \
    || die 1 "download failed for $TARGET from $url"
fi

actual="$(sha256_of "$artifact")"
if [ "$actual" != "$expected" ]; then
  {
    echo "CHECKSUM MISMATCH for $TARGET"
    echo "  source:   ${LOCAL:-$url}"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    echo "  Refusing to install. If the pin is being deliberately bumped,"
    echo "  update apps/desktop/linphone-sdk-checksums.txt in its own commit."
  } >&2
  exit 1
fi

mkdir -p "$tmp/x"
case "$FORMAT" in
  zip) unzip -q "$artifact" -d "$tmp/x" ;;
  tar.gz) tar -xzf "$artifact" -C "$tmp/x" ;;
esac
staged="$tmp/x/$INNER"
[ -d "$staged" ] || die 1 "verified artifact for $TARGET has no $INNER/ directory"
for rel in "${REQUIRED[@]}"; do
  [ -e "$staged/$rel" ] || die 1 "verified artifact for $TARGET lacks $INNER/$rel"
done
printf '%s\n' "$expected" >"$staged/.sdk-sha256"

# Replace the vendored tree only now that the new one is verified and complete.
dest="$VENDOR_ROOT/$TARGET"
mkdir -p "$VENDOR_ROOT"
rm -rf "$dest"
mv "$staged" "$dest"
echo "installed liblinphone SDK for $TARGET at $dest (sha256 $expected)"
