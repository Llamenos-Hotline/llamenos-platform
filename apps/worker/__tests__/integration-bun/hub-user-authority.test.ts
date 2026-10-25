/**
 * A hub admin's authority never reaches past their hub (#2153, #1099), against
 * real PostgreSQL, Bun-native driver, through the real users router and the
 * real hubContext / IdentityService.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/hub-user-authority.test.ts
 *
 * The defect: two hub-member write paths stored the hub grant in the
 * account-wide `users.roles` column, which the auth middleware resolves into
 * `permissions` on every UNSCOPED route. Adding someone to one hub as
 * `role-hub-admin` therefore made them an admin of every hub through
 * `/api/users`, which lists and edits users across all hubs.
 *
 * What it asserts:
 *   - a user added to hub A through the real create route holds NO global role;
 *   - that hub-A admin gets 403 from every unscoped users/volunteers route and
 *     from hub B's mount, and nothing about hub B's people changed in the DB;
 *   - through hub A's own mount a user of hub B is a 404, and a member of both
 *     hubs can only have their hub-A assignment touched from hub A;
 *   - `roles` sent to a hub's PATCH changes the assignment in THAT hub and never
 *     the global column;
 *   - a hub admin cannot edit an account that holds a global role (the
 *     super-admin counts as a member of every hub);
 *   - the legitimate paths still work: in-hub administration by the hub admin,
 *     and the instance view (list / edit / create) for the super-admin.
 *
 * The caller is loaded from the database on every request and its permissions
 * are resolved from its GLOBAL roles, exactly as middleware/auth.ts does, so a
 * role written to the wrong column has the effect it has in production.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres) with
 * migrations applied. Everything created here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { auditLog, hubs, users } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { CasesService } from '../../services/cases'
import { IdentityService } from '../../services/identity'
import { ServiceError, SettingsService } from '../../services/settings'
import { hubContext } from '../../middleware/hub'
import usersRoutes from '../../routes/users'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const audit = new AuditService(db)
const identity = new IdentityService(db)
const svc = {
  identity,
  settings: new SettingsService(db),
  audit,
  cases: new CasesService(db),
}

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-auth-a-${suffix}`
const HUB_B = `hub-auth-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
/** A schema-valid 64-char lowercase hex string, unique to this run. */
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')

const SUPER = hex('51')
const ADMIN_A = hex('a1')
const ADMIN_B = hex('b1')
const VOL_A = hex('a2')
const VOL_B = hex('b2')
const BOTH = hex('c2')
const NEW_ADMIN_A = hex('a3')
const ALL_PUBKEYS = [SUPER, ADMIN_A, ADMIN_B, VOL_A, VOL_B, BOTH, NEW_ADMIN_A]

/**
 * The app as app.ts mounts the users router: unscoped at /api/users and
 * /api/volunteers, and under /api/hubs/:hubId/users behind hubContext. The
 * caller is re-read from the database per request, as the auth middleware does.
 */
function appAs(pubkey: string) {
  const app = new Hono<AppEnv>()
  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409)
    throw err
  })
  app.use('*', async (c, next) => {
    const user = await identity.getUserInternal(pubkey)
    if (!user) return c.json({ error: 'Authentication failed' }, 401)
    c.set('pubkey', pubkey)
    c.set('user', user)
    c.set('allRoles', ALL_ROLES)
    c.set('permissions', resolvePermissions(user.roles, ALL_ROLES))
    c.set('services', svc as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/api/users', usersRoutes)
  app.route('/api/volunteers', usersRoutes)
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/users', usersRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

async function call(as: string, method: string, path: string, body?: unknown) {
  const res = await appAs(as).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ENV)
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
  return { status: res.status, json }
}

async function row(pubkey: string) {
  const [r] = await db.select().from(users).where(eq(users.pubkey, pubkey))
  return r
}

function createBody(pubkey: string, name: string, roleIds: string[]) {
  return { pubkey, name, phone: '+15550000000', roleIds }
}

beforeAll(async () => {
  await db.insert(users).values({
    pubkey: SUPER, displayName: 'Super', phone: '', roles: ['role-super-admin'], encryptedSecretKey: '',
  })
  for (const id of [HUB_A, HUB_B]) {
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: SUPER })
  }
  // Seeded through the real create route as the super-admin — the path the
  // desktop add-member flow takes — so the roles column is whatever it writes.
  for (const [hubId, pubkey, roleIds] of [
    [HUB_A, ADMIN_A, ['role-hub-admin']],
    [HUB_B, ADMIN_B, ['role-hub-admin']],
    [HUB_A, VOL_A, ['role-volunteer']],
    [HUB_B, VOL_B, ['role-volunteer']],
    [HUB_A, BOTH, ['role-volunteer']],
  ] as const) {
    const res = await call(SUPER, 'POST', `/api/hubs/${hubId}/users`, createBody(pubkey, `user-${pubkey.slice(0, 4)}`, [...roleIds]))
    expect(res.status).toBe(201)
  }
  await identity.setHubRole({ pubkey: BOTH, hubId: HUB_B, roleIds: ['role-volunteer'] })
})

