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
#   IOS_SIMULATOR   Name of the dedicated simulator to create-or-reuse
#                   (default: llamenos-dev-ios). Never pass an Xcode default
#                   name here — see the note on find_simulator_udid.
#   MAC_SSH_HOST    SSH host alias for the Mac when running from Linux (default: mac)
#   MAC_PROJECT     Project root on the Mac (default: ~/projects/llamenos)
#   IOS_BUILD_DATA_ROOT / IOS_BUILD_DATA_VOLUME / IOS_BUILD_DATA_MIN_FREE_GIB
#                   Where DerivedData and result bundles go — the external SSD
#                   by default, never Xcode's default location on the internal
#                   disk. See scripts/lib/ios-build-data.sh.

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

# shellcheck source=lib/ios-build-data.sh
source "$SCRIPT_DIR/lib/ios-build-data.sh"

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

# ─── Simulator selection ─────────────────────────────────────
#
# Never a default-named device. Selecting by NAME ("the first available
# iPhone", falling back to `iPhone 17`) makes xcodebuild adopt — or create —
# an Xcode-default device that nothing owns and nothing reaps: on the CI Mac
# one such device sat Shutdown for 61 hours holding 3.86 GiB and pushed the
# host into its own disk floor (#1861). This script create-or-reuses ONE
# dedicated device (default name `llamenos-dev-ios`), resolves it to a UDID,
# and every destination below is `id=`-pinned to that UDID. The Mac's disk
# guard reaps the device once it sits Shutdown past MAC_SIM_STALE_MAX_AGE_HOURS
# (default 24h); the next run just creates it again.

DEV_SIM_NAME="${IOS_SIMULATOR:-llamenos-dev-ios}"

find_simulator_udid() {
  local udid runtime types type err
  udid=$(xcrun simctl list devices available -j 2>/dev/null | python3 -c "
import json, sys
name = sys.argv[1]
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    if 'iOS' not in runtime:
        continue
    for d in devices:
        if d.get('isAvailable') and d.get('name') == name:
            print(d['udid'])
            sys.exit(0)
" "$DEV_SIM_NAME") || true
  if [ -n "$udid" ]; then
    echo "$udid"
    return
  fi

  log "Creating dedicated simulator: $DEV_SIM_NAME"
  runtime=$(xcrun simctl list runtimes -j | python3 -c "
import json, sys
rs = [r for r in json.load(sys.stdin)['runtimes']
      if r.get('isAvailable') and r.get('platform') == 'iOS']
if not rs: sys.exit('no available iOS runtime')
print(sorted(rs, key=lambda r: r['version'], reverse=True)[0]['identifier'])
")
  # Iterate iPhone types newest-first until simctl accepts one: a hardcoded
  # type newer than the installed runtime is listed but refused
  # ("Incompatible device").
  types=$(xcrun simctl list devicetypes -j | python3 -c "
import json, sys
ts = [t['identifier'] for t in json.load(sys.stdin)['devicetypes']
      if t.get('name', '').startswith('iPhone')]
if not ts: sys.exit('simctl lists no iPhone device types')
for t in ts:
    print(t)
")
  err="${TMPDIR:-/tmp}/ios-build-simctl-create.err"
  for type in $types; do
    if udid=$(xcrun simctl create "$DEV_SIM_NAME" "$type" "$runtime" 2>"$err"); then
      log "Created simulator: $DEV_SIM_NAME ($udid)"
      echo "$udid"
      return
    fi
    warn "simctl refused $type on $runtime: $(tr '\n' ' ' < "$err")"
  done
  err "could not create an iPhone simulator on $runtime; simctl refused every iPhone device type"
  return 1
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
  echo "  $DEV_SIM_NAME ($(find_simulator_udid))"
  echo ""
  echo "=== Build data (DerivedData, result bundles) ==="
  ( ios_build_data_preflight "$PROJECT_ROOT" ) || echo "  build/test/uitest will refuse until this is fixed"
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
  ios_build_data_preflight "$PROJECT_ROOT"
  ensure_xcodeproj

  local sim_udid
  sim_udid=$(find_simulator_udid)
  log "Using simulator: $DEV_SIM_NAME ($sim_udid)"

  cd "$IOS_DIR"
  xcodebuild build \
    -project Llamenos.xcodeproj \
    -scheme "$XCODE_SCHEME" \
    -destination "platform=iOS Simulator,id=$sim_udid" \
    -derivedDataPath "$IOS_DERIVED_DATA_PATH" \
    -quiet \
    2>&1

  log "Build succeeded."
}

cmd_test() {
  log "Running iOS unit tests..."
  ios_build_data_preflight "$PROJECT_ROOT"
  ensure_xcodeproj

  local sim_udid
  sim_udid=$(find_simulator_udid)
  log "Using simulator: $DEV_SIM_NAME ($sim_udid)"

  cd "$IOS_DIR"
  xcodebuild test \
    -project Llamenos.xcodeproj \
    -scheme "$XCODE_SCHEME" \
    -only-testing:LlamenosTests \
    -destination "platform=iOS Simulator,id=$sim_udid" \
    -derivedDataPath "$IOS_DERIVED_DATA_PATH" \
    2>&1 | filter_xcodebuild

  log "Unit tests complete."
}

cmd_uitest() {
  log "Running XCUITests on simulator (parallel, 4 workers)..."
  ios_build_data_preflight "$PROJECT_ROOT"
  ensure_xcodeproj

  local sim_udid
  sim_udid=$(find_simulator_udid)
  log "Using simulator: $DEV_SIM_NAME ($sim_udid)"

  # Worker count: default 4 (Mac M4 has 4 performance + 4 efficiency cores).
  # Override with IOS_TEST_WORKERS env var.
  local workers="${IOS_TEST_WORKERS:-4}"

  local docker_dir="$PROJECT_ROOT/deploy/docker"
  local started_docker=false

  # Start Docker Compose test backend if not already running
  if [ -f "$docker_dir/docker-compose.test.yml" ]; then
    if ! curl -sf "http://localhost:3000/api/health" &>/dev/null; then
      log "Starting Docker Compose test backend..."
      # The compose app mounts the ban-list and messaging-thread hash keys from
      # ./secrets/ and refuses to start without them. Create development keys if
      # absent (gitignored, never printed, kept across runs).
      # shellcheck source=lib/server-hash-keys.sh
      source "$PROJECT_ROOT/scripts/lib/server-hash-keys.sh"
      ensure_hash_key_files "$docker_dir/secrets" 0444
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

  local result_bundle
  result_bundle="$IOS_RESULTS_DIR/uitest-$(date +%Y%m%d-%H%M%S).xcresult"

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
    -destination "platform=iOS Simulator,id=$sim_udid" \
    -derivedDataPath "$IOS_DERIVED_DATA_PATH" \
    -parallel-testing-enabled YES \
    -parallel-testing-worker-count "$workers" \
    -resultBundlePath "$result_bundle" \
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
  log "Test result bundle: $result_bundle"

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
  echo "  IOS_SIMULATOR  Name of the dedicated simulator to create-or-reuse (default: llamenos-dev-ios)"
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
