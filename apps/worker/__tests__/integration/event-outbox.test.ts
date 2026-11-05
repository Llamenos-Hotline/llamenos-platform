/**
 * EventOutbox integration tests — PostgreSQL durability and retry semantics.
 *
 * These tests connect to a real PostgreSQL instance and verify:
 *   1. Events written to the outbox persist across service restarts
 *   2. Failed events are retried with exponential backoff
 *   3. Successfully delivered events are marked as delivered
 *   4. The drain sweep picks up undelivered events
 *   5. Cleanup removes expired rows
 *
 * Requires postgres running at DATABASE_URL (default: local dev postgres).
 * Each test run uses an isolated schema that is dropped on teardown.
 *
 * Uses postgres.js + drizzle-orm/postgres-js — both are Node.js-compatible
 * and work in vitest's worker processes without needing Bun built-ins.
 *
 * JSONB serialization: postgres.js does not automatically serialize JS objects
 * for JSONB parameters. We configure it with a custom type definition so that
 * raw objects (passed by bun-jsonb's customType with no toDriver) are encoded
 * to JSON strings before being sent to PostgreSQL.
 */

// pg-array-patch must be imported before any schema is loaded.
// It patches Drizzle's PgArray.prototype — harmless in the postgres.js context.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { EventOutbox } from '../../lib/event-outbox'
import type { Database } from '../../db'
import * as schema from '../../db/schema'

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

