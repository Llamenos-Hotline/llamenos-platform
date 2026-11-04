import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import auditRoutes, { platformAuditRoutes } from '@worker/routes/audit'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(opts: {
  permissions?: string[]
  /** The path hub hubContext would set; `null` = a request outside any hub. */
  hubId?: string | null
  pubkey?: string
  serviceMock?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['*'],
    hubId = 'hub-1',
    pubkey = 'a'.repeat(64),
    serviceMock = {},
  } = opts

  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', {
      audit: serviceMock.audit || {},
    } as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'test-req-1')
    c.set('user', {
      pubkey,
      name: 'Test User',
      phone: '+1555000000',
      roles: permissions.includes('*') ? ['role-super-admin'] : ['role-volunteer'],
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
    if (hubId !== null) {
      c.set('hubId', hubId)
    }
    await next()
  })

  app.route('/audit', auditRoutes)
  app.route('/admin/audit', platformAuditRoutes)

  return { app }
}

const makeEntry = (overrides = {}) => ({
  id: 'entry-1',
  action: 'userCreated',
  actorPubkey: 'a'.repeat(64),
  details: {},
  createdAt: new Date().toISOString(),
  previousEntryHash: null,
  entryHash: 'abc123',
  ...overrides,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // GET /audit — List audit entries
  // -------------------------------------------------------------------------

  describe('GET /audit', () => {
    it('returns audit entries for super admin', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        entries: [makeEntry(), makeEntry({ id: 'entry-2', action: 'hubCreated' })],
        total: 2,
        page: 1,
        limit: 50,
      })
      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: { audit: { list: listSpy } },
      })

      const res = await app.request('/audit')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.entries).toHaveLength(2)
      expect(json.entries[0].action).toBe('userCreated')
    })

    it('requires audit:read permission', async () => {
      const { app } = createTestApp({
        permissions: ['other:read'],
        serviceMock: { audit: { list: vi.fn() } },
      })

      const res = await app.request('/audit')
      expect(res.status).toBe(403)
    })

    it('passes hubId from context to audit service', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
      })
      const { app } = createTestApp({
        permissions: ['audit:read'],
        hubId: 'hub-42',
        serviceMock: { audit: { list: listSpy } },
      })

      const res = await app.request('/audit')
      expect(res.status).toBe(200)
      // First positional arg is hubId (hubScoped: true)
      expect(listSpy).toHaveBeenCalledWith('hub-42', expect.anything())
    })

    it('refuses (404) outside a hub, even to a super-admin, without reading any log (#2395)', async () => {
      const listSpy = vi.fn()
      const verifySpy = vi.fn()
      const { app } = createTestApp({
        permissions: ['*'],
        hubId: null,
        serviceMock: { audit: { list: listSpy, verifyChain: verifySpy } },
      })

      expect((await app.request('/audit')).status).toBe(404)
      expect((await app.request('/audit/verify')).status).toBe(404)
      expect(listSpy).not.toHaveBeenCalled()
      expect(verifySpy).not.toHaveBeenCalled()
    })

    it('verifies the path hub\'s chain', async () => {
      const verifySpy = vi.fn().mockResolvedValue({ valid: true, totalEntries: 0, checkedEntries: 0 })
      const { app } = createTestApp({
        permissions: ['audit:read'],
        hubId: 'hub-42',
        serviceMock: { audit: { verifyChain: verifySpy } },
      })

      const res = await app.request('/audit/verify?hubId=hub-other')
      expect(res.status).toBe(200)
      // The query's hubId is never the scope: the path hub is.
      expect(verifySpy).toHaveBeenCalledWith('hub-42', { limit: 500, offset: 0 })
    })

    it('forwards actorPubkey filter query param', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
      })
      const { app } = createTestApp({
        permissions: ['audit:read'],
        hubId: 'hub-1',
        serviceMock: { audit: { list: listSpy } },
      })

      const actor = 'b'.repeat(64)
      const res = await app.request(`/audit?actorPubkey=${actor}`)
      expect(res.status).toBe(200)
      expect(listSpy).toHaveBeenCalledWith(
        'hub-1',
        expect.objectContaining({ actorPubkey: actor }),
      )
    })

    it('forwards eventType filter query param', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
      })
      const { app } = createTestApp({
        permissions: ['audit:read'],
        hubId: 'hub-1',
        serviceMock: { audit: { list: listSpy } },
      })

      const res = await app.request('/audit?eventType=userCreated')
      expect(res.status).toBe(200)
      expect(listSpy).toHaveBeenCalledWith(
        'hub-1',
        expect.objectContaining({ eventType: 'userCreated' }),
      )
    })

    it('forwards dateFrom and dateTo filters', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        entries: [],
        total: 0,
        page: 1,
        limit: 50,
      })
      const { app } = createTestApp({
        permissions: ['audit:read'],
        hubId: 'hub-1',
        serviceMock: { audit: { list: listSpy } },
      })

      const res = await app.request('/audit?dateFrom=2024-01-01&dateTo=2024-01-31')
      expect(res.status).toBe(200)
      expect(listSpy).toHaveBeenCalledWith(
        'hub-1',
        expect.objectContaining({ dateFrom: '2024-01-01', dateTo: '2024-01-31' }),
      )
    })

    it('returns hash chain fields for verifying log integrity', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        entries: [
          makeEntry({
            id: 'entry-1',
            previousEntryHash: null,
            entryHash: 'hash1',
          }),
          makeEntry({
            id: 'entry-2',
            previousEntryHash: 'hash1',
            entryHash: 'hash2',
          }),
        ],
        total: 2,
        page: 1,
        limit: 50,
      })
      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: { audit: { list: listSpy } },
      })

      const res = await app.request('/audit')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.entries[0].entryHash).toBe('hash1')
      expect(json.entries[1].previousEntryHash).toBe('hash1')
      expect(json.entries[1].entryHash).toBe('hash2')
    })
  })

  // -------------------------------------------------------------------------
  // GET, DELETE disabled — verify 404 / not registered
  // -------------------------------------------------------------------------

  describe('disabled methods', () => {
    it('GET /audit/:id returns 404 — single-item get is disabled', async () => {
      const listSpy = vi.fn().mockResolvedValue({ entries: [], total: 0, page: 1, limit: 50 })
      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: { audit: { list: listSpy } },
      })

      const res = await app.request('/audit/some-entry-id')
      // disableGet: true means no GET /:id route is registered
      expect(res.status).toBe(404)
    })

    it('DELETE /audit/:id returns 404 — delete is disabled', async () => {
      const { app } = createTestApp({ permissions: ['*'] })

      const res = await app.request('/audit/some-entry-id', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })
})

