#!/usr/bin/env bash
# `bun run db:migrate` — apply the migrations to the database THIS worktree owns.
#
# scripts/run-migrations.ts migrates whatever DATABASE_URL names and has no default,
# which is exactly how a worker that was handed (or typed) the shared dev database's
# URL migrated it (#2659). This wrapper puts the one resolver in front of it, the same
# one the dev server and the BDD runner use (scripts/lib/worktree-db.sh):
#
#   - DATABASE_URL unset  -> this worktree's own database, provisioned if need be
#   - DATABASE_URL set    -> used as-is, unless it names the shared dev database and
#                            this worktree may not use that (a fleet worker never may)
#
# Outside a git checkout (an exported tree, a container) there is no worktree to
# protect: DATABASE_URL is passed straight through, and is still required.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if git rev-parse --show-toplevel >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/scripts/lib/worktree-db.sh"
  worktree_db_export --ensure
fi

exec bun scripts/run-migrations.ts "$@"
