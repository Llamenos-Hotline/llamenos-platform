/**
 * Rails for scripts/check-migration-safety.ts, the gate that rejects a
 * migration the previous release cannot run against.
 *
 *   bun test scripts/check-migration-safety.test.ts
 *
 * No database: `--target` is exercised against a real Postgres by
 * apps/worker/__tests__/integration/migration-safety-target.test.ts.
 *
 * Three tiers:
 *   - every rule, judged on SQL text against a hand-built catalog;
 *   - the CI source's presumptions, with no database to read;
 *   - `--ci` end to end: real `.sql` files in a scratch git repo holding a copy
 *     of this repo's drizzle tree, run through the CLI, so they are split by
 *     the runner's own splitter and scoped by a real git diff. This is where
 *     the gate is shown to reject the defect it exists for (a DROP COLUMN the
 *     previous release still reads) and to reject an annotation claimed for it.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModule } from '@libpg-query/parser'
import {
  type DrizzleSnapshot,
  type Rule,
  type SnapshotColumn,
  CatalogSchema,
  PresumedSchema,
  RelaxedSchema,
  SchemaView,
  compareSchemas,
  describeObject,
  lintContext,
  lintSql,
  parseAnnotations,
  parseBackupEntry,
  snapshotFileAtOrBefore,
} from './check-migration-safety'
import { listMigrationFiles } from './lib/migration-statements'

const ROOT = join(import.meta.dir, '..')

beforeAll(async () => {
  await loadModule()
})

// ── A hand-built previous release ────────────────────────────────────────────

function col(name: string, type: string, notNull = false, extra: Partial<SnapshotColumn> = {}): SnapshotColumn {
  return { name, type, primaryKey: false, notNull, ...extra }
}

function table(name: string, columns: SnapshotColumn[]) {
  return { name, schema: '', columns: Object.fromEntries(columns.map((c) => [c.name, c])) }
}

function snapshot(tables: ReturnType<typeof table>[], enums: Record<string, string[]> = {}): DrizzleSnapshot {
  return {
    tables: Object.fromEntries(tables.map((t) => [`public.${t.name}`, t])),
    enums: Object.fromEntries(
      Object.entries(enums).map(([name, values]) => [`public.${name}`, { name, schema: 'public', values }]),
    ),
    views: {},
    sequences: {},
  }
}

const PREVIOUS = snapshot(
  [
    table('users', [
      col('pubkey', 'text', true, { primaryKey: true }),
      col('team_id', 'text'),
      col('status', 'text', true, { default: "'active'" }),
      col('display_name', 'varchar(64)'),
    ]),
    table('notes', [col('id', 'serial', true), col('body', 'text', true), col('author', 'text')]),
  ],
  { role: ['admin', 'member'] },
)
/** The database the previous release runs on, as the catalog would report it. */
function catalogOf(s: DrizzleSnapshot): CatalogSchema {
  const tables = Object.values(s.tables)
  return new CatalogSchema(
    tables.map((t) => ({ schema: t.schema || 'public', name: t.name })),
    tables.flatMap((t) =>
      Object.values(t.columns).map((c) => ({ schema: t.schema || 'public', table: t.name, column: c.name, not_null: c.notNull })),
    ),
  )
}

const CTX = lintContext(catalogOf(PREVIOUS), PREVIOUS)

function rules(sql: string): Rule[] {
  return lintSql(sql, CTX).map((f) => f.rule)
}

function objects(sql: string): string[] {
  return lintSql(sql, CTX).flatMap((f) => (f.object ? [describeObject(f.object)] : []))
}

// ── Tier 1: every rule ───────────────────────────────────────────────────────