// ---------------------------------------------------------------------------
// The platform chain — its own route and permission (#2395)
// ---------------------------------------------------------------------------

describe('platform audit routes (/admin/audit)', () => {
  it('lists the platform chain (null), never a hub\'s and never every hub\'s', async () => {
    const listSpy = vi.fn().mockResolvedValue({ entries: [], total: 0 })
    const { app } = createTestApp({
      permissions: ['system:view-audit'],
      hubId: null,
      serviceMock: { audit: { list: listSpy } },
    })

    const res = await app.request('/admin/audit?eventType=userCreated')
    expect(res.status).toBe(200)
    expect(listSpy).toHaveBeenCalledWith(null, expect.objectContaining({ eventType: 'userCreated' }))
  })

  it('verifies the platform chain', async () => {
    const verifySpy = vi.fn().mockResolvedValue({ valid: true, totalEntries: 0, checkedEntries: 0 })
    const { app } = createTestApp({
      permissions: ['system:view-audit'],
      hubId: null,
      serviceMock: { audit: { verifyChain: verifySpy } },
    })

    const res = await app.request('/admin/audit/verify')
    expect(res.status).toBe(200)
    expect(verifySpy).toHaveBeenCalledWith(undefined, { limit: 500, offset: 0 })
  })

  it('requires system:view-audit — audit:read is a hub permission and is not enough', async () => {
    const listSpy = vi.fn()
    const verifySpy = vi.fn()
    const { app } = createTestApp({
      permissions: ['audit:read'],
      hubId: null,
      serviceMock: { audit: { list: listSpy, verifyChain: verifySpy } },
    })

    expect((await app.request('/admin/audit')).status).toBe(403)
    expect((await app.request('/admin/audit/verify')).status).toBe(403)
    expect(listSpy).not.toHaveBeenCalled()
    expect(verifySpy).not.toHaveBeenCalled()
  })
})
