#!/usr/bin/env bash
set -euo pipefail

# Backend BDD test runner
# Runs @backend-tagged Gherkin scenarios against a live backend via API only (no browser).
# Requires a running backend (Docker Compose or wrangler dev).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse arguments (before sourcing test-reporter.sh so REPORTER_TIMEOUT is set first)
VERBOSE="${VERBOSE:-false}"
NO_CODEGEN="${NO_CODEGEN:-false}"
JSON_OUTPUT="${JSON_OUTPUT:-false}"
REPORTER_TIMEOUT="${REPORTER_TIMEOUT:-3600}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose) VERBOSE=true; shift ;;
    --no-codegen) NO_CODEGEN=true; shift ;;
    --json) JSON_OUTPUT=true; shift ;;
    --timeout) REPORTER_TIMEOUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

source "$SCRIPT_DIR/lib/test-reporter.sh"

export VERBOSE JSON_OUTPUT REPORTER_TIMEOUT

cd "$PROJECT_ROOT"

reporter_init "backend-bdd"

overall_result="pass"

# Step 1: Codegen guard (optional)
if [[ "$NO_CODEGEN" != "true" ]]; then
  if ! source "$SCRIPT_DIR/lib/codegen-guard.sh" && run_codegen_guard; then
    overall_result="fail"
    reporter_summary "$overall_result"
    exit 1
  fi
fi

# Step 2: Check backend is reachable
HUB_URL="${TEST_HUB_URL:-http://localhost:3000}"
if ! reporter_run_step "health-check" curl -sf "${HUB_URL}/api/health/live" >/dev/null 2>&1; then
  echo "Backend not reachable at ${HUB_URL}. Start it with:"
  echo "  docker compose -f deploy/docker/docker-compose.dev.yml up -d && bun run dev:server"
  overall_result="fail"
  reporter_record_suite "health-check" 0 1 0
  reporter_summary "$overall_result"
  exit 1
fi
reporter_record_suite "health-check" 1 0 0

# Step 3: API-level bootstrap — reset DB and create admin account without requiring
# the frontend UI. The bootstrap Playwright project needs the desktop frontend running
# at PLAYWRIGHT_BASE_URL; for backend-only test runs we bypass it via the dev API.
ADMIN_SEED="${ADMIN_SEED:-f54a5851e9372b87810a8e60cdd2e7cfd80b6e31c7af18188f7db106ceda8be7}"
E2E_SECRET="${E2E_TEST_SECRET:-${DEV_RESET_SECRET:-test-reset-secret}}"
ADMIN_PUBKEY="79215a4c04f08fcd817c6f820c87169beb8cddf96dfa590a1315556b78af9183"

if reporter_run_step "api-bootstrap" bash -c "
  # Reset DB (clears all data, removes admin)
  curl -sf --max-time 120 -X POST '${HUB_URL}/api/test-reset-no-admin' -H 'X-Test-Secret: ${E2E_SECRET}' > /dev/null || exit 1
  # Re-create admin account via test-promote-admin (no UI needed)
  curl -sf -X POST '${HUB_URL}/api/test-promote-admin' \
    -H 'X-Test-Secret: ${E2E_SECRET}' \
    -H 'Content-Type: application/json' \
    -d '{\"pubkey\":\"${ADMIN_PUBKEY}\"}' > /dev/null || exit 1
"; then
  reporter_record_suite "api-bootstrap" 1 0 0
else
  echo "API bootstrap failed — cannot run BDD tests without admin account"
  overall_result="fail"
  reporter_record_suite "api-bootstrap" 0 1 0
  reporter_summary "$overall_result"
  exit 1
fi

# Step 4: Generate BDD test files from features + step definitions
# playwright-bdd v8 requires explicit bddgen before test execution
bunx bddgen 2>&1

# Step 5: Run backend BDD tests via Playwright
# Uses --no-deps to skip the bootstrap Playwright project (we bootstrapped via API above).
# Backend BDD tests use per-scenario hub isolation (workerHub fixture).
# Worker count is controlled by playwright.config.ts (CI=4, local=3).
if reporter_run_step "backend-bdd" bunx playwright test --project=backend-bdd --no-deps; then
  parse_playwright_results "$REPORTER_LOG_FILE"
  reporter_record_suite "backend-bdd" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
else
  overall_result="fail"
  parse_playwright_results "$REPORTER_LOG_FILE"
  reporter_record_suite "backend-bdd" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
fi

# Step 6: Run @global-setting scenarios in their own serial project (#676).
# These mutate a server-wide system setting (e.g. requireForAdmins) — tagged
# @global-setting and excluded from backend-bdd above, they must never run
# fullyParallel alongside it. workers:1 in playwright.config.ts forces this
# project to execute one scenario at a time; each step file resets the
# setting it touches via an `After` hook (not a separate teardown project).
if reporter_run_step "backend-bdd-global-setting" bunx playwright test --project=backend-bdd-global-setting --no-deps; then
  parse_playwright_results "$REPORTER_LOG_FILE"
  reporter_record_suite "backend-bdd-global-setting" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
else
  overall_result="fail"
  parse_playwright_results "$REPORTER_LOG_FILE"
  reporter_record_suite "backend-bdd-global-setting" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
fi

# Step 7: Run @demo-mode scenarios (#723) — opt-in. They need a server started with
# DEMO_MODE=true + DEMO_MODE_CONFIRM=DESTROY_ALL_DATA (the MockTelephonyAdapter refuses to be
# constructed otherwise), so they are excluded from the default project and only run when the
# caller says the server is in demo mode. They fail loudly if that claim is wrong.
if [[ "${BDD_DEMO_MODE:-false}" == "true" ]]; then
  if reporter_run_step "backend-bdd-demo-mode" bunx playwright test --project=backend-bdd-demo-mode --no-deps; then
    parse_playwright_results "$REPORTER_LOG_FILE"
    reporter_record_suite "backend-bdd-demo-mode" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
  else
    overall_result="fail"
    parse_playwright_results "$REPORTER_LOG_FILE"
    reporter_record_suite "backend-bdd-demo-mode" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
  fi
fi

# Step 8: Run @signed-webhooks scenarios (#1036) — opt-in. They need a server started with the
# env-var Twilio provider (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER) and the
# same values exported to this process so the test can sign webhooks like Twilio does. They fail
# loudly (never skip) if that environment is missing.
if [[ "${BDD_SIGNED_WEBHOOKS:-false}" == "true" ]]; then
  if reporter_run_step "backend-bdd-signed-webhooks" bunx playwright test --project=backend-bdd-signed-webhooks --no-deps; then
    parse_playwright_results "$REPORTER_LOG_FILE"
    reporter_record_suite "backend-bdd-signed-webhooks" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
  else
    overall_result="fail"
    parse_playwright_results "$REPORTER_LOG_FILE"
    reporter_record_suite "backend-bdd-signed-webhooks" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
  fi
fi

reporter_summary "$overall_result"

if [[ "$overall_result" == "fail" ]]; then
  exit 1
fi
