#!/usr/bin/env bash
# iOS build pipeline — runs on Mac; auto-SSHes when run from Linux.
#
# Usage:
#   ./scripts/ios-build.sh status      # Check Xcode/toolchain status
#   ./scripts/ios-build.sh setup       # Install Rust + iOS targets + xcodegen
#   ./scripts/ios-build.sh build       # Build app via xcodegen + xcodebuild
#   ./scripts/ios-build.sh test        # Run unit tests (xcodegen project)
#   ./scripts/ios-build.sh uitest      # Run XCUITests on simulator
#   ./scripts/ios-build.sh xcframework # Build LlamenosCoreFFI XCFramework
#   ./scripts/ios-build.sh all         # xcframework + build + test + uitest
#
# Environment:
#   IOS_SIMULATOR   Simulator device name (default: auto-detected)
#   MAC_SSH_HOST    SSH host alias for the Mac when running from Linux (default: mac)
#   MAC_PROJECT     Project root on the Mac (default: ~/projects/llamenos)

set -euo pipefail

# ─── Auto-SSH when not on macOS ───────────────────────────────
# Transparently forwards the command to the Mac so `bun run ios:*`
# works from any machine (Linux dev box, CI, etc.).
if [[ "$(uname)" != "Darwin" ]]; then
  MAC_HOST="${MAC_SSH_HOST:-mac}"
  MAC_PROJECT="${MAC_PROJECT:-~/projects/llamenos}"
  exec ssh "$MAC_HOST" \
    "cd ${MAC_PROJECT} && eval \"\$(/opt/homebrew/bin/brew shellenv)\" 2>/dev/null; export PATH=\"\$HOME/.asdf/shims:\$HOME/.asdf/bin:\$PATH\"; bash scripts/ios-build.sh $*"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IOS_DIR="$PROJECT_ROOT/apps/ios"
CRYPTO_DIR="$PROJECT_ROOT/packages/crypto"

XCODE_SCHEME="Llamenos"
XCODE_PROJECT="$IOS_DIR/Llamenos.xcodeproj"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[ios]${NC} $*"; }
warn() { echo -e "${YELLOW}[ios]${NC} $*"; }
err()  { echo -e "${RED}[ios]${NC} $*" >&2; }
info() { echo -e "${BLUE}[ios]${NC} $*"; }

# ─── Simulator detection ─────────────────────────────────────

find_simulator() {
  if [ -n "${IOS_SIMULATOR:-}" ]; then
    echo "$IOS_SIMULATOR"
    return
  fi
  xcrun simctl list devices available -j 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in sorted(data.get('devices', {}).items(), reverse=True):
    if 'iOS' in runtime:
        for d in devices:
            if d.get('isAvailable') and 'iPhone' in d.get('name', ''):
                print(d['name'])
                sys.exit(0)
print('iPhone 17')
" 2>/dev/null || echo "iPhone 17"
}

# ─── Helpers ──────────────────────────────────────────────────

ensure_xcodeproj() {
  if [ ! -d "$XCODE_PROJECT" ]; then
    log "Generating Xcode project from project.yml..."
    cd "$IOS_DIR" && xcodegen generate
  fi
}

# Filter xcodebuild output to show only relevant lines (errors, warnings, test results)
# Uses --line-buffered to avoid pipe buffering hangs
filter_xcodebuild() {
  if command -v xcbeautify &>/dev/null; then
    xcbeautify --quiet
  else
    grep --line-buffered -E '(Test Case|Test Suite|error:|warning:|BUILD|FAILED|passed|failed|\*\*|Executed)' || true
  fi
}

# ─── Commands ─────────────────────────────────────────────────

