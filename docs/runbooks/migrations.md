# Schema Migrations: Expand / Contract

## Purpose

Write a migration the previous release can run against, get it past the
migration safety gate, and know what the gate does again before a deploy.

The gate is one program, `scripts/check-migration-safety.ts`, run in two
places:

| Where | Mode | Judges | Against | Backup |
|-------|------|--------|---------|--------|
| CI, the `migration-drift` job | `--ci` | the migrations this change **adds** (git diff against the base) | no database: every object the change does not create is presumed to exist and be read by N-1 | — |
| Every deploy, before the new image starts (`deploy/ansible`) | `--target` | the migrations the database's **ledger has not applied** | the live catalog of the database about to be migrated, and the release it is actually running | required whenever anything is pending |

Both modes run the same `judge()`. They differ only in where its inputs come
from, so CI and the deploy can never disagree about what a rule means. CI is
the early, conservative read; the deploy check is the authoritative one,
because only it can see the real schema.

## Why every migration must be backward compatible

The previous release (N-1) always runs against the schema the new release (N)
migrates:

- **Helm upgrades.** `RollingUpdate` with `maxSurge: 1, maxUnavailable: 0`
  (`deploy/helm/llamenos/templates/deployment-app.yaml`) keeps the old pod
  serving while the new pod runs its migrations. For the length of the rollout,
  N-1's code reads and writes N's schema.
- **Rollbacks.** Rolling back the image does not roll back the schema. N-1
  boots on N's schema, and its runner skips N's migrations: it looks up only
  its own filenames in `llamenos_schema_migrations` (`scripts/run-migrations.ts`).

So a migration may only **add**. Removing, renaming, retyping or tightening
anything N-1 uses is split across two releases.

## The pattern

| Phase | Release | What ships |
|-------|---------|------------|
| **Expand** | N | Add the new shape next to the old one: a new column, table or enum value that is nullable or has a default. The code writes both shapes and reads the new one, falling back to the old. |
| **Backfill** | N | An `UPDATE … WHERE` (or a batched job) copies old into new. The dual write covers rows the old code writes during the rollout. |
| **Forget** | N+1 | The code stops using the old shape, and the drizzle schema stops declaring it. `bun run db:generate` writes a `DROP`. Delete that statement and keep the generated snapshot. The database keeps the old shape, so N, still running beside the new pod, finds it. |
| **Contract** | N+2 | The migration drops the old shape, annotated `-- migration-safety: allow …`. N+1 no longer declares it, so the gate verifies the annotation and accepts the drop. |

Expand and forget can share a release when nothing in the previous release
still needs the old shape. Contract always comes at least one release after
forget. The gate accepts a drop only once the release being replaced no longer
declares the object. At deploy time that is the release the database actually
runs, read from its ledger, so a deploy that skips the forget release is
refused even though CI passed the contract against its own base.

### Rename a column (`users.team_id` → `users.group_id`)

1. **N, expand + backfill:** `ALTER TABLE users ADD COLUMN group_id text;`
   then `UPDATE users SET group_id = team_id WHERE group_id IS NULL;`. The code
   writes both columns and reads `group_id`, falling back to `team_id`.
2. **N+1, forget:** the code and the drizzle schema drop `team_id`. Keep the
   generated snapshot and remove the generated `DROP COLUMN` from the `.sql`
   file, leaving a comment that says why.
3. **N+2, contract:**

   ```sql
   -- migration-safety: allow column public.users.team_id because group_id replaced it in 0.21.0 (#1234)
   ALTER TABLE "users" DROP COLUMN "team_id";
   ```

Never `RENAME COLUMN`: the previous release still names the old column.

### Make a column NOT NULL (`notes.author`)

The gate never accepts `SET NOT NULL` on a column that already exists. It cannot
prove that the previous release never writes NULL. Replace the column:

1. **N, expand + backfill:** add `author_v2 text NOT NULL DEFAULT ''`. A
   NOT NULL column with a default accepts the previous release's INSERTs,
   which do not name it. Backfill it from `author` and write both.
2. **N+1, forget** `author` (it is nullable, so INSERTs that omit it succeed).
3. **N+2, contract:** drop `author`. If the default on `author_v2` is now
   unwanted, `DROP DEFAULT` on it is accepted only once the release being
   replaced no longer omits it on INSERT: it has to be a release after N.

### Change a column's type (`integer` → `bigint`)

Add a new column of the new type, dual-write, backfill and switch reads. Then
forget and drop the old column, as for a rename. The only in-place changes the
schema contract accepts are the widenings `varchar(n)` → `text` and
`NOT NULL` → nullable.

### Add a NOT NULL column to an existing table

Give it a `DEFAULT`, or an identity, generated or serial type. N-1's INSERTs
do not name the column. Without a default they fail. A NOT NULL column on a
table **created in this release** needs no default: N-1 never writes that table.

### Add UNIQUE, CHECK or FOREIGN KEY constraints, or a unique index

