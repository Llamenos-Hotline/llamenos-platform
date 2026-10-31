#!/usr/bin/env bash
# The one place the Android UniFFI Kotlin binding is generated, installed and checked.
#
# Usage:
#   ./scripts/kotlin-bindings.sh sync    # regenerate and overwrite the tracked binding
#   ./scripts/kotlin-bindings.sh check   # regenerate, fail if the tracked binding differs
#
# Gradle compiles apps/android/.../org/llamenos/core/llamenos_core.kt, and
# Android-only work (compile gate, unit tests, lint) has no Rust toolchain, so
# unlike the iOS binding the file stays tracked. A tracked generated file is a
# snapshot of code it is no longer derived from unless something regenerates it
# and compares: `check` is that something (crypto-tests runs it), and `sync` is
# the only way the file is meant to change (build-mobile.sh android runs it).
#
# Generation is made deterministic on purpose:
#   --no-format  uniffi-bindgen otherwise runs ktlint when it happens to be on
#                PATH, so the same crate would yield different bytes per machine.
#   dev profile  the binding is derived from the library's UniFFI metadata, which
#                is profile-independent (verified byte-identical to release-bindgen),
#                and the dev build is what cargo test already compiled.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRATE_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$CRATE_DIR/../.." && pwd)"
TRACKED="$REPO_ROOT/apps/android/app/src/main/java/org/llamenos/core/llamenos_core.kt"
LIB="$CRATE_DIR/target/debug/libllamenos_core"
if [[ "$(uname)" == "Darwin" ]]; then LIB="$LIB.dylib"; else LIB="$LIB.so"; fi

MODE="${1:-}"
if [[ "$MODE" != "sync" && "$MODE" != "check" ]]; then
  echo "Usage: $0 sync|check" >&2
  exit 2
fi

cd "$CRATE_DIR"

# stderr, not stdout: cargo's progress is noise next to the verdict below.
cargo build --features uniffi-bindgen >&2
[[ -f "$LIB" ]] || { echo "ERROR: bindgen library not found at $LIB" >&2; exit 1; }

OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
cargo run --quiet --features uniffi-bindgen --bin uniffi-bindgen -- \
  generate --library "$LIB" --language kotlin --no-format --out-dir "$OUT_DIR" >&2

GENERATED="$OUT_DIR/org/llamenos/core/llamenos_core.kt"
[[ -s "$GENERATED" ]] || { echo "ERROR: uniffi-bindgen produced no Kotlin at $GENERATED" >&2; exit 1; }

if [[ "$MODE" == "sync" ]]; then
  mkdir -p "$(dirname "$TRACKED")"
  cp "$GENERATED" "$TRACKED"
  echo "Wrote ${TRACKED#"$REPO_ROOT"/}"
  exit 0
fi

if cmp -s "$GENERATED" "$TRACKED"; then
  echo "OK: ${TRACKED#"$REPO_ROOT"/} matches the crate's UniFFI surface."
  exit 0
fi

# Public functions, by name, so the failure says WHAT drifted and not just that
# something did. Anything the symbol lists do not explain (a signature change,
# a doc comment, a uniffi upgrade) is still caught by the byte comparison above.
symbols() { grep -oE '^\s*(@Throws\([^)]*\)\s*)?fun `[A-Za-z0-9_]+`' "$1" | grep -oE '`[A-Za-z0-9_]+`' | tr -d '`' | sort -u; }
MISSING="$(comm -23 <(symbols "$GENERATED") <(symbols "$TRACKED"))"
STALE="$(comm -13 <(symbols "$GENERATED") <(symbols "$TRACKED"))"

{
  echo "ERROR: ${TRACKED#"$REPO_ROOT"/} has drifted from the Rust crate's UniFFI surface."
  if [[ -n "$MISSING" ]]; then
    echo "  exported by the crate, absent from the committed Kotlin:"
    sed 's/^/    - /' <<<"$MISSING"
  fi
  if [[ -n "$STALE" ]]; then
    echo "  in the committed Kotlin, no longer exported by the crate:"
    sed 's/^/    - /' <<<"$STALE"
  fi
  if [[ -z "$MISSING" && -z "$STALE" ]]; then
    echo "  same function names, different bytes (a changed signature, doc comment or uniffi version):"
    diff -u "$TRACKED" "$GENERATED" | head -40 | sed 's/^/    /'
  fi
  echo "  Regenerate and commit it: packages/crypto/scripts/kotlin-bindings.sh sync"
} >&2
exit 1
