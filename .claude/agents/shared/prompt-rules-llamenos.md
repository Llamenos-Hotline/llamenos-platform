# Project Rules: Llámenos Platform

Paste this block into the "Rules you must follow" section of worker prompts for the Llámenos
platform monorepo (`llamenos-platform` on GitHub; local directory name `llamenos`). This is
the current multi-platform monorepo — it is a different repo from the retired `llamenos-hotline`
v1 project; do not mix their paths, remotes, or scripts.

## Dispatch invocation (for supervisors)

```bash
# DISPATCH_REPO = absolute path of the main llamenos checkout (must already be set — the :? guard
# aborts rather than let dispatch-one.sh fall back to whatever repo the cwd happens to be in).
# WORKTREE_BASE = directory that holds worktrees; defaults to the checkout's parent directory.
: "${DISPATCH_REPO:?set DISPATCH_REPO to the absolute path of the main llamenos checkout}"
export DISPATCH_REPO WORKTREE_BASE="${WORKTREE_BASE:-$(dirname "$DISPATCH_REPO")}"
~/.claude/skills/supervising-dispatched-sessions/dispatch-one.sh <name> <prompt-file> [timeout] [model]
```

Prefix names with `ll-` to disambiguate from other projects in status.sh output.

---

## Llámenos Platform Worker Rules

### Git & Worktrees
- **Always work in your worktree** — never `cd` to or `git checkout` in the main repo checkout (`$DISPATCH_REPO`; it is the first entry of `git worktree list`).
- **Worktrees live at** `$WORKTREE_BASE/<repo-dir>-<name>`, where `<repo-dir>` is the main checkout's directory name (`llamenos` for a default clone). Your own worktree is your current directory.
- **GitHub remote:** `git@github.com:Llamenos-Hotline/llamenos-platform.git`

### Push & PR Creation (GitHub)
```bash
git push -u origin HEAD
gh pr create --title "<type>(<scope>): <description>" --body "## Summary\n<bullets>\n\n## Test plan\n<checklist>"
```
Use `gh` CLI for PR operations. Poll `gh pr view <n> --json statusCheckRollup` for CI status.

### Determinism invariants (every one learned from a live failure)
- **Never merge.** Open exactly one PR with `Closes #<issue>` and stop. Never `--admin`, `--force`, `--approve`, `--no-verify`; never edit a ruleset to land work.
- **Run every command in the FOREGROUND.** A backgrounded run outlives your session; you die with no terminal status and your work is lost.
- **Derive state, never self-report it.** Branch, worktree and PR number come from `git`/`gh` at read time. Your status file never carries a branch or worktree.
- **Stay inside your owned paths.** A file outside them is a scope failure, not a judgement call; stop and report instead.
- **Codegen renames are bulk renames** — never a typealias, never a hand-written duplicate of a generated type.
- **No non-waiting probe may guard a write.** `isVisible()`/`.first()` around a click/fill/toggle is a bug regardless of flakiness.
- **Fix the app, not the test.** A test that passes when its dependency is unreachable is a no-op: make it fail loudly or exclude it by tag.
- **Reproduce before fixing**, and show the failing run in the PR body.

### Build + Test Verification (ALL tiers, MANDATORY before pushing)

**Run every build, test and verification command in the FOREGROUND.** Never background a
command (`&`, `run_in_background`, "launch a monitor and wait for it") — this session ends
the moment your last foreground command returns, and a worker that exits while a background
run is still going leaves no PR and no status (observed 2026-09-13: `ll-sweep-admin-probes-2`).

Run **all applicable test tiers**, not just typecheck+build. CI is not the test runner.

```bash
# 1. Build verification
bun run typecheck
bun run lint
bun run build

# 2. Unit tests (fast, no services needed)
bun run test:worker:unit

# 3. Integration tests (need PostgreSQL — start backing services first per CLAUDE.md)
docker compose -f deploy/docker/docker-compose.dev.yml up -d   # PostgreSQL, RustFS
bun run test:worker:integration

# 4. Backend BDD (against a real running server + real authenticated API — see CLAUDE.md)
bun run dev:server &  # if not already up
bun run test:backend:bdd

# 5. Targeted desktop E2E (Playwright) — target specs that touch your changes
PLAYWRIGHT_TEST=true bunx playwright test <targeted-spec-path> --workers=1
```

- **Start dev services first:** `docker compose -f deploy/docker/docker-compose.dev.yml up -d`, then `bun run dev:server`. Confirm `curl -sf http://localhost:3000/api/health/ready` → 200.
  (`bun run test:docker:up` / `test:docker:down` builds and runs the app inside Docker against the CI compose overlay — use that instead when you need to validate the containerized build itself, not for routine local iteration.)
- **NEVER use `deploy/docker/docker-compose.yml` alone for local dev/testing** — it bundles the app into an image that won't reflect code changes until rebuilt. Use `docker-compose.dev.yml` (backing services) + `bun run dev:server` (app with file watching).
- **Don't run the full suite unless you changed shared infrastructure.** If shared state was touched (routes, schemas, crypto, protocol types), run a broader slice:
  ```bash
  PLAYWRIGHT_TEST=true bunx playwright test --workers=3 --reporter=list
  ```
- If anything fails, diagnose root cause. No blind patches.

### Package Management
- **Package manager:** Bun
- **Lockfile:** `bun.lock` — commit after any package change
- **No in-place edits to shipped drizzle migrations** — create new migration files

### Code Standards
- **Testid-only selectors** in any E2E test — no CSS class or text selectors
- **Root-cause only** — no `--no-verify`, no weakening app code to silence tests
- **If blocked >60 min**, write `status: BLOCKED` and exit. Never push broken code. Exhaust alternative approaches before giving up.

### Test Fixture Maintenance (CRITICAL)
- **When you change types, schemas, or wire formats:** grep ALL test files (`tests/`, `apps/worker/__tests__/`) for stubs/fixtures that construct the old shape. Update them in the SAME commit/PR. Never defer test fixture updates to a follow-up.
- **Refactors that touch shared types are not done until every test stub matches.** A PR that changes an envelope shape MUST also update every test that constructs that envelope.
- **Run tests locally, not just typecheck+build.** Type-checking cannot catch stale runtime test data — only running the tests reveals shape mismatches at the zod validation boundary.

### CI False-Positive Awareness
- **Doc-only PRs skip all test jobs** (unit, integration, BDD, E2E). A "green main" after merging a docs PR is meaningless for test health.
- **Before merging a code PR or release PR**, verify that the last *code-changing* CI run on main was green — not just the latest commit's CI status. Check `gh run list --branch main` and find the most recent run that actually ran tests (not all SKIPPED).
- **After merging a major refactor**, always trigger or wait for a full CI run on a code-changing commit before merging the next PR.

### Release Safety
- **Never merge the release PR autonomously.** The release PR is auto-maintained by knope, lives on branch `release`, title starts with `chore: prepare release v`. Merging it cuts a real release. Only merge when the user explicitly says "cut the release" / "ship it" AND all checks pass.
