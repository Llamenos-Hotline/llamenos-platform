#!/usr/bin/env bash
# Build the linux-x86_64 liblinphone SDK tarball from the pinned Dockerfile
# (#1770, plan Task 1; operator decision 2026-11-24, option (a)).
#
# LOCAL ONLY. This produces a file and prints its sha256; it uploads nothing.
# Publishing the tarball to the release origin is an operator step (it needs
# the release-origin credentials, #719) — see the header of
# apps/desktop/linphone-sdk-checksums.txt for the intended URL.
#
# Usage: scripts/build-linphone-sdk-linux.sh [out-dir]
#   out-dir defaults to apps/desktop/vendor/linphone-sdk-build (gitignored).
#
# Re-running resumes from Docker's layer cache: the compile is split into
# layers in the Dockerfile, so an interrupted build does not start over.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
DOCKERFILE="$ROOT/apps/desktop/linphone-sdk-linux-x86_64.Dockerfile"
OUT="${1:-$ROOT/apps/desktop/vendor/linphone-sdk-build}"

mkdir -p "$OUT"
# The Dockerfile COPYs nothing, so the build context is an empty directory:
# nothing from the working tree can leak into, or perturb, the artifact.
ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
DOCKER_BUILDKIT=1 docker build \
  --platform linux/amd64 \
  --file "$DOCKERFILE" \
  --target artifact \
  --output "type=local,dest=$OUT" \
  "$ctx"

shopt -s nullglob
tarballs=("$OUT"/linphone-sdk-linux-x86_64-*.tar.gz)
[ "${#tarballs[@]}" -eq 1 ] || { echo "expected exactly one tarball in $OUT" >&2; exit 1; }
tarball="${tarballs[0]}"
if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$tarball" | cut -d' ' -f1)"
else digest="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
fi
echo "built:  $tarball"
echo "sha256: $digest"
