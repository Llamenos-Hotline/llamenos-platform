import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import banRoutes from '@worker/routes/bans'
import { banHash } from '@worker/lib/crypto'

const TEST_BAN_HASH_KEY = 'b'.repeat(64)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(opts: {
  permissions?: string[]
  hubId?: string
  pubkey?: string
  serviceMock?: Record<string, unknown>
  auditLogSpy?: ReturnType<typeof vi.fn>
} = {}) {
  const {
    permissions = ['*'],
    hubId,
    pubkey = 'a'.repeat(64),
    serviceMock = {},
    auditLogSpy = vi.fn().mockResolvedValue(undefined),
  } = opts

  const mockAuditService = { log: auditLogSpy }

  const services: Record<string, unknown> = {
    records: serviceMock.records || {},
    audit: mockAuditService,
  }

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
    if (hubId !== undefined) {
      c.set('hubId', hubId)
    }
    c.env = {
      HMAC_SECRET: 'a'.repeat(64),
      BAN_HASH_KEY: TEST_BAN_HASH_KEY,
    } as unknown as AppEnv['Bindings']
    await next()
  })

  app.route('/bans', banRoutes)

  return { app, auditLogSpy }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bans routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // GET /bans — List (via entity-router)
  // -------------------------------------------------------------------------

  describe('GET /bans', () => {
    it('lists bans', async () => {
      const listBansSpy = vi.fn().mockResolvedValue({
        bans: [{ phoneHash: 'f'.repeat(64), reason: 'Spam', bannedBy: 'admin', bannedAt: new Date().toISOString() }],
      })
      const { app } = createTestApp({
        permissions: ['bans:read'],
        hubId: 'hub-1',
        serviceMock: { records: { listBans: listBansSpy } },
      })

      const res = await app.request('/bans')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.bans).toHaveLength(1)
      expect(listBansSpy).toHaveBeenCalledWith('hub-1')
    })

    it('requires bans:read permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/bans')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /bans — Ban a number
  // -------------------------------------------------------------------------

  describe('POST /bans', () => {
    it('bans a valid phone number', async () => {
      const addBanSpy = vi.fn().mockResolvedValue({
        phone: banHash('+12125551234', 'hub-1', TEST_BAN_HASH_KEY),
        reason: 'Spam',
        bannedBy: 'a'.repeat(64),
        bannedAt: new Date().toISOString(),
      })
      const { app, auditLogSpy } = createTestApp({
        permissions: ['bans:create'],
        hubId: 'hub-1',
        serviceMock: { records: { addBan: addBanSpy } },
      })

      const res = await app.request('/bans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+12125551234', reason: 'Spam' }),
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      // The response carries an opaque handle, a reason and a date: no number, masked or not.
      expect(Object.keys(json.ban).sort()).toEqual(['bannedAt', 'bannedBy', 'phoneHash', 'reason'])
      expect(JSON.stringify(json)).not.toContain('1234')
      expect(json.ban.phoneHash).toBe(banHash('+12125551234', 'hub-1', TEST_BAN_HASH_KEY))
      expect(addBanSpy).toHaveBeenCalledWith({
        hubId: 'hub-1',
        phoneHash: banHash('+12125551234', 'hub-1', TEST_BAN_HASH_KEY),
        reason: 'Spam',
        bannedBy: 'a'.repeat(64),
      })
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('keys the hash to the hub it is made in, so another hub gets a different hash for the same number', async () => {
      const hashesByHub = new Map<string, string>()
      for (const hubId of ['hub-1', 'hub-2']) {
        const addBanSpy = vi.fn().mockResolvedValue({ phone: 'x', reason: '', bannedBy: 'a', bannedAt: new Date().toISOString() })
        const { app } = createTestApp({ permissions: ['bans:create'], hubId, serviceMock: { records: { addBan: addBanSpy } } })
        await app.request('/bans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: '+12125551234' }),
        })
        hashesByHub.set(hubId, addBanSpy.mock.calls[0]![0].phoneHash)
      }
      expect(hashesByHub.get('hub-1')).not.toBe(hashesByHub.get('hub-2'))
    })

    it('rejects invalid phone number', async () => {
      const { app } = createTestApp({
        permissions: ['bans:create'],
        serviceMock: { records: {} },
      })

      const res = await app.request('/bans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: 'invalid', reason: 'Spam' }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 403 without bans:create permission', async () => {
      const { app } = createTestApp({ permissions: ['bans:read'] })
      const res = await app.request('/bans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+12125551234' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /bans/bulk — Bulk ban
  // -------------------------------------------------------------------------

  describe('POST /bans/bulk', () => {
    it('bulk bans valid phone numbers', async () => {
      const bulkAddBansSpy = vi.fn().mockResolvedValue(2)
      const { app, auditLogSpy } = createTestApp({
        permissions: ['bans:bulk-create'],
        hubId: 'hub-1',
        serviceMock: { records: { bulkAddBans: bulkAddBansSpy } },
      })

      const res = await app.request('/bans/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones: ['+12125551234', '+12125555678'], reason: 'Spam' }),
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.count).toBe(2)
      expect(bulkAddBansSpy).toHaveBeenCalledWith(
        [
          banHash('+12125551234', 'hub-1', TEST_BAN_HASH_KEY),
          banHash('+12125555678', 'hub-1', TEST_BAN_HASH_KEY),
        ],
        'Spam', 'a'.repeat(64), 'hub-1',
      )
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('rejects when any phone is invalid', async () => {
      const { app } = createTestApp({
        permissions: ['bans:bulk-create'],
        serviceMock: { records: {} },
      })

      const res = await app.request('/bans/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones: ['+12125551234', 'invalid'], reason: 'Spam' }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 403 without bans:bulk-create permission', async () => {
      const { app } = createTestApp({ permissions: ['bans:read'] })
      const res = await app.request('/bans/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones: ['+12125551234'], reason: 'Spam' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /bans/:phoneHash — Unban
  // -------------------------------------------------------------------------

  describe('DELETE /bans/:phoneHash', () => {
    it('refuses a raw E.164 number in the path: it would land in access logs', async () => {
      const removeBanSpy = vi.fn().mockResolvedValue(undefined)
      const { app, auditLogSpy } = createTestApp({
        permissions: ['bans:delete'],
        hubId: 'hub-1',
        serviceMock: { records: { removeBan: removeBanSpy } },
      })

      const res = await app.request('/bans/%2B12125551234', { method: 'DELETE' })
      expect(res.status).toBe(400)
      expect(removeBanSpy).not.toHaveBeenCalled()
      expect(auditLogSpy).not.toHaveBeenCalled()
    })

    it('unbans by the handle from the ban list', async () => {
      const removeBanSpy = vi.fn().mockResolvedValue(undefined)
      const handle = banHash('+12125551234', 'hub-1', TEST_BAN_HASH_KEY)
      const { app, auditLogSpy } = createTestApp({
        permissions: ['bans:delete'],
        hubId: 'hub-1',
        serviceMock: { records: { removeBan: removeBanSpy } },
      })

      const res = await app.request(`/bans/${handle}`, { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(removeBanSpy).toHaveBeenCalledWith(handle, 'hub-1')
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('returns 403 without bans:delete permission', async () => {
      const { app } = createTestApp({ permissions: ['bans:read'] })
      const res = await app.request('/bans/+12125551234', { method: 'DELETE' })
      expect(res.status).toBe(403)
    })
  })
})
