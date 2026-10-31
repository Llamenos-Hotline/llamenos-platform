#!/usr/bin/env bash
set -euo pipefail

# Developer setup script for llamenos-core (shared crypto crate).
# Checks prerequisites and verifies the build environment.
#
# Usage:
#   ./scripts/dev-setup.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}OK${NC}    $1"; }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }
fail() { echo -e "  ${RED}FAIL${NC}  $1"; ERRORS=$((ERRORS + 1)); }

ERRORS=0

echo "Llamenos Core — Developer Setup"
echo "================================"
echo ""

# --- Prerequisites ---
echo "Checking prerequisites:"

# Rust
if command -v rustc &>/dev/null; then
  RUST_VER=$(rustc --version | awk '{print $2}')
  ok "Rust $RUST_VER"
  # Check minimum version
  MIN_VER="1.85.0"
  if [[ "$(printf '%s\n' "$MIN_VER" "$RUST_VER" | sort -V | head -1)" != "$MIN_VER" ]]; then
    warn "Rust $RUST_VER may be too old — minimum $MIN_VER recommended"
  fi
else
  fail "Rust not found — install from https://rustup.rs"
fi

# Cargo
if command -v cargo &>/dev/null; then
  ok "Cargo"
else
  fail "Cargo not found"
fi

# wasm-pack (for WASM builds)
if command -v wasm-pack &>/dev/null; then
  ok "wasm-pack $(wasm-pack --version 2>/dev/null | awk '{print $2}')"
else
  warn "wasm-pack not found — install for WASM builds: cargo install wasm-pack"
fi

# cargo-ndk (for Android builds)
if command -v cargo-ndk &>/dev/null; then
  ok "cargo-ndk"
else
  warn "cargo-ndk not found — install for Android builds: cargo install cargo-ndk"
fi

# --- Targets ---
echo ""
echo "Checking Rust targets:"

INSTALLED_TARGETS=$(rustup target list --installed 2>/dev/null)

check_target() {
  local target="$1"
  local label="$2"
  if echo "$INSTALLED_TARGETS" | grep -q "^${target}$"; then
    ok "$label ($target)"
  else
    warn "$label ($target) — install: rustup target add $target"
  fi
}

check_target "wasm32-unknown-unknown" "WASM"
check_target "aarch64-apple-ios" "iOS device"
check_target "aarch64-apple-ios-sim" "iOS simulator"
check_target "aarch64-linux-android" "Android arm64"
check_target "armv7-linux-androideabi" "Android armv7"
check_target "i686-linux-android" "Android x86"
check_target "x86_64-linux-android" "Android x86_64"

# --- Android NDK ---
echo ""
echo "Checking Android NDK:"

if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
  ok "ANDROID_NDK_HOME=$ANDROID_NDK_HOME"
elif [[ -n "${ANDROID_HOME:-}" ]] && [[ -d "${ANDROID_HOME}/ndk" ]]; then
  NDK_DIR=$(ls -d "${ANDROID_HOME}/ndk/"* 2>/dev/null | sort -V | tail -1)
  if [[ -n "$NDK_DIR" ]]; then
    ok "Found NDK at $NDK_DIR (via ANDROID_HOME)"
  else
    warn "ANDROID_HOME set but no NDK found — install via Android Studio SDK Manager"
  fi
else
  warn "Android NDK not found — set ANDROID_NDK_HOME or install via Android Studio"
fi

# --- Tests ---
echo ""
echo "Running cargo test:"

cd "$(dirname "$0")/.."
if cargo test 2>&1 | tail -1 | grep -q "test result: ok"; then
  ok "All tests pass"
else
  fail "Some tests failed — run 'cargo test' for details"
fi

# --- Summary ---
echo ""
if [[ $ERRORS -eq 0 ]]; then
  echo -e "${GREEN}Setup complete!${NC} Key commands:"
  echo "  cargo test                          # Run all tests"
  echo "  cargo build --release               # Release build"
  echo "  ./scripts/generate-bindings.sh      # Generate Swift bindings (Kotlin: ./scripts/kotlin-bindings.sh sync)"
  echo "  ./scripts/build-mobile.sh           # Build for mobile targets"
else
  echo -e "${RED}$ERRORS issue(s) found.${NC} Fix the above errors and re-run this script."
  exit 1
fi