describe('rejects every statement the previous release cannot run against', () => {
  test.each([
    ['DROP TABLE notes', 'drop', 'table public.notes'],
    ['DROP VIEW v', 'drop', 'table public.v'],
    ['DROP MATERIALIZED VIEW mv', 'drop', 'table public.mv'],
    ['DROP TYPE public.role', 'drop', 'type public.role'],
    ['DROP SEQUENCE notes_id_seq', 'drop', 'sequence public.notes_id_seq'],
    ['DROP SCHEMA audit CASCADE', 'drop', 'schema audit'],
    ['ALTER TABLE users DROP COLUMN team_id', 'drop-column', 'column public.users.team_id'],
    ['ALTER TABLE users RENAME COLUMN team_id TO team', 'rename', 'column public.users.team_id'],
    ['ALTER TABLE users RENAME TO members', 'rename', 'table public.users'],
    ['ALTER TYPE role RENAME TO member_role', 'rename', 'type public.role'],
    ["ALTER TYPE role RENAME VALUE 'member' TO 'volunteer'", 'rename', 'enum-value public.role.member'],
    ['ALTER TABLE users SET SCHEMA archive', 'set-schema', 'table public.users'],
    ['ALTER TABLE users ALTER COLUMN team_id SET DATA TYPE uuid USING team_id::uuid', 'alter-column-type', 'column public.users.team_id'],
    ['ALTER TABLE users ALTER COLUMN team_id SET NOT NULL', 'set-not-null', 'column public.users.team_id'],
    ['ALTER TABLE users ALTER COLUMN status DROP DEFAULT', 'drop-default-not-null', 'column public.users.status'],
    ['ALTER TABLE users ADD COLUMN locale text NOT NULL', 'add-not-null-column-without-default', 'column public.users.locale'],
    ['ALTER TABLE users ADD CONSTRAINT users_team_uq UNIQUE (team_id)', 'add-constraint-existing', 'column public.users.team_id'],
    ['ALTER TABLE users ADD CONSTRAINT users_pk PRIMARY KEY (pubkey)', 'add-constraint-existing', 'column public.users.pubkey'],
    ['ALTER TABLE notes ADD CONSTRAINT notes_author_fk FOREIGN KEY (author) REFERENCES users(pubkey)', 'add-constraint-existing', 'column public.notes.author'],
    ["ALTER TABLE users ADD CONSTRAINT users_status_ck CHECK (status <> '') NOT VALID", 'add-constraint-existing', 'column public.users.status'],
    ['ALTER TABLE users ADD CONSTRAINT users_uq UNIQUE USING INDEX users_team_idx', 'add-constraint-existing', 'table public.users'],
    ['CREATE UNIQUE INDEX users_team_uq ON users USING btree (team_id)', 'unique-index-existing', 'column public.users.team_id'],
    ['CREATE UNIQUE INDEX users_name_uq ON users (lower(display_name))', 'unique-index-existing', 'column public.users.display_name'],
    ['TRUNCATE notes', 'truncate', 'table public.notes'],
    ['DELETE FROM notes', 'delete-without-where', 'table public.notes'],
    ['WITH gone AS (DELETE FROM notes RETURNING id) SELECT count(*) FROM gone', 'delete-without-where', 'table public.notes'],
  ] as const)('%s', (sql, rule, object) => {
    expect(rules(sql)).toEqual([rule])
    expect(objects(sql)).toEqual([object])
  })

  test('a DO block is judged by what its body executes', () => {
    expect(objects('DO $$ BEGIN DROP TABLE notes; END $$')).toEqual(['table public.notes'])
    expect(
      objects(`DO $body$
        DECLARE n integer;
        BEGIN
          IF (SELECT count(*) FROM notes) > 0 THEN
            ALTER TABLE users DROP COLUMN team_id;
          END IF;
        END
      $body$`),
    ).toEqual(['column public.users.team_id'])
    expect(lintSql('DO $$ BEGIN DROP TABLE notes; END $$', CTX)[0].context).toBe('inside DO block')
  })

  test('dynamic SQL and non-plpgsql DO blocks fail, because no parser can see what they run', () => {
    expect(rules("DO $$ BEGIN EXECUTE 'DROP TABLE ' || 'notes'; END $$")).toEqual(['dynamic-sql'])
    expect(rules("DO $$ DECLARE r record; BEGIN FOR r IN EXECUTE 'SELECT 1' LOOP END LOOP; END $$")).toEqual([
      'dynamic-sql',
    ])
    expect(rules('DO LANGUAGE plperl $$ 1 $$')).toEqual(['unjudgeable-do'])
  })

  test('SQL Postgres would reject fails as a parse error, not a pass', () => {
    expect(rules('ALTER TABL users DROP COLUMN team_id')).toEqual(['parse-error'])
  })

  test('several commands in one ALTER TABLE are each judged', () => {
    expect(objects('ALTER TABLE users DROP COLUMN team_id, ALTER COLUMN display_name SET NOT NULL')).toEqual([
      'column public.users.team_id',
      'column public.users.display_name',
    ])
  })
})

