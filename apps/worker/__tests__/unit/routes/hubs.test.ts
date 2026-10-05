import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import hubRoutes from '@worker/routes/hubs'
import { ServiceError } from '@worker/services/settings'
import { DEFAULT_ROLES } from '@shared/permissions'

const VOLUNTEER_PERMISSIONS = DEFAULT_ROLES.find(r => r.id === 'role-volunteer')!.permissions

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `permissions` is expressed as a role so hub-scoped routes (behind hubContext)
 * resolve it the way production does: `['*']` makes the caller a global
 * super-admin; anything else is a `role-test` assignment in hub-1 (unless
 * `userHubRoles` says otherwise) and NO global role — a non-super-admin global
 * role carries no hub authority (#1037).
 */
function createTestApp(opts: {
  permissions?: string[]
  hubId?: string
  pubkey?: string
  userHubRoles?: { hubId: string; roleIds: string[] }[]
  globalRoles?: string[]
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
  const isSuper = permissions.includes('*')
  const userHubRoles = opts.userHubRoles ?? (isSuper ? [] : [{ hubId: 'hub-1', roleIds: ['role-test'] }])
  const globalRoles = opts.globalRoles ?? (isSuper ? ['role-super-admin'] : [])
  const allRoles = [{ id: 'role-test', name: 'Test', slug: 'test', permissions, isDefault: false, isSystem: false, description: '' }]

  const mockAuditService = { log: auditLogSpy }

  const settingsMock = (serviceMock.settings || {}) as Record<string, unknown>
  const services: Record<string, unknown> = {
    settings: {
      // hubContext looks the hub up first
      getHub: vi.fn().mockImplementation(async (id: string) => ({ hub: { id, name: id, status: 'active' } })),
      ...settingsMock,
    },
    identity: serviceMock.identity || {},
    audit: mockAuditService,
  }

  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', allRoles as unknown as AppEnv['Variables']['allRoles'])
    c.set('requestId', 'test-req-1')
    c.set('user', {
      pubkey,
      name: 'Test User',
      phone: '+1555000000',
      roles: globalRoles,
      hubRoles: userHubRoles,
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
    // Minimal env
    c.env = {
      HMAC_SECRET: 'test-hmac-secret',
    } as unknown as AppEnv['Bindings']
    await next()
  })

  app.route('/hubs', hubRoutes)

  return { app, auditLogSpy }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hubs routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // GET /hubs — List
  // -------------------------------------------------------------------------

  describe('GET /hubs', () => {
    it('lists all active hubs for super admin', async () => {
      const getHubsSpy = vi.fn().mockResolvedValue({
        hubs: [
          { id: 'hub-1', name: 'Hub 1', status: 'active' },
          { id: 'hub-2', name: 'Hub 2', status: 'suspended' },
          { id: 'hub-3', name: 'Hub 3', status: 'active' },
        ],
      })

      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: { settings: { getHubs: getHubsSpy } },
      })

      const res = await app.request('/hubs')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.hubs).toHaveLength(2)
      expect(json.hubs.map((h: { id: string }) => h.id)).toEqual(['hub-1', 'hub-3'])
    })

    it('lists only member hubs for non-super-admin', async () => {
      const getHubsSpy = vi.fn().mockResolvedValue({
        hubs: [
          { id: 'hub-1', name: 'Hub 1', status: 'active' },
          { id: 'hub-2', name: 'Hub 2', status: 'active' },
          { id: 'hub-3', name: 'Hub 3', status: 'active' },
        ],
      })

      const { app } = createTestApp({
        permissions: ['hubs:read'],
        userHubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }],
        serviceMock: { settings: { getHubs: getHubsSpy } },
      })

      const res = await app.request('/hubs')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.hubs).toHaveLength(1)
      expect(json.hubs[0].id).toBe('hub-1')
    })

    it('returns empty list when user has no hub memberships', async () => {
      const getHubsSpy = vi.fn().mockResolvedValue({
        hubs: [{ id: 'hub-1', name: 'Hub 1', status: 'active' }],
      })

      const { app } = createTestApp({
        permissions: ['hubs:read'],
        userHubRoles: [],
        serviceMock: { settings: { getHubs: getHubsSpy } },
      })

      const res = await app.request('/hubs')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.hubs).toHaveLength(0)
    })

    it('omits hubs where the caller lacks hubs:read', async () => {
      const { app } = createTestApp({
        permissions: ['other:read'],
        serviceMock: { settings: { getHubs: vi.fn().mockResolvedValue({ hubs: [{ id: 'hub-1', name: 'Hub 1', status: 'active' }] }) } },
      })

      const res = await app.request('/hubs')
      expect(res.status).toBe(200)
      expect((await res.json()).hubs).toEqual([])
    })

    // #1037: a non-super-admin global role is not membership of every hub
    it('does not list hubs to a non-super-admin global role without membership', async () => {
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        globalRoles: ['role-hub-admin'],
        userHubRoles: [],
        serviceMock: { settings: { getHubs: vi.fn().mockResolvedValue({ hubs: [{ id: 'hub-1', name: 'Hub 1', status: 'active' }] }) } },
      })

      const res = await app.request('/hubs')
      expect(res.status).toBe(200)
      expect((await res.json()).hubs).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // POST /hubs — Create
  // -------------------------------------------------------------------------

  describe('POST /hubs', () => {
    it('creates a hub with explicit slug', async () => {
      const createHubSpy = vi.fn().mockResolvedValue(undefined)
      const { app } = createTestApp({
        permissions: ['system:manage-hubs'],
        serviceMock: { settings: { createHub: createHubSpy } },
      })

      const res = await app.request('/hubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Hub', slug: 'new-hub' }),
      })

      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.hub.name).toBe('New Hub')
      expect(json.hub.slug).toBe('new-hub')
      expect(createHubSpy).toHaveBeenCalledOnce()
    })

    it('generates slug from name when not provided', async () => {
      const createHubSpy = vi.fn().mockResolvedValue(undefined)
      const { app } = createTestApp({
        permissions: ['system:manage-hubs'],
        serviceMock: { settings: { createHub: createHubSpy } },
      })

      const res = await app.request('/hubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'My Test Hub' }),
      })

      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.hub.slug).toBe('my-test-hub')
    })

    it('rejects empty name-derived slug with 400', async () => {
      const createHubSpy = vi.fn().mockResolvedValue(undefined)
      const { app } = createTestApp({
        permissions: ['system:manage-hubs'],
        serviceMock: { settings: { createHub: createHubSpy } },
      })

      const res = await app.request('/hubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      })

      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toMatch(/generated slug is empty/i)
      expect(createHubSpy).not.toHaveBeenCalled()
    })

    it('returns 403 without system:manage-hubs permission', async () => {
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        serviceMock: { settings: {} },
      })

      const res = await app.request('/hubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Hub' }),
      })
      expect(res.status).toBe(403)
    })

    it('handles ServiceError from createHub', async () => {
      const createHubSpy = vi.fn().mockRejectedValue(
        Object.assign(new Error('Hub already exists'), { status: 409 }),
      )
      const { app } = createTestApp({
        permissions: ['system:manage-hubs'],
        serviceMock: { settings: { createHub: createHubSpy } },
      })

      const res = await app.request('/hubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Existing Hub' }),
      })

      expect(res.status).toBe(500)
    })
  })

  // -------------------------------------------------------------------------
  // GET /hubs/:hubId — Get details
  // -------------------------------------------------------------------------

  describe('GET /hubs/:hubId', () => {
    it('returns hub details for super admin', async () => {
      const getHubSpy = vi.fn().mockResolvedValue({
        hub: { id: 'hub-1', name: 'Hub 1', status: 'active' },
      })
      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: { settings: { getHub: getHubSpy } },
      })

      const res = await app.request('/hubs/hub-1')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.hub.id).toBe('hub-1')
    })

    it('returns hub details for hub member', async () => {
      const getHubSpy = vi.fn().mockResolvedValue({
        hub: { id: 'hub-1', name: 'Hub 1', status: 'active' },
      })
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        userHubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }],
        serviceMock: { settings: { getHub: getHubSpy } },
      })

      const res = await app.request('/hubs/hub-1')
      expect(res.status).toBe(200)
    })

    it('returns 403 for non-member non-super-admin', async () => {
      const getHubSpy = vi.fn().mockResolvedValue({
        hub: { id: 'hub-1', name: 'Hub 1', status: 'active' },
      })
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        userHubRoles: [{ hubId: 'hub-2', roleIds: ['role-volunteer'] }],
        serviceMock: { settings: { getHub: getHubSpy } },
      })

      const res = await app.request('/hubs/hub-1')
      expect(res.status).toBe(403)
    })

    it('returns 404 when hub not found', async () => {
      const getHubSpy = vi.fn().mockRejectedValue(new ServiceError(404, 'Not found'))
      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: { settings: { getHub: getHubSpy } },
      })

      const res = await app.request('/hubs/nonexistent')
      expect(res.status).toBe(404)
    })

    it('returns 403 without hubs:read permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/hubs/hub-1')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /hubs/:hubId — Update
  // -------------------------------------------------------------------------

  describe('PATCH /hubs/:hubId', () => {
    it('updates a hub', async () => {
      const updateHubSpy = vi.fn().mockResolvedValue({ hub: { id: 'hub-1', name: 'Updated' } })
      const { app } = createTestApp({
        permissions: ['system:manage-hubs'],
        serviceMock: { settings: { updateHub: updateHubSpy } },
      })

      const res = await app.request('/hubs/hub-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })

      expect(res.status).toBe(200)
      expect(updateHubSpy).toHaveBeenCalledWith('hub-1', { name: 'Updated' })
    })

    it('returns 403 without system:manage-hubs permission', async () => {
      const { app } = createTestApp({ permissions: ['hubs:read'] })
      const res = await app.request('/hubs/hub-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /hubs/:hubId/members — Add member
  // -------------------------------------------------------------------------

  describe('POST /hubs/:hubId/members', () => {
    it('adds a member to hub', async () => {
      const setHubRoleSpy = vi.fn().mockResolvedValue({ ok: true })
      const { app, auditLogSpy } = createTestApp({
        // The caller holds every permission of the role they grant
        permissions: ['hubs:manage-members', ...VOLUNTEER_PERMISSIONS],
        hubId: 'hub-1',
        serviceMock: {
          identity: { setHubRole: setHubRoleSpy },
          settings: {},
        },
      })

      const res = await app.request('/hubs/hub-1/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), roleIds: ['role-volunteer'] }),
      })

      expect(res.status).toBe(200)
      expect(setHubRoleSpy).toHaveBeenCalledWith({
        pubkey: 'b'.repeat(64),
        hubId: 'hub-1',
        roleIds: ['role-volunteer'],
      })
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('returns 403 without hubs:manage-members permission', async () => {
      const { app } = createTestApp({ permissions: ['hubs:read'] })
      const res = await app.request('/hubs/hub-1/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), roleIds: ['role-volunteer'] }),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /hubs/:hubId/members — hub isolation (#1037)', () => {
    it('refuses a hub admin granting a role broader than their own', async () => {
      const setHubRoleSpy = vi.fn()
      const { app } = createTestApp({
        permissions: ['hubs:manage-members', ...VOLUNTEER_PERMISSIONS],
        serviceMock: { identity: { setHubRole: setHubRoleSpy } },
      })
      const res = await app.request('/hubs/hub-1/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), roleIds: ['role-super-admin'] }),
      })
      expect(res.status).toBe(403)
      expect(setHubRoleSpy).not.toHaveBeenCalled()
    })

    it('refuses a global hub-admin who is not a member of the hub', async () => {
      const setHubRoleSpy = vi.fn()
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        globalRoles: ['role-hub-admin'],
        userHubRoles: [{ hubId: 'hub-2', roleIds: ['role-volunteer'] }],
        serviceMock: { identity: { setHubRole: setHubRoleSpy } },
      })
      const res = await app.request('/hubs/hub-1/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'a'.repeat(64), roleIds: ['role-volunteer'] }),
      })
      expect(res.status).toBe(403)
      expect(setHubRoleSpy).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /hubs/:hubId/members/:pubkey — Remove member
  // -------------------------------------------------------------------------

  describe('DELETE /hubs/:hubId/members/:pubkey', () => {
    it('removes a member from hub', async () => {
      const removeHubRoleSpy = vi.fn().mockResolvedValue(undefined)
      const { app, auditLogSpy } = createTestApp({
        permissions: ['hubs:manage-members'],
        serviceMock: {
          identity: { removeHubRole: removeHubRoleSpy },
          settings: {},
        },
      })

      const res = await app.request('/hubs/hub-1/members/member-pubkey', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(removeHubRoleSpy).toHaveBeenCalledWith({ pubkey: 'member-pubkey', hubId: 'hub-1' })
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('returns 403 without hubs:manage-members permission', async () => {
      const { app } = createTestApp({ permissions: ['hubs:read'] })
      const res = await app.request('/hubs/hub-1/members/member-pubkey', {
        method: 'DELETE',
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /hubs/:hubId — Delete hub
  // -------------------------------------------------------------------------

  describe('DELETE /hubs/:hubId', () => {
    it('deletes a hub', async () => {
      const deleteHubSpy = vi.fn().mockResolvedValue(undefined)
      const getHubStorageCredentialsSpy = vi.fn().mockResolvedValue(undefined)
      const { app } = createTestApp({
        permissions: ['system:manage-hubs'],
        serviceMock: {
          settings: {
            deleteHub: deleteHubSpy,
            getHubStorageCredentials: getHubStorageCredentialsSpy,
          },
        },
      })

      const res = await app.request('/hubs/hub-1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(deleteHubSpy).toHaveBeenCalledWith('hub-1')
    })

    it('returns 403 without system:manage-hubs permission', async () => {
      const { app } = createTestApp({ permissions: ['hubs:read'] })
      const res = await app.request('/hubs/hub-1', { method: 'DELETE' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /hubs/:hubId/key — Get my hub key envelope
  // -------------------------------------------------------------------------

  describe('GET /hubs/:hubId/key', () => {
    it('returns envelope for current user', async () => {
      const getHubKeyEnvelopesSpy = vi.fn().mockResolvedValue({
        envelopes: [
          { pubkey: 'a'.repeat(64), enc: 'd'.repeat(64), ct: 'wrapped' },
          { pubkey: 'c'.repeat(64), enc: 'e'.repeat(64), ct: 'wrapped2' },
        ],
      })
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        userHubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }],
        serviceMock: { settings: { getHubKeyEnvelopes: getHubKeyEnvelopesSpy } },
      })

      const res = await app.request('/hubs/hub-1/key')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.envelope.pubkey).toBe('a'.repeat(64))
    })

    it('returns 404 when no envelope for user', async () => {
      const getHubKeyEnvelopesSpy = vi.fn().mockResolvedValue({
        envelopes: [{ pubkey: 'c'.repeat(64), enc: 'd'.repeat(64), ct: 'wrapped' }],
      })
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        userHubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }],
        serviceMock: { settings: { getHubKeyEnvelopes: getHubKeyEnvelopesSpy } },
      })

      const res = await app.request('/hubs/hub-1/key')
      expect(res.status).toBe(404)
    })

    it('returns 403 for non-member non-super-admin', async () => {
      const getHubKeyEnvelopesSpy = vi.fn().mockResolvedValue({ envelopes: [] })
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        userHubRoles: [{ hubId: 'hub-2', roleIds: ['role-volunteer'] }],
        serviceMock: { settings: { getHubKeyEnvelopes: getHubKeyEnvelopesSpy } },
      })

      const res = await app.request('/hubs/hub-1/key')
      expect(res.status).toBe(403)
    })

    it('returns 404 when hub not found', async () => {
      const getHubKeyEnvelopesSpy = vi.fn().mockRejectedValue(new Error('Not found'))
      const { app } = createTestApp({
        permissions: ['hubs:read'],
        userHubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }],
        serviceMock: { settings: { getHubKeyEnvelopes: getHubKeyEnvelopesSpy } },
      })

      const res = await app.request('/hubs/hub-1/key')
      expect(res.status).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // PUT /hubs/:hubId/key — Set hub key envelopes
  // -------------------------------------------------------------------------

  describe('PUT /hubs/:hubId/key', () => {
    it('sets hub key envelopes', async () => {
      const setHubKeyEnvelopesSpy = vi.fn().mockResolvedValue(undefined)
      const { app } = createTestApp({
        permissions: ['hubs:manage-keys'],
        serviceMock: { settings: { setHubKeyEnvelopes: setHubKeyEnvelopesSpy } },
      })

      const res = await app.request('/hubs/hub-1/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          envelopes: [
            { pubkey: 'f'.repeat(64), enc: '1'.repeat(64), ct: 'wrap1' },
          ],
        }),
      })

      expect(res.status).toBe(200)
      expect(setHubKeyEnvelopesSpy).toHaveBeenCalledWith('hub-1', {
        envelopes: [{ pubkey: 'f'.repeat(64), enc: '1'.repeat(64), ct: 'wrap1' }],
      })
    })

    it('returns 403 without hubs:manage-keys permission', async () => {
      const { app } = createTestApp({ permissions: ['hubs:read'] })
      const res = await app.request('/hubs/hub-1/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envelopes: [] }),
      })
      expect(res.status).toBe(403)
    })
  })
})
