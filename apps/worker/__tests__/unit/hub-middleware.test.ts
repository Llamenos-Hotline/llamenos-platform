/**
 * Unit tests for apps/worker/middleware/hub.ts
 *
 * Tests hub context middleware: membership verification,
 * cross-hub access denied, missing hub header, permission resolution.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'
import { hubContext, requireHubPermission, checkHubPermission } from '@worker/middleware/hub'
import { ServiceError } from '@worker/services/settings'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: 'aabb1122',
    name: 'Test User',
    roles: ['role-volunteer'],
    hubRoles: [],
    active: true,
    ...overrides,
  }
}

const allRoles = [
  {
    id: 'role-volunteer',
    name: 'Volunteer',
    slug: 'volunteer',
    permissions: ['calls:answer', 'notes:create', 'shifts:read-own', 'hubs:read'],
    isDefault: true,
    isSystem: false,
    description: 'Volunteer',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'role-super-admin',
    name: 'Super Admin',
    slug: 'super-admin',
    permissions: ['*'],
    isDefault: true,
    isSystem: true,
    description: 'Full access',
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'role-hub-admin',
    name: 'Hub Admin',
    slug: 'hub-admin',
    permissions: ['users:*', 'shifts:*', 'settings:*', 'audit:read', 'hubs:read'],
    isDefault: true,
    isSystem: false,
    description: 'Hub admin',
    createdAt: '',
    updatedAt: '',
  },
]

function createApp(user: Record<string, unknown>, hubExists = true) {
  const app = new Hono<AppEnv>()
  const services = {
    settings: {
      getHub: vi.fn().mockImplementation(async (id: string) => {
        if (!hubExists) throw new ServiceError(404, 'Not found')
        return { id, name: 'Test Hub' }
      }),
    },
  }

  app.use('*', async (c, next) => {
    c.set('user', user as never)
    c.set('allRoles', allRoles as never)
    c.set('services', services as never)
    await next()
  })

  return { app, services }
}

// ---------------------------------------------------------------------------
// hubContext tests
// ---------------------------------------------------------------------------

describe('hubContext middleware', () => {
  it('returns 400 when hubId param is missing', async () => {
    const { app } = createApp(makeUser())
    // Route without :hubId param
    app.use('/no-hub', hubContext)
    app.get('/no-hub', (c) => c.json({ ok: true }))

    const res = await app.request('/no-hub')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Hub ID required')
  })

  it('returns 404 when hub does not exist', async () => {
    const { app } = createApp(makeUser(), false)
    app.use('/hub/:hubId', hubContext)
    app.get('/hub/:hubId', (c) => c.json({ ok: true }))

    const res = await app.request('/hub/nonexistent')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('Hub not found')
  })

  it('returns 403 when user has no permissions in hub', async () => {
    // User with no global roles and no hub roles
    const user = makeUser({ roles: [], hubRoles: [] })
    const { app } = createApp(user)
    app.use('/hub/:hubId', hubContext)
    app.get('/hub/:hubId', (c) => c.json({ ok: true }))

    const res = await app.request('/hub/hub-1')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Access denied')
  })

  // #1037: a non-super-admin global role is not hub membership. A volunteer
  // invited by Hub A must not be admitted to every other hub on the server.
  it('denies a user whose only role is a non-super-admin global role', async () => {
    const user = makeUser({ roles: ['role-volunteer'], hubRoles: [] })
    const { app } = createApp(user)
    app.use('/hub/:hubId', hubContext)
    app.get('/hub/:hubId', (c) => c.json({ hubId: c.get('hubId') }))

    const res = await app.request('/hub/hub-1')
    expect(res.status).toBe(403)
  })

  it('bounds `permissions` to the hub assignment, dropping global roles', async () => {
    const user = makeUser({
      roles: ['role-hub-admin'],
      hubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }],
    })
    const { app } = createApp(user)
    app.use('/hub/:hubId', hubContext)
    app.get('/hub/:hubId', (c) => c.json({ permissions: c.get('permissions') }))

    const res = await app.request('/hub/hub-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { permissions: string[] }
    expect(body.permissions).toContain('calls:answer')
    // role-hub-admin is global only — it must not authorise anything in hub-1
    expect(body.permissions).not.toContain('users:*')
    expect(body.permissions).not.toContain('settings:*')
  })

  it('grants access to super admin for any hub', async () => {
    const user = makeUser({ roles: ['role-super-admin'] })
    const { app } = createApp(user)
    app.use('/hub/:hubId', hubContext)
    app.get('/hub/:hubId', (c) => c.json({ hubId: c.get('hubId') }))

    const res = await app.request('/hub/any-hub')
    expect(res.status).toBe(200)
  })

  it('grants access via hub-specific role assignments', async () => {
    const user = makeUser({
      roles: [],  // no global roles
      hubRoles: [{ hubId: 'hub-1', roleIds: ['role-hub-admin'] }],
    })
    const { app } = createApp(user)
    app.use('/hub/:hubId', hubContext)
    app.get('/hub/:hubId', (c) => c.json({ ok: true }))

    const res = await app.request('/hub/hub-1')
    expect(res.status).toBe(200)
  })

  it('denies access to hub user is not assigned to', async () => {
    const user = makeUser({
      roles: [],
      hubRoles: [{ hubId: 'hub-1', roleIds: ['role-hub-admin'] }],
    })
    const { app } = createApp(user)
    app.use('/hub/:hubId', hubContext)
    app.get('/hub/:hubId', (c) => c.json({ ok: true }))

    const res = await app.request('/hub/hub-2')  // different hub
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// requireHubPermission tests
// ---------------------------------------------------------------------------

describe('requireHubPermission', () => {
  it('returns 400 when hubPermissions is not set', async () => {
    const app = new Hono<AppEnv>()
    // Skip hubContext, so hubPermissions is never set
    app.use('/test', requireHubPermission('calls:answer'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Hub context required')
  })

  it('returns 403 when user lacks required permission', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('hubPermissions', ['calls:answer'] as never)
      await next()
    })
    app.use('/test', requireHubPermission('settings:manage'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(403)
  })

  it('grants access when user has required permission', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('hubPermissions', ['calls:answer', 'notes:create'] as never)
      await next()
    })
    app.use('/test', requireHubPermission('calls:answer'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })

  it('requires ALL permissions (AND logic)', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('hubPermissions', ['calls:answer'] as never)
      await next()
    })
    app.use('/test', requireHubPermission('calls:answer', 'notes:create'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// checkHubPermission tests
// ---------------------------------------------------------------------------

describe('checkHubPermission', () => {
  it('returns true for exact match', () => {
    expect(checkHubPermission(['calls:answer', 'notes:create'], 'calls:answer')).toBe(true)
  })

  it('returns false when not granted', () => {
    expect(checkHubPermission(['calls:answer'], 'settings:manage')).toBe(false)
  })

  it('returns true for wildcard', () => {
    expect(checkHubPermission(['*'], 'anything:here')).toBe(true)
  })

  it('returns true for domain wildcard', () => {
    expect(checkHubPermission(['calls:*'], 'calls:debug')).toBe(true)
  })
})
