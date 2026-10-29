/**
 * Rails for scripts/check-migration-safety.ts, the gate that rejects a
 * migration the previous release cannot run against, and for the knope step
 * that records the release floor it judges against.
 *
 *   bun test scripts/check-migration-safety.test.ts
 *
 * Three tiers:
 *   - every rule, judged on SQL text against a hand-built floor;
 *   - the gate end to end: real `.sql` files in a scratch copy of this repo's
 *     drizzle tree, run through the CLI, so they are split by the runner's own
 *     splitter and scoped by the real floor. This is where the gate is shown
 *     to reject the defect it exists for (a DROP COLUMN the floor still reads)
 *     and to reject an exemption claimed for it;
 *   - knope's prepare-release steps, executed in order against a scratch git
 *     repo, so the release commit is shown to carry the floor.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModule } from '@libpg-query/parser'
import {
  type Rule,
  compareSchemas,
  describeObject,
  lintContext,
  lintSql,
} from './check-migration-safety'
import { listMigrationFiles } from './lib/migration-statements'
import {
  type DrizzleSnapshot,
  type MigrationContract,
  type ReleaseFloor,
  type SnapshotColumn,
  latestSnapshotFile,
} from './lib/release-floor'
import { recordReleaseFloor } from './record-release-floor'

const ROOT = join(import.meta.dir, '..')

beforeAll(async () => {
  await loadModule()
})

// ── A hand-built floor ───────────────────────────────────────────────────────

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

const FLOOR = snapshot(
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
const CTX = lintContext(FLOOR, FLOOR)

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

describe('schema contract', () => {
  const withUsers = (columns: SnapshotColumn[], enums?: Record<string, string[]>) =>
    snapshot([table('users', columns), FLOOR.tables['public.notes'] as ReturnType<typeof table>], enums ?? { role: ['admin', 'member'] })
  const floorUsers = Object.values(FLOOR.tables['public.users'].columns)

  test('the floor against itself holds', () => {
    expect(compareSchemas(FLOOR, FLOOR)).toEqual([])
  })

  test('widening is allowed: varchar(n) → text, NOT NULL → nullable', () => {
    const cur = withUsers(
      floorUsers.map((c) =>
        c.name === 'display_name' ? { ...c, type: 'text' } : c.name === 'status' ? { ...c, notNull: false } : c,
      ),
    )
    expect(compareSchemas(FLOOR, cur)).toEqual([])
  })

  test('a column the floor declares may not change type or become NOT NULL', () => {
    expect(compareSchemas(FLOOR, withUsers(floorUsers.map((c) => (c.name === 'team_id' ? { ...c, type: 'uuid' } : c))))).toEqual([
      'column public.users.team_id changed type text → uuid',
    ])
    expect(compareSchemas(FLOOR, withUsers(floorUsers.map((c) => (c.name === 'team_id' ? { ...c, notNull: true } : c))))).toEqual([
      'column public.users.team_id became NOT NULL',
    ])
  })

  test('a column or table the floor declares may be forgotten, unless INSERTs that omit it would fail', () => {
    // Forgetting is the step before contracting: the code stops declaring
    // it, the database keeps it, and the previous release still finds it.
    expect(compareSchemas(FLOOR, withUsers(floorUsers.filter((c) => c.name !== 'team_id')))).toEqual([])
    expect(compareSchemas(FLOOR, snapshot([table('users', floorUsers)], { role: ['admin', 'member'] }))).toEqual([])
    // status has a default, so omitting it is fine; body is NOT NULL with none.
    expect(compareSchemas(FLOOR, withUsers(floorUsers.filter((c) => c.name !== 'status')))).toEqual([])
    const notes = FLOOR.tables['public.notes']
    const forgotBody = withUsers(floorUsers)
    forgotBody.tables['public.notes'] = { ...notes, columns: { id: notes.columns.id, author: notes.columns.author } }
    expect(compareSchemas(FLOOR, forgotBody)).toEqual([
      expect.stringContaining('column public.notes.body is no longer declared but is NOT NULL with no default'),
    ])
  })

  test('an enum may gain values but never lose one', () => {
    expect(compareSchemas(FLOOR, withUsers(floorUsers, { role: ['admin', 'member', 'observer'] }))).toEqual([])
    expect(compareSchemas(FLOOR, withUsers(floorUsers, { role: ['admin'] }))).toEqual(["enum public.role lost value 'member'"])
  })

  test('a NOT NULL column added to a floor table needs a default; one on a new table does not', () => {
    expect(compareSchemas(FLOOR, withUsers([...floorUsers, col('locale', 'text', true)]))).toHaveLength(1)
    expect(compareSchemas(FLOOR, withUsers([...floorUsers, col('locale', 'text', true, { default: "'en'" })]))).toEqual([])
    const withNewTable = withUsers(floorUsers)
    withNewTable.tables['public.things'] = table('things', [col('label', 'text', true)])
    expect(compareSchemas(FLOOR, withNewTable)).toEqual([])
  })
})

// ── Tier 2: the gate, end to end ─────────────────────────────────────────────

/** A scratch copy of this repo's migration tree, floor, contract and version. */
function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'migration-safety-'))
  cpSync(join(ROOT, 'drizzle'), join(root, 'drizzle'), { recursive: true })
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'))
  return root
}

