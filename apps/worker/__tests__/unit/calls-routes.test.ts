import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import calls from '@worker/routes/calls'
import { hashPhone } from '@worker/lib/crypto'
import type { AppEnv } from '@worker/types'
import { ServiceError } from '@worker/services/settings'
import { cancelLosingLegs } from '@worker/services/ringing'
import { DEFAULT_ROLES } from '@shared/permissions'
import type { Role } from '@shared/permissions'

// Ring-leg cancellation talks to the telephony provider — covered in ringing-service.test.ts.
// Here we only assert the answer route invokes it (and only after winning).
vi.mock('@worker/services/ringing', async (orig) => ({
  ...(await orig<typeof import('@worker/services/ringing')>()),
  cancelLosingLegs: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@worker/lib/ws-events', () => ({ publishEvent: vi.fn() }))

const TEST_HMAC_SECRET = 'a'.repeat(64) // gitleaks:allow

function createTestApp(opts: {
  permissions?: string[]
  hubId?: string
  pubkey?: string
  services?: Record<string, unknown>
  env?: AppEnv['Bindings']
} = {}) {
  const {
    permissions = ['*'],
    hubId = 'hub-1',
    pubkey = 'a'.repeat(64),
    services = {},
    env = {} as AppEnv['Bindings'],
  } = opts

  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'test-req-1')
    c.set('user', {
      pubkey,
      name: 'Test User',
      phone: '+1555000000',
      roles: ['role-volunteer'],
      active: true,
      createdAt: new Date().toISOString(),
      encryptedSecretKey: '',
      transcriptionEnabled: false,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: true,
      onBreak: false,
      callPreference: 'phone',
    })
    c.set('hubId', hubId)
    c.env = env
    await next()
  })

  app.route('/', calls)

  return { app, services }
}

function makeMockCallsService() {
  return {
    getActiveCalls: vi.fn().mockResolvedValue([]),
    getTodayCount: vi.fn().mockResolvedValue(5),
    getPresence: vi.fn().mockResolvedValue({ activeCalls: 0, availableVolunteers: 2, users: [] }),
    listCallHistory: vi.fn().mockResolvedValue({ calls: [], total: 0, hasMore: false }),
    getActiveCallById: vi.fn().mockResolvedValue(null),
    getActiveCallByCallId: vi.fn().mockResolvedValue(null),
    getCallRecord: vi.fn().mockResolvedValue(null),
    answerCall: vi.fn().mockResolvedValue({ callId: 'call-1', status: 'in-progress' }),
    endCall: vi.fn().mockResolvedValue({ callId: 'call-1', status: 'completed' }),
    reportSpam: vi.fn().mockResolvedValue({ ok: true }),
    debug: vi.fn().mockResolvedValue({ activeCount: 0, activeCalls: [] }),
  }
}

