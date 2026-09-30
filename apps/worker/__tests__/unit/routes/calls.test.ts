/**
 * The calls routes send calls as `callRecordResponseSchema`, never as database rows (#1129).
 *
 * Fixtures are typed as full `active_calls` / `call_records` rows, so they cannot be
 * shaped like the schema and hide a route that passes the row straight through — the
 * blind spot that let `/calls/active` ship `callId` and the caller-number HMAC while its
 * schema said `id`.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import calls from '@worker/routes/calls'
import type { AppEnv } from '@worker/types'
import type { activeCalls, callRecords } from '@worker/db/schema'
import {
  activeCallsResponseSchema,
  callActionResponseSchema,
  callHistoryResponseSchema,
} from '@protocol/schemas/calls'

type ActiveCallRow = typeof activeCalls.$inferSelect
type CallRecordRow = typeof callRecords.$inferSelect

const VOLUNTEER = 'a'.repeat(64)
const REPORTER = 'b'.repeat(64)
// Stand-in for the HMAC-SHA256 of the caller's number the row stores as `callerNumber`.
const CALLER_HASH = 'c0ffee'.repeat(10) + 'beef'
const RECORDING_SID = 'RE-provider-handle-1'

const ACTIVE_CALL_KEYS = [
  'answeredBy', 'callerLast4', 'hasRecording', 'hasTranscription', 'hasVoicemail',
  'hubId', 'id', 'startedAt', 'status',
]

function activeRow(overrides: Partial<ActiveCallRow> = {}): ActiveCallRow {
  return {
    callId: 'CA-active-1',
    hubId: 'hub-1',
    callerNumber: CALLER_HASH,
    callerLast4: '4567',
    answeredBy: VOLUNTEER,
    status: 'in-progress',
    hasTranscription: false,
    hasVoicemail: false,
    hasRecording: true,
    recordingSid: RECORDING_SID,
    reportedBy: REPORTER,
    startedAt: new Date('2026-09-30T10:00:00.000Z'),
    answeredAt: new Date('2026-09-30T10:00:05.000Z'),
    endedAt: null,
    duration: null,
    ...overrides,
  }
}

function historyRow(overrides: Partial<CallRecordRow> = {}): CallRecordRow {
  return {
    callId: 'CA-history-1',
    hubId: 'hub-1',
    callerLast4: '4567',
    startedAt: new Date('2026-09-30T09:00:00.000Z'),
    endedAt: new Date('2026-09-30T09:05:00.000Z'),
    duration: 300,
    answeredBy: VOLUNTEER,
    status: 'completed',
    hasTranscription: false,
    hasVoicemail: false,
    hasRecording: false,
    recordingSid: null,
    encryptedContent: 'ciphertext',
    adminEnvelopes: [{ pubkey: 'd'.repeat(64), enc: 'e'.repeat(64), ct: 'wrapped-key' }],
    createdAt: new Date('2026-09-30T09:05:00.000Z'),
    ...overrides,
  }
}

function createTestApp(permissions: string[], callsService: Record<string, unknown>) {
  const services = {
    calls: callsService,
    audit: { log: vi.fn().mockResolvedValue(undefined) },
  }
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', VOLUNTEER)
    c.set('permissions', permissions)
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'test-req-1')
    c.set('hubId', 'hub-1')
    await next()
  })
  app.route('/', calls)
  return app
}

/** The response must not carry anything that identifies the caller or the reporter. */
function expectNoRowLeak(raw: string) {
  expect(raw).not.toContain(CALLER_HASH)
  expect(raw).not.toContain(REPORTER)
  expect(raw).not.toContain('callId')
  expect(raw).not.toContain('reportedBy')
  expect(raw).not.toContain('callerNumber')
}

