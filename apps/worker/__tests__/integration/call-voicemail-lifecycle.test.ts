/**
 * Call voicemail lifecycle integration tests (#1043) — real PostgreSQL.
 *
 * A caller nobody could be rung for still gets a call record (created before ringing is
 * attempted), and a voicemail left afterwards must land on that record — never silently
 * update zero rows. Each run uses an isolated schema that is dropped on teardown.
 */
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { CallsService } from '../../services/calls'
import { ServiceError } from '../../services/settings'
import type { Database } from '../../db'
import * as schema from '../../db/schema'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_callvm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.active_calls (
    call_id TEXT PRIMARY KEY,
    hub_id TEXT,
    caller_number_hash TEXT NOT NULL,
    caller_last4 TEXT,
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
    caller_last4 TEXT,
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

const HUB = 'hub-vm'

describe('voicemail on a call nobody could be rung for', () => {
  it('flags the active call, and ending it lands in history as unanswered with hasVoicemail', async () => {
    await calls.addCall(HUB, { callId: 'CA-vm-1', callerNumber: 'hash', callerLast4: '4567' })

    await calls.markVoicemail(HUB, 'CA-vm-1')
    const active = await calls.getActiveCallById(HUB, 'CA-vm-1')
    expect(active?.hasVoicemail).toBe(true)

    await calls.endCall(HUB, 'CA-vm-1')

    const history = await calls.listCallHistory(HUB)
    expect(history.total).toBe(1)
    expect(history.calls[0]).toMatchObject({
      callId: 'CA-vm-1',
      status: 'unanswered',
      hasVoicemail: true,
      answeredBy: null,
    })
  })

  it('sets the flag on the history record when the call already ended', async () => {
    await calls.addCall(HUB, { callId: 'CA-vm-2', callerNumber: 'hash' })
    await calls.endCall(HUB, 'CA-vm-2')

    await calls.markVoicemail(HUB, 'CA-vm-2')

    const record = await calls.getCallRecord('CA-vm-2')
    expect(record?.hasVoicemail).toBe(true)
  })

  it('throws 404 instead of silently updating zero rows when there is no call record', async () => {
    const err = await calls.markVoicemail(HUB, 'CA-does-not-exist').catch(e => e)
    expect(err).toBeInstanceOf(ServiceError)
    expect((err as ServiceError).status).toBe(404)
  })

  it('does not touch a call in another hub', async () => {
    await calls.addCall(HUB, { callId: 'CA-vm-3', callerNumber: 'hash' })

    await expect(calls.markVoicemail('other-hub', 'CA-vm-3')).rejects.toBeInstanceOf(ServiceError)
    expect((await calls.getActiveCallById(HUB, 'CA-vm-3'))?.hasVoicemail).toBe(false)
  })
})
