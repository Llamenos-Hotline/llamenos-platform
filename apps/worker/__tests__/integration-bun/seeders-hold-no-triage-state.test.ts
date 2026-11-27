/**
 * #2779, #3114 — what the seeders write holds no status, severity or contact
 * type, and the schema keeps it that way.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/seeders-hold-no-triage-state.test.ts
 *
 * Both seeders ran against real PostgreSQL, through the real services:
 *   - `POST /api/test-seed` (routes/dev.ts), which seeded each case with its
 *     template's default status and each contact with its type, and slugified
 *     the display name into `identifier_hashes`;
 *   - `seedSampleDataset` (services/sample-seeder.ts), which seeded a status per
 *     case and a type per contact.
 *
 * The columns that held those values are retired, not yet dropped (the contract
 * release does that), so the assertion reads them straight from the catalog: every
 * retired column that still exists is NULL in every row. After the contract
 * release the columns are gone and the same test passes on an empty list.
 *
 * The triggers are the part a seeder cannot show. A previous-release pod is still
 * serving while this release rolls out, and it writes the plaintext value; the
 * trigger must null it, so a rollout leaves nothing behind either.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { createServices } from '../../services'
import { seedSampleDataset } from '../../services/sample-seeder'
import { sampleIdentities } from '../../lib/sample-identities'
import dev from '../../routes/dev'
import type { AppEnv } from '../../types'
import { requireDatabaseUrl } from '../helpers/database-url'

const db = createDatabase(requireDatabaseUrl())

const SECRET = 'seeders-hold-no-triage-state-secret'
const ENV = {
  ENVIRONMENT: 'development',
  DEV_ROUTES_ENABLED: 'true',
  DEV_RESET_SECRET: SECRET,
  MESSAGING_HASH_KEY: 'ab'.repeat(32),
  SERVER_KEK: 'ef'.repeat(32),
}

const services = createServices(db, {
  hmacSecret: 'cd'.repeat(32),
  serverKek: ENV.SERVER_KEK,
  messagingHashKey: ENV.MESSAGING_HASH_KEY,
  env: ENV,
})

const RETIRED: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'case_records', column: 'status_hash' },
  { table: 'case_records', column: 'severity_hash' },
  { table: 'case_records', column: 'category_hash' },
  { table: 'events', column: 'status_hash' },
  { table: 'contacts', column: 'contact_type_hash' },
  { table: 'contacts', column: 'status_hash' },
  { table: 'case_interactions', column: 'previous_status_hash' },
  { table: 'case_interactions', column: 'new_status_hash' },
]

async function existingRetiredColumns() {
  const rows = await db.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (${sql.join(RETIRED.map(r => sql`(${r.table}, ${r.column})`), sql`, `)})`)
  return (rows as unknown as Array<{ table_name: string; column_name: string }>)
}

/** Every row of every retired column that still exists, that holds a value. */
async function valuesHeld(): Promise<string[]> {
  const held: string[] = []
  for (const { table_name: table, column_name: column } of await existingRetiredColumns()) {
    const rows = await db.execute(sql.raw(`SELECT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL`))
    for (const row of rows as unknown as Array<{ v: string }>) held.push(`${table}.${column}=${row.v}`)
  }
  return held
}

function devApp() {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => { c.set('services', services); await next() })
  app.route('/', dev)
  return app
}

const HUB_ID = crypto.randomUUID()
const ADMIN_SEED = 'ab'.repeat(32)

afterAll(async () => {
  await services.hubs.purgeHub(HUB_ID, services.callRecordings).catch(() => undefined)
})

describe('POST /api/test-seed', () => {
  it('writes no status, severity or contact type, and no name slug as an identifier index', async () => {
    const res = await devApp().request('/test-seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Test-Secret': SECRET },
      body: JSON.stringify({
        hubId: HUB_ID,
        adminSeed: ADMIN_SEED,
        permissions: { enableCaseManagement: true },
        entityTypes: [{ template: 'arrest_case', records: 2, assignTo: [] }, { template: 'protest_event', records: 1, assignTo: [] }],
        contacts: [{ displayName: 'Seeded Contact Name', contactType: 'individual' }],
      }),
    }, ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as { records: unknown[]; warnings?: string[] }
    expect(body.records.length).toBeGreaterThan(0)

    expect(await valuesHeld()).toEqual([])

    const contacts = await db.execute(sql`SELECT identifier_hashes FROM contacts WHERE hub_id = ${HUB_ID}`)
    const rows = contacts as unknown as Array<{ identifier_hashes: string[] }>
    expect(rows.length).toBe(1)
    // The real clients write none until per-hub index keys exist (D7/E5), and a
    // slug of the display name is a reversible index of a name.
    expect(rows[0].identifier_hashes).toEqual([])
  })
})

describe('seedSampleDataset', () => {
  it('writes no status, severity or contact type', async () => {
    await services.identity.ensureSampleAccounts(sampleIdentities(ENV))
    const summary = await seedSampleDataset(services, ENV)
    expect(summary.cases).toBeGreaterThan(0)
    expect(summary.contacts).toBeGreaterThan(0)

    expect(await valuesHeld()).toEqual([])
  })
})

describe('the rollout window', () => {
  it('nulls a retired column a previous-release pod still writes', async () => {
    const present = await existingRetiredColumns()
    if (present.length === 0) return // the contract release dropped them; nothing can be written

    const hubId = `hub-trigger-${crypto.randomUUID()}`
    await db.execute(sql`INSERT INTO hubs (id, name, slug, status, created_by) VALUES (${hubId}, 'trigger', ${hubId}, 'active', 'creator')`)
    try {
      const has = (table: string, column: string) => present.some(p => p.table_name === table && p.column_name === column)
      if (has('case_records', 'status_hash')) {
        await db.execute(sql`INSERT INTO case_records (id, hub_id, status_hash, severity_hash, category_hash, created_by)
          VALUES (${`rec-${hubId}`}, ${hubId}, 'open', 'high', 'arrest', 'creator')`)
        await db.execute(sql`UPDATE case_records SET status_hash = 'closed' WHERE id = ${`rec-${hubId}`}`)
      }
      if (has('contacts', 'contact_type_hash')) {
        await db.execute(sql`INSERT INTO contacts (id, hub_id, encrypted_summary, contact_type_hash, status_hash)
          VALUES (${`con-${hubId}`}, ${hubId}, 'ct', 'individual', 'active')`)
      }
      if (has('events', 'status_hash')) {
        await db.execute(sql`INSERT INTO events (id, hub_id, event_type_hash, status_hash, created_by)
          VALUES (${`ev-${hubId}`}, ${hubId}, 'type', 'open', 'creator')`)
      }
      const held = (await valuesHeld()).filter(v => v.includes('open') || v.includes('closed') || v.includes('individual') || v.includes('active') || v.includes('high') || v.includes('arrest'))
      expect(held).toEqual([])
    } finally {
      await db.execute(sql`DELETE FROM contacts WHERE hub_id = ${hubId}`)
      await db.execute(sql`DELETE FROM events WHERE hub_id = ${hubId}`)
      await db.execute(sql`DELETE FROM case_records WHERE hub_id = ${hubId}`)
      await db.execute(sql`DELETE FROM hubs WHERE id = ${hubId}`)
    }
  })
})
