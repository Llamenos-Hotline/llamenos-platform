/**
 * `scripts/run-migrations.ts` — the migration runner the container entrypoint
 * executes before EVERY `exec bun src/server/index.ts`
 * (deploy/docker/docker-entrypoint.sh:33-37).
 *
 * The bug these tests pin: the runner had no ledger. It read all of
 * drizzle/migrations/, sorted by filename, and executed every file on every
 * boot, swallowing "already exists" / "does not exist" to survive the replay.
 * `0024_ep03_teams_tags.sql:50` is a bare `ALTER TABLE "users" DROP COLUMN
 * "team_id"` (no IF EXISTS, and `makeIdempotent()` does not patch DROP COLUMN)
 * and `0026_add-team-id-to-users.sql:1` re-adds it. So boot 1 dropped nothing
 * and then added the column; from boot 2 onward the column EXISTED, the drop
 * succeeded, and every user's team_id was destroyed and re-added as all-NULL.
 * `team_id` is live data (apps/worker/db/schema/users.ts:53,
 * services/identity.ts:97 and :449).
 *
 * The existing suite could not catch this: startup-init.test.ts runs the
 * migrations exactly once per fresh database and then boots the server
 * directly, so the second application never happens. These tests run the
 * sequence repeatedly against ONE database, which is what a restart does.
 *
 * Each test gets its own database, dropped on teardown.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const MIGRATE_TIMEOUT_MS = 120_000
const LEDGER = 'llamenos_schema_migrations'

const createdDatabases: string[] = []

function databaseUrlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

async function createDatabase(): Promise<string> {
  const name = `migrate_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  createdDatabases.push(name)
  return databaseUrlFor(name)
}

interface MigrateResult {
  status: number | null
  output: string
}

/** Run the real entrypoint migration command, exactly as the container does. */
function migrate(databaseUrl: string): MigrateResult {
  const run = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: databaseUrl },
    encoding: 'utf-8',
    timeout: MIGRATE_TIMEOUT_MS,
  })
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

function migrateOrThrow(databaseUrl: string): string {
  const { status, output } = migrate(databaseUrl)
  if (status !== 0) throw new Error(`migrations failed (exit ${status}):\n${output}`)
  return output
}

async function withDb<T>(databaseUrl: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, { max: 1 })
  try {
    return await fn(sql)
  } finally {
    await sql.end()
  }
}

/** Column list of the public schema, ignoring the ledger the runner owns. */
async function publicSchema(databaseUrl: string): Promise<string[]> {
  return withDb(databaseUrl, async (sql) => {
    const rows = await sql<{ sig: string }[]>`
      SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS sig
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> ${LEDGER}
      ORDER BY 1`
    return rows.map((r) => r.sig)
  })
}

afterEach(async () => {
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    for (const name of createdDatabases.splice(0)) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    }
  } finally {
    await admin.end()
  }
}, MIGRATE_TIMEOUT_MS)

