# Development Setup

See [QUICKSTART.md](./QUICKSTART.md) for the current development setup guide covering all platforms (Desktop, iOS, Android, Backend).

## Multi-Machine Workflow

**Mac M4** (`ssh mac`, 192.168.50.243, user `rhonda`) — iOS builds, XCUITest, UniFFI XCFramework, simulator testing.
**Linux** (192.168.50.95) — Desktop, backend, Android E2E. Coordinate via git push/pull on the `main` branch.

### Mac M4 specifics
- macOS 26.2 (Tahoe), Xcode 26.4.1, iOS Simulator 26.4.1
- Passwordless SSH via `~/.ssh/id_ed25519`
- SSH PATH init required: `eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null; export PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH"`
- Available simulators: iPhone 17 Pro, iPhone 17 Pro Max, iPhone Air, iPhone 17, iPhone 16e, iPad Pro/Air (NO iPhone 16 — not available on Xcode 26.4.1)
- `swift build` does NOT work for iOS-only SPM packages — use `xcodebuild`

## One PostgreSQL database per worktree

Every worktree gets its own database on the one dev Postgres from
`deploy/docker/docker-compose.dev.yml` (no extra containers or ports), so parallel
worktrees no longer `test-reset` each other's data.

- **Opting in**: `bash scripts/worktree-setup.sh` does it — it creates
  `llamenos_wt_<dir>_<hash>` by cloning a schema template (well under a second),
  then sweeps databases of removed worktrees. A worktree that never ran setup stays
  on the shared `llamenos` database and is warned about it on every
  `bun run dev:server` / `bun run test:backend:bdd`; nothing switches implicitly.
- **One resolution for server and tests**: `scripts/lib/worktree-db.sh` composes
  `DATABASE_URL`; `scripts/dev-bun.sh` and `scripts/test-backend-bdd.sh` both source
  it. An explicit `DATABASE_URL` (environment or `.env`) always wins. For a manual
  shell — e.g. `bunx playwright test` directly — run
  `source scripts/lib/worktree-db.sh && worktree_db_export` inside the worktree.
- **Migrations**: the template is keyed by a hash of `drizzle/migrations/*.sql` and
  `scripts/run-migrations.ts`, so a new migration set builds a new template (~4s,
  once). An existing worktree database is migrated forward in place on the next
  `dev:server` start. Use `bun scripts/worktree-db.ts ensure`, not `bun run db:migrate`
  (drizzle-kit keeps a different ledger).
- **Running a second server**: `PORT=3101 bun run dev:server`, then point the tests
  at it with `TEST_HUB_URL=http://localhost:3101 TEST_RELAY_URL=ws://127.0.0.1:3101/ws`.

```bash
bun scripts/worktree-db.ts status          # this worktree's mode, database, template
bun scripts/worktree-db.ts use-shared      # opt out: back to `llamenos` (keeps your DB)
bun scripts/worktree-db.ts use-isolated    # opt in without re-running setup
bun scripts/worktree-db.ts reset --yes     # drop and recreate this worktree's DB
bun scripts/worktree-db.ts teardown --yes  # drop it and forget the opt-in
bun scripts/worktree-db.ts sweep           # dry run: what would be dropped, and why
bun scripts/worktree-db.ts sweep --drop    # what setup runs
```

The sweep only drops a `llamenos_wt_*` database whose recorded provenance names a
worktree that is gone from disk (with its parent directory still present), is no
longer listed by `git worktree list`, has no open sessions, and was first seen gone
more than 24 hours ago (`--grace-hours N`). It never touches `llamenos`, `postgres`,
the `template*` databases, the `llamenos_tpl_*` templates, or any database it did not
create (e.g. hand-made `llamenos_<name>` scratch databases).

**Password mismatch.** The Postgres image reads `POSTGRES_PASSWORD` only when the
volume is first created. If `.env`'s `PG_PASSWORD` has changed since, everything that
connects (`ensure`, `sweep`, `dev:server`) stops with an explicit authentication error,
never printing either password. Set `PG_PASSWORD` in `.env` to the one the volume was
created with (the compose default is `dev`) — `scripts/dev-bun.sh` loads `.env` over the
environment, so exporting it is not enough — or change the role's password in the
container.
