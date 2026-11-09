/**
 * Unit tests for apps/worker/middleware/permission-guard.ts
 *
 * Tests requirePermission, requireAnyPermission, checkPermission,
 * and requireEntityTypeAccess middleware.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'
import {
  requirePermission,
  requireAnyPermission,
  checkPermission,
  requireEntityTypeAccess,
} from '@worker/middleware/permission-guard'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const allRoles = [
  { id: 'role-super-admin', slug: 'super-admin', permissions: ['*'], name: 'Super Admin' },
  { id: 'role-volunteer', slug: 'volunteer', permissions: ['calls:answer', 'notes:create'], name: 'Volunteer' },
  { id: 'role-legal-observer', slug: 'legal-observer', permissions: ['cases:read-own', 'cases:create'], name: 'Legal Observer' },
]

function createApp(permissions: string[], userRoles: string[] = ['role-volunteer']) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('permissions', permissions as never)
    c.set('user', { roles: userRoles } as never)
    c.set('allRoles', allRoles as never)
    c.set('services', {
      settings: {
        getEntityTypeById: vi.fn(),
      },
    } as never)
    await next()
  })
  return app
}

// ---------------------------------------------------------------------------
// requirePermission (AND logic)
// ---------------------------------------------------------------------------

describe('requirePermission', () => {
  it('grants access when user has exact permission', async () => {
    const app = createApp(['calls:answer'])
    app.use('/test', requirePermission('calls:answer'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })

  it('rejects when user lacks permission', async () => {
    const app = createApp(['calls:answer'])
    app.use('/test', requirePermission('settings:manage'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Forbidden')
    expect(body.required).toBe('settings:manage')
  })

  it('requires ALL permissions', async () => {
    const app = createApp(['calls:answer'])
    app.use('/test', requirePermission('calls:answer', 'notes:create'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(403)
  })

  it('grants access with wildcard', async () => {
    const app = createApp(['*'])
    app.use('/test', requirePermission('anything:here'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })

  it('grants access with domain wildcard', async () => {
    const app = createApp(['calls:*'])
    app.use('/test', requirePermission('calls:debug'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// requireAnyPermission (OR logic)
// ---------------------------------------------------------------------------

describe('requireAnyPermission', () => {
  it('grants when user has at least one', async () => {
    const app = createApp(['calls:answer'])
    app.use('/test', requireAnyPermission('calls:answer', 'notes:create'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })

  it('rejects when user has none', async () => {
    const app = createApp(['calls:answer'])
    app.use('/test', requireAnyPermission('settings:manage', 'audit:read'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.required).toEqual(['settings:manage', 'audit:read'])
  })

  it('grants with wildcard', async () => {
    const app = createApp(['*'])
    app.use('/test', requireAnyPermission('settings:manage'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// checkPermission (inline helper)
// ---------------------------------------------------------------------------

describe('checkPermission', () => {
  it('returns true for exact match', () => {
    expect(checkPermission(['calls:answer', 'notes:create'], 'calls:answer')).toBe(true)
  })

  it('returns false when not granted', () => {
    expect(checkPermission(['calls:answer'], 'audit:read')).toBe(false)
  })

  it('returns true for global wildcard', () => {
    expect(checkPermission(['*'], 'system:manage-roles')).toBe(true)
  })

  it('returns true for domain wildcard', () => {
    expect(checkPermission(['calls:*'], 'calls:debug')).toBe(true)
  })

  it('returns false for empty permissions', () => {
    expect(checkPermission([], 'calls:answer')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// requireEntityTypeAccess
// ---------------------------------------------------------------------------

describe('requireEntityTypeAccess', () => {
  it('skips check when entityTypeId is not present', async () => {
    const app = createApp(['cases:read-own'])
    app.use('/test', requireEntityTypeAccess('read'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test')
    expect(res.status).toBe(200)
  })

  it('returns 404 when entity type is not found', async () => {
    const app = createApp(['cases:read-own'], ['role-volunteer'])
    const mockGetEntityType = vi.fn().mockRejectedValue(new Error('not found'))
    app.use('*', async (c, next) => {
      const svc = c.get('services')
      ;(svc.settings as unknown as Record<string, unknown>).getEntityTypeById = mockGetEntityType
      await next()
    })
    app.use('/entity/:entityTypeId', requireEntityTypeAccess('read'))
    app.get('/entity/:entityTypeId', (c) => c.json({ ok: true }))

    const res = await app.request('/entity/et-123')
    expect(res.status).toBe(404)
  })

  it('bypasses entity type check for cases:* admin', async () => {
    const app = createApp(['cases:*'], ['role-super-admin'])
    const mockGetEntityType = vi.fn().mockResolvedValue({
      accessRoles: ['legal-observer'],
      editRoles: ['legal-observer'],
    })
    app.use('*', async (c, next) => {
      const svc = c.get('services')
      ;(svc.settings as unknown as Record<string, unknown>).getEntityTypeById = mockGetEntityType
      await next()
    })
    app.use('/entity/:entityTypeId', requireEntityTypeAccess('read'))
    app.get('/entity/:entityTypeId', (c) => c.json({ ok: true }))

    const res = await app.request('/entity/et-123')
    expect(res.status).toBe(200)
  })

  it('bypasses entity type check for global wildcard', async () => {
    const app = createApp(['*'], ['role-super-admin'])
    const mockGetEntityType = vi.fn().mockResolvedValue({
      accessRoles: ['legal-observer'],
    })
    app.use('*', async (c, next) => {
      const svc = c.get('services')
      ;(svc.settings as unknown as Record<string, unknown>).getEntityTypeById = mockGetEntityType
      await next()
    })
    app.use('/entity/:entityTypeId', requireEntityTypeAccess('read'))
    app.get('/entity/:entityTypeId', (c) => c.json({ ok: true }))

    const res = await app.request('/entity/et-123')
    expect(res.status).toBe(200)
  })

  it('denies read when user role not in accessRoles', async () => {
    const app = createApp(['cases:read-own'], ['role-volunteer'])
    const mockGetEntityType = vi.fn().mockResolvedValue({
      accessRoles: ['legal-observer'],
      editRoles: [],
    })
    app.use('*', async (c, next) => {
      const svc = c.get('services')
      ;(svc.settings as unknown as Record<string, unknown>).getEntityTypeById = mockGetEntityType
      await next()
    })
    app.use('/entity/:entityTypeId', requireEntityTypeAccess('read'))
    app.get('/entity/:entityTypeId', (c) => c.json({ ok: true }))

    const res = await app.request('/entity/et-123')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('No access to this entity type')
  })

  it('grants read when user role is in accessRoles', async () => {
    const app = createApp(['cases:read-own'], ['role-legal-observer'])
    const mockGetEntityType = vi.fn().mockResolvedValue({
      accessRoles: ['legal-observer'],
      editRoles: [],
    })
    app.use('*', async (c, next) => {
      const svc = c.get('services')
      ;(svc.settings as unknown as Record<string, unknown>).getEntityTypeById = mockGetEntityType
      await next()
    })
    app.use('/entity/:entityTypeId', requireEntityTypeAccess('read'))
    app.get('/entity/:entityTypeId', (c) => c.json({ ok: true }))

    const res = await app.request('/entity/et-123')
    expect(res.status).toBe(200)
  })

  it('denies write when user role not in editRoles', async () => {
    const app = createApp(['cases:read-own'], ['role-volunteer'])
    const mockGetEntityType = vi.fn().mockResolvedValue({
      accessRoles: [],
      editRoles: ['legal-observer'],
    })
    app.use('*', async (c, next) => {
      const svc = c.get('services')
      ;(svc.settings as unknown as Record<string, unknown>).getEntityTypeById = mockGetEntityType
      await next()
    })
    app.use('/entity/:entityTypeId', requireEntityTypeAccess('write'))
    app.get('/entity/:entityTypeId', (c) => c.json({ ok: true }))

    const res = await app.request('/entity/et-123')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Cannot edit this entity type')
  })

  it('grants access when accessRoles is empty (fallback to generic perms)', async () => {
    const app = createApp(['cases:read-own'], ['role-volunteer'])
    const mockGetEntityType = vi.fn().mockResolvedValue({
      accessRoles: [],
      editRoles: [],
    })
    app.use('*', async (c, next) => {
      const svc = c.get('services')
      ;(svc.settings as unknown as Record<string, unknown>).getEntityTypeById = mockGetEntityType
      await next()
    })
    app.use('/entity/:entityTypeId', requireEntityTypeAccess('read'))
    app.get('/entity/:entityTypeId', (c) => c.json({ ok: true }))

    const res = await app.request('/entity/et-123')
    expect(res.status).toBe(200)
  })

  it('reads entityTypeId from query string', async () => {
    const app = createApp(['cases:*'], ['role-super-admin'])
    const mockGetEntityType = vi.fn().mockResolvedValue({ accessRoles: ['admin'] })
    app.use('*', async (c, next) => {
      const svc = c.get('services')
      ;(svc.settings as unknown as Record<string, unknown>).getEntityTypeById = mockGetEntityType
      await next()
    })
    app.use('/test', requireEntityTypeAccess('read'))
    app.get('/test', (c) => c.json({ ok: true }))

    const res = await app.request('/test?entityTypeId=et-456')
    expect(res.status).toBe(200)
    expect(mockGetEntityType).toHaveBeenCalledWith('et-456', '')
  })
})