On columns N-1 already writes, the constraint rejects rows N-1 still produces.
Constraints on columns or tables that do not exist yet are fine. N-1
leaves those NULL, and UNIQUE, FK and CHECK all accept NULL. On an existing
column, enforce it in the release **after** the code that guarantees it ships.

## What the gate checks

Both modes, in three parts.

1. **Order.** Every pending file sorts after every settled one (applied, at
   deploy time; on the base branch, in CI). The runner applies by filename, so
   an upgraded database would run an out-of-order file last but a fresh one in
   the middle. The exception is a timestamped migration **concurrent** with
   every settled file it sorts before: written on another branch, so neither
   descends from the other in the snapshot graph. `migration:order` proves in
   Postgres that each such upgrade order builds the schema a fresh install
   does (see "Naming and order" below).
2. **Destructive-DDL lint.** Each pending file is split with the runner's own
   splitter (`scripts/lib/migration-statements.ts`, on
   `--> statement-breakpoint`). Each statement is then parsed with the real
   Postgres 17 grammar (libpg_query, via `@libpg-query/parser`, WASM). It
   rejects:
   - `DROP` of a table, view, materialized view, type, domain, sequence or schema;
   - `DROP COLUMN`;
   - `RENAME` of a table, column, view, sequence, type or enum value, and `SET SCHEMA`;
   - any column type change, and `SET NOT NULL`;
   - `DROP DEFAULT` on an existing NOT NULL column;
   - `ADD COLUMN … NOT NULL` with no default, on an existing table;
   - `ADD CONSTRAINT` UNIQUE, PRIMARY KEY, CHECK, FOREIGN KEY or EXCLUDE, and
     `CREATE UNIQUE INDEX`, on an existing column;
   - `TRUNCATE`, and `DELETE` without `WHERE`, at any depth (a CTE included).

   "Existing" is the difference between the modes. `--target` reads it off
   the database's catalog, including objects no snapshot declares. `--ci`
   cannot look, so it presumes every table and column exists unless a pending
   statement creates it, and presumes an unknown column NOT NULL.

   A `DO` block runs now, so its body is parsed with the plpgsql grammar and
   every SQL statement inside it is judged the same way. `EXECUTE` of a string
   built at run time is rejected: nothing can see what it runs. A function
   body (`CREATE FUNCTION … AS $$ … $$`) is a definition and is not judged.
   Comments, string literals and `COMMENT ON` text are never mistaken for
   statements.
3. **Schema contract.** Every column the replaced release's snapshot declares
   keeps its type (or a listed widening) and its nullability (or NOT NULL →
   nullable) in the newest snapshot. Enums keep their values. Every NOT NULL
   column a known table gained has a default. An object may be **forgotten**
   (absent from the newest snapshot) because part 2 still blocks physically
   dropping it. A forgotten column must not be NOT NULL without a default, or
   this release's INSERTs, which omit it, fail.

**The release being replaced** is the schema the settled files build: the
merge of the snapshot heads among them (`drizzle/migrations/meta/`; one head is
simply the newest snapshot). Snapshots are immutable, so both modes read it from
the tree: CI takes the files on the base branch, the deploy takes the files the
database's ledger applied. **The newest snapshot** is the same merge over every
snapshot in the tree.

CI additionally rejects any edit to, or deletion of, a migration or snapshot
that exists on the base branch: the runner refuses a file whose checksum
changed. The deploy check reports the same thing from the ledger before the
new container starts, instead of after.

### Limits

- The gate judges SQL that runs at migration time. It cannot see a function
  that a migration creates and then calls. Call the function from a `DO` block
  and inline its statements instead.
- Part 3 compares drizzle snapshots. A hand-written migration must also update
  the drizzle schema, or `migration:check` (the drift check in the same job)
  fails first.
- CI's presumptions are conservative: a statement touching a table an earlier,
  not-yet-deployed change created is judged as if that table were live. Annotate
  it, or (when the table has never been deployed) fold the change into a new
  migration that creates it right.

## Naming and order

