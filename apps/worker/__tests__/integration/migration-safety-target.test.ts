/**
 * `scripts/check-migration-safety.ts --target`: the pre-deploy migration gate,
 * run against a REAL database the way deploy/ansible/playbooks/update.yml runs
 * it, before the new image migrates anything.
 *
 * What only this mode can see, and these tests pin:
 *   - which files are pending, from the runner's own ledger;
 *   - what those files meet, from the live catalog, including objects no
 *     snapshot declares;
 *   - which release is being replaced, so a contract whose "forget" step never
 *     reached this database is rejected even though CI, judging one branch
 *     against its base, passed it;
 *   - the mandatory pre-upgrade backup, whenever the deploy migrates anything.
 *
 * The CI mode, which has no database, is covered by
 * scripts/check-migration-safety.test.ts.
 *
 * Every test gets its own database: a copy of one template migrated once by
 * the real runner. Each is dropped on teardown.
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { MigrationGraph } from '../../../../scripts/lib/migration-graph'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TIMEOUT_MS = 120_000
const LEDGER = 'llamenos_schema_migrations'

const createdDatabases: string[] = []
const scratchRoots: string[] = []
let template = ''

function databaseUrlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1 })
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

async function newDatabase(from?: string): Promise<string> {
  const name = `migsafe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  await admin((sql) => sql.unsafe(`CREATE DATABASE ${name}${from ? ` TEMPLATE ${from}` : ''}`))
  return name
}

/** A database for one test, dropped after it. */
async function createDatabase(from?: string): Promise<string> {
  const name = await newDatabase(from)
  createdDatabases.push(name)
  return name
}

async function withDb<T>(name: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrlFor(name), { max: 1 })
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

interface Run {
  status: number | null
  output: string
}

function run(args: string[], env: Record<string, string>): Run {
  const r = spawnSync('bun', ['--no-env-file', ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
  })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function migrate(name: string, migrationsDir?: string): void {
  const r = run(['scripts/run-migrations.ts'], {
    DATABASE_URL: databaseUrlFor(name),
    ...(migrationsDir ? { LLAMENOS_MIGRATIONS_DIR: migrationsDir } : {}),
  })
  if (r.status !== 0) throw new Error(`migrations failed (exit ${r.status}):\n${r.output}`)
}

/** The manifest line backup-postgres.sh writes for a backup taken at `at`. */
function backupEntry(at: Date): string {
  const s = at.toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')
  return `postgres|${s}|llamenos-postgres-${s}.dump.age|4096|${'0'.repeat(64)}|manual`
}

function gate(name: string, opts: { root?: string; backup?: string | null } = {}): Run {
  // A backup "just taken": a second ahead, so the manifest's second-resolution
  // stamp never falls before an applied_at from the same second.
  const backup = opts.backup === undefined ? backupEntry(new Date(Date.now() + 1000)) : opts.backup
  return run(
    [
      'scripts/check-migration-safety.ts',
      '--target',
      '--root',
      opts.root ?? REPO_ROOT,
      ...(backup === null ? [] : ['--backup', backup]),
    ],
    { DATABASE_URL: databaseUrlFor(name) },
  )
}

/** A scratch copy of this repo's drizzle tree, to add pending migrations to. */
function scratchRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'migsafe-'))
  cpSync(path.join(REPO_ROOT, 'drizzle'), path.join(root, 'drizzle'), { recursive: true })
  scratchRoots.push(root)
  return root
}

function addMigration(root: string, file: string, sql: string): void {
  writeFileSync(path.join(root, 'drizzle', 'migrations', file), sql)
}

/** Timestamped prefixes that sort after every real migration, as db:generate's would. */
const FORGET = '99991231235958'
const CONTRACT = '99991231235959'

const DROP_TEAM_ID = 'ALTER TABLE "users" DROP COLUMN "team_id";'
const ALLOW_TEAM_ID =
  '-- migration-safety: allow column public.users.team_id because the release before stopped declaring it\n'

beforeAll(async () => {
  template = await newDatabase()
  migrate(template)
}, TIMEOUT_MS)

afterEach(async () => {
  await admin(async (sql) => {
    for (const name of createdDatabases.splice(0)) await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  })
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
}, TIMEOUT_MS)

