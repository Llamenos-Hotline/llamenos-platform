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

HUB_URL="${TEST_HUB_URL:-http://localhost:3000}"

# TestDB (tests/db-helpers.ts) asserts persisted state straight from Postgres, so
# it must query the database the server writes to.
#
# Two modes, told apart by whether the caller POINTED the suite at a server:
#
#   TEST_HUB_URL unset  — the suite assumes this machine's dev server on :3000,
#                         so it may also resolve this worktree's database the
#                         same way scripts/dev-bun.sh resolved it for the server.
#                         Both sides then agree by construction.
#
#   TEST_HUB_URL set    — somebody aimed the suite somewhere deliberately, and
#                         nothing here knows what database that server writes to.
#                         DATABASE_URL must be given too (--require-explicit),
#                         because the alternative is resolving a LOCAL database
#                         and asserting against this machine's data while the
#                         server wrote to the target's — a green run that proved
#                         nothing. Against a deployment that is the DEFAULT
#                         outcome, not an accident: its PostgreSQL publishes no
#                         port, so there is nothing local that could be right.
#
# Derived from TEST_HUB_URL alone, with no "is this remote?" heuristic and no
# separate flag. A heuristic on the hostname gets the common deployed case
# WRONG: an SSH forward puts the deployment on 127.0.0.1, which looks local and
# is not. A flag can disagree with the URL, and then the run is in neither mode
# honestly. "Was the suite pointed at something" has no such failure.
source "$SCRIPT_DIR/lib/worktree-db.sh"
if [[ -n "${TEST_HUB_URL:-}" ]]; then
  echo "[backend-bdd] target: ${HUB_URL} (explicit — DATABASE_URL must name ITS database)"
  if ! worktree_db_export --require-explicit; then
    exit 1
  fi
else
  worktree_db_export
fi

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

# Step 2: Check the backend can actually SERVE, not merely that it is alive.
#
# This gated on /api/health/live, a LIVENESS probe: it reports that the process
# is up and says nothing about its dependencies. A dev server whose database had
# been dropped from under it (a per-worktree test DB removed by teardown, the
# process left running) answered that probe 200 OK indefinitely — so this gate
# went green and the run died two steps later at `api-bootstrap` with "cannot
# run BDD tests without admin account", blaming the admin account when the real
# fault was `database "tel_594161" does not exist`.
#
# /api/health/ready is the READINESS probe and does query PostgreSQL. On that
# same server it correctly returned 503:
#   {"status":"degraded","checks":{"postgres":{"status":"failing",...}}}
# Gating on it turns a misleading later failure into an accurate immediate one,
# and the body is printed so the cause is in the output rather than in a log
# nobody reads.
if ! reporter_run_step "health-check" curl -sf "${HUB_URL}/api/health/ready" >/dev/null 2>&1; then
  echo "Backend at ${HUB_URL} is not READY (liveness can still pass — readiness queries PostgreSQL):"
  curl -s --max-time 10 "${HUB_URL}/api/health/ready" 2>/dev/null | head -c 500
  echo
  echo "Start it with:"
  echo "  docker compose -f deploy/docker/docker-compose.dev.yml up -d && bun run dev:server"
  overall_result="fail"
  reporter_record_suite "health-check" 0 1 0
  reporter_summary "$overall_result"
  exit 1
fi
reporter_record_suite "health-check" 1 0 0

# Step 3: Prove the runner's DATABASE_URL and the server share ONE database.
#
# The suite asserts persisted state straight from PostgreSQL (tests/db-helpers.ts),
# which only means anything if both sides look at the same instance. That was
# checked lazily, on whichever scenario happened to touch TestDB first — so a run
# whose scenarios did not touch it never checked at all, and a run that did failed
# deep inside an unrelated scenario. Against a deployed target the mismatch is the
# DEFAULT (its PostgreSQL publishes no host port), which is the worst version of
# the same bug: a green suite that proved nothing about the deployment.
#
# Checked BEFORE bddgen — which takes minutes — and before any data is written, so
# the run either fails in seconds naming both databases or is known to be measuring
# the right one. Never skipped, never downgraded to a warning.
if ! reporter_run_step "db-identity" bun scripts/check-db-identity.ts; then
  echo "The test runner and ${HUB_URL} are not using the same database (or the"
  echo "server's /api/test-db-identity endpoint is unreachable). Direct-database"
  echo "assertions would be meaningless, so the run stops here."
  overall_result="fail"
  reporter_record_suite "db-identity" 0 1 0
  reporter_summary "$overall_result"
  exit 1
