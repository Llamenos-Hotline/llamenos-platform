# Schema Migrations: Expand / Contract

## Purpose

Write a migration the previous release can run against, and get it past the
`migration-drift` CI job's safety gate (`bun run migration:safety`).

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
| **Forget** | N+1 | The code stops using the old shape, and the drizzle schema stops declaring it. `drizzle-kit generate` writes a `DROP`. Delete that statement and keep the regenerated snapshot. The database keeps the old shape, so the floor (N) still finds it. |
| **Contract** | N+2 | The migration drops the old shape, with a `drizzle/contract.json` entry. The floor (N+1) no longer declares it, so the gate verifies the entry and accepts the drop. |

Expand and forget can share a release when nothing in the previous release
still needs the old shape. Contract always comes at least one release after
forget. The gate accepts a drop only once a **shipped** release no longer
declares the object. That release is the one running beside the new pod
during the upgrade.

### Rename a column (`users.team_id` → `users.group_id`)

1. **N, expand + backfill:** `ALTER TABLE users ADD COLUMN group_id text;`
   then `UPDATE users SET group_id = team_id WHERE group_id IS NULL;`. The code
   writes both columns and reads `group_id`, falling back to `team_id`.
2. **N+1, forget:** the code and the drizzle schema drop `team_id`. Keep the
   generated snapshot and remove the generated `DROP COLUMN` from the `.sql`
   file, leaving a comment that says why.
3. **N+2, contract:** `ALTER TABLE "users" DROP COLUMN "team_id";` plus a
   contract entry for `column public.users.team_id`.

Never `RENAME COLUMN`: the previous release still names the old column.

### Make a column NOT NULL (`notes.author`)

The gate never accepts `SET NOT NULL` on a column the floor declares. It cannot
prove that the previous release never writes NULL. Replace the column:

1. **N, expand + backfill:** add `author_v2 text NOT NULL DEFAULT ''`. A
   NOT NULL column with a default accepts the previous release's INSERTs,
   which do not name it. Backfill it from `author` and write both.
2. **N+1, forget** `author` (it is nullable, so INSERTs that omit it succeed).
3. **N+2, contract:** drop `author`. If the default on `author_v2` is now
   unwanted, `DROP DEFAULT` on it is accepted only once the floor no longer
   omits it on INSERT: it has to be a release after N.

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
Constraints on columns or tables the floor does not declare are fine. N-1
leaves those NULL, and UNIQUE, FK and CHECK all accept NULL. On an existing
column, enforce it in the release **after** the code that guarantees it ships.

## What the gate checks

`scripts/check-migration-safety.ts`, run in CI's `migration-drift` job, works
offline in three parts.

1. **Release floor.** `drizzle/compat/release-floor.json` records the previous
   release: its `version` (must equal `package.json`'s), the migration files it
   shipped, and its drizzle snapshot (must equal
   `drizzle/migrations/meta/<snapshotFile>` byte for byte, once parsed). Shipped
   files may not be deleted, and a new file must sort after every shipped one.
2. **Destructive-DDL lint.** Every migration file **not** in the floor is split
   with the runner's own splitter (`scripts/lib/migration-statements.ts`, on
   `--> statement-breakpoint`). Each statement is then parsed with the real
   Postgres 17 grammar (libpg_query, via `@libpg-query/parser`, WASM). It
   rejects:
   - `DROP` of a table, view, materialized view, type, domain, sequence or schema;
   - `DROP COLUMN`;
   - `RENAME` of a table, column, view, sequence, type or enum value, and `SET SCHEMA`;
   - any column type change, and `SET NOT NULL`;
   - `DROP DEFAULT` on a NOT NULL column the floor declares;
   - `ADD COLUMN … NOT NULL` with no default, on a table the floor declares;
   - `ADD CONSTRAINT` UNIQUE, PRIMARY KEY, CHECK, FOREIGN KEY or EXCLUDE, and
     `CREATE UNIQUE INDEX`, on a column the floor declares;
   - `TRUNCATE`, and `DELETE` without `WHERE`, at any depth (a CTE included).

   A `DO` block runs now, so its body is parsed with the plpgsql grammar and
   every SQL statement inside it is judged the same way. `EXECUTE` of a string
   built at run time is rejected: nothing can see what it runs. A function
   body (`CREATE FUNCTION … AS $$ … $$`) is a definition and is not judged.
   Comments, string literals and `COMMENT ON` text are never mistaken for
   statements.
3. **Schema contract.** Every column the floor snapshot declares keeps its type
   (or a listed widening) and its nullability (or NOT NULL → nullable) in the
   newest snapshot. Enums keep their values. Every NOT NULL column a floor table
   gained has a default. An object may be **forgotten** (absent from the newest
   snapshot) because part 2 still blocks physically dropping it. A forgotten
   column must not be NOT NULL without a default, or this release's INSERTs,
   which omit it, fail.

The files the floor lists, including the historical destructive ones, are out
of scope because they shipped. There is no allow-list of old files.

### Limits

- The gate judges SQL that runs at migration time. It cannot see a function
  that a migration creates and then calls. Call the function from a `DO` block
  and inline its statements instead.
- Part 3 compares drizzle snapshots. A hand-written migration must also update
  the drizzle schema, or `migration:check` (the drift check in the same job)
  fails first.

## Contracting: `drizzle/contract.json`

A rejected statement whose object the floor **no longer declares** may be
exempted:

```json
{
  "description": "…",
  "exemptions": [
    {
      "file": "0071_drop_team_id.sql",
      "statementIndex": 0,
      "object": "column public.users.team_id",
      "reason": "Replaced by group_id in 0.21.0 (#1234); 0.21.0 is the floor and never reads team_id."
    }
  ]
}
```

- `statementIndex` counts from 0, in chunks between `--> statement-breakpoint`
  markers: the same unit the runner executes. The failure message prints both
  the index and the `object` string to copy.
- The entry is **verified, never trusted**. If the floor still declares the
  object, the entry fails the gate. Entries that match no finding, name a
  shipped file, or have no `reason` also fail.
- Dynamic SQL and unparseable statements cannot be exempted.
- When the file ships, knope's release step removes the entry
  (`scripts/record-release-floor.ts`), so the list never accumulates.

## How the floor moves

Knope's `prepare-release` workflow (`knope.toml`) runs
`bun scripts/record-release-floor.ts` after `PrepareRelease` bumps the version
and before the release commit, then stages the floor and contract files. The
release PR carries its own floor. Once it merges, every later migration is
judged against that release. Never edit `release-floor.json` by hand: the gate
checks it against `package.json` and the shipped snapshot, and CODEOWNERS
requires a human review of any change to it.

The floor was bootstrapped once from `v0.20.1`:

```bash
T=$(mktemp -d)
git archive v0.20.1 drizzle/migrations package.json | tar -x -C "$T"
mkdir -p "$T/drizzle/compat" && echo '{"description":"","exemptions":[]}' > "$T/drizzle/contract.json"
bun scripts/record-release-floor.ts --root "$T"
cp "$T/drizzle/compat/release-floor.json" drizzle/compat/
```

## Running it

```bash
bun run migration:safety                         # the gate, against this tree
bun test scripts/check-migration-safety.test.ts  # its rails (bun:test, not a vitest config)
```
