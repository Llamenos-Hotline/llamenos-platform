#!/usr/bin/env bash
# The one place the iOS UniFFI Swift binding is generated, installed and checked.
# (The Android Kotlin binding has the same shape: scripts/kotlin-bindings.sh.)
#
# Usage:
#   ./scripts/generate-bindings.sh [sync]   # regenerate and overwrite the tracked binding (default)
#   ./scripts/generate-bindings.sh check    # regenerate, fail if the tracked binding differs
#
# bindings/swift/ is tracked generated output: apps/ios/ compiles LlamenosCore.swift,
# and codegen.ts reads it to refuse protocol type names that collide with UniFFI's.
# A tracked generated file is a snapshot of code it is no longer derived from unless
# something regenerates it and compares: `check` is that something (crypto-tests runs
# it), and `sync` is the only way the files are meant to change.
#
# This matters more than it looks. UniFFI hashes a function's *doc comment* into its
# checksum, so editing the doc on an exported function changes the number the loaded
# library reports while every signature is untouched. A stale Swift binding then
# compiles and fails at load with "UniFFI API checksum mismatch" (#2797).
#
# Generation is made deterministic on purpose:
#   --no-format  uniffi-bindgen otherwise runs swift-format when it happens to be on
#                PATH, so the same crate would yield different bytes per machine.
#   dev profile  the binding is derived from the library's UniFFI metadata, which is
#                profile-independent (verified byte-identical to release-bindgen),
#                and the dev build is what cargo test already compiled.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRATE_DIR="$(dirname "$SCRIPT_DIR")"
TRACKED_DIR="$CRATE_DIR/bindings/swift"
FILES=(LlamenosCore.swift LlamenosCoreFFI.h LlamenosCoreFFI.modulemap)
LIB="$CRATE_DIR/target/debug/libllamenos_core"
if [[ "$(uname)" == "Darwin" ]]; then LIB="$LIB.dylib"; else LIB="$LIB.so"; fi

MODE="${1:-sync}"
if [[ "$MODE" != "sync" && "$MODE" != "check" ]]; then
  echo "Usage: $0 [sync|check]" >&2
  exit 2
fi

cd "$CRATE_DIR"

# stderr, not stdout: cargo's progress is noise next to the verdict below.
cargo build --features uniffi-bindgen >&2
[[ -f "$LIB" ]] || { echo "ERROR: bindgen library not found at $LIB" >&2; exit 1; }

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
cargo run --quiet --features uniffi-bindgen --bin uniffi-bindgen -- \
  generate --library "$LIB" --language swift --no-format --out-dir "$OUT_DIR" >&2

for f in "${FILES[@]}"; do
  [[ -s "$OUT_DIR/$f" ]] || { echo "ERROR: uniffi-bindgen produced no $f in $OUT_DIR" >&2; exit 1; }
done

if [[ "$MODE" == "sync" ]]; then
  mkdir -p "$TRACKED_DIR"
  for f in "${FILES[@]}"; do cp "$OUT_DIR/$f" "$TRACKED_DIR/$f"; done
  echo "Wrote packages/crypto/bindings/swift/{$(IFS=,; echo "${FILES[*]}")}"
  exit 0
fi

DRIFTED=()
for f in "${FILES[@]}"; do
  cmp -s "$OUT_DIR/$f" "$TRACKED_DIR/$f" || DRIFTED+=("$f")
done

if [[ ${#DRIFTED[@]} -eq 0 ]]; then
  echo "OK: packages/crypto/bindings/swift/ matches the crate's UniFFI surface."
  exit 0
fi

# Public functions, by name, so the failure says WHAT drifted and not just that
# something did. Anything the symbol lists do not explain (a signature change,
# a doc comment, a uniffi upgrade) is still caught by the byte comparison above.
symbols() { grep -oE '^\s*public func [A-Za-z0-9_]+' "$1" | awk '{print $3}' | sort -u; }
{
  echo "ERROR: packages/crypto/bindings/swift/ has drifted from the Rust crate's UniFFI surface."
  echo "  drifted files: ${DRIFTED[*]}"
  if [[ " ${DRIFTED[*]} " == *" LlamenosCore.swift "* ]]; then
    MISSING="$(comm -23 <(symbols "$OUT_DIR/LlamenosCore.swift") <(symbols "$TRACKED_DIR/LlamenosCore.swift"))"
    STALE="$(comm -13 <(symbols "$OUT_DIR/LlamenosCore.swift") <(symbols "$TRACKED_DIR/LlamenosCore.swift"))"
    [[ -z "$MISSING" ]] || { echo "  exported by the crate, absent from the committed Swift:"; sed 's/^/    - /' <<<"$MISSING"; }
    [[ -z "$STALE" ]] || { echo "  in the committed Swift, no longer exported by the crate:"; sed 's/^/    - /' <<<"$STALE"; }
    if [[ -z "$MISSING" && -z "$STALE" ]]; then
      echo "  same function names, different bytes (a changed signature, doc comment or uniffi version):"
      diff -u "$TRACKED_DIR/LlamenosCore.swift" "$OUT_DIR/LlamenosCore.swift" | head -40 | sed 's/^/    /' || true
    fi
  fi
  echo "  Regenerate and commit it: packages/crypto/scripts/generate-bindings.sh sync"
} >&2
exit 1
