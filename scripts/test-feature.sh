#!/usr/bin/env bash
set -euo pipefail

# Cross-platform feature test runner
# Maps a feature name to test files across all platforms and runs only those tests

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/platform-detect.sh"
source "$SCRIPT_DIR/lib/test-reporter.sh"

# Parse arguments
VERBOSE="${VERBOSE:-false}"
NO_CODEGEN="${NO_CODEGEN:-false}"
JSON_OUTPUT="${JSON_OUTPUT:-false}"
TIMEOUT="${REPORTER_TIMEOUT:-600}"
FEATURE_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) VERBOSE=true; shift ;;
    --no-codegen) NO_CODEGEN=true; shift ;;
    --json) JSON_OUTPUT=true; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -*)  echo "Unknown option: $1"; exit 1 ;;
    *)   FEATURE_NAME="$1"; shift ;;
  esac
done

if [[ -z "$FEATURE_NAME" ]]; then
  echo "Usage: test-feature.sh [options] <feature-name>"
  echo ""
  echo "Examples:"
  echo "  test-feature.sh auth"
  echo "  test-feature.sh notes"
  echo "  test-feature.sh crypto"
  echo ""
  echo "Options:"
  echo "  --verbose      Full unfiltered output"
  echo "  --no-codegen   Skip codegen guard"
  echo "  --json         JSON output for CI"
  echo "  --timeout N    Override timeout in seconds"
  exit 1
fi

export VERBOSE JSON_OUTPUT REPORTER_TIMEOUT="$TIMEOUT"

cd "$PROJECT_ROOT"

# Colors
if [[ -t 1 ]] && [[ "${JSON_OUTPUT}" != "true" ]]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  DIM='\033[2m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' DIM='' CYAN='' RESET=''
fi

echo -e "${BOLD}Feature Test: ${CYAN}${FEATURE_NAME}${RESET}"

available="$(detect_platforms)"
overall_exit=0

# Search for matching tests per platform
# Desktop: Playwright spec files
if [[ " $available " == *" desktop "* ]]; then
  desktop_matches="$(grep -rl "$FEATURE_NAME" tests/ --include="*.spec.ts" --include="*.test.ts" 2>/dev/null || true)"
  if [[ -n "$desktop_matches" ]]; then
    echo -e "\n${BOLD}Desktop${RESET} -- matching specs:"
    echo "$desktop_matches" | while read -r f; do echo "  $f"; done

    if ! PLAYWRIGHT_TEST=true bunx playwright test --grep "$FEATURE_NAME" 2>&1 | \
      tee "/tmp/test-feature-desktop-$(date +%Y%m%d-%H%M%S).log" | \
      grep --line-buffered -E '(PASS|FAIL|ERROR|passed|failed)'; then
      overall_exit=1
    fi
  else
    echo -e "${DIM}Desktop: no matching test files${RESET}"
  fi
fi

# iOS: Swift test methods
if [[ " $available " == *" ios "* ]]; then
  ios_matches="$(grep -rl "$FEATURE_NAME" apps/ios/Tests/ --include="*.swift" 2>/dev/null || true)"
  if [[ -n "$ios_matches" ]]; then
    echo -e "\n${BOLD}iOS${RESET} -- matching test files:"
    echo "$ios_matches" | while read -r f; do echo "  $f"; done

    # Extract test class names for -only-testing filter
    ios_classes="$(grep -h "class.*XCTestCase" $ios_matches 2>/dev/null | sed 's/.*class \([A-Za-z_]*\).*/\1/' || true)"
    if [[ -n "$ios_classes" ]]; then
      only_testing=""
      for cls in $ios_classes; do
        only_testing="$only_testing -only-testing:LlamenosTests/$cls"
      done
      # UDID-pinned, never name-resolved (#2861): see scripts/lib/ios-simulator.sh.
      # shellcheck source=lib/ios-simulator.sh
      source "$SCRIPT_DIR/lib/ios-simulator.sh"
      ios_sim_udid="$(ios_sim_resolve_dedicated "${IOS_SIMULATOR:-llamenos-dev-ios}")" || exit 1
      xcodebuild test -project apps/ios/Llamenos.xcodeproj -scheme Llamenos \
        -destination "platform=iOS Simulator,id=${ios_sim_udid}" \
        $only_testing \
        CODE_SIGNING_ALLOWED=NO 2>&1 | \
        tee "/tmp/test-feature-ios-$(date +%Y%m%d-%H%M%S).log" | \
        grep --line-buffered -E '(Test Case|Executed|error:)' || overall_exit=1
    fi
  else
    echo -e "${DIM}iOS: no matching test files${RESET}"
  fi
