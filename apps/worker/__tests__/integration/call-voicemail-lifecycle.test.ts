/**
 * Call voicemail lifecycle integration tests (#1043) — real PostgreSQL.
 *
 * A caller nobody could be rung for still gets a call record (created before ringing is
 * attempted), and a voicemail left afterwards must land on that record — never silently
 * update zero rows. Each run uses an isolated schema that is dropped on teardown.
 */
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { CallsService } from '../../services/calls'
import { ServiceError } from '../../services/service-error'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { requireDatabaseUrl } from '../helpers/database-url'
import { createSchemaTables } from '../helpers/schema-ddl'

// CallsService seals §2.5 metadata via lib/crypto (#1684), which loads the
// Rust library through bun:ffi — unavailable under Vitest's Node runtime.
// Same mock the other integration suites use.
vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const DATABASE_URL = requireDatabaseUrl()

const TEST_SCHEMA = `test_callvm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

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
  await createSchemaTables(adminSql, TEST_SCHEMA, [schema.activeCalls, schema.callRecords, schema.callTokens])

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
    await calls.addCall(HUB, { callId: 'CA-vm-1', callerNumberSealed: null })

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
    await calls.addCall(HUB, { callId: 'CA-vm-2', callerNumberSealed: null })
    await calls.endCall(HUB, 'CA-vm-2')

    await calls.markVoicemail(HUB, 'CA-vm-2')

    const record = await calls.getCallRecord(HUB, 'CA-vm-2')
    expect(record?.hasVoicemail).toBe(true)
  })

  it('throws 404 instead of silently updating zero rows when there is no call record', async () => {
    const err = await calls.markVoicemail(HUB, 'CA-does-not-exist').catch(e => e)
    expect(err).toBeInstanceOf(ServiceError)
    expect((err as ServiceError).status).toBe(404)
  })

  it('does not touch a call in another hub', async () => {
    await calls.addCall(HUB, { callId: 'CA-vm-3', callerNumberSealed: null })

    await expect(calls.markVoicemail('other-hub', 'CA-vm-3')).rejects.toBeInstanceOf(ServiceError)
    expect((await calls.getActiveCallById(HUB, 'CA-vm-3'))?.hasVoicemail).toBe(false)
  })
})

describe('a caller who left the queue for voicemail (#2753)', () => {
  it('stops being answerable by either answer path, and still ends as unanswered', async () => {
    await calls.addCall(HUB, { callId: 'CA-left-1', callerNumberSealed: null })
    const token = await calls.createCallToken({ callSid: 'CA-left-1', volunteerPubkey: 'vol-a', hubId: HUB })

    expect(await calls.markLeftQueue(HUB, 'CA-left-1')).toBe(true)

    // The phone-leg claim (/user-answer) and the in-app claim both find nothing to take.
    expect(await calls.answerCallWithToken(token)).toBeNull()
    const inApp = await calls.answerCall(HUB, 'CA-left-1', 'vol-b').catch(e => e)
    expect(inApp).toBeInstanceOf(ServiceError)
    expect((inApp as ServiceError).status).toBe(409)

    const live = await calls.getActiveCallById(HUB, 'CA-left-1')
    expect(live).toMatchObject({ status: 'voicemail', answeredBy: null, answeredAt: null })

    await calls.markVoicemail(HUB, 'CA-left-1')
    await calls.endCall(HUB, 'CA-left-1')
    const history = await calls.listCallHistory(HUB)
    expect(history.calls[0]).toMatchObject({ callId: 'CA-left-1', status: 'unanswered', hasVoicemail: true, answeredBy: null })
  })

  it('does not take a call somebody already answered', async () => {
    await calls.addCall(HUB, { callId: 'CA-left-2', callerNumberSealed: null })
    await calls.answerCall(HUB, 'CA-left-2', 'vol-a')

    expect(await calls.markLeftQueue(HUB, 'CA-left-2')).toBe(false)
    expect(await calls.getActiveCallById(HUB, 'CA-left-2')).toMatchObject({ status: 'in-progress', answeredBy: 'vol-a' })
  })

  it('only moves a call once, in its own hub', async () => {
    await calls.addCall(HUB, { callId: 'CA-left-3', callerNumberSealed: null })

    expect(await calls.markLeftQueue('other-hub', 'CA-left-3')).toBe(false)
    expect(await calls.markLeftQueue(HUB, 'CA-left-3')).toBe(true)
    expect(await calls.markLeftQueue(HUB, 'CA-left-3')).toBe(false)
    expect(await calls.markLeftQueue(HUB, 'CA-unknown')).toBe(false)
  })

  it('is reaped as unanswered when the provider never reports its end', async () => {
    await calls.addCall(HUB, { callId: 'CA-left-4', callerNumberSealed: null })
    await calls.markLeftQueue(HUB, 'CA-left-4')
    await testSql`UPDATE active_calls SET started_at = NOW() - INTERVAL '3 hours' WHERE call_id = 'CA-left-4'`

    expect(await calls.getActiveCalls(HUB)).toHaveLength(0)
    const history = await calls.listCallHistory(HUB)
    expect(history.calls[0]).toMatchObject({ callId: 'CA-left-4', status: 'unanswered', answeredBy: null })
  })
})
