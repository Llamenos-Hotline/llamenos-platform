#!/usr/bin/env bash
# Generate the Swift bindings from the llamenos-core Rust crate.
# (The Android Kotlin binding has its own generator: scripts/kotlin-bindings.sh.)
#
# Usage: ./scripts/generate-bindings.sh
#
# The release-bindgen profile is used (strip = false) so UniFFI can read
# metadata symbols from the library.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRATE_DIR="$(dirname "$SCRIPT_DIR")"
cd "$CRATE_DIR"

echo "Building llamenos-core with UniFFI feature (release-bindgen profile)..."
cargo build --profile release-bindgen --features uniffi-bindgen

LIB_PATH="target/release-bindgen/libllamenos_core"

# Detect platform library extension
if [[ "$(uname)" == "Darwin" ]]; then
  LIB_EXT="dylib"
elif [[ "$(uname)" == "Linux" ]]; then
  LIB_EXT="so"
else
  # Windows
  LIB_EXT="dll"
fi

LIBRARY="${LIB_PATH}.${LIB_EXT}"

if [[ ! -f "$LIBRARY" ]]; then
  echo "ERROR: Library not found at $LIBRARY"
  exit 1
fi

echo "Generating Swift bindings..."
mkdir -p bindings/swift
cargo run --features uniffi-bindgen --bin uniffi-bindgen -- \
  generate --library "$LIBRARY" --language swift --out-dir bindings/swift/

echo ""
echo "Bindings generated:"
echo "  Swift:  bindings/swift/"
ls -1 bindings/swift/

echo ""
echo "Done. Copy these into your iOS project."