describe('passes what the previous release can run against', () => {
  test.each([
    'CREATE TABLE things (id text PRIMARY KEY NOT NULL, label text NOT NULL)',
    'ALTER TABLE users ADD COLUMN locale text',
    "ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'en'",
    'ALTER TABLE users ADD COLUMN seq serial NOT NULL',
    'ALTER TABLE users ADD COLUMN n integer GENERATED ALWAYS AS IDENTITY',
    // Constraints on columns or tables the previous release does not know:
    // it leaves those columns NULL, which UNIQUE, FK and CHECK all accept.
    'ALTER TABLE users ADD CONSTRAINT users_locale_uq UNIQUE (locale)',
    'ALTER TABLE things ADD CONSTRAINT things_fk FOREIGN KEY (owner) REFERENCES users(pubkey)',
    "ALTER TABLE users ADD CONSTRAINT users_locale_ck CHECK (locale <> '')",
    'CREATE UNIQUE INDEX things_label_uq ON things (label)',
    'CREATE INDEX users_team_idx ON users (team_id)',
    'ALTER TABLE users ALTER COLUMN team_id DROP NOT NULL',
    "ALTER TABLE users ALTER COLUMN team_id SET DEFAULT 'none'",
    'ALTER TABLE users ALTER COLUMN team_id DROP DEFAULT',
    'ALTER TABLE users DROP CONSTRAINT users_team_fk',
    'DROP INDEX users_team_idx',
    "ALTER TYPE role ADD VALUE 'observer'",
    "DELETE FROM notes WHERE author IS NULL",
    "UPDATE users SET status = 'active' WHERE status IS NULL",
    'DO $$ BEGIN UPDATE notes SET body = body; END $$',
    // The four break-it cases: each holds destructive text that is not a
    // destructive statement. A scanner fails them; the parser must not.
    '-- DROP TABLE users\nCREATE INDEX notes_author_idx ON notes (author)',
    "INSERT INTO notes_templates VALUES ('drop table x; DROP COLUMN y')",
    "COMMENT ON TABLE t IS 'RENAME TO'",
    'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DROP TABLE users; END $$',
    'CREATE FUNCTION g() RETURNS void LANGUAGE sql BEGIN ATOMIC DELETE FROM notes; END',
  ])('%s', (sql) => {
    expect(lintSql(sql, CTX)).toEqual([])
  })
})

/**
 * A unique index whose predicate matches no row the table holds is safe: the
 * set it constrains is empty. The gate proves that for one shape only, `col IS
 * NULL` on a column that is NOT NULL before the migration, alone or as a
 * conjunct. It is a proof, not a trust in partial indexes: a predicate that
 * might match an existing row fails like an unconditional index does.
 *
 * `status` is NOT NULL and `team_id` is nullable in PREVIOUS.
 */
describe('a unique index over a provably empty predicate', () => {
  const index = (where?: string) => `CREATE UNIQUE INDEX users_uq ON users USING btree (team_id)${where ? ` WHERE ${where}` : ''}`

  test.each([
    ['status IS NULL'],
    ['users.status IS NULL'],
    ['public.users.status IS NULL'],
    // drizzle's own rendering, and #2361's statement 4 shape.
    ['"users"."status" IS NULL'],
    ['display_name IS NULL AND status IS NULL'],
    ['status IS NULL AND display_name IS NULL AND team_id IS NULL'],
  ])('passes WHERE %s, a NOT NULL column that cannot be NULL', (where) => {
    expect(lintSql(index(where), CTX)).toEqual([])
  })

  test.each([
    ['no predicate', undefined],
    ['a nullable column, which existing rows can satisfy', 'team_id IS NULL'],
    ['a nullable conjunct only', 'display_name IS NULL AND team_id IS NULL'],
    ['IS NOT NULL on a NOT NULL column, which every row satisfies', 'status IS NOT NULL'],
    ['an OR, which the nullable side can satisfy', 'status IS NULL OR team_id IS NULL'],
    ['a negation', 'NOT (status IS NULL)'],
    ['a comparison, which the gate does not read', "status = 'active'"],
    ['a NOT NULL column of another table', 'notes.body IS NULL'],
    ['a column the snapshot does not declare', 'mystery IS NULL'],
  ] as const)('still fails with %s', (_why, where) => {
    expect(lintSql(index(where), CTX).map((f) => f.rule)).toEqual(['unique-index-existing'])
  })

  test('judges the predicate against the schema before the migration, not after it', () => {
    // The migration is what makes the column nullable; the gate reads the
    // database it meets, where the column is still NOT NULL.
    const ctx = lintContext(catalogOf(PREVIOUS), snapshot([table('users', [col('team_id', 'text', false), col('status', 'text', false)])]))
    expect(lintSql(index('status IS NULL'), ctx)).toEqual([])
  })

  test('--ci proves NOT NULL from the replaced release snapshot, and presumes nothing for an undeclared column', () => {
    const ctx = lintContext(new PresumedSchema([], new SchemaView(PREVIOUS)), PREVIOUS)
    expect(lintSql(index('status IS NULL'), ctx)).toEqual([])
    // Declared nullable: existing rows may match.
    expect(lintSql(index('team_id IS NULL'), ctx).map((f) => f.rule)).toEqual(['unique-index-existing'])
    // Undeclared: presumed NOT NULL for the other rules, but a presumption is not a proof.
    expect(lintSql(index('mystery IS NULL'), ctx).map((f) => f.rule)).toEqual(['unique-index-existing'])
  })

  test('#2361 statement 4: hub_id was NOT NULL until that migration, so the index constrains no row', () => {
    const incidents = (hubIdNotNull: boolean) =>
      snapshot([table('hub_incidents', [col('category', 'text', true), col('closed_at', 'timestamp'), col('hub_id', 'text', hubIdNotNull)])])
    const statement =
      'CREATE UNIQUE INDEX "hub_incidents_open_platform_unique" ON "hub_incidents" USING btree ("category") WHERE "hub_incidents"."closed_at" IS NULL AND "hub_incidents"."hub_id" IS NULL'
    const judged = (prev: DrizzleSnapshot) =>
      lintSql(statement, lintContext(new PresumedSchema([], new SchemaView(prev)), prev)).map((f) => f.rule)
    expect(judged(incidents(true))).toEqual([])
    expect(judged(incidents(false))).toEqual(['unique-index-existing'])
  })
})