function makeMockContactsService() {
  return {
    lookupByIdentifierHash: vi.fn().mockResolvedValue(null),
    updateLastInteraction: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockCasesService() {
  return {
    listByContact: vi.fn().mockResolvedValue({ total: 0, records: [] }),
  }
}

function makeMockRecordsService() {
  return {
    addBan: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockAuditService() {
  return {
    log: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMockSettingsService() {
  return {
    getTelephonyProvider: vi.fn().mockResolvedValue(null),
    getFallbackGroup: vi.fn().mockResolvedValue({ userPubkeys: [] }),
    getRoles: vi.fn().mockResolvedValue({ roles: DEFAULT_ROLES as unknown as Role[] }),
  }
}

/** Every roster user is a volunteer member of the hub the tests answer in. */
const HUB_MEMBER = { roles: [] as string[], hubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }] }

/** Volunteers a call would ring: on shift, active, not on break, members of hub-1. */
function makeRingRoster(onShift: string[], users = onShift) {
  return {
    shifts: { getCurrentVolunteers: vi.fn().mockResolvedValue(onShift) },
    identity: {
      getUsers: vi.fn().mockResolvedValue({
        users: users.map(pubkey => ({ pubkey, active: true, onBreak: false, callPreference: 'phone', phone: '+1555', ...HUB_MEMBER })),
      }),
    },
  }
}

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    calls: makeMockCallsService(),
    contacts: makeMockContactsService(),
    cases: makeMockCasesService(),
    records: makeMockRecordsService(),
    audit: makeMockAuditService(),
    settings: makeMockSettingsService(),
    ...makeRingRoster(['a'.repeat(64)]),
    ...overrides,
  }
}

describe('Calls Routes', () => {
  describe('GET /active', () => {
    it('returns active calls with full info when user has calls:read-active-full', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCalls.mockResolvedValue([
        { callId: 'call-1', callerNumber: '+15551234567', status: 'ringing' },
      ])

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:read-active', 'calls:read-active-full'],
        services,
      })

      const res = await app.request('/active')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.calls).toHaveLength(1)
      expect(body.calls[0].callerNumber).toBe('+15551234567')
      expect(callsSvc.getActiveCalls).toHaveBeenCalledWith('hub-1')
    })

    it('redacts callerNumber when user lacks calls:read-active-full', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCalls.mockResolvedValue([
        { callId: 'call-1', callerNumber: '+15551234567', status: 'ringing' },
      ])

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:read-active'],
        services,
      })

      const res = await app.request('/active')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.calls[0].callerNumber).toBe('[redacted]')
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: ['other:perm'] })
      const res = await app.request('/active')
      expect(res.status).toBe(403)
    })
  })

  describe('GET /today-count', () => {
    it('returns today\'s call count', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getTodayCount.mockResolvedValue(12)

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:read-active'],
        services,
      })

      const res = await app.request('/today-count')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.count).toBe(12)
      expect(callsSvc.getTodayCount).toHaveBeenCalledWith('hub-1')
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: [] })
      const res = await app.request('/today-count')
      expect(res.status).toBe(403)
    })
  })

  describe('GET /presence', () => {
    it('returns presence status', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getPresence.mockResolvedValue({
        activeCalls: 1,
        availableVolunteers: 2,
        users: [{ pubkey: 'pk1', status: 'available' }],
      })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:read-presence'],
        services,
      })

      const res = await app.request('/presence')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.activeCalls).toBe(1)
      expect(body.availableVolunteers).toBe(2)
      expect(callsSvc.getPresence).toHaveBeenCalledWith('hub-1')
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: ['calls:read-active'] })
      const res = await app.request('/presence')
      expect(res.status).toBe(403)
    })
  })

  describe('GET /history', () => {
    it('returns paginated call history', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.listCallHistory.mockResolvedValue({
        calls: [{ callId: 'c1' }],
        total: 1,
        hasMore: false,
      })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:read-history'],
        services,
      })

      const res = await app.request('/history?page=1&limit=10')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.calls).toHaveLength(1)
      expect(callsSvc.listCallHistory).toHaveBeenCalledWith('hub-1', {
        search: undefined,
        dateFrom: undefined,
        dateTo: undefined,
        page: 1,
        limit: 10,
      })
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: [] })
      const res = await app.request('/history')
      expect(res.status).toBe(403)
    })
  })

  describe('GET /identify/:identifierHash', () => {
    it('returns contact and cases when found', async () => {
      const contactsSvc = makeMockContactsService()
      contactsSvc.lookupByIdentifierHash.mockResolvedValue({
        id: 'contact-1',
        interactionCount: 3,
      })

      const casesSvc = makeMockCasesService()
      casesSvc.listByContact.mockResolvedValue({
        total: 2,
        records: [
          { id: 'case-1', caseNumber: 'C001', statusHash: 'hash-open' },
          { id: 'case-2', caseNumber: 'C002', statusHash: 'hash-closed' },
        ],
      })

      const services = makeServices({ contacts: contactsSvc, cases: casesSvc })
      const { app } = createTestApp({
        permissions: ['calls:identify-caller'],
        services,
      })

      const res = await app.request('/identify/abc123')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.contact.id).toBe('contact-1')
      expect(body.activeCaseCount).toBe(2)
      expect(body.recentCases).toHaveLength(2)
      expect(contactsSvc.lookupByIdentifierHash).toHaveBeenCalledWith('hub-1', 'abc123')
    })

    it('returns empty result when contact not found', async () => {
      const contactsSvc = makeMockContactsService()
      contactsSvc.lookupByIdentifierHash.mockResolvedValue(null)

      const services = makeServices({ contacts: contactsSvc })
      const { app } = createTestApp({
        permissions: ['calls:identify-caller'],
        services,
      })

      const res = await app.request('/identify/unknown')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.contact).toBeNull()
      expect(body.activeCaseCount).toBe(0)
      expect(body.recentCases).toEqual([])
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: [] })
      const res = await app.request('/identify/abc123')
      expect(res.status).toBe(403)
    })
  })

  describe('POST /:callId/answer', () => {
    const ME = 'a'.repeat(64)
    const ringingCall = { callId: 'call-1', hubId: 'hub-1', status: 'ringing', answeredBy: null }

    function answerApp(callsSvc = makeMockCallsService(), extra: Record<string, unknown> = {}) {
      callsSvc.getActiveCallById.mockResolvedValue(ringingCall)
      const services = makeServices({ calls: callsSvc, ...extra })
      const { app } = createTestApp({ permissions: ['calls:answer'], services })
      return { app, services, callsSvc }
    }

    beforeEach(() => {
      vi.mocked(cancelLosingLegs).mockClear()
    })

    it('answers a call, audits it, and cancels the other ringing legs', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.answerCall.mockResolvedValue({ callId: 'call-1', hubId: 'hub-1', callerLast4: '1234', status: 'in-progress' })
      const { app, services } = answerApp(callsSvc)

      const res = await app.request('/call-1/answer', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.call.status).toBe('in-progress')
      expect(callsSvc.answerCall).toHaveBeenCalledWith('hub-1', 'call-1', ME)
      expect((services.audit as ReturnType<typeof makeMockAuditService>).log).toHaveBeenCalled()
      // In-app answer: no winning phone leg, so every phone leg is a loser.
      expect(cancelLosingLegs).toHaveBeenCalledWith(expect.anything(), services, 'hub-1', 'call-1')
    })

    it('returns 404 when the call does not exist', async () => {
      const callsSvc = makeMockCallsService()
      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({ permissions: ['calls:answer'], services })

      const res = await app.request('/call-1/answer', { method: 'POST' })
      expect(res.status).toBe(404)
      expect(callsSvc.answerCall).not.toHaveBeenCalled()
    })

    it('returns 409 without answering when the call is already in progress', async () => {
      const callsSvc = makeMockCallsService()
      const { app } = answerApp(callsSvc)
      callsSvc.getActiveCallById.mockResolvedValue({ ...ringingCall, status: 'in-progress', answeredBy: 'b'.repeat(64) })

      const res = await app.request('/call-1/answer', { method: 'POST' })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe('Call already answered')
      expect(callsSvc.answerCall).not.toHaveBeenCalled()
      expect(cancelLosingLegs).not.toHaveBeenCalled()
    })

    it('returns 409 and does no side effects when another answer wins the race', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.answerCall.mockRejectedValue(new ServiceError(409, 'Call already answered'))
      const { app, services } = answerApp(callsSvc)

      const res = await app.request('/call-1/answer', { method: 'POST' })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe('Call already answered')
      expect((services.audit as ReturnType<typeof makeMockAuditService>).log).not.toHaveBeenCalled()
      expect(cancelLosingLegs).not.toHaveBeenCalled()
    })

    it('returns 403 when the volunteer was not rung for this call', async () => {
      const callsSvc = makeMockCallsService()
      // Someone else is on shift; the caller is not.
      const { app } = answerApp(callsSvc, makeRingRoster(['b'.repeat(64)]))

      const res = await app.request('/call-1/answer', { method: 'POST' })
      expect(res.status).toBe(403)
      expect(callsSvc.answerCall).not.toHaveBeenCalled()
    })

    it('returns 403 when the volunteer is on shift but on break (not rung)', async () => {
      const callsSvc = makeMockCallsService()
      const roster = makeRingRoster([ME])
      roster.identity.getUsers.mockResolvedValue({
        users: [{ pubkey: ME, active: true, onBreak: true, callPreference: 'phone', phone: '+1555', ...HUB_MEMBER }],
      })
      const { app } = answerApp(callsSvc, roster)

      const res = await app.request('/call-1/answer', { method: 'POST' })
      expect(res.status).toBe(403)
      expect(callsSvc.answerCall).not.toHaveBeenCalled()
    })

    it('returns 500 on generic answer failure', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.answerCall.mockRejectedValue(new Error('DB failure'))
      const { app } = answerApp(callsSvc)

      const res = await app.request('/call-1/answer', { method: 'POST' })
      expect(res.status).toBe(500)
      expect((await res.json()).error).toBe('Failed to answer call')
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: [] })
      const res = await app.request('/call-1/answer', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /:callId/hangup', () => {
    it('hangs up a call when user is the one who answered', async () => {
      const callsSvc = makeMockCallsService()
      const pubkey = 'a'.repeat(64)
      callsSvc.getActiveCallById.mockResolvedValue({
        callId: 'call-1',
        answeredBy: pubkey,
        status: 'in-progress',
      })
      callsSvc.endCall.mockResolvedValue({ callId: 'call-1', status: 'completed' })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:hangup'],
        pubkey,
        services,
      })

      const res = await app.request('/call-1/hangup', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.call.status).toBe('completed')
      expect(callsSvc.getActiveCallById).toHaveBeenCalledWith('hub-1', 'call-1')
      expect(callsSvc.endCall).toHaveBeenCalledWith('hub-1', 'call-1')
    })

    it('returns 404 when call not found', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCallById.mockResolvedValue(null)

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:hangup'],
        services,
      })

      const res = await app.request('/call-1/hangup', { method: 'POST' })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('Call not found')
    })

    it('returns 403 when user did not answer the call', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCallById.mockResolvedValue({
        callId: 'call-1',
        answeredBy: 'b'.repeat(64),
        status: 'in-progress',
      })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:hangup'],
        pubkey: 'a'.repeat(64),
        services,
      })

      const res = await app.request('/call-1/hangup', { method: 'POST' })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('Not your call')
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: [] })
      const res = await app.request('/call-1/hangup', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /:callId/spam', () => {
    it('reports spam when user answered the call', async () => {
      const callsSvc = makeMockCallsService()
      const pubkey = 'a'.repeat(64)
      callsSvc.getActiveCallById.mockResolvedValue({
        callId: 'call-1',
        answeredBy: pubkey,
        status: 'in-progress',
      })
      callsSvc.reportSpam.mockResolvedValue({ ok: true })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:report-spam'],
        pubkey,
        services,
      })

      const res = await app.request('/call-1/spam', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(callsSvc.reportSpam).toHaveBeenCalledWith('hub-1', 'call-1', pubkey)
    })

    it('returns 404 when call not found', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCallById.mockResolvedValue(null)

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:report-spam'],
        services,
      })

      const res = await app.request('/call-1/spam', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('returns 403 when user did not answer the call', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCallById.mockResolvedValue({
        callId: 'call-1',
        answeredBy: 'b'.repeat(64),
        status: 'in-progress',
      })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:report-spam'],
        pubkey: 'a'.repeat(64),
        services,
      })

      const res = await app.request('/call-1/spam', { method: 'POST' })
      expect(res.status).toBe(403)
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: [] })
      const res = await app.request('/call-1/spam', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /:callId/ban', () => {
    it('bans caller and hangs up when user answered the call', async () => {
      const callsSvc = makeMockCallsService()
      const recordsSvc = makeMockRecordsService()
      const auditSvc = makeMockAuditService()
      const pubkey = 'a'.repeat(64)

      const hashedPhone = hashPhone('+15551234567', TEST_HMAC_SECRET)
      callsSvc.getActiveCallByCallId.mockResolvedValue({
        callId: 'call-1',
        answeredBy: pubkey,
        callerNumber: hashedPhone, // already HMAC-hashed at call ingestion
        callerLast4: '4567',
        hubId: 'hub-1',
      })
      callsSvc.endCall.mockResolvedValue({ callId: 'call-1', status: 'completed' })

      const services = makeServices({
        calls: callsSvc,
        records: recordsSvc,
        audit: auditSvc,
      })
      const { app } = createTestApp({
        permissions: ['bans:report'],
        pubkey,
        services,
        env: { HMAC_SECRET: TEST_HMAC_SECRET } as AppEnv['Bindings'],
      })

      const res = await app.request('/call-1/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Harassment' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.banned).toBe(true)
      expect(body.hungUp).toBe(true)
      expect(recordsSvc.addBan).toHaveBeenCalledWith({
        phone: hashedPhone,
        phoneDisplay: '***4567',
        reason: 'Harassment',
        bannedBy: pubkey,
        hubId: 'hub-1',
      })
      expect(callsSvc.endCall).toHaveBeenCalledWith('hub-1', 'call-1')
    })

    it('uses default reason when body reason is empty', async () => {
      const callsSvc = makeMockCallsService()
      const recordsSvc = makeMockRecordsService()
      const pubkey = 'a'.repeat(64)

      const hashedPhone = hashPhone('+15551234567', TEST_HMAC_SECRET)
      callsSvc.getActiveCallByCallId.mockResolvedValue({
        callId: 'call-1',
        answeredBy: pubkey,
        callerNumber: hashedPhone, // already HMAC-hashed at call ingestion
        hubId: 'hub-1',
        // no callerLast4 — phoneDisplay should be undefined
      })

      const services = makeServices({ calls: callsSvc, records: recordsSvc })
      const { app } = createTestApp({
        permissions: ['bans:report'],
        pubkey,
        services,
        env: { HMAC_SECRET: TEST_HMAC_SECRET } as AppEnv['Bindings'],
      })

      const res = await app.request('/call-1/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      expect(recordsSvc.addBan).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Banned during active call', phoneDisplay: undefined }),
      )
    })

    it('returns 404 when call not found', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCallByCallId.mockResolvedValue(null)

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['bans:report'],
        services,
      })

      const res = await app.request('/call-1/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('Call not found')
    })

    it('returns 403 when user did not answer the call', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCallByCallId.mockResolvedValue({
        callId: 'call-1',
        answeredBy: 'b'.repeat(64),
        callerNumber: '+15551234567',
        hubId: 'hub-1',
      })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['bans:report'],
        pubkey: 'a'.repeat(64),
        services,
      })

      const res = await app.request('/call-1/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('Not your call')
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: [] })
      const res = await app.request('/call-1/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('GET /:callId/recording', () => {
    it('returns 404 when no recording is available', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCallById.mockResolvedValue({
        callId: 'call-1',
        recordingSid: null,
        hasRecording: false,
        answeredBy: 'a'.repeat(64),
      })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:read-active', 'calls:read-recording'],
        pubkey: 'a'.repeat(64),
        services,
      })

      const res = await app.request('/call-1/recording')
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe('No recording available for this call')
    })

    it('returns 403 when user is neither admin nor answering volunteer', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.getActiveCallById.mockResolvedValue({
        callId: 'call-1',
        recordingSid: 'REC123',
        hasRecording: true,
        answeredBy: 'b'.repeat(64),
      })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:read-active'],
        pubkey: 'a'.repeat(64),
        services,
      })

      const res = await app.request('/call-1/recording')
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('Forbidden')
    })

    it('allows answering volunteer without admin permission', async () => {
      const callsSvc = makeMockCallsService()
      const pubkey = 'a'.repeat(64)
      callsSvc.getActiveCallById.mockResolvedValue({
        callId: 'call-1',
        recordingSid: 'REC123',
        hasRecording: true,
        answeredBy: pubkey,
      })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:read-active'],
        pubkey,
        services,
      })

      const res = await app.request('/call-1/recording')
      expect(res.status).not.toBe(403)
    })
  })

  describe('GET /debug', () => {
    it('returns debug info', async () => {
      const callsSvc = makeMockCallsService()
      callsSvc.debug.mockResolvedValue({ activeCount: 3, activeCalls: [] })

      const services = makeServices({ calls: callsSvc })
      const { app } = createTestApp({
        permissions: ['calls:debug'],
        services,
      })

      const res = await app.request('/debug')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.activeCount).toBe(3)
      expect(callsSvc.debug).toHaveBeenCalledWith('hub-1')
    })

    it('returns 403 when permission is missing', async () => {
      const { app } = createTestApp({ permissions: [] })
      const res = await app.request('/debug')
      expect(res.status).toBe(403)
    })
  })
})