Migrations are written by `bun run db:generate --name <what>` (`--custom` for a
hand-written one) as `drizzle/migrations/YYYYMMDDHHMMSS_<what>.sql` plus
`meta/YYYYMMDDHHMMSS_snapshot.json`. `bunx drizzle-kit generate` is not used:
drizzle-kit 0.31 numbers files from `_journal.json` (now deleted; nothing read
it at run time) and aborts as soon as two snapshots share a parent, so every
migration PR had to be regenerated after the one before it landed (#2391).
`0000`–`0069` keep their numbered names, and sort before every timestamped one.

Each snapshot is the full schema its branch declared, and its `prevIds` name
every head the tree had when it was generated (`scripts/lib/migration-graph.ts`).
Two PRs that each add a migration are two heads; nothing is renumbered when the
first lands. The schema the tree's migrations build is the 3-way merge of the
heads over their nearest common ancestor, which `migration:check` compares with
the declared schema. Two heads that changed one object differently do not merge,
and the check fails: regenerate the later one on top.

A migration written first can land second, and so sort before a file a deployed
database has already applied. That database applies the two in the opposite
order to a fresh install. `migration:order` (`scripts/check-migration-order.ts`,
in the `migration-drift` job) takes every main tip a deployment can sit on — the
base, and each merge-group entry ahead — builds a real database from it and
upgrades it, builds a fresh install twice (the second run must be a no-op), and
compares catalog fingerprints: tables, columns, constraints, indexes, triggers,
functions, enums, sequences, views, policies. It trusts no `prevIds`: the orders
come from git. The runner logs every such out-of-order application.

`migration:claims` (`scripts/check-migration-claims.ts`, CI and pre-push) fails a
PR whose migration cannot land as named — for the numbered PRs from before the
cutover, a number already taken or claimed by an older open PR, or a stale
`prevId` — and prints the regeneration command. The procedure, and why a
hand-edited `prevId` is never the fix, is in
`.claude/agents/fragments/_worker-rules.md` ("Migrations").

## Contracting: annotations

A rejected statement may be allowed by a comment **inside that statement** (the
chunk between `--> statement-breakpoint` markers that the runner executes):

```sql
-- migration-safety: allow column public.users.team_id because group_id replaced it in 0.21.0 (#1234)
ALTER TABLE "users" DROP COLUMN "team_id";
```

- `<object>` is the finding's object exactly as the failure message prints it
  (`table public.x`, `column public.t.c`, `type public.e`, `enum-value public.e.v`,
  `sequence public.s`, `schema s`). The `because` reason is required.
- The annotation is **verified, never trusted**. If the release being replaced
  still declares the object, it fails the gate: in CI against the base branch,
  and again at deploy time against the release the database actually runs.
  An annotation that matches no finding in its statement, or a line that starts
  `-- migration-safety:` but does not parse, also fails.
- Dynamic SQL and unparseable statements cannot be allowed.
- The annotation ships inside the file and the image, so the deploy check sees
  exactly what CI saw.

## Deploying: the pre-deploy check and the mandatory backup

Migrations run from the image entrypoint on every container start
(`deploy/docker/docker-entrypoint.sh`); there is no separate migration job. So
the check runs **before** the new image's container exists, from that image:

- `deploy/ansible/roles/llamenos-app/tasks/migration-gate.yml` runs
  `docker compose run --rm --no-deps app` with the entrypoint replaced by
  `bun scripts/check-migration-safety.ts --target`. It uses the app's own
  rendered `.env.app` for `DATABASE_URL` (from the vault-encrypted `vars.yml`),
  so the image judges exactly the files it would apply, against the database
  it would apply them to. Nothing about the target is known to GitHub.
- `playbooks/update.yml` takes the pre-update backup, pulls the new app image,
  runs the gate, and only then enters the recreate-with-rollback block. A
  refusal changes nothing, so there is nothing to roll back.
- `roles/llamenos-app` (and so `playbooks/deploy.yml`) runs the same gate
  between pulling the image and starting the container, because `just deploy`
  with a new `llamenos_app_image` also migrates.

**The backup gate (operator decision C1).** When anything is pending,
`--target` requires `--backup <entry>`: the newest line
`roles/backup-postgres/templates/backup-postgres.sh.j2` appended to
`{{ backup_base_dir }}/manifest.log`
(`postgres|<YYYYMMDD-HHMMSS>|<file>.dump.age|<bytes>|<sha256>|<type>`). The
task reads it on the database's backup host and checks the file it names
exists at that size. The gate then refuses unless the backup was taken
**after the database's last schema change** (so it can restore the schema
being replaced) and within `--backup-max-age-minutes` (default 60) by the
database's clock. A deploy that migrates nothing, or a fresh database, needs
no backup. `just update-quick` skips the backup step, so it only works when
nothing is pending or `just backup` ran within the hour.

**Helm.** The chart has no pre-upgrade hook for this yet, and provisions no
database of its own. Before `helm upgrade`, run the same check from the new
image against the external database, with the manifest entry of the backup you
just took:

```bash
kubectl run llamenos-migration-gate --rm -i --restart=Never --image=<new image> \
  --env DATABASE_URL="$DATABASE_URL" --command -- \
  bun scripts/check-migration-safety.ts --target --backup '<manifest entry>'
```

## Running it

```bash
bun run migration:safety --ci                    # diff-only, against origin/main's merge-base; no database
bun run migration:safety --ci --base <rev>       # against an explicit base
DATABASE_URL=… bun scripts/check-migration-safety.ts --target --backup '<entry>'   # against a real database
bun test scripts/check-migration-safety.test.ts  # rails for both modes' logic (bun:test, no database)
bunx vitest run --config vitest.integration.config.ts \
  apps/worker/__tests__/integration/migration-safety-target.test.ts   # --target against a real Postgres
```