afterAll(async () => {
  if (template) await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`))
}, TIMEOUT_MS)

describe('migration safety gate --target', () => {
  it('a fresh database has nothing to protect and needs no backup', async () => {
    const db = await createDatabase()
    const r = gate(db, { backup: null })
    expect(r.output).toContain('fresh database')
    expect(r.status).toBe(0)
  })

  it('an up-to-date database with a fresh backup passes, judging nothing', async () => {
    const db = await createDatabase(template)
    const r = gate(db)
    expect(r.output).toContain('judged 0 pending migration file(s)')
    expect(r.output).toContain('[migration-safety] OK')
    expect(r.status).toBe(0)
  })

  it('a deploy that migrates nothing changes nothing, so needs no backup', async () => {
    const db = await createDatabase(template)
    const r = gate(db, { backup: null })
    expect(r.output).toContain('nothing pending')
    expect(r.status).toBe(0)
  })

  it('refuses to migrate with no pre-upgrade backup', async () => {
    const db = await createDatabase(template)
    const root = scratchRoot()
    addMigration(root, '9999_safe.sql', 'CREATE TABLE safe_addition (id text);')
    expect(gate(db, { root }).status).toBe(0)
    const r = gate(db, { root, backup: null })
    expect(r.status).toBe(1)
    expect(r.output).toContain('pre-upgrade backup: no --backup was given')
  })

  it('refuses a backup taken before the database last changed', async () => {
    const db = await createDatabase(template)
    const root = scratchRoot()
    addMigration(root, '9999_safe.sql', 'CREATE TABLE safe_addition (id text);')
    const r = gate(db, { root, backup: backupEntry(new Date(Date.now() - 10 * 60_000)) })
    expect(r.status).toBe(1)
    expect(r.output).toContain("before this database's last schema change")
  })

  it('refuses a stale backup, and one from the future', async () => {
    const db = await createDatabase(template)
    await withDb(db, (sql) => sql`UPDATE ${sql(LEDGER)} SET applied_at = now() - interval '2 days'`)
    const root = scratchRoot()
    addMigration(root, '9999_safe.sql', 'CREATE TABLE safe_addition (id text);')
    const stale = gate(db, { root, backup: backupEntry(new Date(Date.now() - 3 * 3600_000)) })
    expect(stale.status).toBe(1)
    expect(stale.output).toContain('it must be from the last 60 minutes')
    const future = gate(db, { root, backup: backupEntry(new Date(Date.now() + 3600_000)) })
    expect(future.status).toBe(1)
    expect(future.output).toContain('it must be from the last 60 minutes')
  })

  it('GATE THE GATE: a pending migration dropping a column the database holds fails', async () => {
    const db = await createDatabase(template)
    const root = scratchRoot()
    addMigration(root, '9999_gate.sql', DROP_TEAM_ID)
    const r = gate(db, { root })
    expect(r.status).toBe(1)
    expect(r.output).toContain('judged 1 pending migration file(s)')
    expect(r.output).toContain('9999_gate.sql statement 0: drop-column column public.users.team_id')
    // Nothing ran: the gate only reads.
    const kept = await withDb(
      db,
      (sql) => sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'team_id'`,
    )
    expect(kept).toHaveLength(1)
  })

  it('reads the live catalog: a table no snapshot declares is still one the running release writes', async () => {
    const db = await createDatabase(template)
    await withDb(db, (sql) => sql`CREATE TABLE hand_made (id text)`)
    const root = scratchRoot()
    addMigration(root, '9999_gate.sql', 'ALTER TABLE hand_made ADD COLUMN owner text NOT NULL;')
    const r = gate(db, { root })
    expect(r.status).toBe(1)
    expect(r.output).toContain('add-not-null-column-without-default column public.hand_made.owner')

    // The same statement on a table the pending files create is fine.
    addMigration(root, '9999_gate.sql', 'CREATE TABLE hand_made_2 (id text);\nALTER TABLE hand_made_2 ADD COLUMN owner text NOT NULL;')
    expect(gate(db, { root }).status).toBe(0)
  })

  it('judges against the release this database runs, not the branch base: a skipped forget step is caught', async () => {
    const db = await createDatabase(template)
    const root = scratchRoot()
    const migrations = path.join(root, 'drizzle', 'migrations')
    const meta = path.join(migrations, 'meta')
    // Release N's snapshot, as `bun run db:generate` writes it on this tree:
    // the schema the tree's snapshot heads build (one head, or the merge of
    // several once concurrent migrations have landed), its own id, and every
    // head as a parent. Copying "the last snapshot by filename" instead would
    // model the wrong tree as soon as main has a timestamped migration or two
    // heads (#2391).
    const { heads, schema } = MigrationGraph.load(meta).state()
    const body = structuredClone(schema) as { tables: Record<string, { columns: Record<string, unknown> }> }
    delete body.tables['public.users'].columns.team_id
    const snapshot = { id: randomUUID(), prevId: heads[0].id, prevIds: heads.map((h) => h.id), ...body }
    // Release N forgets users.team_id; release N+1 contracts it. CI judged
    // N+1 against a base that already held N, so its annotation passed there.
    writeFileSync(path.join(meta, `${FORGET}_snapshot.json`), JSON.stringify(snapshot))
    addMigration(root, `${FORGET}_forget_team_id.sql`, '-- users.team_id is no longer declared.\n')
    // N+1 declares what N declared: its snapshot is N's, under its own id.
    writeFileSync(
      path.join(meta, `${CONTRACT}_snapshot.json`),
      JSON.stringify({ ...snapshot, id: randomUUID(), prevId: snapshot.id, prevIds: [snapshot.id] }),
    )
    addMigration(root, `${CONTRACT}_drop_team_id.sql`, ALLOW_TEAM_ID + DROP_TEAM_ID)

    // This database never ran N, so the release it runs still reads team_id.
    const skipped = gate(db, { root })
    expect(skipped.status).toBe(1)
    expect(skipped.output).toContain('the annotation for column public.users.team_id is rejected')

    // Deploy N alone, as its own release, and the contract is accepted.
    const nOnly = scratchRoot()
    cpSync(
      path.join(meta, `${FORGET}_snapshot.json`),
      path.join(nOnly, 'drizzle', 'migrations', 'meta', `${FORGET}_snapshot.json`),
    )
    addMigration(nOnly, `${FORGET}_forget_team_id.sql`, '-- users.team_id is no longer declared.\n')
    migrate(db, path.join(nOnly, 'drizzle', 'migrations'))
    const contracted = gate(db, { root })
    expect(contracted.output).toContain(`against ${FORGET}_snapshot.json`)
    expect(contracted.output).toContain('1 finding(s) allowed by verified annotations')
    expect(contracted.status).toBe(0)
  })

  it('reports a ledger the runner would refuse before the deploy, not after', async () => {
    const db = await createDatabase(template)
    await withDb(db, (sql) => sql`UPDATE ${sql(LEDGER)} SET checksum = 'tampered' WHERE filename = '0024_ep03_teams_tags.sql'`)
    const r = gate(db)
    expect(r.status).toBe(1)
    expect(r.output).toContain('0024_ep03_teams_tags.sql was applied with checksum tampered')
  })
})
