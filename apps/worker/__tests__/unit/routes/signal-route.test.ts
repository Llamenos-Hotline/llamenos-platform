/**
 * Unit tests for routes/signal.ts (Signal admin routes)
 *
 * Tests: permission enforcement (settings:manage-messaging gate),
 * identity listing/trust management, queue stats/dead-letters/retry.
 *
 * The route directly instantiates SignalIdentityService and SignalMessageQueue
 * from the DB, so we mock getDb() and both service classes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'

// Mock the DB access and service classes before importing the route
vi.mock('@worker/db', () => ({
  getDb: vi.fn().mockReturnValue({}),
}))

// Use vi.hoisted so mock objects are available when vi.mock factories run
const { mockIdentityService, mockQueue } = vi.hoisted(() => ({
  mockIdentityService: {
    getIdentities: vi.fn().mockResolvedValue([]),
    getUntrustedIdentities: vi.fn().mockResolvedValue([]),
    setTrustLevel: vi.fn().mockResolvedValue(true),
  },
  mockQueue: {
    getStats: vi.fn().mockResolvedValue({ pending: 0, processing: 0, dead: 0 }),
    getDeadLetters: vi.fn().mockResolvedValue([]),
    retryDeadLetter: vi.fn().mockResolvedValue(true),
  },
}))

vi.mock('@worker/messaging/signal/identity', () => ({
  SignalIdentityService: vi.fn(function() { return mockIdentityService }),
}))

vi.mock('@worker/messaging/signal/queue', () => ({
  SignalMessageQueue: vi.fn(function() { return mockQueue }),
}))

import signalRoutes from '@worker/routes/signal'

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
} = {}) {
  const {
    permissions = ['settings:manage-messaging'],
    pubkey = 'a'.repeat(64),
  } = opts

  const auditLog = vi.fn().mockResolvedValue(undefined)

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', {
      audit: { log: auditLog },
    } as unknown as AppEnv['Variables']['services'])
    c.set('user', {
      pubkey,
      name: 'Test Admin',
      phone: '+1555000000',
      roles: ['role-super-admin'],
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
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', signalRoutes)

  const request = (input: string, init?: RequestInit) =>
    app.request(input, init, { HMAC_SECRET: 'a'.repeat(64) })

  return { app, request, auditLog }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIdentityService.getIdentities.mockResolvedValue([])
  mockIdentityService.getUntrustedIdentities.mockResolvedValue([])
  mockIdentityService.setTrustLevel.mockResolvedValue(true)
  mockQueue.getStats.mockResolvedValue({ pending: 0, processing: 0, dead: 0 })
  mockQueue.getDeadLetters.mockResolvedValue([])
  mockQueue.retryDeadLetter.mockResolvedValue(true)
})

// ---------------------------------------------------------------------------
// GET /identities
// ---------------------------------------------------------------------------

describe('GET /signal/identities', () => {
  it('returns all identity records', async () => {
    const identity = { uuid: 'uuid-1', hubId: 'hub-1', trustLevel: 'trusted', fingerprint: 'fp-1' }
    mockIdentityService.getIdentities.mockResolvedValue([identity])

    const { app } = makeApp()
    const res = await app.request('/identities?hub=hub-1')

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.identities as unknown[]).length).toBe(1)
    expect(mockIdentityService.getIdentities).toHaveBeenCalledWith('hub-1')
  })

  it('uses empty string when hub query param not provided', async () => {
    const { app } = makeApp()
    await app.request('/identities')
    expect(mockIdentityService.getIdentities).toHaveBeenCalledWith('')
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })
    const res = await app.request('/identities')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /identities/untrusted
// ---------------------------------------------------------------------------

describe('GET /signal/identities/untrusted', () => {
  it('returns untrusted identity records', async () => {
    const untrusted = { uuid: 'uuid-2', hubId: 'hub-1', trustLevel: 'untrusted', fingerprint: 'fp-2' }
    mockIdentityService.getUntrustedIdentities.mockResolvedValue([untrusted])

    const { app } = makeApp()
    const res = await app.request('/identities/untrusted')

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.identities as unknown[]).length).toBe(1)
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/identities/untrusted')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /identities/trust
// ---------------------------------------------------------------------------

describe('POST /signal/identities/trust', () => {
  const validBody = {
    uuid: 'uuid-1',
    trustLevel: 'TRUSTED_VERIFIED',
    hubId: 'hub-1',
  }

  it('sets trust level and audits on success', async () => {
    mockIdentityService.setTrustLevel.mockResolvedValue(true)

    const { app, auditLog } = makeApp()
    const res = await app.request('/identities/trust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(mockIdentityService.setTrustLevel).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'uuid-1', trustLevel: 'TRUSTED_VERIFIED' }),
    )
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('does not audit when setTrustLevel returns false', async () => {
    mockIdentityService.setTrustLevel.mockResolvedValue(false)

    const { app, auditLog } = makeApp()
    const res = await app.request('/identities/trust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.success).toBe(false)
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('returns 400 on missing uuid', async () => {
    const { app } = makeApp()

    const res = await app.request('/identities/trust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trustLevel: 'TRUSTED_VERIFIED' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: ['audit:read'] })

    const res = await app.request('/identities/trust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /queue/stats
// ---------------------------------------------------------------------------

describe('GET /signal/queue/stats', () => {
  it('returns queue statistics', async () => {
    mockQueue.getStats.mockResolvedValue({ pending: 3, processing: 1, dead: 2 })

    const { request } = makeApp()
    const res = await request('/queue/stats')

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.pending).toBe(3)
    expect(json.dead).toBe(2)
  })

  it('passes hub query param to queue', async () => {
    const { request } = makeApp()
    await request('/queue/stats?hub=hub-1')
    expect(mockQueue.getStats).toHaveBeenCalledWith('hub-1')
  })

  it('passes undefined when hub not specified', async () => {
    const { request } = makeApp()
    await request('/queue/stats')
    expect(mockQueue.getStats).toHaveBeenCalledWith(undefined)
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/queue/stats')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /queue/dead-letters
// ---------------------------------------------------------------------------

describe('GET /signal/queue/dead-letters', () => {
  it('returns dead-letter messages', async () => {
    const deadLetter = { id: 'msg-1', to: '+15550001234', body: '...', failedAt: new Date().toISOString() }
    mockQueue.getDeadLetters.mockResolvedValue([deadLetter])

    const { request } = makeApp()
    const res = await request('/queue/dead-letters')

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.deadLetters as unknown[]).length).toBe(1)
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })
    const res = await app.request('/queue/dead-letters')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /queue/retry/:id
// ---------------------------------------------------------------------------

describe('POST /signal/queue/retry/:id', () => {
  it('retries dead-letter message and audits', async () => {
    mockQueue.retryDeadLetter.mockResolvedValue(true)

    const { request, auditLog } = makeApp()
    const res = await request('/queue/retry/msg-1', { method: 'POST' })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.success).toBe(true)
    expect(mockQueue.retryDeadLetter).toHaveBeenCalledWith('msg-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns success:false when retry returns false', async () => {
    mockQueue.retryDeadLetter.mockResolvedValue(false)

    const { request, auditLog } = makeApp()
    const res = await request('/queue/retry/msg-missing', { method: 'POST' })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.success).toBe(false)
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/queue/retry/msg-1', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})