describe('GET /active — projects rows onto the active-call shape', () => {
  for (const [role, permissions] of [
    ['a volunteer', ['calls:read-active']],
    ['an admin with calls:read-active-full', ['calls:read-active', 'calls:read-active-full']],
  ] as const) {
    it(`sends ${role} the id, hub and display fields — never the caller hash`, async () => {
      const app = createTestApp([...permissions], {
        getActiveCalls: vi.fn().mockResolvedValue([activeRow()]),
      })

      const res = await app.request('/active')
      expect(res.status).toBe(200)
      const raw = await res.text()
      expectNoRowLeak(raw)
      expect(raw).not.toContain(RECORDING_SID)

      const body = activeCallsResponseSchema.parse(JSON.parse(raw))
      const [call] = (JSON.parse(raw) as { calls: Record<string, unknown>[] }).calls
      expect(Object.keys(call).sort()).toEqual(ACTIVE_CALL_KEYS)
      expect(body.calls[0]).toMatchObject({
        id: 'CA-active-1',
        hubId: 'hub-1',
        callerLast4: '4567',
        answeredBy: VOLUNTEER,
        startedAt: '2026-09-30T10:00:00.000Z',
        status: 'in-progress',
        hasRecording: true,
      })
    })
  }

  it('keeps a ringing call with no answerer and no last four digits', async () => {
    const app = createTestApp(['calls:read-active'], {
      getActiveCalls: vi.fn().mockResolvedValue([
        activeRow({ status: 'ringing', answeredBy: null, answeredAt: null, callerLast4: null }),
      ]),
    })

    const res = await app.request('/active')
    const body = activeCallsResponseSchema.parse(await res.json())
    expect(body.calls[0]).toMatchObject({ id: 'CA-active-1', status: 'ringing', answeredBy: null })
    expect(body.calls[0].callerLast4).toBeUndefined()
  })
})

describe('GET /history — projects rows onto the call-record shape', () => {
  it('sends id-keyed records with the pagination the schema declares', async () => {
    const app = createTestApp(['calls:read-history'], {
      listCallHistory: vi.fn().mockResolvedValue({ calls: [historyRow()], total: 1, hasMore: false }),
    })

    const res = await app.request('/history?page=1&limit=20')
    expect(res.status).toBe(200)
    const raw = await res.text()
    expectNoRowLeak(raw)

    const body = callHistoryResponseSchema.parse(JSON.parse(raw))
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['calls', 'limit', 'page', 'total'])
    expect(body).toMatchObject({ total: 1, page: 1, limit: 20 })
    expect(body.calls[0]).toMatchObject({
      id: 'CA-history-1',
      hubId: 'hub-1',
      endedAt: '2026-09-30T09:05:00.000Z',
      duration: 300,
      status: 'completed',
      encryptedContent: 'ciphertext',
    })
    expect(body.calls[0].adminEnvelopes).toHaveLength(1)
  })
})

describe('single-call routes — wrap the projected call in { call }', () => {
  it('GET /:callId returns an active call without the caller hash', async () => {
    const app = createTestApp(['calls:read-active'], {
      getActiveCallById: vi.fn().mockResolvedValue(activeRow()),
    })

    const res = await app.request('/CA-active-1')
    expect(res.status).toBe(200)
    const raw = await res.text()
    expectNoRowLeak(raw)
    const body = callActionResponseSchema.parse(JSON.parse(raw))
    expect(Object.keys(body.call).sort()).toEqual(ACTIVE_CALL_KEYS)
    expect(body.call.id).toBe('CA-active-1')
  })

  it('GET /:callId falls back to the history record', async () => {
    const app = createTestApp(['calls:read-active'], {
      getActiveCallById: vi.fn().mockResolvedValue(null),
      getCallRecord: vi.fn().mockResolvedValue(historyRow()),
    })

    const res = await app.request('/CA-history-1')
    expect(res.status).toBe(200)
    const body = callActionResponseSchema.parse(await res.json())
    expect(body.call).toMatchObject({ id: 'CA-history-1', status: 'completed' })
  })

  it('POST /:callId/answer returns the answered call without the caller hash', async () => {
    const app = createTestApp(['calls:answer'], {
      answerCall: vi.fn().mockResolvedValue(activeRow()),
    })

    const res = await app.request('/CA-active-1/answer', { method: 'POST' })
    expect(res.status).toBe(200)
    const raw = await res.text()
    expectNoRowLeak(raw)
    const body = callActionResponseSchema.parse(JSON.parse(raw))
    expect(Object.keys(body.call).sort()).toEqual(ACTIVE_CALL_KEYS)
    expect(body.call).toMatchObject({ id: 'CA-active-1', status: 'in-progress', answeredBy: VOLUNTEER })
  })

  it('POST /:callId/hangup returns the finished record', async () => {
    const app = createTestApp(['calls:hangup'], {
      getActiveCallById: vi.fn().mockResolvedValue(activeRow()),
      endCall: vi.fn().mockResolvedValue(historyRow({ callId: 'CA-active-1', encryptedContent: '', adminEnvelopes: [] })),
    })

    const res = await app.request('/CA-active-1/hangup', { method: 'POST' })
    expect(res.status).toBe(200)
    const raw = await res.text()
    expectNoRowLeak(raw)
    const body = callActionResponseSchema.parse(JSON.parse(raw))
    expect(body.call).toMatchObject({ id: 'CA-active-1', status: 'completed', duration: 300 })
    expect(body.call.encryptedContent).toBeUndefined()
  })
})