/**
 * The exemption's premise is that N-1 cannot write a NULL where the index
 * looks for one. A pending `DROP NOT NULL` on that column falsifies it, so the
 * column loses the exemption wherever in the pending set the drop is: before
 * the index, after it, or in another file. The drop alone disqualifies; no
 * UPDATE is read.
 */
describe('a pending DROP NOT NULL takes the column out of the exemption', () => {
  const DROP_STATUS = 'ALTER TABLE users ALTER COLUMN status DROP NOT NULL'
  const BACKFILL = 'UPDATE users SET status = NULL WHERE team_id IS NULL'
  const INDEX = 'CREATE UNIQUE INDEX users_uq ON users USING btree (team_id) WHERE team_id IS NULL AND status IS NULL'
  // `--target` judges against the catalog, `--ci` against the presumed schema.
  const modes = {
    '--target': () => catalogOf(PREVIOUS),
    '--ci': () => new PresumedSchema([], new SchemaView(PREVIOUS)),
  }
  const judged = (live: () => CatalogSchema | PresumedSchema, pending: string[], judge: string) =>
    lintSql(judge, lintContext(new RelaxedSchema(live(), pending), PREVIOUS)).map((f) => f.rule)

  describe.each(Object.entries(modes))('%s', (_mode, live) => {
    test('the reviewer’s sequence fails: DROP NOT NULL, backfill NULLs, then the index', () => {
      const pending = [DROP_STATUS, BACKFILL, INDEX]
      expect(judged(live, pending, INDEX)).toEqual(['unique-index-existing'])
    })

    test('reordered, the index first, it still fails', () => {
      const pending = [INDEX, BACKFILL, DROP_STATUS]
      expect(judged(live, pending, INDEX)).toEqual(['unique-index-existing'])
    })

    test('the drop alone disqualifies: no UPDATE needs to appear', () => {
      expect(judged(live, [DROP_STATUS, INDEX], INDEX)).toEqual(['unique-index-existing'])
    })

    test('the drop is column-scoped: another column dropped, a still-NOT NULL column in the predicate, passes', () => {
      const dropOther = 'ALTER TABLE users ALTER COLUMN team_id DROP NOT NULL'
      expect(judged(live, [dropOther, INDEX], INDEX)).toEqual([])
    })

    test('the drop is table-scoped: the same column name on another table does not disqualify', () => {
      const dropNotesStatus = 'ALTER TABLE notes ALTER COLUMN status DROP NOT NULL'
      expect(judged(live, [dropNotesStatus, INDEX], INDEX)).toEqual([])
    })

    test('a schema-qualified and a multi-command drop are both seen', () => {
      expect(judged(live, ['ALTER TABLE public.users ALTER COLUMN status DROP NOT NULL'], INDEX)).toEqual(['unique-index-existing'])
      expect(
        judged(live, ['ALTER TABLE users ADD COLUMN scratch text, ALTER COLUMN status DROP NOT NULL, DROP COLUMN scratch'], INDEX),
      ).toEqual(['unique-index-existing'])
    })

    test('a DO block that drops NOT NULL cannot be attributed to a column, so it disqualifies them all', () => {
      const doBlock = 'DO $$ BEGIN ALTER TABLE users ALTER COLUMN status DROP NOT NULL; END $$'
      expect(judged(live, [doBlock], INDEX)).toEqual(['unique-index-existing'])
    })

    test('with no drop in the pending set the exemption stands', () => {
      expect(judged(live, ['ALTER TABLE users ADD COLUMN scratch text'], INDEX)).toEqual([])
    })

    test('only provenNotNull is withdrawn: the other rules still read the column as NOT NULL', () => {
      const ctx = lintContext(new RelaxedSchema(live(), [DROP_STATUS]), PREVIOUS)
      expect(ctx.live.column('public', 'users', 'status')).toMatchObject({ notNull: true, provenNotNull: false })
    })
  })

  test('#2361 statement 4 where hub_id’s NOT NULL is dropped by the same migration fails; without that drop it passes', () => {
    const incidents = snapshot([
      table('hub_incidents', [col('category', 'text', true), col('closed_at', 'timestamp'), col('hub_id', 'text', true)]),
    ])
    const statement =
      'CREATE UNIQUE INDEX "hub_incidents_open_platform_unique" ON "hub_incidents" USING btree ("category") WHERE "hub_incidents"."closed_at" IS NULL AND "hub_incidents"."hub_id" IS NULL'
    const drop = 'ALTER TABLE "hub_incidents" ALTER COLUMN "hub_id" DROP NOT NULL'
    const ctx = (pending: string[]) => lintContext(new RelaxedSchema(new PresumedSchema(pending, new SchemaView(incidents)), pending), incidents)
    expect(lintSql(statement, ctx([drop, statement])).map((f) => f.rule)).toEqual(['unique-index-existing'])
    expect(lintSql(statement, ctx([statement])).map((f) => f.rule)).toEqual([])
  })
})