/** Unique schema per test run to prevent cross-run interference */
const TEST_SCHEMA = `test_outbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

/** The hubs the events below are addressed to. */
const HUB_IDS = ['hub-test-1', 'hub-restart-1']

// Mirrors the migrated table, including the #2459 hub constraint: every event
// names a hub that exists. A fixture that could store a hubless event would
// prove nothing about the schema the server actually runs on.
const EVENT_OUTBOX_DDL = `
  CREATE TABLE ${TEST_SCHEMA}.hubs (id TEXT PRIMARY KEY);
  CREATE TABLE ${TEST_SCHEMA}.event_outbox (
    id            SERIAL PRIMARY KEY,
    event_json    JSONB    NOT NULL,
    hub_id        TEXT     NOT NULL REFERENCES ${TEST_SCHEMA}.hubs(id) ON DELETE CASCADE,
    kind          INTEGER  NOT NULL,
    epoch         INTEGER  NOT NULL,
    status        TEXT     NOT NULL DEFAULT 'pending',
    retry_count   INTEGER  NOT NULL DEFAULT 0,
    last_error    TEXT,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

/**
 * postgres.js JSONB type config.
 *
 * By default postgres.js does not know how to serialize a raw JavaScript
 * object for OID 3802 (jsonb). We register a serializer so that objects
 * emitted by Drizzle's bun-jsonb customType (which has no toDriver and
 * therefore passes the value as-is) are converted to JSON strings before
 * being sent to PostgreSQL. PostgreSQL then parses them back to JSONB objects.
 */
const JSONB_TYPE = {
  // OID 3802 = jsonb
  to: 3802,
  from: [3802],
  serialize: (v: unknown) =>
    typeof v === 'string' ? v : JSON.stringify(v),
  parse: (v: string) => {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  },
}

/**
 * postgres.js TIMESTAMPTZ type config.
 *
 * drizzle-orm/postgres-js's execute() passes Date objects from raw sql``
 * template parameters directly to postgres.js's byte encoder, bypassing
 * postgres.js's built-in Date → ISO string coercion. We register explicit
 * serializers so that Date objects are stringified before encoding.
 *
 * OID 1114 = timestamp, OID 1184 = timestamptz
 */
const TIMESTAMPTZ_TYPE = {
  to: 1184,
  from: [1114, 1184],
  serialize: (v: unknown) => v instanceof Date ? v.toISOString() : String(v),
  parse: (v: string) => new Date(v),
}

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let db: Database
let outbox: EventOutbox

beforeAll(async () => {
  // Admin connection — default search_path (public schema)
  adminSql = postgres(DATABASE_URL, { max: 1 })

  // Create isolated test schema and table
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(EVENT_OUTBOX_DDL)
  for (const id of HUB_IDS) await adminSql.unsafe(`INSERT INTO ${TEST_SCHEMA}.hubs (id) VALUES ('${id}')`)

  // Test connection scoped to the test schema via search_path.
  // Configure JSONB serialization so raw objects from bun-jsonb columns
  // are correctly encoded for PostgreSQL.
  testSql = postgres(DATABASE_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE, timestamptz: TIMESTAMPTZ_TYPE },
  })

  // EventOutbox types its db parameter as BunSQLDatabase<schema>. At runtime,
  // drizzle/postgres-js exposes the same ORM interface (insert/update/execute).
  // The cast is safe for integration testing purposes.
  db = drizzle({ client: testSql, schema }) as unknown as Database
  outbox = new EventOutbox(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  // Wipe rows between tests for isolation
  await testSql`TRUNCATE TABLE event_outbox RESTART IDENTITY`
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<Parameters<typeof outbox.enqueue>[0]> = {}) {
  return {
    hubId: 'hub-test-1',
    kind: 1000,
    epoch: Math.floor(Date.now() / 1000 / 86400),
    payload: JSON.stringify({ type: 'test', ts: Date.now() }),
    ...overrides,
  }
}

/** Set next_retry_at in the past so drainBatch picks the row up immediately */
async function makeRetryable(id: number) {
  await testSql`
    UPDATE event_outbox
    SET next_retry_at = NOW() - INTERVAL '1 second'
    WHERE id = ${id}
  `
}

// ---------------------------------------------------------------------------
// 1. Persist across service restart
// ---------------------------------------------------------------------------

describe('persist across service restart', () => {
  it('event enqueued by one outbox instance is visible to a fresh instance', async () => {
    // Simulate first service lifetime: enqueue an event
    const id = await outbox.enqueue(makeEvent({ hubId: 'hub-restart-1', kind: 2000 }))
    expect(id).toBeGreaterThan(0)

    // Simulate restart: create a brand-new EventOutbox backed by the same DB
    const freshOutbox = new EventOutbox(db)
    const batch = await freshOutbox.drainBatch()

    expect(batch).toHaveLength(1)
    expect(batch[0].id).toBe(id)
    expect(batch[0].event.hubId).toBe('hub-restart-1')
    expect(batch[0].event.kind).toBe(2000)
  })

  it('multiple events survive restart and are drained in insertion order', async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(await outbox.enqueue(makeEvent({ kind: 1000 + i, epoch: i })))
    }

    const freshOutbox = new EventOutbox(db)
    const batch = await freshOutbox.drainBatch()

    expect(batch).toHaveLength(3)
    // drainBatch returns rows ORDER BY created_at ASC — same as insertion order
    expect(batch.map((r) => r.id)).toEqual(ids)
    expect(batch.map((r) => r.event.kind)).toEqual([1000, 1001, 1002])
  })

  it('event payload is persisted accurately as a structured object', async () => {
    const payload = JSON.stringify({ text: 'hello world', num: 42, arr: [1, 2, 3] })
    const id = await outbox.enqueue(makeEvent({ payload, kind: 9999 }))

    const freshOutbox = new EventOutbox(db)
    const [row] = await freshOutbox.drainBatch()

    expect(row.id).toBe(id)
    expect(row.event.payload).toBe(payload)
    expect(row.event.kind).toBe(9999)
    expect(row.event.hubId).toBe('hub-test-1')
  })

  // #2459: there is no "global" event. The database refuses an event with no
  // hub and one naming a hub that does not exist, so nothing hubless survives
  // to be drained.
  it('an event with no hub, or an unknown hub, is refused by the database', async () => {
    await expect(testSql`
      INSERT INTO event_outbox (event_json, kind, epoch) VALUES (${'{}'}::jsonb, 1, 1)
    `).rejects.toThrow(/null value in column "hub_id"/)
    await expect(outbox.enqueue(makeEvent({ hubId: 'hub-that-does-not-exist' })))
      .rejects.toThrow()
    expect(await new EventOutbox(db).drainBatch()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Successful delivery is marked
// ---------------------------------------------------------------------------

describe('mark delivered', () => {
  it('markDelivered sets status to delivered', async () => {
    const id = await outbox.enqueue(makeEvent())
    await outbox.markDelivered(id)

    const stats = await outbox.stats()
    expect(stats.delivered).toBe(1)
    expect(stats.pending).toBe(0)
  })

  it('delivered event does not appear in drainBatch', async () => {
    const id = await outbox.enqueue(makeEvent())
    await outbox.markDelivered(id)

    const batch = await outbox.drainBatch()
    expect(batch).toHaveLength(0)
  })

  it('only the targeted event is marked delivered when multiple exist', async () => {
    const id1 = await outbox.enqueue(makeEvent({ kind: 1001 }))
    const id2 = await outbox.enqueue(makeEvent({ kind: 1002 }))
    await outbox.markDelivered(id1)

    const stats = await outbox.stats()
    expect(stats.delivered).toBe(1)
    expect(stats.pending).toBe(1)

    const batch = await outbox.drainBatch()
    expect(batch).toHaveLength(1)
    expect(batch[0].id).toBe(id2)
  })
})

// ---------------------------------------------------------------------------
// 3. Failed events retried with backoff
// ---------------------------------------------------------------------------

describe('retry with backoff', () => {
  it('markFailed increments retry_count', async () => {
    const id = await outbox.enqueue(makeEvent())
    await outbox.markFailed(id, 'connection refused')

    const [row] = await testSql`SELECT retry_count, last_error FROM event_outbox WHERE id = ${id}`
    expect(row.retry_count).toBe(1)
    expect(row.last_error).toBe('connection refused')
  })

  it('markFailed sets next_retry_at in the future', async () => {
    const id = await outbox.enqueue(makeEvent())
    const before = new Date()
    await outbox.markFailed(id, 'timeout')

    const [row] = await testSql`SELECT next_retry_at, status FROM event_outbox WHERE id = ${id}`
    const nextRetryAt = new Date(row.next_retry_at)

    // next_retry_at = now() + 2^1 = now() + 2s (first failure)
    expect(nextRetryAt.getTime()).toBeGreaterThan(before.getTime())
    expect(row.status).toBe('pending')
  })

  it('failed event is not drained until next_retry_at passes', async () => {
    const id = await outbox.enqueue(makeEvent())
    await outbox.markFailed(id, 'transient error')

    // next_retry_at is in the future — should not appear in drain
    const batch = await outbox.drainBatch()
    expect(batch).toHaveLength(0)
  })

  it('failed event is drained after next_retry_at passes', async () => {
    const id = await outbox.enqueue(makeEvent())
    await outbox.markFailed(id, 'transient error')

    // Move next_retry_at into the past
    await makeRetryable(id)

    const batch = await outbox.drainBatch()
    expect(batch).toHaveLength(1)
    expect(batch[0].id).toBe(id)
  })

  it('retry_count increments on each markFailed call', async () => {
    const id = await outbox.enqueue(makeEvent())

    for (let i = 1; i <= 3; i++) {
      await makeRetryable(id)
      await outbox.markFailed(id, `error ${i}`)
    }

    const [row] = await testSql`SELECT retry_count, last_error FROM event_outbox WHERE id = ${id}`
    expect(row.retry_count).toBe(3)
    expect(row.last_error).toBe('error 3')
  })

  it('event is marked failed permanently after MAX_ATTEMPTS (10)', async () => {
    const id = await outbox.enqueue(makeEvent())

    for (let i = 0; i < 10; i++) {
      await makeRetryable(id)
      await outbox.markFailed(id, `attempt ${i + 1}`)
    }

    const [row] = await testSql`SELECT status, retry_count FROM event_outbox WHERE id = ${id}`
    expect(row.status).toBe('failed')
    expect(row.retry_count).toBe(10)
  })

  it('permanently failed event does not appear in drainBatch', async () => {
    const id = await outbox.enqueue(makeEvent())

    for (let i = 0; i < 10; i++) {
      await makeRetryable(id)
      await outbox.markFailed(id, `attempt ${i + 1}`)
    }

    await makeRetryable(id) // even with past next_retry_at, status='failed' blocks drain
    const batch = await outbox.drainBatch()
    expect(batch).toHaveLength(0)
  })

  it('backoff is capped at 300 seconds', async () => {
    const id = await outbox.enqueue(makeEvent())

    // Drive to retry 9 (uncapped would be 2^9 = 512s)
    for (let i = 0; i < 9; i++) {
      await makeRetryable(id)
      await outbox.markFailed(id, `attempt ${i + 1}`)
    }

    const [row] = await testSql`SELECT next_retry_at FROM event_outbox WHERE id = ${id}`
    const nextRetryAt = new Date(row.next_retry_at)
    const now = new Date()

    // Cap is 300s; allow 10s tolerance for test execution time
    const futureMs = nextRetryAt.getTime() - now.getTime()
    expect(futureMs).toBeLessThanOrEqual(310_000)
    expect(futureMs).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Drain sweep picks up undelivered events
// ---------------------------------------------------------------------------

describe('drain sweep', () => {
  it('drainBatch returns only pending events with next_retry_at in the past', async () => {
    // pending + immediately retryable
    const id1 = await outbox.enqueue(makeEvent({ kind: 1 }))
    // pending but scheduled in the future
    await outbox.enqueue(makeEvent({ kind: 2 }))
    await testSql`
      UPDATE event_outbox
      SET next_retry_at = NOW() + INTERVAL '1 hour'
      WHERE kind = 2
    `
    // delivered
    const id3 = await outbox.enqueue(makeEvent({ kind: 3 }))
    await outbox.markDelivered(id3)
    // permanently failed
    const id4 = await outbox.enqueue(makeEvent({ kind: 4 }))
    await testSql`UPDATE event_outbox SET status = 'failed' WHERE id = ${id4}`

    const batch = await outbox.drainBatch()
    expect(batch).toHaveLength(1)
    expect(batch[0].id).toBe(id1)
  })

  it('drainBatch returns rows oldest-first', async () => {
    const id1 = await outbox.enqueue(makeEvent({ kind: 10 }))
    // Backdate id1 so it was created earlier
    await testSql`UPDATE event_outbox SET created_at = NOW() - INTERVAL '5 seconds' WHERE id = ${id1}`
    const id2 = await outbox.enqueue(makeEvent({ kind: 20 }))

    const batch = await outbox.drainBatch()
    expect(batch).toHaveLength(2)
    expect(batch[0].id).toBe(id1)
    expect(batch[1].id).toBe(id2)
  })

  it('stats reports correct counts across statuses', async () => {
    const id1 = await outbox.enqueue(makeEvent())
    const id2 = await outbox.enqueue(makeEvent())
    const id3 = await outbox.enqueue(makeEvent())

    await outbox.markDelivered(id1)
    await testSql`UPDATE event_outbox SET status = 'failed' WHERE id = ${id2}`

    const stats = await outbox.stats()
    expect(stats.pending).toBe(1)
    expect(stats.delivered).toBe(1)
    expect(stats.failed).toBe(1)

    // id3 is still pending and retryable
    const batch = await outbox.drainBatch()
    expect(batch.map((r) => r.id)).toContain(id3)
  })
})

// ---------------------------------------------------------------------------
// 5. Cleanup removes expired rows
// ---------------------------------------------------------------------------

describe('cleanup', () => {
  it('cleanup removes delivered rows past the 1-hour TTL', async () => {
    const id = await outbox.enqueue(makeEvent())
    await outbox.markDelivered(id)

    // Age the row beyond 1 hour
    await testSql`UPDATE event_outbox SET created_at = NOW() - INTERVAL '2 hours' WHERE id = ${id}`

    const deleted = await outbox.cleanup()
    expect(deleted).toBeGreaterThanOrEqual(1)

    const rows = await testSql`SELECT id FROM event_outbox WHERE id = ${id}`
    expect(rows.length).toBe(0)
  })

  it('cleanup removes failed rows past the 24-hour TTL', async () => {
    const id = await outbox.enqueue(makeEvent())
    await testSql`UPDATE event_outbox SET status = 'failed' WHERE id = ${id}`
    await testSql`UPDATE event_outbox SET created_at = NOW() - INTERVAL '25 hours' WHERE id = ${id}`

    const deleted = await outbox.cleanup()
    expect(deleted).toBeGreaterThanOrEqual(1)

    const rows = await testSql`SELECT id FROM event_outbox WHERE id = ${id}`
    expect(rows.length).toBe(0)
  })

  it('cleanup does not remove pending events regardless of age', async () => {
    const id = await outbox.enqueue(makeEvent())
    await testSql`UPDATE event_outbox SET created_at = NOW() - INTERVAL '48 hours' WHERE id = ${id}`

    await outbox.cleanup()

    const [row] = await testSql`SELECT id, status FROM event_outbox WHERE id = ${id}`
    expect(row).toBeDefined()
    expect(row.status).toBe('pending')
  })

  it('cleanup does not remove recently delivered rows', async () => {
    const id = await outbox.enqueue(makeEvent())
    await outbox.markDelivered(id)
    // created_at is default NOW() — within the 1-hour TTL

    const deleted = await outbox.cleanup()
    expect(deleted).toBe(0)

    const [row] = await testSql`SELECT id FROM event_outbox WHERE id = ${id}`
    expect(row).toBeDefined()
  })

  it('cleanup returns total count of deleted rows', async () => {
    // 2 delivered (aged past 1h TTL) + 1 failed (aged past 24h TTL) = 3 rows
    for (let i = 0; i < 2; i++) {
      const id = await outbox.enqueue(makeEvent())
      await outbox.markDelivered(id)
      await testSql`UPDATE event_outbox SET created_at = NOW() - INTERVAL '2 hours' WHERE id = ${id}`
    }
    const id3 = await outbox.enqueue(makeEvent())
    await testSql`
      UPDATE event_outbox
      SET status = 'failed', created_at = NOW() - INTERVAL '25 hours'
      WHERE id = ${id3}
    `

    const deleted = await outbox.cleanup()
    expect(deleted).toBe(3)
  })
})
