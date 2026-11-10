/**
 * Call history status filter integration tests (#1139) — real PostgreSQL.
 *
 * GET /calls/history?status=… was silently ignored: the schema had no `status`,
 * so the filter chips narrowed the page while `total` and the pager still
 * described the unfiltered set. These tests pin the invariant that the count
 * and the page run under the SAME WHERE — `total` is the filtered total.
 */
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { CallsService } from '../../services/calls'
import type { Database } from '../../db'
import * as schema from '../../db/schema'

// CallsService seals §2.5 metadata via lib/crypto (#1684), which loads the
// Rust library through bun:ffi — unavailable under Vitest's Node runtime.
// Same mock the other integration suites use.
vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_callhist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.active_calls (
    call_id TEXT PRIMARY KEY,
    push_ref TEXT UNIQUE,
    hub_id TEXT,
    caller_number_sealed TEXT,
    answered_by TEXT,
    status TEXT NOT NULL DEFAULT 'ringing',
    has_transcription BOOLEAN DEFAULT FALSE,
    has_voicemail BOOLEAN DEFAULT FALSE,
    has_recording BOOLEAN DEFAULT FALSE,
    recording_sid TEXT,
    reported_by TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    duration INTEGER
  );
  CREATE TABLE ${TEST_SCHEMA}.call_records (
    call_id TEXT PRIMARY KEY,
    hub_id TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    duration INTEGER,
    answered_by TEXT,
    status TEXT NOT NULL,
    has_transcription BOOLEAN DEFAULT FALSE,
    has_voicemail BOOLEAN DEFAULT FALSE,
    has_recording BOOLEAN DEFAULT FALSE,
    recording_sid TEXT,
    encrypted_content TEXT NOT NULL,
    admin_envelopes JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ${TEST_SCHEMA}.call_tokens (
    token TEXT PRIMARY KEY,
    call_sid TEXT NOT NULL,
    volunteer_pubkey TEXT NOT NULL,
    hub_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`

const JSONB_TYPE = {
  to: 3802,
  from: [3802],
  serialize: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
  parse: (v: string) => {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  },
}

const TIMESTAMPTZ_TYPE = {
  to: 1184,
  from: [1114, 1184],
  serialize: (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)),
  parse: (v: string) => new Date(v),
}

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let calls: CallsService

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)

  testSql = postgres(DATABASE_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE, timestamptz: TIMESTAMPTZ_TYPE },
  })
  const db = drizzle({ client: testSql, schema }) as unknown as Database
  calls = new CallsService(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE active_calls, call_records`
})

const HUB = 'hub-hist'

function historicalCall(callId: string, status: 'completed' | 'unanswered', startedAt: Date) {
  return calls.recordHistoricalCall(HUB, {
    callId,
    startedAt,
    durationSeconds: status === 'completed' ? 120 : 0,
    answeredBy: status === 'completed' ? 'a'.repeat(64) : null,
    status,
    encryptedContent: 'sealed',
    adminEnvelopes: [],
  })
}

describe('listCallHistory status filter (#1139)', () => {
  it('total and the page describe the filtered set, not the unfiltered one', async () => {
    await historicalCall('CA-done-1', 'completed', new Date('2026-01-01T10:00:00Z'))
    await historicalCall('CA-done-2', 'completed', new Date('2026-01-01T11:00:00Z'))
    await historicalCall('CA-missed-1', 'unanswered', new Date('2026-01-01T12:00:00Z'))

    const unfiltered = await calls.listCallHistory(HUB)
    expect(unfiltered.total).toBe(3)

    const completed = await calls.listCallHistory(HUB, { status: 'completed' })
    expect(completed.total).toBe(2)
    expect(completed.calls).toHaveLength(2)
    expect(completed.calls.every(c => c.status === 'completed')).toBe(true)

    const unanswered = await calls.listCallHistory(HUB, { status: 'unanswered' })
    expect(unanswered.total).toBe(1)
    expect(unanswered.calls).toHaveLength(1)
    expect(unanswered.calls[0]).toMatchObject({ callId: 'CA-missed-1', status: 'unanswered' })
  })

  it('paginates within the filtered set — page count comes from the filtered total', async () => {
    // The reported defect: 200 completed + 3 unanswered, page 1 of "Unanswered"
    // looked empty while the pager showed the unfiltered page count.
    for (let i = 0; i < 5; i++) {
      await historicalCall(`CA-done-${i}`, 'completed', new Date(`2026-01-01T1${i}:00:00Z`))
    }
    await historicalCall('CA-missed-1', 'unanswered', new Date('2026-01-02T10:00:00Z'))

    const page = await calls.listCallHistory(HUB, { status: 'unanswered', page: 1, limit: 2 })
    expect(page.total).toBe(1)
    expect(page.hasMore).toBe(false)
    expect(page.calls).toHaveLength(1)
    expect(page.calls[0].status).toBe('unanswered')

    const completedPage = await calls.listCallHistory(HUB, { status: 'completed', page: 2, limit: 2 })
    expect(completedPage.total).toBe(5)
    expect(completedPage.hasMore).toBe(true)
    expect(completedPage.calls).toHaveLength(2)
    expect(completedPage.calls.every(c => c.status === 'completed')).toBe(true)
  })

  it('combines with the date-range filter under one WHERE', async () => {
    await historicalCall('CA-done-old', 'completed', new Date('2026-01-01T10:00:00Z'))
    await historicalCall('CA-done-new', 'completed', new Date('2026-02-01T10:00:00Z'))
    await historicalCall('CA-missed-new', 'unanswered', new Date('2026-02-01T11:00:00Z'))

    const result = await calls.listCallHistory(HUB, {
      status: 'completed',
      dateFrom: '2026-01-15',
      dateTo: '2026-02-15',
    })
    expect(result.total).toBe(1)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0].callId).toBe('CA-done-new')
  })
})