describe('schema contract', () => {
  const withUsers = (columns: SnapshotColumn[], enums?: Record<string, string[]>) =>
    snapshot([table('users', columns), PREVIOUS.tables['public.notes'] as ReturnType<typeof table>], enums ?? { role: ['admin', 'member'] })
  const previousUsers = Object.values(PREVIOUS.tables['public.users'].columns)

  test('the previous snapshot against itself holds', () => {
    expect(compareSchemas(PREVIOUS, PREVIOUS)).toEqual([])
  })

  test('widening is allowed: varchar(n) → text, NOT NULL → nullable', () => {
    const cur = withUsers(
      previousUsers.map((c) =>
        c.name === 'display_name' ? { ...c, type: 'text' } : c.name === 'status' ? { ...c, notNull: false } : c,
      ),
    )
    expect(compareSchemas(PREVIOUS, cur)).toEqual([])
  })

  test('a column the previous release declares may not change type or become NOT NULL', () => {
    expect(compareSchemas(PREVIOUS, withUsers(previousUsers.map((c) => (c.name === 'team_id' ? { ...c, type: 'uuid' } : c))))).toEqual([
      'column public.users.team_id changed type text → uuid',
    ])
    expect(compareSchemas(PREVIOUS, withUsers(previousUsers.map((c) => (c.name === 'team_id' ? { ...c, notNull: true } : c))))).toEqual([
      'column public.users.team_id became NOT NULL',
    ])
  })

  test('a column or table the previous release declares may be forgotten, unless INSERTs that omit it would fail', () => {
    // Forgetting is the step before contracting: the code stops declaring
    // it, the database keeps it, and the previous release still finds it.
    expect(compareSchemas(PREVIOUS, withUsers(previousUsers.filter((c) => c.name !== 'team_id')))).toEqual([])
    expect(compareSchemas(PREVIOUS, snapshot([table('users', previousUsers)], { role: ['admin', 'member'] }))).toEqual([])
    // status has a default, so omitting it is fine; body is NOT NULL with none.
    expect(compareSchemas(PREVIOUS, withUsers(previousUsers.filter((c) => c.name !== 'status')))).toEqual([])
    const notes = PREVIOUS.tables['public.notes']
    const forgotBody = withUsers(previousUsers)
    forgotBody.tables['public.notes'] = { ...notes, columns: { id: notes.columns.id, author: notes.columns.author } }
    expect(compareSchemas(PREVIOUS, forgotBody)).toEqual([
      expect.stringContaining('column public.notes.body is no longer declared but is NOT NULL with no default'),
    ])
  })

  test('an enum may gain values but never lose one', () => {
    expect(compareSchemas(PREVIOUS, withUsers(previousUsers, { role: ['admin', 'member', 'observer'] }))).toEqual([])
    expect(compareSchemas(PREVIOUS, withUsers(previousUsers, { role: ['admin'] }))).toEqual(["enum public.role lost value 'member'"])
  })

  test('a NOT NULL column added to a known table needs a default; one on a new table does not', () => {
    expect(compareSchemas(PREVIOUS, withUsers([...previousUsers, col('locale', 'text', true)]))).toHaveLength(1)
    expect(compareSchemas(PREVIOUS, withUsers([...previousUsers, col('locale', 'text', true, { default: "'en'" })]))).toEqual([])
    const withNewTable = withUsers(previousUsers)
    withNewTable.tables['public.things'] = table('things', [col('label', 'text', true)])
    expect(compareSchemas(PREVIOUS, withNewTable)).toEqual([])
  })
})


// ── Tier 2: --ci presumes, because it cannot look ───────────────────────────