afterAll(async () => {
  await db.delete(auditLog).where(inArray(auditLog.hubId, [HUB_A, HUB_B]))
  await db.delete(users).where(inArray(users.pubkey, ALL_PUBKEYS))
  await db.delete(hubs).where(inArray(hubs.id, [HUB_A, HUB_B]))
})

describe('adding a member to a hub writes the hub grant only', () => {
  it('create route: a hub admin added to hub A holds no global role', async () => {
    const res = await call(SUPER, 'POST', `/api/hubs/${HUB_A}/users`, createBody(NEW_ADMIN_A, 'new admin a', ['role-hub-admin']))
    expect(res.status).toBe(201)

    const r = await row(NEW_ADMIN_A)
    expect(r.roles, 'the hub grant leaked into the account-wide roles column').toEqual([])
    expect(r.hubRoles).toEqual([{ hubId: HUB_A, roleIds: ['role-hub-admin'] }])
  })

  it('every seeded hub member holds no global role', async () => {
    for (const pubkey of [ADMIN_A, ADMIN_B, VOL_A, VOL_B, BOTH]) {
      expect((await row(pubkey)).roles, pubkey).toEqual([])
    }
  })

  it('the hub admin created that way is an admin of hub A — and of nothing else', async () => {
    expect((await call(NEW_ADMIN_A, 'GET', `/api/hubs/${HUB_A}/users`)).status).toBe(200)
    expect((await call(NEW_ADMIN_A, 'GET', `/api/hubs/${HUB_B}/users`)).status).toBe(403)
  })
})

describe('a hub admin of A cannot reach hub B through the unscoped routes', () => {
  const attempts: Array<{ name: string; method: string; path: () => string; body?: unknown }> = [
    { name: 'list users', method: 'GET', path: () => '/api/users' },
    { name: 'list volunteers (alias)', method: 'GET', path: () => '/api/volunteers' },
    { name: 'read a hub-B user', method: 'GET', path: () => `/api/users/${VOL_B}` },
    { name: 'read a hub-B user (alias)', method: 'GET', path: () => `/api/volunteers/${VOL_B}` },
    { name: 'deactivate a hub-B user', method: 'PATCH', path: () => `/api/users/${VOL_B}`, body: { active: false } },
    { name: 'rename a hub-B user', method: 'PATCH', path: () => `/api/users/${VOL_B}`, body: { name: 'hijacked' } },
    { name: 'grant a hub-B user roles', method: 'PATCH', path: () => `/api/users/${VOL_B}`, body: { roles: ['role-hub-admin'] } },
    { name: 'delete a hub-B user', method: 'DELETE', path: () => `/api/users/${VOL_B}` },
    { name: 'create a user', method: 'POST', path: () => '/api/users', body: createBody(hex('ee'), 'x', ['role-volunteer']) },
    { name: 'read hub-B user cases', method: 'GET', path: () => `/api/users/${VOL_B}/cases?hubId=${HUB_B}` },
    { name: 'read hub-B user metrics', method: 'GET', path: () => `/api/users/${VOL_B}/metrics?hubId=${HUB_B}` },
  ]

  for (const actor of [['ADMIN_A', ADMIN_A], ['NEW_ADMIN_A (created via the add-member route)', NEW_ADMIN_A]] as const) {
    for (const a of attempts) {
      it(`${actor[0]}: ${a.name} → 403`, async () => {
        const res = await call(actor[1], a.method, a.path(), a.body)
        expect(res.status).toBe(403)
      })
    }
  }

  it('hub B\'s own mount refuses them too', async () => {
    for (const [method, path, body] of [
      ['GET', `/api/hubs/${HUB_B}/users`, undefined],
      ['GET', `/api/hubs/${HUB_B}/users/${VOL_B}`, undefined],
      ['PATCH', `/api/hubs/${HUB_B}/users/${VOL_B}`, { active: false }],
      ['DELETE', `/api/hubs/${HUB_B}/users/${VOL_B}`, undefined],
    ] as const) {
      expect((await call(ADMIN_A, method, path, body)).status, `${method} ${path}`).toBe(403)
    }
  })

  it('and nothing about hub B\'s people changed', async () => {
    const r = await row(VOL_B)
    expect(r.active).toBe(true)
    expect(r.displayName).toBe(`user-${VOL_B.slice(0, 4)}`)
    expect(r.roles).toEqual([])
    expect(r.hubRoles).toEqual([{ hubId: HUB_B, roleIds: ['role-volunteer'] }])
  })
})