cmd_status() {
  log "Checking toolchain status..."
  echo ""
  echo "=== macOS ==="
  sw_vers
  echo ""
  echo "=== Xcode ==="
  xcodebuild -version 2>&1 | head -2
  echo ""
  echo "=== xcodegen ==="
  xcodegen --version 2>&1 || echo "NOT INSTALLED — brew install xcodegen"
  echo ""
  echo "=== Rust ==="
  if command -v rustc &>/dev/null; then
    rustc --version
    echo "  iOS targets:"
    rustup target list --installed 2>/dev/null | grep "ios" || echo "  none"
  else
    echo "  NOT INSTALLED — run: ./scripts/ios-build.sh setup"
  fi
  echo ""
  echo "=== Simulators (iPhone) ==="
  xcrun simctl list devices available | grep -E "iPhone" | head -10
  echo ""
  echo "=== Selected Simulator ==="
  echo "  $(find_simulator)"
}

cmd_setup() {
  log "Setting up build toolchain..."

  if ! command -v rustc &>/dev/null; then
    log "Installing Rust via rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    source "$HOME/.cargo/env"
  else
    info "Rust already installed: $(rustc --version)"
  fi

  log "Adding iOS cross-compilation targets..."
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim

  if ! command -v xcodegen &>/dev/null; then
    log "Installing xcodegen via Homebrew..."
    brew install xcodegen
  else
    info "xcodegen already installed."
  fi

  if ! command -v xcbeautify &>/dev/null; then
    log "Installing xcbeautify via Homebrew..."
    brew install xcbeautify
  else
    info "xcbeautify already installed."
  fi

  log "Setup complete. Run './scripts/ios-build.sh status' to verify."
}

cmd_xcframework() {
  log "Building LlamenosCoreFFI XCFramework..."
  cd "$CRYPTO_DIR"
  bash scripts/build-mobile.sh ios

  log "Installing XCFramework to apps/ios/..."
  rm -rf "$IOS_DIR/LlamenosCoreFFI.xcframework"
  cp -R dist/ios/LlamenosCoreFFI.xcframework "$IOS_DIR/LlamenosCoreFFI.xcframework"
  cp dist/ios/LlamenosCore.swift "$IOS_DIR/Sources/Generated/LlamenosCore.swift"

  log "XCFramework built and installed."
}

cmd_build() {
  log "Building iOS app..."
  ensure_xcodeproj

  local sim_device
  sim_device=$(find_simulator)
  log "Using simulator: $sim_device"

  cd "$IOS_DIR"
  xcodebuild build \
    -project Llamenos.xcodeproj \
    -scheme "$XCODE_SCHEME" \
    -destination "platform=iOS Simulator,name=$sim_device" \
    -quiet \
    2>&1

  log "Build succeeded."
}

cmd_test() {
  log "Running iOS unit tests..."
  ensure_xcodeproj

  local sim_device
  sim_device=$(find_simulator)
  log "Using simulator: $sim_device"

  cd "$IOS_DIR"
  xcodebuild test \
    -project Llamenos.xcodeproj \
    -scheme "$XCODE_SCHEME" \
    -only-testing:LlamenosTests \
    -destination "platform=iOS Simulator,name=$sim_device" \
    2>&1 | filter_xcodebuild

  log "Unit tests complete."
}

