/**
 * Volunteer call-token lifecycle — real telephony router + real CallsService +
 * real PostgreSQL, replaying each provider's documented callback order.
 *
 * Regression for #1038: providers send the SAME opaque callToken to the answer
 * URL (/user-answer) and to the status URL (/call-status), and the status
 * callbacks (initiated/ringing) arrive BEFORE the volunteer picks up. The token
 * used to be deleted on read, so the first pre-answer status callback burned it:
 * the pickup then got a 403, and the answered leg's `completed` callback could
 * not find its call, leaving it `in-progress` for up to 2 hours.
 *
 * Only the telephony adapter and unrelated services are stubbed; the token,
 * active-call and call-record rows are real.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
// The real crypto FFI needs bun:ffi; the route's import graph pulls it in.
import '../mocks/llamenos-crypto-ffi'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { Services } from '@worker/services'
import type { TelephonyAdapter } from '@worker/telephony/adapter'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { CallsService } from '../../services/calls'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({ getDb: vi.fn().mockReturnValue({}) }))
import { getTelephonyFromService, getHubTelephonyFromService } from '@worker/lib/service-factories'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_calltoken_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

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
    try { return JSON.parse(v) } catch { return v }
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
let db: Database
let calls: CallsService

const HUB = 'hub-1'
const V1 = 'a'.repeat(64)
const V2 = 'b'.repeat(64)

/** Adapter stub — real webhook parsing is provider-specific; the status is carried in the body. */
function makeAdapter(): TelephonyAdapter {
  const xml = (body: string) => ({ contentType: 'text/xml', body })
  return {
    validateWebhook: vi.fn().mockResolvedValue(true),
    handleCallAnswered: vi.fn().mockResolvedValue(xml('<Response><Dial><Queue/></Dial></Response>')),
    parseCallStatusWebhook: vi.fn().mockImplementation(async (req: Request) => {
      const form = new URLSearchParams(await req.clone().text())
      return { status: form.get('CallStatus') ?? '' }
    }),
    emptyResponse: vi.fn().mockReturnValue(xml('<Response/>')),
  } as unknown as TelephonyAdapter
}

async function makeApp(adapter: TelephonyAdapter) {
  vi.mocked(getTelephonyFromService).mockResolvedValue(adapter)
  vi.mocked(getHubTelephonyFromService).mockResolvedValue(adapter)

  const services = {
    calls,
    settings: {},
    identity: { getUser: vi.fn().mockResolvedValue({ name: 'Volunteer' }) },
    audit: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Services

  const { default: telephony } = await import('@worker/routes/telephony')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = { ENVIRONMENT: 'test' } as AppEnv['Bindings']
    Object.defineProperty(c, 'executionCtx', {
      value: { waitUntil: vi.fn(), passThroughOnException: vi.fn() },
      writable: true,
      configurable: true,
    })
    await next()
  })
  app.route('/api/telephony', telephony)
  return app
}

type App = Awaited<ReturnType<typeof makeApp>>

function post(app: App, path: string, token: string, callStatus?: string) {
  return app.request(`/api/telephony/${path}?callToken=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: callStatus ? `CallStatus=${callStatus}` : '',
  })
}

async function seedRingingCall(callSid: string, volunteers: string[]): Promise<string[]> {
  await db.insert(schema.activeCalls).values({
    callId: callSid,
    hubId: HUB,
    callerNumber: 'hash',
    callerLast4: '1111',
    status: 'ringing',
  })
  return Promise.all(
    volunteers.map((volunteerPubkey) => calls.createCallToken({ callSid, volunteerPubkey, hubId: HUB })),
  )
}

const activeRow = async (callSid: string) =>
  (await testSql`SELECT status, answered_by FROM active_calls WHERE call_id = ${callSid}`)[0]
const recordRow = async (callSid: string) =>
  (await testSql`SELECT status, answered_by FROM call_records WHERE call_id = ${callSid}`)[0]
const tokenCount = async (callSid: string) =>
  Number((await testSql`SELECT count(*)::int AS n FROM call_tokens WHERE call_sid = ${callSid}`)[0].n)

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)
  testSql = postgres(DATABASE_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE, timestamptz: TIMESTAMPTZ_TYPE },
  })
  db = drizzle({ client: testSql, schema }) as unknown as Database
  calls = new CallsService(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE active_calls, call_records, call_tokens`
})

/**
 * Each provider's documented order for one phone-rung volunteer leg:
 * status callbacks with the leg's token BEFORE the answer, then the answer,
 * then further status callbacks up to `completed`.
 */
