#!/usr/bin/env bash
# `bun run test:worker:integration-bun` — the bun-native integration tier, run against
# the database THIS worktree owns.
#
# The test files read DATABASE_URL and refuse to run without one (#2704): there is no
# default, because a default quietly pointed them at the shared dev database. This
# wrapper supplies it from the one resolver (scripts/lib/worktree-db.sh), the same one
# the dev server, `db:migrate`, the BDD runner and test-worker-integration.ts use:
#
#   - DATABASE_URL unset  -> this worktree's own database, provisioned if need be
#   - DATABASE_URL set    -> used as-is (CI sets one per job), unless it names the shared
#                            dev database and this worktree may not use that
#
# Outside a git checkout there is no worktree to resolve: DATABASE_URL is passed
# through and the test files fail loudly if it is missing.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if git rev-parse --show-toplevel >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/scripts/lib/worktree-db.sh"
  worktree_db_export --ensure
fi

exec bun test apps/worker/__tests__/integration-bun/ "$@"
