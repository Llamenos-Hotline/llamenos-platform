import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import userRoutes from '@worker/routes/users'

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
    identity: serviceMock.identity || {},
    cases: serviceMock.cases || {},
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
    it('creates a user with default volunteer role when roleIds omitted', async () => {
      const createUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'b'.repeat(64), name: 'New User', active: true, createdAt: new Date().toISOString(), roles: ['role-volunteer'] },
      })
      const { app, auditLogSpy } = createTestApp({
        permissions: ['users:create'],
        serviceMock: { identity: { createUser: createUserSpy, getUsers: vi.fn(), getUser: vi.fn() } },
      })

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New User', phone: '+15551234567' }),
      })

      expect(res.status).toBe(201)
      expect(createUserSpy).toHaveBeenCalledWith(
        expect.objectContaining({ roleIds: ['role-volunteer'] }),
      )
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('creates a user with provided roleIds', async () => {
      const createUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'b'.repeat(64), name: 'New User', active: true, createdAt: new Date().toISOString(), roles: ['role-hub-admin'] },
      })
      const { app } = createTestApp({
        permissions: ['users:create'],
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

    it('defaults to volunteer when roleIds is empty array', async () => {
      const createUserSpy = vi.fn().mockResolvedValue({
        volunteer: { pubkey: 'b'.repeat(64), name: 'New User', active: true, createdAt: new Date().toISOString(), roles: ['role-volunteer'] },
      })
      const { app } = createTestApp({
        permissions: ['users:create'],
        serviceMock: { identity: { createUser: createUserSpy, getUsers: vi.fn(), getUser: vi.fn() } },
      })

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'b'.repeat(64), name: 'New User', phone: '+15551234567', roleIds: [] }),
      })

      expect(res.status).toBe(201)
      expect(createUserSpy).toHaveBeenCalledWith(
        expect.objectContaining({ roleIds: ['role-volunteer'] }),
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
          identity: { getUser: getUserSpy, getUsers: vi.fn() },
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
          identity: { getUser: getUserSpy, getUsers: vi.fn() },
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
          identity: { getUser: getUserSpy, getUsers: vi.fn() },
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
          identity: { getUser: getUserSpy, getUsers: vi.fn() },
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
          identity: { getUser: getUserSpy, getUsers: vi.fn() },
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
})