describe('the CI source presumes every object it does not create exists', () => {
  const presumed = (...sql: string[]) => lintContext(new PresumedSchema(sql, new SchemaView(PREVIOUS)), PREVIOUS)

  test('a table the diff creates is new; every other table is presumed read by N-1', () => {
    const ctx = presumed('CREATE TABLE things (id text PRIMARY KEY, label text)')
    expect(lintSql('ALTER TABLE things ADD COLUMN owner text NOT NULL', ctx)).toEqual([])
    expect(lintSql('CREATE UNIQUE INDEX things_label_uq ON things (label)', ctx)).toEqual([])
    // `ledger` is in no snapshot, but CI cannot see the database, so it is presumed to exist.
    expect(lintSql('ALTER TABLE ledger ADD COLUMN owner text NOT NULL', ctx).map((f) => f.rule)).toEqual([
      'add-not-null-column-without-default',
    ])
  })

  test('a column the diff adds is new; an unknown column of an existing table is presumed NOT NULL', () => {
    const ctx = presumed('ALTER TABLE users ADD COLUMN locale text')
    expect(lintSql('ALTER TABLE users ADD CONSTRAINT users_locale_uq UNIQUE (locale)', ctx)).toEqual([])
    expect(lintSql('ALTER TABLE users ALTER COLUMN mystery DROP DEFAULT', ctx).map((f) => f.rule)).toEqual([
      'drop-default-not-null',
    ])
    // A column the previous snapshot declares nullable keeps that nullability.
    expect(lintSql('ALTER TABLE users ALTER COLUMN team_id DROP DEFAULT', ctx)).toEqual([])
  })
})

describe('annotations', () => {
  test('parse the documented form, and report a line that only looks like one', () => {
    expect(
      parseAnnotations(
        '-- migration-safety: allow column public.users.team_id because 1.4 stopped reading it (#1)\nALTER TABLE users DROP COLUMN team_id',
      ),
    ).toEqual({ annotations: [{ object: 'column public.users.team_id', reason: '1.4 stopped reading it (#1)' }], malformed: [] })
    expect(parseAnnotations('-- migration-safety: allow column public.users.team_id').malformed).toHaveLength(1)
    expect(parseAnnotations('-- migration-safety allow nothing\nSELECT 1')).toEqual({ annotations: [], malformed: [] })
  })
})

describe('the backup manifest entry --target requires', () => {
  const entry = `postgres|20261029-101500|llamenos-postgres-20261029-101500.dump.age|4096|${'a'.repeat(64)}|daily`

  test('is the line backup-postgres.sh appends', () => {
    expect(parseBackupEntry(entry)).toEqual({
      takenAt: new Date('2026-10-29T10:15:00Z'),
      file: 'llamenos-postgres-20261029-101500.dump.age',
      bytes: 4096,
    })
    const script = readFileSync(
      join(ROOT, 'deploy', 'ansible', 'roles', 'backup-postgres', 'templates', 'backup-postgres.sh.j2'),
      'utf-8',
    )
    expect(script).toContain('MANIFEST_ENTRY="postgres|${TIMESTAMP}|${FILENAME}|${FINAL_SIZE}|${DUMP_SHA256}|${BACKUP_TYPE}"')
    expect(script).toContain('TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"')
    expect(script).toContain('FILENAME="llamenos-postgres-${TIMESTAMP}.dump.age"')
  })

  test.each([
    ['', 'not a backup-postgres.sh manifest entry'],
    ['rustfs|20261029-101500|x|1|y|daily', 'not a backup-postgres.sh manifest entry'],
    [entry.replace('|4096|', '|0|'), 'empty file'],
    [entry.replace('20261029-101500|', '20261399-101500|'), 'impossible timestamp'],
  ])('rejects %p', (bad, why) => {
    expect(parseBackupEntry(bad)).toEqual(expect.stringContaining(why))
  })
})

// ── Tier 3: --ci end to end ──────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/** A scratch git repo holding a copy of this repo's drizzle tree, committed: the base. */
function scratchRepo(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), 'migration-safety-'))
  cpSync(join(ROOT, 'drizzle'), join(root, 'drizzle'), { recursive: true })
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  return { root, base: git(root, 'rev-parse', 'HEAD') }
}

function migrationsOf(root: string): string {
  return join(root, 'drizzle', 'migrations')
}

/** A new migration. Left untracked: the gate judges uncommitted files too. */
function addMigration(root: string, name: string, sql: string): void {
  writeFileSync(join(migrationsOf(root), name), sql)
}