function floorOf(root: string): ReleaseFloor {
  return JSON.parse(readFileSync(join(root, 'drizzle', 'compat', 'release-floor.json'), 'utf-8'))
}

/** A new migration, named to sort after every file in the tree. */
function addMigration(root: string, name: string, sql: string): void {
  writeFileSync(join(root, 'drizzle', 'migrations', name), sql)
}

function setContract(root: string, exemptions: MigrationContract['exemptions']): void {
  writeFileSync(join(root, 'drizzle', 'contract.json'), JSON.stringify({ description: 'test', exemptions }))
}

function runGate(root: string): { code: number; out: string } {
  const r = Bun.spawnSync([process.execPath, join(ROOT, 'scripts', 'check-migration-safety.ts'), '--root', root])
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` }
}

describe('the gate end to end', () => {
  test('this tree passes, against a floor whose version is package.json’s', () => {
    const r = runGate(ROOT)
    expect(r.out).toContain('[migration-safety] OK')
    expect(r.code).toBe(0)
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
    expect(floorOf(ROOT).version).toBe(version)
  })

  test('the floor’s snapshot is the snapshot file that release shipped, verbatim', () => {
    const floor = floorOf(ROOT)
    const shipped = JSON.parse(readFileSync(join(ROOT, 'drizzle', 'migrations', 'meta', floor.snapshotFile), 'utf-8'))
    expect(floor.snapshot).toEqual(shipped)
  })

  test('GATE THE GATE: a new migration dropping a column the floor declares fails', () => {
    const root = scratchRepo()
    try {
      expect(floorOf(root).snapshot.tables['public.users'].columns.team_id).toBeDefined()
      addMigration(root, '9999_gate.sql', 'ALTER TABLE users DROP COLUMN team_id;')
      const r = runGate(root)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('9999_gate.sql statement 0: drop-column column public.users.team_id')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('GATE THE GATE: an exemption for a column the floor still declares fails', () => {
    const root = scratchRepo()
    try {
      addMigration(root, '9999_gate.sql', 'ALTER TABLE users DROP COLUMN team_id;')
      setContract(root, [
        { file: '9999_gate.sql', statementIndex: 0, object: 'column public.users.team_id', reason: 'no longer used' },
      ])
      const r = runGate(root)
      expect(r.code).not.toBe(0)
      expect(r.out).toContain('still declares column public.users.team_id')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an exemption for an object the floor no longer declares is honoured', () => {
    const root = scratchRepo()
    try {
      addMigration(root, '9998_expand.sql', 'ALTER TABLE users ADD COLUMN scratch_note text;')
      addMigration(root, '9999_contract.sql', 'ALTER TABLE users DROP COLUMN scratch_note;')
      expect(runGate(root).code).not.toBe(0)
      setContract(root, [
        { file: '9999_contract.sql', statementIndex: 0, object: 'column public.users.scratch_note', reason: 'never shipped' },
      ])
      const r = runGate(root)
      expect(r.out).toContain('1 finding(s) exempted')
      expect(r.code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('expand/contract lifecycle: forget a column, release, then drop it with an exemption', () => {
    const root = scratchRepo()
    try {
      const meta = join(root, 'drizzle', 'migrations', 'meta')
      const latest = JSON.parse(readFileSync(join(meta, latestSnapshotFile(meta)), 'utf-8')) as DrizzleSnapshot
      delete latest.tables['public.users'].columns.team_id
      // Release N forgets users.team_id: the drizzle schema stops declaring
      // it and the migration drizzle-kit generated has its DROP removed.
      writeFileSync(join(meta, '9999_snapshot.json'), JSON.stringify(latest))
      addMigration(root, '9999_forget_team_id.sql', '-- users.team_id is no longer declared; dropped a release later.\n')
      expect(runGate(root).code).toBe(0)

      // Dropping it in the same release is rejected even with an exemption:
      // the floor (N-1) still reads it.
      const drop = 'ALTER TABLE "users" DROP COLUMN "team_id";'
      const exemption = (file: string) =>
        setContract(root, [{ file, statementIndex: 0, object: 'column public.users.team_id', reason: 'forgotten in N' }])
      addMigration(root, '9999_x_drop_team_id.sql', drop)
      exemption('9999_x_drop_team_id.sql')
      expect(runGate(root).out).toContain('still declares column public.users.team_id')
      rmSync(join(root, 'drizzle', 'migrations', '9999_x_drop_team_id.sql'))
      setContract(root, [])

      // N ships and becomes the floor (what knope's prepare-release does).
      const p = join(root, 'package.json')
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf-8')), version: '99.0.0' }))
      recordReleaseFloor(root)
      expect(floorOf(root).snapshotFile).toBe('9999_snapshot.json')

      // N+1 drops it: rejected without the exemption, accepted with it.
      addMigration(root, '9999_y_drop_team_id.sql', drop)
      expect(runGate(root).out).toContain('drop-column column public.users.team_id')
      exemption('9999_y_drop_team_id.sql')
      const r = runGate(root)
      expect(r.out).toContain('1 finding(s) exempted')
      expect(r.code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('break-it fixtures pass as real files; the real DROP COLUMN in every spelling fails', () => {
    const root = scratchRepo()
    try {
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
      expect(runGate(root)).toMatchObject({ code: 0 })

      for (const spelling of [
        'ALTER TABLE "users" DROP COLUMN "team_id";',
        'alter table users drop column team_id;',
        'alter table\n users\n drop\n column team_id;',
      ]) {
        addMigration(root, '9999_real.sql', spelling)
        const r = runGate(root)
        expect(r.code).not.toBe(0)
        expect(r.out).toContain('9999_real.sql statement 0: drop-column column public.users.team_id')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('statement indexes are the runner’s: chunks between breakpoints', () => {
    const root = scratchRepo()
    try {
      addMigration(
        root,
        '9999_multi.sql',
        'CREATE TABLE a (x text);--> statement-breakpoint\nCREATE TABLE b (y text);\n--> statement-breakpoint\nTRUNCATE users;',
      )
      expect(runGate(root).out).toContain('9999_multi.sql statement 2: truncate table public.users')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the floor cannot drift: version, deleted files, edited snapshot, out-of-order names', () => {
    const cases: [string, (root: string) => void, string][] = [
      [
        'package.json bumped without the floor',
        (root) => {
          const p = join(root, 'package.json')
          writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf-8')), version: '999.0.0' }))
        },
        'but package.json is 999.0.0',
      ],
      [
        'a shipped migration deleted',
        (root) => rmSync(join(root, 'drizzle', 'migrations', floorOf(root).migrations[0])),
        'Shipped migrations are never deleted',
      ],
      [
        'the floor snapshot edited to forget a column',
        (root) => {
          const floor = floorOf(root)
          delete floor.snapshot.tables['public.users'].columns.team_id
          writeFileSync(join(root, 'drizzle', 'compat', 'release-floor.json'), JSON.stringify(floor))
        },
        'differs from meta/',
      ],
      [
        'a new file named to sort among shipped ones',
        (root) => addMigration(root, '0000_aaa_early.sql', 'CREATE TABLE early (x text);'),
        'sorts before',
      ],
      [
        'an exemption that matches no finding',
        (root) => setContract(root, [{ file: '9999_none.sql', statementIndex: 0, object: 'table public.x', reason: 'r' }]),
        'matches no finding',
      ],
      [
        'an exemption left behind for a shipped file',
        (root) =>
          setContract(root, [
            { file: floorOf(root).migrations[0], statementIndex: 0, object: 'table public.x', reason: 'r' },
          ]),
        'the entry is stale',
      ],
    ]
    for (const [name, mutate, expected] of cases) {
      const root = scratchRepo()
      try {
        mutate(root)
        const r = runGate(root)
        expect(r.code, name).not.toBe(0)
        expect(r.out, name).toContain(expected)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
})

// ── Tier 3: knope's prepare-release records the floor ────────────────────────

interface KnopeStep {
  type: string
  command?: string
  shell?: boolean
}

function prepareReleaseSteps(): KnopeStep[] {
  const config = Bun.TOML.parse(readFileSync(join(ROOT, 'knope.toml'), 'utf-8')) as {
    workflows: { name: string; steps: KnopeStep[] }[]
  }
  const wf = config.workflows.find((w) => w.name === 'prepare-release')
  if (!wf) throw new Error('knope.toml has no prepare-release workflow')
  return wf.steps
}

/**
 * Knope's Command step without `shell = true`: the command is split into an
 * executable and arguments (double quotes group), `$version` is replaced by
 * the new version, and the executable is run directly in the repo root.
 */
function knopeArgv(command: string, version: string): string[] {
  const argv: string[] = []
  for (const m of command.replaceAll('$version', version).matchAll(/"([^"]*)"|(\S+)/g)) argv.push(m[1] ?? m[2])
  return argv
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

describe("knope's prepare-release", () => {
  test('records the floor between PrepareRelease and the commit, and stages it', () => {
    const steps = prepareReleaseSteps()
    const at = (pred: (s: KnopeStep) => boolean) => steps.findIndex(pred)
    const prepare = at((s) => s.type === 'PrepareRelease')
    const record = at((s) => s.command === 'bun scripts/record-release-floor.ts')
    const stage = at((s) => s.command === 'git add drizzle/compat/release-floor.json drizzle/contract.json')
    const commit = at((s) => s.command?.startsWith('git commit') ?? false)
    expect(prepare).toBeGreaterThanOrEqual(0)
    expect(record).toBeGreaterThan(prepare)
    expect(stage).toBeGreaterThan(record)
    expect(commit).toBeGreaterThan(stage)
  })

  test('executed against a scratch repo, the release commit carries the new floor', () => {
    const repo = mkdtempSync(join(tmpdir(), 'knope-floor-'))
    try {
      cpSync(join(ROOT, 'drizzle'), join(repo, 'drizzle'), { recursive: true })
      cpSync(join(ROOT, 'scripts', 'record-release-floor.ts'), join(repo, 'scripts', 'record-release-floor.ts'))
      cpSync(join(ROOT, 'scripts', 'lib'), join(repo, 'scripts', 'lib'), { recursive: true })
      cpSync(join(ROOT, 'package.json'), join(repo, 'package.json'))
      const shippedBefore = floorOf(repo).migrations.length
      git(repo, 'init', '-q', '-b', 'main')
      git(repo, 'config', 'user.email', 'test@example.invalid')
      git(repo, 'config', 'user.name', 'test')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'base')

      // Work merged since the last release: a new migration with a verified
      // exemption, which the release must absorb into its floor.
      addMigration(repo, '9998_expand.sql', 'ALTER TABLE users ADD COLUMN scratch_note text;')
      addMigration(repo, '9999_contract.sql', 'ALTER TABLE users DROP COLUMN scratch_note;')
      setContract(repo, [
        { file: '9999_contract.sql', statementIndex: 0, object: 'column public.users.scratch_note', reason: 'never shipped' },
      ])
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'feat: scratch')

      const version = '99.0.0'
      for (const step of prepareReleaseSteps()) {
        if (step.type === 'PrepareRelease') {
          // What PrepareRelease leaves for the steps after it: the bumped
          // version, written and staged.
          const p = join(repo, 'package.json')
          writeFileSync(p, `${JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf-8')), version }, null, 2)}\n`)
          git(repo, 'add', 'package.json')
          continue
        }
        if (step.type !== 'Command' || !step.command) continue
        // Publishing leaves the machine; everything before it is local.
        if (step.command.startsWith('git push')) break
        expect(step.shell ?? false).toBe(false)
        const argv = knopeArgv(step.command, version)
        const r = Bun.spawnSync(argv, { cwd: repo })
        expect(r.exitCode, `${step.command}: ${r.stderr.toString()}`).toBe(0)
      }

      expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe(`chore: prepare release ${version}`)
      expect(git(repo, 'status', '--porcelain').trim()).toBe('')
      const committed = JSON.parse(git(repo, 'show', 'HEAD:drizzle/compat/release-floor.json')) as ReleaseFloor
      expect(committed.version).toBe(version)
      expect(committed.migrations).toEqual(listMigrationFiles(join(repo, 'drizzle', 'migrations')))
      expect(committed.migrations).toContain('9999_contract.sql')
      expect(committed.migrations.length).toBeGreaterThan(shippedBefore)
      const contract = JSON.parse(git(repo, 'show', 'HEAD:drizzle/contract.json')) as MigrationContract
      expect(contract.exemptions).toEqual([])
      // The released tree passes its own gate.
      expect(runGate(repo).code).toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