const PROVIDER_ORDERS: Array<{ provider: string; steps: Array<['status', string] | ['answer']> }> = [
  {
    provider: 'twilio (initiated, ringing, answer, answered, completed)',
    steps: [['status', 'initiated'], ['status', 'ringing'], ['answer'], ['status', 'answered'], ['status', 'completed']],
  },
  {
    provider: 'vonage (started, ringing, answer, answered, completed)',
    steps: [['status', 'started'], ['status', 'ringing'], ['answer'], ['status', 'answered'], ['status', 'completed']],
  },
  {
    provider: 'plivo (ring_url, answer, hangup)',
    steps: [['status', 'ringing'], ['answer'], ['status', 'completed']],
  },
  {
    provider: 'bandwidth (answer, disconnect)',
    steps: [['answer'], ['status', 'completed']],
  },
]

describe('volunteer call token across the provider callback order (#1038)', () => {
  for (const { provider, steps } of PROVIDER_ORDERS) {
    it(`${provider}: pickup is bridged and completion moves the call to call_records`, async () => {
      const adapter = makeAdapter()
      const app = await makeApp(adapter)
      const [token] = await seedRingingCall('CA-1', [V1])

      for (const step of steps) {
        if (step[0] === 'answer') {
          const res = await post(app, 'user-answer', token)
          expect(res.status, 'volunteer pickup must be bridged, not 403').toBe(200)
          expect(await res.text()).toContain('<Dial')
          expect(await activeRow('CA-1')).toMatchObject({ status: 'in-progress', answered_by: V1 })
        } else {
          const res = await post(app, 'call-status', token, step[1])
          expect(res.status).toBe(200)
        }
      }

      expect(await activeRow('CA-1')).toBeUndefined()
      expect(await recordRow('CA-1')).toMatchObject({ status: 'completed', answered_by: V1 })
      // The volunteer is free again: no active call, and the call's tokens are gone.
      expect(await calls.getActiveCalls(HUB)).toHaveLength(0)
      expect(await tokenCount('CA-1')).toBe(0)
    })
  }

  it('pre-answer status callbacks leave the token intact', async () => {
    const app = await makeApp(makeAdapter())
    const [token] = await seedRingingCall('CA-2', [V1])

    await post(app, 'call-status', token, 'initiated')
    await post(app, 'call-status', token, 'ringing')

    expect(await tokenCount('CA-2')).toBe(1)
    expect(await calls.resolveCallToken(token)).toEqual({ callSid: 'CA-2', volunteerPubkey: V1, hubId: HUB })
    expect((await post(app, 'user-answer', token)).status).toBe(200)
  })

  it('a token cannot answer twice (replayed answer URL)', async () => {
    const app = await makeApp(makeAdapter())
    const [token] = await seedRingingCall('CA-3', [V1])

    expect((await post(app, 'user-answer', token)).status).toBe(200)
    const replay = await post(app, 'user-answer', token)
    expect(replay.status).toBe(403)
    expect(await activeRow('CA-3')).toMatchObject({ status: 'in-progress', answered_by: V1 })
  })

  it('only one of several racing volunteers wins the call', async () => {
    const app = await makeApp(makeAdapter())
    const [t1, t2] = await seedRingingCall('CA-4', [V1, V2])

    const results = await Promise.all([post(app, 'user-answer', t1), post(app, 'user-answer', t2)])
    expect(results.map(r => r.status).sort()).toEqual([200, 403])
    const winner = results[0].status === 200 ? V1 : V2
    expect(await activeRow('CA-4')).toMatchObject({ status: 'in-progress', answered_by: winner })
  })

  it('a cancelled leg reporting completed does not end the answered call', async () => {
    const app = await makeApp(makeAdapter())
    const [t1, t2] = await seedRingingCall('CA-5', [V1, V2])

    expect((await post(app, 'user-answer', t1)).status).toBe(200)
    expect((await post(app, 'call-status', t2, 'completed')).status).toBe(200)

    expect(await activeRow('CA-5')).toMatchObject({ status: 'in-progress', answered_by: V1 })
    expect(await recordRow('CA-5')).toBeUndefined()

    expect((await post(app, 'call-status', t1, 'completed')).status).toBe(200)
    expect(await recordRow('CA-5')).toMatchObject({ status: 'completed', answered_by: V1 })
  })

  it('rejects an answer once the token is older than 5 minutes', async () => {
    const app = await makeApp(makeAdapter())
    const [token] = await seedRingingCall('CA-6', [V1])
    await testSql`UPDATE call_tokens SET created_at = NOW() - INTERVAL '6 minutes' WHERE token = ${token}`

    expect((await post(app, 'user-answer', token)).status).toBe(403)
    expect(await activeRow('CA-6')).toMatchObject({ status: 'ringing', answered_by: null })
  })

  it('rejects an unknown token', async () => {
    const app = await makeApp(makeAdapter())
    await seedRingingCall('CA-7', [V1])
    expect((await post(app, 'user-answer', 'no-such-token')).status).toBe(403)
  })
})
