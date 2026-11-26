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

## The dev database: what is guaranteed, and what is not

There is ONE dev Postgres (`deploy/docker/docker-compose.dev.yml`). On it sit the
**shared** `llamenos` database — the primary checkout's — and one `llamenos_wt_*`
database per linked worktree. Two layers keep worktrees off the shared one:

| Layer | What it stops | What it does not stop |
|---|---|---|
| **Convention** (#2659/#2703) — the resolver, `scripts/lib/worktree-db.sh` | Every sanctioned path (`dev:server`, `test:backend:bdd`, `db:migrate`, the integration wrappers) lands a linked worktree on its own database; a fleet worktree is refused the shared one outright. | Anything that bypasses the wrappers. |
| **Database boundary** (#2705) — two Postgres roles | Any connection as the well-known role — a hand-typed `psql`, a one-off script, a `bun -e` snippet, a bootstrap — can **read** the shared database and nothing else: writes, `TRUNCATE`, DDL, migrations, resets and `DROP DATABASE` are refused by Postgres itself. | A process that reads the primary's owner secret, or `docker exec`s into the container (its local socket is trusted). Those are deliberate escalations. |

**In force today: non-primary checkouts are READ-ONLY on the shared database.** That is
the whole guarantee. It is *not* per-worktree isolation: every worktree connects as the
same well-known role, which owns every `llamenos_wt_*` database, so one worktree can
still write — or drop — another worktree's own database. Do not assume more than that.

The two roles:

- **`llamenos`** — the well-known role: `PG_PASSWORD`, the compose default, every
  documented and hand-typed URL. `NOSUPERUSER CREATEDB`, member of `pg_read_all_data`
  and `pg_signal_backend` (so `DROP DATABASE … WITH (FORCE)` on its own databases can end
  an autovacuum worker — it still cannot signal the owner's superuser sessions).
  Owns every database except `llamenos` and `postgres`.
- **`llamenos_owner`** — the cluster's bootstrap superuser, owner of `llamenos`. Its
  password is a random secret in the **primary checkout's git dir**
  (`.git/llamenos-dev-db-owner`, mode 0600) — never in `.env`, which every worktree
  symlinks. Only the primary checkout's resolver hands out a URL carrying it.

What a refusal looks like, from any worktree:

```text
$ psql postgresql://llamenos:dev@localhost:5432/llamenos -c 'DELETE FROM hubs'
NOTICE:  connected to the SHARED dev database "llamenos" as role "llamenos", which is READ-ONLY here
DETAIL:  Writes, DDL, migrations, resets and drops are refused by the database (#2705). Only the primary checkout may change it.
HINT:  Use your worktree's own database: unset DATABASE_URL (the dev server and test runners provision llamenos_wt_* for you).
ERROR:  permission denied for table hubs
```

`bun scripts/run-migrations.ts` pointed at it stops with `REFUSED by the database: role
"llamenos" may not create objects in schema public of "llamenos"`.

**Setting it up.** Nothing to do by hand: `bun run dev:server`, `bun run test:backend:bdd`
and `scripts/worktree-setup.sh` run `bun scripts/worktree-db.ts secure-shared` first. On a
cluster that has never been secured (a fresh volume, or one that predates #2705) it renames
the bootstrap superuser to `llamenos_owner`, writes its secret to the primary's git dir,
recreates `llamenos` as above, ends sessions opened with the old all-powerful credential,
and hands every non-shared database to `llamenos`. Any checkout may do that — it only
*removes* rights from a credential every worktree already holds. Afterwards it is a no-op.
It only ever acts on a cluster started with `cluster_name=llamenos-dev` (the dev compose
file sets it), never on CI's or a containerised stack's Postgres.

```bash
bun scripts/worktree-db.ts check-boundary   # prove it from the database's side (exit 5 if not in force)
bun scripts/worktree-db.ts status           # includes a `boundary` line
bun scripts/worktree-db.ts secure-shared    # convert / heal; idempotent
bun scripts/worktree-db.ts secure-shared --rotate-owner-password
                                            # primary only: a new owner secret, set through the
                                            # container's local socket — for a primary that lost
                                            # the file, or a cluster secured from another clone
```

The signal-notifier sidecar (`--profile signal`) has its own `signal_notifier` database
for the same reason; `secure-shared` creates it. `scripts/test-integration-full.sh` runs
its own compose project (`llamenos-integration-full`) and refuses to start while the dev
stack is up — it used to share the dev stack's project name, so its teardown's `down -v`
deleted every checkout's database.

## One PostgreSQL database per worktree

Every linked worktree gets its own database on that one dev Postgres (no extra
containers or ports), so parallel worktrees do not `test-reset` each other's data.

- **Provisioning**: a linked worktree is isolated by default and provisioned on first
  use (`bun run dev:server`, the BDD runner, or `bash scripts/worktree-setup.sh`) by
  cloning a schema template — well under a second. A fleet worktree (branch `fleet/*`
  or directory `llamenos-fleet-*`) is isolated always. Only the primary checkout uses
  the shared `llamenos` database, and is warned about it until it chooses.
- **One resolution for server and tests**: `scripts/lib/worktree-db.sh` composes
  `DATABASE_URL`; `scripts/dev-bun.sh` and `scripts/test-backend-bdd.sh` both source
  it. An explicit `DATABASE_URL` (environment or `.env`) always wins, after the same
  shared-database check. For a manual shell — e.g. `bunx playwright test` directly — run
  `source scripts/lib/worktree-db.sh && worktree_db_export` inside the worktree.
- **Migrations**: the template is keyed by a hash of `drizzle/migrations/*.sql` and
  `scripts/run-migrations.ts`, so a new migration set builds a new template (~4s,
  once). An existing worktree database is migrated forward in place on the next
  `dev:server` start. Use `bun scripts/worktree-db.ts ensure`, not `bun run db:migrate`
  (drizzle-kit keeps a different ledger).
- **Running a second server**: `PORT=3101 bun run dev:server`, then point the tests
  at it with `TEST_HUB_URL=http://localhost:3101 TEST_RELAY_URL=ws://127.0.0.1:3101/ws`.

```bash
bun scripts/worktree-db.ts status          # this worktree's mode, database, template, boundary
bun scripts/worktree-db.ts use-shared      # a linked worktree: needs LLAMENOS_ALLOW_SHARED_DB=1, and is READ-ONLY there
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
created with (for a volume created without one, the default in `docker-compose.dev.yml`) —
`scripts/dev-bun.sh` loads `.env` over the
environment, so exporting it is not enough — or change the role's password in the
container. `PG_PASSWORD` is the well-known role's password only; the owner's is the file
above, and a mismatch there says so and names `--rotate-owner-password`.