fi

# Android: Kotlin test methods
if [[ " $available " == *" android "* ]]; then
  android_matches="$(grep -rl "$FEATURE_NAME" apps/android/app/src/test/ apps/android/app/src/androidTest/ --include="*.kt" 2>/dev/null || true)"
  if [[ -n "$android_matches" ]]; then
    echo -e "\n${BOLD}Android${RESET} -- matching test files:"
    echo "$android_matches" | while read -r f; do echo "  $f"; done

    # Run matching tests via gradle --tests filter
    apps/android/gradlew -p apps/android testDebugUnitTest --tests "*${FEATURE_NAME}*" 2>&1 | \
      tee "/tmp/test-feature-android-$(date +%Y%m%d-%H%M%S).log" | \
      grep --line-buffered -E '(> Task|BUILD|PASSED|FAILED)' || overall_exit=1
  else
    echo -e "${DIM}Android: no matching test files${RESET}"
  fi
fi

# Crypto: Rust test functions
if [[ " $available " == *" crypto "* ]]; then
  crypto_matches="$(grep -rl "$FEATURE_NAME" packages/crypto/src/ packages/crypto/tests/ --include="*.rs" 2>/dev/null || true)"
  if [[ -n "$crypto_matches" ]]; then
    echo -e "\n${BOLD}Crypto${RESET} -- matching test files:"
    echo "$crypto_matches" | while read -r f; do echo "  $f"; done

    cargo test --manifest-path packages/crypto/Cargo.toml --features mobile "$FEATURE_NAME" 2>&1 | \
      tee "/tmp/test-feature-crypto-$(date +%Y%m%d-%H%M%S).log" | \
      grep --line-buffered -E '(test .* \.\.\.|test result:|running|FAILED)' || overall_exit=1
  else
    echo -e "${DIM}Crypto: no matching test files${RESET}"
  fi
fi

# Worker: Vitest
if [[ " $available " == *" worker "* ]]; then
  worker_matches="$(grep -rl "$FEATURE_NAME" apps/worker/ --include="*.test.ts" --include="*.spec.ts" 2>/dev/null || true)"
  if [[ -n "$worker_matches" ]]; then
    echo -e "\n${BOLD}Worker${RESET} -- matching test files:"
    echo "$worker_matches" | while read -r f; do echo "  $f"; done

    bunx vitest run --config vitest.unit.config.ts --reporter=verbose -t "$FEATURE_NAME" 2>&1 | \
      tee "/tmp/test-feature-worker-$(date +%Y%m%d-%H%M%S).log" | \
      grep --line-buffered -E '(PASS|FAIL|Tests|test)' || overall_exit=1
  else
    echo -e "${DIM}Worker: no matching test files${RESET}"
  fi
fi

echo ""
if [[ "$overall_exit" -eq 0 ]]; then
  echo -e "${BOLD}=== Feature '${FEATURE_NAME}': ${GREEN}PASS${RESET}${BOLD} ===${RESET}"
else
  echo -e "${BOLD}=== Feature '${FEATURE_NAME}': ${RED}FAIL${RESET}${BOLD} ===${RESET}"
fi

exit "$overall_exit"