cmd_uitest() {
  log "Running XCUITests on simulator (parallel, 4 workers)..."
  ensure_xcodeproj

  local sim_device
  sim_device=$(find_simulator)
  log "Using simulator: $sim_device"

  # Worker count: default 4 (Mac M4 has 4 performance + 4 efficiency cores).
  # Override with IOS_TEST_WORKERS env var.
  local workers="${IOS_TEST_WORKERS:-4}"

  local docker_dir="$PROJECT_ROOT/deploy/docker"
  local started_docker=false

  # Start Docker Compose test backend if not already running
  if [ -f "$docker_dir/docker-compose.test.yml" ]; then
    if ! curl -sf "http://localhost:3000/api/health" &>/dev/null; then
      log "Starting Docker Compose test backend..."
      # The compose app mounts the ban-list hash key from ./secrets/ban-hash-key
      # and refuses to start without it. Create a development key if absent
      # (gitignored, never printed, kept across runs).
      # shellcheck source=lib/ban-hash-key.sh
      source "$PROJECT_ROOT/scripts/lib/ban-hash-key.sh"
      ensure_ban_hash_key_file "$docker_dir/secrets/ban-hash-key" 0444
      cd "$docker_dir"
      docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build app 2>&1 || {
        warn "Docker Compose start failed — running UI tests without API backend"
      }
      started_docker=true

      # Wait for backend to be ready (up to 30s)
      local attempts=0
      while ! curl -sf "http://localhost:3000/api/health" &>/dev/null; do
        attempts=$((attempts + 1))
        if [ $attempts -ge 30 ]; then
          warn "Backend did not become ready in 30s — continuing anyway"
          break
        fi
        sleep 1
      done
      if [ $attempts -lt 30 ]; then
        log "Docker Compose backend ready."
      fi
    else
      info "Docker Compose backend already running on localhost:3000"
    fi
  fi

  cd "$IOS_DIR"
  set +e
  # Use UITesting configuration so the app is compiled with UI_TESTING=1, which
  # enables the test-automation hooks in AppState (mock identity injection,
  # keychain reset, etc.). These hooks are stripped from Debug and Release builds.
  TEST_HUB_URL="${TEST_HUB_URL:-http://localhost:3000}" \
  xcodebuild test \
    -project Llamenos.xcodeproj \
    -scheme "$XCODE_SCHEME" \
    -configuration UITesting \
    -only-testing:LlamenosUITests \
    -destination "platform=iOS Simulator,name=$sim_device" \
    -parallel-testing-enabled YES \
    -parallel-testing-worker-count "$workers" \
    -resultBundlePath /tmp/llamenos-uitest.xcresult \
    2>&1 | filter_xcodebuild
  local exit_code=$?
  set -e

  # Stop Docker Compose if we started it
  if [ "$started_docker" = true ]; then
    log "Stopping Docker Compose test backend..."
    cd "$docker_dir"
    docker compose -f docker-compose.yml -f docker-compose.test.yml down 2>&1 || true
  fi

  # Show test summary
  echo ""
  log "Test result bundle: /tmp/llamenos-uitest.xcresult"

  if [ $exit_code -ne 0 ]; then
    warn "Some UI tests failed (exit code $exit_code)"
    return $exit_code
  fi
  log "All XCUITests passed."
}

cmd_all() {
  cmd_xcframework
  cmd_build
  cmd_test
  cmd_uitest
  log "All iOS build steps completed successfully."
}

cmd_help() {
  echo "Usage: $0 <command>"
  echo ""
  echo "Commands:"
  echo "  status       Check Xcode, Rust, Swift, xcodegen, and simulator status"
  echo "  setup        Install Rust, iOS targets, xcodegen, and xcbeautify (first-time)"
  echo "  build        Build the iOS app (generates .xcodeproj via xcodegen if needed)"
  echo "  test         Run unit tests via xcodebuild (LlamenosTests target)"
  echo "  uitest       Run XCUITests on a simulator (LlamenosUITests target)"
  echo "  xcframework  Build the LlamenosCoreFFI XCFramework (requires Xcode + Rust)"
  echo "  all          xcframework + build + test + uitest"
  echo ""
  echo "Environment variables:"
  echo "  IOS_SIMULATOR  Override simulator device name (default: auto-detected)"
}

# ─── Main ─────────────────────────────────────────────────────

ACTION="${1:-help}"
case "$ACTION" in
  status)      cmd_status ;;
  setup)       cmd_setup ;;
  xcframework) cmd_xcframework ;;
  build)       cmd_build ;;
  test)        cmd_test ;;
  uitest)      cmd_uitest ;;
  all)         cmd_all ;;
  help|--help|-h) cmd_help ;;
  *)
    err "Unknown command: $ACTION"
    echo ""
    cmd_help
    exit 1
    ;;
esac
