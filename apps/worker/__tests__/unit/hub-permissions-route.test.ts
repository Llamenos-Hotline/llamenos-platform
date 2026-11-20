/**
 * GET /api/hubs/:hubId/permissions/me (#1101)
 *
 * The caller's permissions in ONE hub. The desktop gates its UI on this, so the
 * property under test is that two hubs give two different answers for the same
 * account — and that a member whose roles are all hub-scoped (who holds no global
 * `users:read`, so cannot use `/settings/users/:id/effective-permissions`) gets one.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'
import hubRoutes from '@worker/routes/hubs'

const role = (id: string, permissions: string[]) => ({
  id, name: id, slug: id, permissions, isDefault: true, isSystem: false, description: id, createdAt: '', updatedAt: '',
})
const allRoles = [
  role('role-volunteer', ['calls:answer', 'notes:create']),
  role('role-hub-admin', ['settings:*', 'users:*', 'audit:read']),
  role('role-super-admin', ['*']),
]

function appFor(user: Record<string, unknown>) {
  const app = new Hono<AppEnv>()
  const services = {
    settings: { getHub: vi.fn(async (id: string) => ({ hub: { id } })) },
  }
  app.use('*', async (c, next) => {
    c.set('user', user as never)
    c.set('allRoles', allRoles as never)
    c.set('services', services as never)
    await next()
  })
  app.route('/hubs', hubRoutes)
  return app
}

const get = async (app: Hono<AppEnv>, hubId: string) => {
  const res = await app.request(`/hubs/${hubId}/permissions/me`)
  return { status: res.status, body: await res.json() as { hubId?: string; permissions?: string[] } }
}

describe('GET /hubs/:hubId/permissions/me', () => {
  // No global roles at all — the member the effective-permissions route cannot serve.
  const hubOnly = {
    pubkey: 'aa'.repeat(32),
    roles: [],
    hubRoles: [
      { hubId: 'hub-A', roleIds: ['role-hub-admin'] },
      { hubId: 'hub-B', roleIds: ['role-volunteer'] },
    ],
  }

  it('answers each hub with that hub\'s own set, not the union', async () => {
    const app = appFor(hubOnly)
    const a = await get(app, 'hub-A')
    const b = await get(app, 'hub-B')
    expect(a.status).toBe(200)
    expect(a.body).toEqual({ hubId: 'hub-A', permissions: ['settings:*', 'users:*', 'audit:read'] })
    expect(b.status).toBe(200)
    expect(b.body).toEqual({ hubId: 'hub-B', permissions: ['calls:answer', 'notes:create'] })
  })

  it('refuses a hub the caller holds no role in', async () => {
    const { status } = await get(appFor(hubOnly), 'hub-C')
    expect(status).toBe(403)
  })

  it('gives a super-admin every permission in any hub', async () => {
    const { status, body } = await get(appFor({ pubkey: 'bb'.repeat(32), roles: ['role-super-admin'], hubRoles: [] }), 'hub-Z')
    expect(status).toBe(200)
    expect(body.permissions).toEqual(['*'])
  })

  it('does not let a non-super-admin global role leak into a hub', async () => {
    const { status } = await get(appFor({ pubkey: 'cc'.repeat(32), roles: ['role-hub-admin'], hubRoles: [] }), 'hub-A')
    expect(status).toBe(403)
  })
})