fi
reporter_record_suite "db-identity" 1 0 0

# Step 4: Generate BDD test files from features + step definitions.
# playwright-bdd v8 requires explicit bddgen before test execution, and every BDD
# project runs with missingSteps: "fail-on-gen" (#1153): a scenario selected by a
# project's tag filter with a step that has no definition fails generation here,
# before any backend is needed — instead of being rendered as a silently skipped
# test. Deliberately unimplemented scenarios carry @wip/@fixme with a linked
# issue (enforced by `bun run test-specs:validate`).
#
# `bddgen export` runs first to fill Playwright's TS transform cache from a single
# thread: bddgen itself generates every BDD project concurrently in worker threads,
# and the cache is written non-atomically, so on a cold cache one thread can load a
# step file another is still writing — empty (its steps read as "missing") or
# truncated (bddgen crashes). See the build job in .github/workflows/ci.yml.
if ! reporter_run_step "bddgen" bash -c 'bunx bddgen export > /dev/null && bunx bddgen'; then
  echo "bddgen failed. If it printed 'Missing step definitions', a scenario selected"
  echo "by a BDD project's tag filter has an unbound step: bind it, or tag it"
  echo "@wip / @fixme with a '# ... — #<issue>' comment above the tag."
  overall_result="fail"
  reporter_record_suite "bddgen" 0 1 0
  reporter_summary "$overall_result"
  exit 1
fi
reporter_record_suite "bddgen" 1 0 0

# Step 5: API-level bootstrap — reset DB and create admin account without requiring
# the frontend UI. The bootstrap Playwright project needs the desktop frontend running
# at PLAYWRIGHT_BASE_URL; for backend-only test runs we bypass it via the dev API.
#
# ADMIN_SEED and ADMIN_PUBKEY are a PAIR and only the shell half reads the
# environment: tests/global-setup.ts, tests/helpers.ts and tests/crypto-helpers.ts
# hardcode the same seed, so overriding $ADMIN_SEED here would make this step
# promote one identity while every scenario authenticated as another. Treat the
# default as fixed until that seed is threaded through the TypeScript harness
# too. A DEPLOYED target must therefore be provisioned with THIS pair's
# ADMIN_PUBKEY / ADMIN_DECRYPTION_PUBKEY — see
# docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md, which explains the 401 you get
# otherwise (POST /api/test-reset re-seeds the admin from the server's own
# ADMIN_PUBKEY, deleting the one this step just promoted).
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

# Step 6: Run backend BDD tests via Playwright
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

# Step 7: Run @global-setting scenarios in their own serial project (#676).
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

# Step 8: Run @simulated-telephony scenarios. Serial, and NOT opt-in.
#
# These exercise the MockTelephonyAdapter, which until #1604 required a server started with
# DEMO_MODE=true + DEMO_MODE_CONFIRM=DESTROY_ALL_DATA — a demo-product mode the default BDD
# server never set, so the project sat behind a BDD_DEMO_MODE flag and nothing ran it. The
# mock is now gated on `devSurfacesEnabled` (apps/worker/lib/dev-surfaces.ts), which every
# server this script talks to already satisfies — it is the same condition that lets the
# suite call POST /api/test-reset-no-admin at all. So they run every time, and they fail
# loudly (never skip) if the mock turns out not to be selectable.
if reporter_run_step "backend-bdd-simulated-telephony" bunx playwright test --project=backend-bdd-simulated-telephony --no-deps; then
  parse_playwright_results "$REPORTER_LOG_FILE"
  reporter_record_suite "backend-bdd-simulated-telephony" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
else
  overall_result="fail"
  parse_playwright_results "$REPORTER_LOG_FILE"
  reporter_record_suite "backend-bdd-simulated-telephony" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
fi

# Step 9: Run @signed-webhooks scenarios (#1036) — opt-in. They need a server started with the
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