describe('migration runner: each file applies at most once', () => {
  it('a second run does not destroy users.team_id', async () => {
    const url = await createDatabase()
    migrateOrThrow(url)

    await withDb(url, async (sql) => {
      await sql`INSERT INTO users (pubkey, team_id) VALUES ('aa', 'team-crisis')`
    })

    // The restart. Under the old runner this replayed 0024's unguarded
    // DROP COLUMN and nulled the column out.
    migrateOrThrow(url)
    // A third boot, because the old bug only bit from the second one onward.
    migrateOrThrow(url)

    await withDb(url, async (sql) => {
      const [user] = await sql<{ team_id: string | null }[]>`
        SELECT team_id FROM users WHERE pubkey = 'aa'`
      expect(user.team_id).toBe('team-crisis')
    })
  }, MIGRATE_TIMEOUT_MS * 4)

  it('records every file once and applies nothing on the next run', async () => {
    const url = await createDatabase()
    const first = migrateOrThrow(url)
    const second = migrateOrThrow(url)

    const { total, applied } = await withDb(url, async (sql) => {
      const [row] = await sql<{ total: number; applied: number }[]>`
        SELECT count(*)::int AS total,
               count(applied_at)::int AS applied
        FROM ${sql(LEDGER)}`
      return row
    })

    expect(total).toBeGreaterThan(0)
    expect(applied).toBe(total)
    expect(first).toMatch(new RegExp(`${total} applied`))
    // Nothing is applied or reconciled on the second run.
    expect(second).toMatch(/0 applied, 0 reconciled/)
    expect(second).toMatch(new RegExp(`${total} already in the ledger`))

    // An edit to an already-applied shipped migration is a hard failure, not a
    // silent re-run — checked on this database rather than a fresh one,
    // because each extra database means another full 55-file migration pass.
    await withDb(url, async (sql) => {
      await sql`UPDATE ${sql(LEDGER)} SET checksum = 'tampered'
                WHERE filename = '0024_ep03_teams_tags.sql'`
    })
    const tampered = migrate(url)
    expect(tampered.status).not.toBe(0)
    expect(tampered.output).toMatch(/0024_ep03_teams_tags\.sql/)
    expect(tampered.output).toMatch(/immutable/)
  }, MIGRATE_TIMEOUT_MS * 3)

  it('applies a file at most once even when the run is interrupted midway', async () => {
    const url = await createDatabase()
    migrateOrThrow(url)
    await withDb(url, async (sql) => {
      await sql`INSERT INTO users (pubkey, team_id) VALUES ('aa', 'team-crisis')`
      // Simulate a crash partway through: the tail of the sequence never got
      // marked applied. The retry must not replay it destructively.
      await sql`UPDATE ${sql(LEDGER)} SET applied_at = NULL, checksum = NULL
                WHERE filename >= '0024'`
    })

    migrateOrThrow(url)

    await withDb(url, async (sql) => {
      const [user] = await sql<{ team_id: string | null }[]>`
        SELECT team_id FROM users WHERE pubkey = 'aa'`
      expect(user.team_id).toBe('team-crisis')
    })
  }, MIGRATE_TIMEOUT_MS * 3)
})

describe('migration runner: a database predating the ledger', () => {
  /**
   * A pre-ledger database is exactly "schema present, ledger absent" — what
   * every database built by the old runner looks like. Dropping the ledger
   * after a normal run reproduces that state faithfully.
   */
  async function asPreLedgerDatabase(url: string): Promise<void> {
    await withDb(url, async (sql) => {
      await sql`DROP TABLE ${sql(LEDGER)}`
    })
  }

  it('reconciles without destroying data, and converges on the fresh schema', async () => {
    const reference = await createDatabase()
    migrateOrThrow(reference)
    const freshSchema = await publicSchema(reference)

    const url = await createDatabase()
    migrateOrThrow(url)
    await withDb(url, async (sql) => {
      await sql`INSERT INTO users (pubkey, team_id) VALUES ('aa', 'team-crisis')`
    })
    await asPreLedgerDatabase(url)

    const output = migrateOrThrow(url)
    expect(output).toMatch(/CATCH-UP RUN/)

    await withDb(url, async (sql) => {
      const [user] = await sql<{ team_id: string | null }[]>`
        SELECT team_id FROM users WHERE pubkey = 'aa'`
      expect(user.team_id).toBe('team-crisis')
    })

    // The reconciliation must leave the schema indistinguishable from one
    // built by a fresh run — no table or column resurrected by the replay,
    // none dropped that should still be there.
    expect(await publicSchema(url)).toEqual(freshSchema)

    // Only the statements that would actually have destroyed something are
    // skipped — skipping more than that is what causes the drift asserted
    // against above.
    const skipped = await withDb(url, async (sql) => {
      const rows = await sql<{ filename: string; skipped_sql: string[] }[]>`
        SELECT filename, skipped_sql FROM ${sql(LEDGER)}
        WHERE jsonb_array_length(skipped_sql) > 0`
      return Object.fromEntries(rows.map((r) => [r.filename, r.skipped_sql.join('\n')]))
    })
    // 0024's unguarded DROP COLUMN — the statement that caused the data loss.
    expect(skipped['0024_ep03_teams_tags.sql']).toMatch(/DROP COLUMN "team_id"/)
    // 0001 rewrites role permissions in place; replaying it would clobber any
    // permission an operator has since edited.
    expect(skipped['0001_rename_volunteers_to_users.sql']).toMatch(/UPDATE "roles"/)
    // Drops of objects that are genuinely empty are NOT skipped.
    expect(skipped['0015_drop_nostr_outbox.sql']).toBeUndefined()
    expect(skipped['0031_remove_phone_plain.sql']).toBeUndefined()

    // And it is a one-off: the next boot applies nothing.
    expect(migrateOrThrow(url)).toMatch(/0 applied, 0 reconciled/)
  }, MIGRATE_TIMEOUT_MS * 5)

})
