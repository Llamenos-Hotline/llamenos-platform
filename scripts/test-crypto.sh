#!/usr/bin/env bash
set -euo pipefail

# Crypto test runner
# Runs cargo test + clippy on packages/crypto

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/test-reporter.sh"

# Parse arguments
VERBOSE="${VERBOSE:-false}"
NO_CODEGEN="${NO_CODEGEN:-false}"
JSON_OUTPUT="${JSON_OUTPUT:-false}"
REPORTER_TIMEOUT="${REPORTER_TIMEOUT:-300}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) VERBOSE=true; shift ;;
    --no-codegen) NO_CODEGEN=true; shift ;;
    --json) JSON_OUTPUT=true; shift ;;
    --timeout) REPORTER_TIMEOUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

export VERBOSE JSON_OUTPUT REPORTER_TIMEOUT

cd "$PROJECT_ROOT"

reporter_init "crypto"

overall_result="pass"

# Step 1: Codegen guard (optional for crypto, but ensures protocol consistency)
if [[ "$NO_CODEGEN" != "true" ]]; then
  if ! source "$SCRIPT_DIR/lib/codegen-guard.sh" && run_codegen_guard; then
    overall_result="fail"
    reporter_summary "$overall_result"
    exit 1
  fi
fi

# Step 2: cargo test with mobile features
reporter_run_step "cargo test" \
  cargo test --manifest-path packages/crypto/Cargo.toml --features mobile || overall_result="fail"
reporter_record_step_results "cargo test" cargo

# Step 3: cargo clippy (--all-targets so test code is linted too — #1686)
if reporter_run_step "cargo clippy" \
  cargo clippy --manifest-path packages/crypto/Cargo.toml --all-targets -- -D warnings; then
  reporter_record_suite "clippy" 1 0 0
else
  overall_result="fail"
  reporter_record_suite "clippy" 0 1 0
fi

reporter_summary "$overall_result"

if [[ "$overall_result" == "fail" ]]; then
  exit 1
fi
