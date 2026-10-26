import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import userRoutes from '@worker/routes/users'
import { ServiceError } from '@worker/services/settings'
import { DEFAULT_ROLES } from '@shared/permissions'
import { resolveHubDefaultMemberRoles } from '@worker/lib/hub-default-role'

vi.mock('@worker/lib/hub-default-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@worker/lib/hub-default-role')>()),
  resolveHubDefaultMemberRoles: vi.fn().mockResolvedValue([]),
}))

const VOLUNTEER_PERMISSIONS = DEFAULT_ROLES.find(r => r.id === 'role-volunteer')!.permissions

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(opts: {
  permissions?: string[]
  hubId?: string
  pubkey?: string
  serviceMock?: Record<string, unknown>
  auditLogSpy?: ReturnType<typeof vi.fn>
  userHubRoles?: { hubId: string; roleIds: string[] }[]
  /**
   * Whether the caller holds a global super-admin role. Defaults to true
   * outside a hub — the unscoped mount is the instance view and is refused to
   * everyone else — and wherever `permissions` is the wildcard. `permissions`
   * still decides each route, so a limited set exercises requirePermission.
   */
  superAdmin?: boolean
} = {}) {
  const {
    permissions = ['*'],
    hubId,
    pubkey = 'a'.repeat(64),
    serviceMock = {},
    auditLogSpy = vi.fn().mockResolvedValue(undefined),
    userHubRoles = [],
    superAdmin = permissions.includes('*') || hubId === undefined,
  } = opts
  // `permissions` is the request's resolved authority (what hubContext / auth
  // would set); `role-test` carries the same set so role lookups agree.
  const allRoles = [{ id: 'role-test', name: 'Test', slug: 'test', permissions, isDefault: false, isSystem: false, description: '' }]

  const mockAuditService = { log: auditLogSpy }

  const services: Record<string, unknown> = {
    identity: serviceMock.identity || {},
    settings: serviceMock.settings || {},
    cases: serviceMock.cases || {},
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
      roles: superAdmin ? ['role-super-admin'] : ['role-test'],
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
    // Minimal env — the delete route reads HMAC_SECRET for SIP revocation.
    c.env = {
      HMAC_SECRET: 'test-hmac-secret',
    } as unknown as AppEnv['Bindings']
    await next()
  })

  app.route('/users', userRoutes)

  return { app, auditLogSpy }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('users routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // GET /users — List (via entity-router)
  // -------------------------------------------------------------------------

  describe('GET /users', () => {
    it('lists users', async () => {
      const getUsersSpy = vi.fn().mockResolvedValue({
        users: [{ pubkey: 'u1', name: 'User 1', active: true, createdAt: new Date().toISOString(), roles: ['role-volunteer'] }],
      })
      const { app } = createTestApp({
        permissions: ['users:read'],
        serviceMock: { identity: { getUsers: getUsersSpy, getUser: vi.fn() } },
      })

      const res = await app.request('/users')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.users).toHaveLength(1)
    })

    it('requires users:read permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/users')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /users/:targetPubkey — Get user (via entity-router)
  // -------------------------------------------------------------------------

  describe('GET /users/:targetPubkey', () => {
    it('returns a user', async () => {
      const getUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'u1', name: 'User 1', active: true, createdAt: new Date().toISOString(), roles: ['role-volunteer'] },
      })
      const { app } = createTestApp({
        permissions: ['users:read'],
        serviceMock: { identity: { getUsers: vi.fn(), getUser: getUserSpy } },
      })

      const res = await app.request('/users/u1')
      expect(res.status).toBe(200)
      expect(getUserSpy).toHaveBeenCalledWith('u1', undefined)
    })
  })

  // -------------------------------------------------------------------------
  // POST /users — Create
  // -------------------------------------------------------------------------

  describe('POST /users', () => {
    it('grants no role when roleIds is omitted and there is no hub to name a default', async () => {
      const createUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'b'.repeat(64), name: 'New User', active: true, createdAt: new Date().toISOString(), roles: [] },
      })
      const { app, auditLogSpy } = createTestApp({
        permissions: ['users:create', ...VOLUNTEER_PERMISSIONS],
        serviceMock: { identity: { createUser: createUserSpy, getUsers: vi.fn(), getUser: vi.fn() } },
      })

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New User', phone: '+15551234567' }),
      })

      expect(res.status).toBe(201)
      // No role is implied by the code: a hard-coded `role-volunteer` here was a
      // default-role id acting as an authorisation decision (#2233).
      expect(createUserSpy).toHaveBeenCalledWith(expect.objectContaining({ roleIds: [] }))
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it("grants the hub template's default member role when roleIds is omitted under a hub", async () => {
      vi.mocked(resolveHubDefaultMemberRoles).mockResolvedValueOnce(['role-reviewer'])
      const createUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'b'.repeat(64), name: 'New User', active: true, createdAt: new Date().toISOString(), roles: [], hubRoles: [] },
      })
      const { app } = createTestApp({
        permissions: ['*'],
        hubId: 'hub-1',
        serviceMock: { identity: { createUser: createUserSpy, getUsers: vi.fn(), getUser: vi.fn() } },
      })

      await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New User', phone: '+15551234567' }),
      })

      expect(resolveHubDefaultMemberRoles).toHaveBeenCalledWith(expect.anything(), 'hub-1')
      expect(createUserSpy).toHaveBeenCalledWith(
        expect.objectContaining({ hubId: 'hub-1', roleIds: ['role-reviewer'] }),
      )
    })

    it('creates a user with provided roleIds', async () => {
      const createUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'b'.repeat(64), name: 'New User', active: true, createdAt: new Date().toISOString(), roles: ['role-hub-admin'] },
      })
      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: { identity: { createUser: createUserSpy, getUsers: vi.fn(), getUser: vi.fn() } },
      })

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New User', phone: '+15551234567', roleIds: ['role-hub-admin'] }),
      })

      expect(res.status).toBe(201)
      expect(createUserSpy).toHaveBeenCalledWith(
        expect.objectContaining({ roleIds: ['role-hub-admin'] }),
      )
    })

    it('treats an empty roleIds array as no role named', async () => {
      const createUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'b'.repeat(64), name: 'New User', active: true, createdAt: new Date().toISOString(), roles: ['role-volunteer'] },
      })
      const { app } = createTestApp({
        permissions: ['users:create', ...VOLUNTEER_PERMISSIONS],
        serviceMock: { identity: { createUser: createUserSpy, getUsers: vi.fn(), getUser: vi.fn() } },
      })

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New User', phone: '+15551234567', roleIds: [] }),
      })

      expect(res.status).toBe(201)
      expect(createUserSpy).toHaveBeenCalledWith(
        expect.objectContaining({ roleIds: [] }),
      )
    })

    it('returns 403 without users:create permission', async () => {
      const { app } = createTestApp({ permissions: ['users:read'] })
      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New User', phone: '+15551234567' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /users/:targetPubkey — Update
  // -------------------------------------------------------------------------

  describe('PATCH /users/:targetPubkey', () => {
    it('updates a user', async () => {
      const updateUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'u1', name: 'Updated', active: true, createdAt: new Date().toISOString(), roles: ['role-volunteer'] },
      })
      const { app } = createTestApp({
        permissions: ['users:update'],
        serviceMock: { identity: { updateUser: updateUserSpy, getUsers: vi.fn(), getUser: vi.fn(), revokeAllSessions: vi.fn() } },
      })

      const res = await app.request('/users/u1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })

      expect(res.status).toBe(200)
      expect(updateUserSpy).toHaveBeenCalledWith('u1', { name: 'Updated' }, true, undefined)
    })

    it('revokes sessions when deactivating user', async () => {
      const updateUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'u1', name: 'User', active: false, createdAt: new Date().toISOString(), roles: ['role-volunteer'] },
      })
      const revokeAllSessionsSpy = vi.fn().mockResolvedValue(undefined)
      const { app, auditLogSpy } = createTestApp({
        permissions: ['users:update'],
        serviceMock: {
          identity: {
            updateUser: updateUserSpy,
            revokeAllSessions: revokeAllSessionsSpy,
            getUsers: vi.fn(),
            getUser: vi.fn(),
          },
        },
      })

      const res = await app.request('/users/u1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      })

      expect(res.status).toBe(200)
      expect(revokeAllSessionsSpy).toHaveBeenCalledWith('u1')
      expect(auditLogSpy).toHaveBeenCalledTimes(1)
    })

    it('revokes sessions when changing roles', async () => {
      const updateUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'u1', name: 'User', active: true, createdAt: new Date().toISOString(), roles: ['role-hub-admin'] },
      })
      const revokeAllSessionsSpy = vi.fn().mockResolvedValue(undefined)
      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: {
          identity: {
            updateUser: updateUserSpy,
            revokeAllSessions: revokeAllSessionsSpy,
            getUsers: vi.fn(),
            getUser: vi.fn(),
          },
        },
      })

      const res = await app.request('/users/u1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: ['role-hub-admin'] }),
      })

      expect(res.status).toBe(200)
      expect(revokeAllSessionsSpy).toHaveBeenCalledWith('u1')
    })

    it('returns 403 without users:update permission', async () => {
      const { app } = createTestApp({ permissions: ['users:read'] })
      const res = await app.request('/users/u1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /users/:targetPubkey — Delete
  // -------------------------------------------------------------------------

  describe('DELETE /users/:targetPubkey', () => {
    it('deletes a user and revokes sessions', async () => {
      const deleteUserSpy = vi.fn().mockResolvedValue(undefined)
      const revokeAllSessionsSpy = vi.fn().mockResolvedValue(undefined)
      const { app, auditLogSpy } = createTestApp({
        permissions: ['users:delete'],
        serviceMock: {
          identity: {
            deleteUser: deleteUserSpy,
            revokeAllSessions: revokeAllSessionsSpy,
            getUsers: vi.fn(),
            getUser: vi.fn(),
          },
        },
      })

      const res = await app.request('/users/u1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(revokeAllSessionsSpy).toHaveBeenCalledWith('u1')
      expect(deleteUserSpy).toHaveBeenCalledWith('u1')
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('proceeds with deletion even if session revocation fails', async () => {
      const deleteUserSpy = vi.fn().mockResolvedValue(undefined)
      const revokeAllSessionsSpy = vi.fn().mockRejectedValue(new Error('Session error'))
      const { app } = createTestApp({
        permissions: ['users:delete'],
        serviceMock: {
          identity: {
            deleteUser: deleteUserSpy,
            revokeAllSessions: revokeAllSessionsSpy,
            getUsers: vi.fn(),
            getUser: vi.fn(),
          },
        },
      })

      const res = await app.request('/users/u1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(deleteUserSpy).toHaveBeenCalledWith('u1')
    })

    it('returns 403 without users:delete permission', async () => {
      const { app } = createTestApp({ permissions: ['users:read'] })
      const res = await app.request('/users/u1', { method: 'DELETE' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /users/:targetPubkey/cases — List cases
  // -------------------------------------------------------------------------

  describe('GET /users/:targetPubkey/cases', () => {
    it('lists case records for a user', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        records: [{ id: 'c1', title: 'Case 1' }],
        total: 1,
      })
      const getUserSpy = vi.fn().mockResolvedValue({ volunteer: { pubkey: 'u1', name: 'User 1' } })
      const { app } = createTestApp({
        permissions: ['users:read-cases'],
        hubId: 'hub-1',
        serviceMock: {
          identity: { getUser: getUserSpy, getHubUser: getUserSpy, getUsers: vi.fn() },
          cases: { list: listSpy },
        },
      })

      const res = await app.request('/users/u1/cases')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.records).toHaveLength(1)
      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'u1', hubId: 'hub-1' }))
    })

    it('returns 404 when user not found', async () => {
      const getUserSpy = vi.fn().mockRejectedValue(new Error('User not found'))
      const { app } = createTestApp({
        permissions: ['users:read-cases'],
        serviceMock: {
          identity: { getUser: getUserSpy, getHubUser: getUserSpy, getUsers: vi.fn() },
          cases: { list: vi.fn() },
        },
      })

      const res = await app.request('/users/nonexistent/cases')
      expect(res.status).toBe(404)
    })

    it('requires users:read-cases permission', async () => {
      const { app } = createTestApp({ permissions: ['users:read'] })
      const res = await app.request('/users/u1/cases')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /users/:targetPubkey/metrics — Metrics
  // -------------------------------------------------------------------------

  describe('GET /users/:targetPubkey/metrics', () => {
    it('returns metrics for a user with closed records', async () => {
      const getUserSpy = vi.fn().mockResolvedValue({ volunteer: { pubkey: 'u1', name: 'User 1' } })
      const listSpy = vi.fn().mockResolvedValue({
        records: [
          { id: 'c1', createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-03T00:00:00Z' },
          { id: 'c2', createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-01-05T00:00:00Z' },
          { id: 'c3', createdAt: '2024-01-01T00:00:00Z' }, // active
        ],
      })
      const { app } = createTestApp({
        permissions: ['users:read-metrics'],
        hubId: 'hub-1',
        serviceMock: {
          identity: { getUser: getUserSpy, getHubUser: getUserSpy, getUsers: vi.fn() },
          cases: { list: listSpy },
        },
      })

      const res = await app.request('/users/u1/metrics')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.pubkey).toBe('u1')
      expect(json.activeCaseCount).toBe(1)
      expect(json.totalCasesHandled).toBe(3)
      expect(json.averageResolutionDays).toBe(3)
    })

    it('returns null averageResolutionDays when no closed records', async () => {
      const getUserSpy = vi.fn().mockResolvedValue({ volunteer: { pubkey: 'u1', name: 'User 1' } })
      const listSpy = vi.fn().mockResolvedValue({
        records: [
          { id: 'c1', createdAt: '2024-01-01T00:00:00Z' },
        ],
      })
      const { app } = createTestApp({
        permissions: ['users:read-metrics'],
        hubId: 'hub-1',
        serviceMock: {
          identity: { getUser: getUserSpy, getHubUser: getUserSpy, getUsers: vi.fn() },
          cases: { list: listSpy },
        },
      })

      const res = await app.request('/users/u1/metrics')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.averageResolutionDays).toBeNull()
    })

    it('returns 404 when user not found', async () => {
      const getUserSpy = vi.fn().mockRejectedValue(new Error('User not found'))
      const { app } = createTestApp({
        permissions: ['users:read-metrics'],
        serviceMock: {
          identity: { getUser: getUserSpy, getHubUser: getUserSpy, getUsers: vi.fn() },
          cases: { list: vi.fn() },
        },
      })

      const res = await app.request('/users/nonexistent/metrics')
      expect(res.status).toBe(404)
    })

    it('requires users:read-metrics permission', async () => {
      const { app } = createTestApp({ permissions: ['users:read'] })
      const res = await app.request('/users/u1/metrics')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // Hub isolation — /api/hubs/:hubId/users (#1044, #1037)
  // -------------------------------------------------------------------------

  describe('hub-scoped (/hubs/:hubId/users)', () => {
    const hubAdminPerms = ['users:*', ...VOLUNTEER_PERMISSIONS]

    it('lists only the members of the hub in the path', async () => {
      const getUsersSpy = vi.fn().mockResolvedValue({ users: [] })
      const { app } = createTestApp({
        permissions: hubAdminPerms,
        hubId: 'hub-b',
        serviceMock: { identity: { getUsers: getUsersSpy } },
      })

      const res = await app.request('/users')
      expect(res.status).toBe(200)
      expect(getUsersSpy).toHaveBeenCalledWith('hub-b')
    })

    it('returns 404 for a user who is not a member of the hub', async () => {
      const getUserSpy = vi.fn().mockRejectedValue(new ServiceError(404, 'Not found'))
      const app = new Hono<AppEnv>()
      app.onError((err, c) => err instanceof ServiceError ? c.json({ error: err.message }, 404) : c.json({ error: 'x' }, 500))
      app.route('/', createTestApp({
        permissions: hubAdminPerms,
        hubId: 'hub-b',
        serviceMock: { identity: { getUser: getUserSpy } },
      }).app)

      const res = await app.request('/users/vera')
      expect(res.status).toBe(404)
      expect(getUserSpy).toHaveBeenCalledWith('vera', 'hub-b')
    })

    it('creates the user as a member of the hub, not with a global role', async () => {
      // The service stores the grant in hubRoles only, so the row it returns
      // has no global role; the response shows the role held in this hub.
      const created = { pubkey: 'b'.repeat(64), roles: [], hubRoles: [{ hubId: 'hub-b', roleIds: ['role-volunteer'] }] }
      const createUserSpy = vi.fn().mockResolvedValue({ volunteer: created })
      const { app } = createTestApp({
        permissions: hubAdminPerms,
        hubId: 'hub-b',
        serviceMock: { identity: { createUser: createUserSpy } },
      })

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New', phone: '+15551234567', roleIds: ['role-volunteer'] }),
      })
      expect(res.status).toBe(201)
      expect(createUserSpy).toHaveBeenCalledWith(expect.objectContaining({ hubId: 'hub-b', roleIds: ['role-volunteer'] }))
      expect((await res.json()).roles).toEqual(['role-volunteer'])
    })

    it('refuses to grant a role broader than the caller\'s own', async () => {
      const createUserSpy = vi.fn()
      const { app } = createTestApp({
        permissions: hubAdminPerms,
        hubId: 'hub-b',
        serviceMock: { identity: { createUser: createUserSpy } },
      })

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New', phone: '+15551234567', roleIds: ['role-super-admin'] }),
      })
      expect(res.status).toBe(403)
      expect(createUserSpy).not.toHaveBeenCalled()
    })

    it('role edits are handed to the service with the hub, which applies them to that hub\'s assignment only', async () => {
      // Under a hub `roles` is the member's assignment IN that hub; the
      // account-wide column is never written from here (#2153). The service
      // owns that (see hub-user-authority.test.ts); the route's part is to pass
      // the hub through and show the hub view back.
      const member = { pubkey: 'u1', roles: [], hubRoles: [{ hubId: 'hub-b', roleIds: ['role-volunteer'] }] }
      const updateUserSpy = vi.fn().mockResolvedValue({ volunteer: member })
      const { app } = createTestApp({
        permissions: hubAdminPerms,
        hubId: 'hub-b',
        serviceMock: {
          identity: {
            getUser: vi.fn().mockResolvedValue(member),
            getUserInternal: vi.fn().mockResolvedValue(member),
            updateUser: updateUserSpy,
            revokeAllSessions: vi.fn(),
          },
        },
      })

      const res = await app.request('/users/u1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed', roles: ['role-volunteer'] }),
      })
      expect(res.status).toBe(200)
      expect(updateUserSpy).toHaveBeenCalledWith('u1', { name: 'Renamed', roles: ['role-volunteer'] }, true, 'hub-b')
      expect((await res.json()).roles).toEqual(['role-volunteer'])
    })

    it('refuses to edit an instance super-admin', async () => {
      const updateUserSpy = vi.fn()
      const { app } = createTestApp({
        permissions: hubAdminPerms,
        hubId: 'hub-b',
        serviceMock: {
          identity: {
            getUser: vi.fn().mockResolvedValue({ pubkey: 'root' }),
            getUserInternal: vi.fn().mockResolvedValue({ pubkey: 'root', roles: ['role-super-admin'], hubRoles: [] }),
            updateUser: updateUserSpy,
          },
        },
      })

      const res = await app.request('/users/root', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hijacked' }),
      })
      expect(res.status).toBe(403)
      expect(updateUserSpy).not.toHaveBeenCalled()
    })

    it.each([
      ['DELETE', undefined],
      ['PATCH', JSON.stringify({ active: false })],
    ])('refuses %s of an account that also belongs to another hub', async (method, body) => {
      const deleteUserSpy = vi.fn()
      const updateUserSpy = vi.fn()
      const { app } = createTestApp({
        permissions: hubAdminPerms,
        hubId: 'hub-b',
        serviceMock: {
          identity: {
            getUser: vi.fn().mockResolvedValue({ pubkey: 'u1' }),
            getHubUser: vi.fn().mockResolvedValue({ pubkey: 'u1' }),
            getUserInternal: vi.fn().mockResolvedValue({
              pubkey: 'u1', roles: [],
              hubRoles: [{ hubId: 'hub-a', roleIds: ['role-volunteer'] }, { hubId: 'hub-b', roleIds: ['role-volunteer'] }],
            }),
            deleteUser: deleteUserSpy,
            updateUser: updateUserSpy,
            revokeAllSessions: vi.fn(),
          },
        },
      })

      const res = await app.request('/users/u1', {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body } : {}),
      })
      expect(res.status).toBe(409)
      expect(deleteUserSpy).not.toHaveBeenCalled()
      expect(updateUserSpy).not.toHaveBeenCalled()
    })

    it('the hub in the path wins over a ?hubId= that differs from it', async () => {
      const listSpy = vi.fn().mockResolvedValue({ records: [] })
      const { app } = createTestApp({
        permissions: ['users:read-cases'],
        hubId: 'hub-b',
        serviceMock: {
          identity: { getUser: vi.fn().mockResolvedValue({ pubkey: 'u1' }) },
          cases: { list: listSpy },
        },
      })

      const res = await app.request('/users/u1/cases?hubId=hub-a')
      expect(res.status).toBe(200)
      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ hubId: 'hub-b' }))
    })
  })

  // -------------------------------------------------------------------------
  // The unscoped mount is the instance view: super-admin only (#1099, #2153)
  // -------------------------------------------------------------------------

  describe('unscoped (/users) for a caller who is not a super-admin', () => {
    // A caller holding every users:* permission through a non-super-admin role
    // is still refused: with no hub in the path there is nothing to bound them
    // to, and a missing hub must never widen authority.
    const allUsersPerms = ['users:*', 'users:read-cases', 'users:read-metrics']
    const reached = vi.fn()
    const identity = {
      getUsers: reached, getUser: reached, getUserInternal: reached, createUser: reached,
      updateUser: reached, deleteUser: reached, revokeAllSessions: reached,
    }

    it.each([
      ['GET', '/users', undefined],
      ['GET', '/users/u1', undefined],
      ['POST', '/users', { pubkey: 'b'.repeat(64), name: 'New', phone: '+15551234567', roleIds: ['role-volunteer'] }],
      ['PATCH', '/users/u1', { active: false }],
      ['DELETE', '/users/u1', undefined],
      ['GET', '/users/u1/cases?hubId=hub-a', undefined],
      ['GET', '/users/u1/metrics?hubId=hub-a', undefined],
    ])('%s %s → 403 before any service is reached', async (method, path, body) => {
      reached.mockClear()
      const { app } = createTestApp({
        permissions: allUsersPerms,
        superAdmin: false,
        serviceMock: { identity, cases: { list: reached } },
      })

      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      expect(res.status).toBe(403)
      expect(reached).not.toHaveBeenCalled()
    })

    it('a super-admin still lists every user', async () => {
      const getUsersSpy = vi.fn().mockResolvedValue({ users: [] })
      const { app } = createTestApp({
        permissions: ['users:read'],
        serviceMock: { identity: { getUsers: getUsersSpy } },
      })
      expect((await app.request('/users')).status).toBe(200)
      expect(getUsersSpy).toHaveBeenCalledWith(undefined)
    })

    it('cases and metrics outside a hub say a hub is needed instead of returning an empty list', async () => {
      const { app } = createTestApp({
        permissions: ['users:read-cases', 'users:read-metrics'],
        serviceMock: { identity: { getUser: vi.fn().mockResolvedValue({ pubkey: 'u1' }) }, cases: { list: vi.fn() } },
      })
      expect((await app.request('/users/u1/cases')).status).toBe(400)
      expect((await app.request('/users/u1/metrics')).status).toBe(400)
    })
  })
})