describe('through hub A\'s own mount, hub A\'s admin sees and edits only hub A', () => {
  it('lists hub A members and not hub B\'s', async () => {
    const res = await call(ADMIN_A, 'GET', `/api/hubs/${HUB_A}/users`)
    expect(res.status).toBe(200)
    const listed = (res.json.users as Array<{ pubkey: string }>).map(u => u.pubkey)
    expect(listed).toContain(VOL_A)
    expect(listed).toContain(BOTH)
    expect(listed).not.toContain(VOL_B)
    expect(listed).not.toContain(ADMIN_B)
  })

  it('a hub-B user is a 404 through hub A — read, edit and delete', async () => {
    for (const [method, body] of [['GET', undefined], ['PATCH', { name: 'hijacked' }], ['PATCH', { active: false }], ['DELETE', undefined]] as const) {
      const res = await call(ADMIN_A, method, `/api/hubs/${HUB_A}/users/${VOL_B}`, body)
      expect(res.status, `${method} ${JSON.stringify(body)}`).toBe(404)
    }
    expect((await row(VOL_B)).active).toBe(true)
  })

  it('edits a hub A member (legitimate in-hub operation)', async () => {
    const res = await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/users/${VOL_A}`, { name: 'renamed in hub a' })
    expect(res.status).toBe(200)
    expect((await row(VOL_A)).displayName).toBe('renamed in hub a')
  })

  it('roles sent to the hub PATCH change the assignment in that hub, never the global column', async () => {
    const res = await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/users/${VOL_A}`, { roles: ['role-reviewer'] })
    expect(res.status).toBe(200)
    const r = await row(VOL_A)
    expect(r.roles, 'a hub PATCH wrote the account-wide roles column').toEqual([])
    expect(r.hubRoles).toEqual([{ hubId: HUB_A, roleIds: ['role-reviewer'] }])
    expect((res.json.roles as string[])).toEqual(['role-reviewer'])
  })

  it('cannot grant a role broader than their own', async () => {
    const res = await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/users/${VOL_A}`, { roles: ['role-super-admin'] })
    expect(res.status).toBe(403)
    expect((await row(VOL_A)).hubRoles).toEqual([{ hubId: HUB_A, roleIds: ['role-reviewer'] }])
  })

  it('a member of both hubs: hub A\'s PATCH touches only the hub A assignment', async () => {
    const res = await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/users/${BOTH}`, { roles: ['role-reviewer'] })
    expect(res.status).toBe(200)
    const r = await row(BOTH)
    expect(r.roles).toEqual([])
    expect(r.hubRoles).toEqual([
      { hubId: HUB_A, roleIds: ['role-reviewer'] },
      { hubId: HUB_B, roleIds: ['role-volunteer'] },
    ])
  })

  it('a member of both hubs cannot be deactivated, deleted, renamed or re-numbered from one hub', async () => {
    // The phone number is where hub B's calls ring: account fields belong to
    // the account, not to whichever hub's admin reached it first.
    const before = await row(BOTH)
    expect((await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/users/${BOTH}`, { active: false })).status).toBe(409)
    expect((await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/users/${BOTH}`, { name: 'hijacked' })).status).toBe(409)
    expect((await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/users/${BOTH}`, { phone: '+15559999999' })).status).toBe(409)
    expect((await call(ADMIN_A, 'DELETE', `/api/hubs/${HUB_A}/users/${BOTH}`)).status).toBe(409)
    const after = await row(BOTH)
    expect(after.active).toBe(true)
    expect(after.displayName).toBe(before.displayName)
    expect(after.phone).toBe(before.phone)
  })

  it('a member of one hub only can have account fields edited by that hub\'s admin', async () => {
    expect((await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/users/${VOL_A}`, { phone: '+15550001111' })).status).toBe(200)
    expect((await row(VOL_A)).phone).toBe('+15550001111')
  })

  it('unscoped cases/metrics outside a hub need a hub to be about', async () => {
    expect((await call(SUPER, 'GET', `/api/users/${VOL_A}/cases`)).status).toBe(400)
    expect((await call(SUPER, 'GET', `/api/users/${VOL_A}/metrics`)).status).toBe(400)
  })
})

