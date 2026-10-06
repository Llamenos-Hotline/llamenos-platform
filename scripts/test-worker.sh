#!/usr/bin/env bash
set -euo pipefail

# Worker test runner
# Pipeline: codegen -> typecheck -> worker integration tests

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

reporter_init "worker"

overall_result="pass"

# Step 1: Codegen guard
if [[ "$NO_CODEGEN" != "true" ]]; then
  if ! source "$SCRIPT_DIR/lib/codegen-guard.sh" && run_codegen_guard; then
    overall_result="fail"
    reporter_summary "$overall_result"
    exit 1
  fi
fi

# Step 2: Typecheck
if ! reporter_run_step "typecheck" bun run typecheck; then
  overall_result="fail"
  reporter_record_suite "typecheck" 0 1 0
  reporter_summary "$overall_result"
  exit 1
fi
reporter_record_suite "typecheck" 1 0 0

# Step 3: Worker unit tests
if reporter_run_step "worker unit tests" bun run test:worker:unit; then
  reporter_record_suite "unit" 1 0 0
else
  overall_result="fail"
  reporter_record_suite "unit" 0 1 0
fi

# Step 4: Worker integration tests.
# The wrapper, not `bun run test:worker:integration`: it runs the same vitest
# config and then asserts the suite actually ran (every file collected, test
# count above a floor). The bare npm script stays un-floored on purpose, as the
# escape hatch for working on a single file — see the script's header (#1167).
if reporter_run_step "worker integration tests" bun scripts/test-worker-integration.ts; then
  reporter_record_suite "integration" 1 0 0
else
  overall_result="fail"
  reporter_record_suite "integration" 0 1 0
fi

reporter_summary "$overall_result"

if [[ "$overall_result" == "fail" ]]; then
  exit 1
fi