/** No database is reachable: DATABASE_URL names a port nothing listens on. */
function runCi(root: string, base: string): { code: number; out: string } {
  const r = Bun.spawnSync(
    [process.execPath, join(ROOT, 'scripts', 'check-migration-safety.ts'), '--ci', '--base', base, '--root', root],
    { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' } },
  )
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` }
}

function withRepo(fn: (root: string, base: string) => void): void {
  const { root, base } = scratchRepo()
  try {
    fn(root, base)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const DROP_TEAM_ID = 'ALTER TABLE "users" DROP COLUMN "team_id";'
const allow = (object: string) => `-- migration-safety: allow ${object} because the previous release no longer reads it\n`

describe('--ci end to end, with no database', () => {
  test('a tree that adds no migration passes', () => {
    withRepo((root, base) => {
      const r = runCi(root, base)
      expect(r.out).toContain('judged 0 pending migration file(s)')
      expect(r.code).toBe(0)
    })
  })

  test('the replaced release is the newest snapshot at or before the last settled file', () => {
    const meta = join(ROOT, 'drizzle', 'migrations', 'meta')
    const files = listMigrationFiles(join(ROOT, 'drizzle', 'migrations'))
    expect(snapshotFileAtOrBefore(meta, files.at(-1))).toBe(snapshotFileAtOrBefore(meta))
    // 0030-0032 are hand-written and have no snapshot of their own.
    expect(snapshotFileAtOrBefore(meta, '0031_remove_phone_plain.sql')).toMatch(/^00(2\d|3[01])_snapshot\.json$/)
    expect(snapshotFileAtOrBefore(meta, '0000_a.sql')).toBe('0000_snapshot.json')
  })

  test('GATE THE GATE: a new migration dropping a column the previous release declares fails', () => {
    withRepo((root, base) => {
      addMigration(root, '9999_gate.sql', DROP_TEAM_ID)
      const r = runCi(root, base)
      expect(r.code).toBe(1)
      expect(r.out).toContain('9999_gate.sql statement 0: drop-column column public.users.team_id')
    })
  })

  test('GATE THE GATE: an annotation for a column the previous release still declares fails', () => {
    withRepo((root, base) => {
      addMigration(root, '9999_gate.sql', allow('column public.users.team_id') + DROP_TEAM_ID)
      const r = runCi(root, base)
      expect(r.code).toBe(1)
      expect(r.out).toContain('the annotation for column public.users.team_id is rejected')
    })
  })

  test('a committed migration is judged as well as an untracked one', () => {
    withRepo((root, base) => {
      addMigration(root, '9999_gate.sql', DROP_TEAM_ID)
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'branch')
      expect(runCi(root, base).out).toContain('drop-column column public.users.team_id')
      expect(runCi(root, 'HEAD').out).toContain('judged 0 pending migration file(s)')
    })
  })

  test('an annotation for an object the previous release does not declare is honoured', () => {
    withRepo((root, base) => {
      addMigration(root, '9998_expand.sql', 'ALTER TABLE users ADD COLUMN scratch_note text;')
      addMigration(root, '9999_contract.sql', 'ALTER TABLE users DROP COLUMN scratch_note;')
      expect(runCi(root, base).code).toBe(1)
      addMigration(root, '9999_contract.sql', allow('column public.users.scratch_note') + 'ALTER TABLE users DROP COLUMN scratch_note;')
      const r = runCi(root, base)
      expect(r.out).toContain('1 finding(s) allowed by verified annotations')
      expect(r.code).toBe(0)
    })
  })

  test('expand/contract lifecycle: forget a column, ship it, then drop it with an annotation', () => {
    withRepo((root, base) => {
      const meta = join(migrationsOf(root), 'meta')
      const latest = JSON.parse(readFileSync(join(meta, snapshotFileAtOrBefore(meta) as string), 'utf-8')) as DrizzleSnapshot
      delete latest.tables['public.users'].columns.team_id
      // Release N forgets users.team_id: the drizzle schema stops declaring
      // it and the migration drizzle-kit generated has its DROP removed.
      writeFileSync(join(meta, '9990_snapshot.json'), JSON.stringify(latest))
      addMigration(root, '9990_forget_team_id.sql', '-- users.team_id is no longer declared; dropped a release later.\n')
      expect(runCi(root, base).code).toBe(0)

      // Dropping it in the same change is rejected even with an annotation:
      // the release being replaced still reads it.
      addMigration(root, '9991_drop_team_id.sql', allow('column public.users.team_id') + DROP_TEAM_ID)
      expect(runCi(root, base).out).toContain('the annotation for column public.users.team_id is rejected')
      rmSync(join(migrationsOf(root), '9991_drop_team_id.sql'))

      // N ships: its files are on the base the next change is judged against.
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'release N')
      const n = git(root, 'rev-parse', 'HEAD')

      // N+1 drops it: rejected without the annotation, accepted with it.
      addMigration(root, '9991_drop_team_id.sql', DROP_TEAM_ID)
      expect(runCi(root, n).out).toContain('drop-column column public.users.team_id')
      addMigration(root, '9991_drop_team_id.sql', allow('column public.users.team_id') + DROP_TEAM_ID)
      const r = runCi(root, n)
      expect(r.out).toContain('against 9990_snapshot.json')
      expect(r.out).toContain('1 finding(s) allowed by verified annotations')
      expect(r.code).toBe(0)
    })
  })

  test('GATE THE GATE: a DROP NOT NULL in one pending file takes the column out of the exemption in a later one', () => {
    withRepo((root, base) => {
      const index =
        'CREATE UNIQUE INDEX "users_open_uq" ON "users" USING btree ("team_id") WHERE "users"."team_id" IS NULL AND "users"."status" IS NULL;'
      addMigration(root, '9999_index.sql', index)
      expect(runCi(root, base).code).toBe(0)

      addMigration(root, '9998_relax.sql', 'ALTER TABLE "users" ALTER COLUMN "status" DROP NOT NULL;')
      const r = runCi(root, base)
      expect(r.code).toBe(1)
      expect(r.out).toContain('9999_index.sql statement 0: unique-index-existing column public.users.team_id')
    })
  })

  test('break-it fixtures pass as real files; the real DROP COLUMN in every spelling fails', () => {
    withRepo((root, base) => {
      addMigration(
        root,
        '9990_break_it.sql',
        [
          '-- DROP TABLE users\nCREATE TABLE notes_templates (body text);',
          "INSERT INTO notes_templates VALUES ('drop table x; DROP COLUMN y');",
          "COMMENT ON TABLE notes_templates IS 'RENAME TO';",
          'CREATE FUNCTION scratch_fn() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DROP TABLE users; END $$;',
        ].join('\n--> statement-breakpoint\n'),
      )
      expect(runCi(root, base)).toMatchObject({ code: 0 })

      for (const spelling of [DROP_TEAM_ID, 'alter table users drop column team_id;', 'alter table\n users\n drop\n column team_id;']) {
        addMigration(root, '9999_real.sql', spelling)
        const r = runCi(root, base)
        expect(r.code).toBe(1)
        expect(r.out).toContain('9999_real.sql statement 0: drop-column column public.users.team_id')
      }
    })
  })

  test('statement indexes are the runner’s: chunks between breakpoints', () => {
    withRepo((root, base) => {
      addMigration(
        root,
        '9999_multi.sql',
        'CREATE TABLE a (x text);--> statement-breakpoint\nCREATE TABLE b (y text);\n--> statement-breakpoint\nTRUNCATE users;',
      )
      expect(runCi(root, base).out).toContain('9999_multi.sql statement 2: truncate table public.users')
    })
  })

  test('history cannot be rewritten: edited or deleted files, out-of-order names, stray annotations', () => {
    const cases: [string, (root: string) => void, string][] = [
      ['an existing migration edited', (root) => writeFileSync(join(migrationsOf(root), '0024_ep03_teams_tags.sql'), 'SELECT 1;'), 'is edited here'],
      ['an existing migration deleted', (root) => rmSync(join(migrationsOf(root), '0024_ep03_teams_tags.sql')), 'is deleted here'],
      [
        'an existing snapshot edited to forget a column',
        (root) => {
          const p = join(migrationsOf(root), 'meta', snapshotFileAtOrBefore(join(migrationsOf(root), 'meta')) as string)
          const s = JSON.parse(readFileSync(p, 'utf-8')) as DrizzleSnapshot
          delete s.tables['public.users'].columns.team_id
          writeFileSync(p, JSON.stringify(s))
        },
        'is edited here',
      ],
      ['a new file named to sort among existing ones', (root) => addMigration(root, '0000_aaa_early.sql', 'CREATE TABLE early (x text);'), 'sorts before'],
      ['an annotation that matches no finding', (root) => addMigration(root, '9999_x.sql', `${allow('table public.x')}SELECT 1;`), 'matches no finding'],
      ['an annotation without a reason', (root) => addMigration(root, '9999_x.sql', '-- migration-safety: allow table public.x\nSELECT 1;'), 'unreadable annotation'],
    ]
    for (const [name, mutate, expected] of cases) {
      withRepo((root, base) => {
        mutate(root)
        const r = runCi(root, base)
        expect(r.code, name).toBe(1)
        expect(r.out, name).toContain(expected)
      })
    }
  })

  test('the journal may change: drizzle-kit appends to it with every migration', () => {
    withRepo((root, base) => {
      const p = join(migrationsOf(root), 'meta', '_journal.json')
      writeFileSync(p, `${readFileSync(p, 'utf-8')}\n`)
      addMigration(root, '9999_ok.sql', 'CREATE TABLE ok (x text);')
      expect(runCi(root, base).code).toBe(0)
    })
  })

  test('the mode is mandatory and singular', () => {
    for (const argv of [[], ['--ci', '--target']]) {
      const r = Bun.spawnSync([process.execPath, join(ROOT, 'scripts', 'check-migration-safety.ts'), ...argv])
      expect(r.exitCode).toBe(2)
    }
  })
})