describe('an account holding a global role is not editable from inside a hub', () => {
  // The super-admin counts as a member of every hub, so hub A's mount can name
  // them. A hub admin must not rename, re-role or deactivate them from there.
  for (const [name, method, body] of [
    ['rename', 'PATCH', { name: 'hijacked' }],
    ['change roles', 'PATCH', { roles: ['role-volunteer'] }],
    ['deactivate', 'PATCH', { active: false }],
    ['delete', 'DELETE', undefined],
  ] as const) {
    it(`${name} → refused, super-admin unchanged`, async () => {
      const res = await call(ADMIN_A, method, `/api/hubs/${HUB_A}/users/${SUPER}`, body)
      expect([403, 404, 409]).toContain(res.status)
      const r = await row(SUPER)
      expect(r.roles).toEqual(['role-super-admin'])
      expect(r.active).toBe(true)
      expect(r.displayName).toBe('Super')
    })
  }
})

describe('the super-admin keeps the instance view', () => {
  it('lists every hub\'s users unscoped', async () => {
    const res = await call(SUPER, 'GET', '/api/users')
    expect(res.status).toBe(200)
    const listed = (res.json.users as Array<{ pubkey: string }>).map(u => u.pubkey)
    for (const pubkey of [VOL_A, VOL_B, ADMIN_A, ADMIN_B, BOTH]) expect(listed).toContain(pubkey)
    expect((await call(SUPER, 'GET', '/api/volunteers')).status).toBe(200)
  })

  it('reads and edits a user of any hub unscoped', async () => {
    expect((await call(SUPER, 'GET', `/api/users/${VOL_B}`)).status).toBe(200)
    expect((await call(SUPER, 'PATCH', `/api/users/${VOL_B}`, { name: 'renamed by super' })).status).toBe(200)
    expect((await row(VOL_B)).displayName).toBe('renamed by super')
  })

  it('creates a user unscoped with a global role (instance-level)', async () => {
    const pubkey = hex('ef')
    ALL_PUBKEYS.push(pubkey)
    const res = await call(SUPER, 'POST', '/api/users', createBody(pubkey, 'global volunteer', ['role-volunteer']))
    expect(res.status).toBe(201)
    const r = await row(pubkey)
    expect(r.roles).toEqual(['role-volunteer'])
    expect(r.hubRoles).toEqual([])
  })

  it('administers a hub from inside it, and keeps reaching every hub', async () => {
    expect((await call(SUPER, 'GET', `/api/hubs/${HUB_B}/users`)).status).toBe(200)
    expect((await call(SUPER, 'PATCH', `/api/hubs/${HUB_B}/users/${VOL_B}`, { roles: ['role-reviewer'] })).status).toBe(200)
    const r = await row(VOL_B)
    expect(r.roles).toEqual([])
    expect(r.hubRoles).toEqual([{ hubId: HUB_B, roleIds: ['role-reviewer'] }])
  })
})
