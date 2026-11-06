#!/usr/bin/env bash
set -euo pipefail

# Desktop test runner
# Pipeline: codegen -> typecheck -> test:build -> crypto:interop-vectors -> playwright

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/lib/test-reporter.sh"

# Parse arguments
VERBOSE="${VERBOSE:-false}"
NO_CODEGEN="${NO_CODEGEN:-false}"
JSON_OUTPUT="${JSON_OUTPUT:-false}"
REPORTER_TIMEOUT="${REPORTER_TIMEOUT:-1800}"

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

reporter_init "desktop"

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

# Step 3: Test build (Vite with Tauri IPC mocks)
export PLAYWRIGHT_TEST=true
if ! reporter_run_step "test:build" bun run build; then
  overall_result="fail"
  reporter_record_suite "build" 0 1 0
  reporter_summary "$overall_result"
  exit 1
fi
reporter_record_suite "build" 1 0 0

# Step 3.5: Generate crypto interop test vectors (enables crypto-interop.spec.ts)
# Vectors are gitignored (non-deterministic nonces) so must be generated at test time.
# Non-fatal: if cargo is unavailable or compilation fails, the 32 interop tests are skipped.
if command -v cargo &>/dev/null; then
  if reporter_run_step "crypto:interop-vectors" \
      cargo test --manifest-path packages/crypto/Cargo.toml --test interop; then
    reporter_record_suite "crypto:interop-vectors" 1 0 0
  else
    echo "WARNING: crypto interop vector generation failed — interop tests will be skipped" >&2
  fi
fi

# Step 4: Start vite preview server and run Playwright E2E tests
# Start the server in the background — set PLAYWRIGHT_BASE_URL so Playwright
# skips its own webServer (which uses Unix env-var syntax incompatible with Windows).
bunx vite preview --port 8788 --strictPort &
PREVIEW_PID=$!
cleanup_preview() { kill "$PREVIEW_PID" 2>/dev/null || true; wait "$PREVIEW_PID" 2>/dev/null || true; }
trap cleanup_preview EXIT

# Wait for the preview server to be ready (use bun for portability on Windows)
for _i in $(seq 1 30); do
  if bun -e "try{await fetch('http://localhost:8788');process.exit(0)}catch{process.exit(1)}" 2>/dev/null; then
    break
  fi
  sleep 1
done

export PLAYWRIGHT_BASE_URL="http://localhost:8788"
reporter_run_step "playwright" bunx playwright test --project=bootstrap --project=chromium --project=bdd || overall_result="fail"
reporter_record_step_results "playwright" playwright

reporter_summary "$overall_result"

if [[ "$overall_result" == "fail" ]]; then
  exit 1
fi
