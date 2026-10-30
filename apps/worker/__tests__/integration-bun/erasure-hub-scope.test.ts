/**
 * The erasure admin surface is scoped to the hub it is called in (#2363),
 * against real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/erasure-hub-scope.test.ts
 *
 * Why this tier: hub membership is read from `users.hub_roles`, a `bun-jsonb`
 * column — the vitest tier's Node driver serialises it differently, so a
 * membership assertion there would test a driver production never uses.
 *
 * An erasure request records that a specific person asked a crisis hotline to
 * delete their record. Listing it across a hub boundary hands one organisation
 * a roster of another's callers-who-asked-to-be-forgotten. Every assertion
 * below is on a response BODY: a status code alone cannot tell "refused" from
 * "returned the wrong rows".
 *
 * Two hubs, each with requests; a person in both; a person in neither. The real
 * router, the real `requirePermission` guard and the real `hubContext` run over
 * real rows, so the permission set a handler sees is the one a request carries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { erasureRequests, hubs, reEncryptionJobs, users } from '../../db/schema'
import { ErasureService } from '../../services/erasure'
import erasureRoutes from '../../routes/erasure'
import { hubContext } from '../../middleware/hub'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const erasure = new ErasureService(db)

/** Holds ONLY the platform permission — no `erasure:admin`, in any hub or globally. */
const PLATFORM_READER_ROLE = 'role-platform-reader-2363'
const ALL_ROLES: Role[] = [
  ...DEFAULT_ROLES.map(r => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
  {
    id: PLATFORM_READER_ROLE,
    name: 'Platform reader',
    slug: 'platform-reader-2363',
    permissions: ['system:manage-instance'],
    isDefault: false,
    isSystem: false,
    description: 'test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-er-a-${suffix}`
const HUB_B = `hub-er-b-${suffix}`
const GONE_HUB = `hub-er-gone-${suffix}`

type HubRole = { hubId: string; roleIds: string[] }
interface Actor { pubkey: string; roles: string[]; hubRoles: HubRole[] }

const uniq = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
const key = (lead: string) => `${lead}${uniq}`.padEnd(64, '0')
const actor = (lead: string, roles: string[], hubRoles: HubRole[]): Actor => ({ pubkey: key(lead), roles, hubRoles })

const SUPER_ADMIN = actor('c1', ['role-super-admin'], [])
const HUB_A_ADMIN = actor('c2', [], [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }])
const HUB_B_ADMIN = actor('c3', [], [{ hubId: HUB_B, roleIds: ['role-hub-admin'] }])
/** Administers hub A, an ordinary volunteer in hub B. */
const A_ADMIN_B_VOLUNTEER = actor('c4', [], [
  { hubId: HUB_A, roleIds: ['role-hub-admin'] },
  { hubId: HUB_B, roleIds: ['role-volunteer'] },
])
const PLATFORM_READER = actor('c5', [PLATFORM_READER_ROLE], [])

// Subjects of the erasure requests.
const IN_A = actor('d1', [], [{ hubId: HUB_A, roleIds: ['role-volunteer'] }])
const IN_B = actor('d2', [], [{ hubId: HUB_B, roleIds: ['role-volunteer'] }])
const IN_A_AND_B = actor('d3', [], [
  { hubId: HUB_A, roleIds: ['role-volunteer'] },
  { hubId: HUB_B, roleIds: ['role-volunteer'] },
])
const IN_NO_HUB = actor('d4', [], [])
/** Belongs only to a hub that no longer exists. */
const IN_GONE_HUB = actor('d5', [], [{ hubId: GONE_HUB, roleIds: ['role-volunteer'] }])

const ACTORS = [SUPER_ADMIN, HUB_A_ADMIN, HUB_B_ADMIN, A_ADMIN_B_VOLUNTEER, PLATFORM_READER]
const SUBJECTS = [IN_A, IN_B, IN_A_AND_B, IN_NO_HUB, IN_GONE_HUB]
const ownPubkeys = [...ACTORS, ...SUBJECTS].map(a => a.pubkey)

/** request id by label, filled in `beforeAll`. */
const REQ: Record<'inA' | 'inB' | 'inAB' | 'noHub' | 'goneHub' | 'shredA' | 'shredB' | 'shredGone', string> = {
  inA: '', inB: '', inAB: '', noHub: '', goneHub: '', shredA: '', shredB: '', shredGone: '',
}
const JOB: Record<'a' | 'b', string> = { a: '', b: '' }

/** The router mounted as app.ts mounts it: unscoped, and under /hubs/:hubId behind the real hubContext. */
function appAs(as: Actor) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', as.pubkey)
    c.set('user', { pubkey: as.pubkey, roles: as.roles, hubRoles: as.hubRoles } as unknown as AppEnv['Variables']['user'])
    c.set('services', {
      erasure,
      settings: { getHub: async () => ({}) },
      audit: { log: async () => {} },
    } as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', ALL_ROLES)
    // auth middleware: global roles only
    c.set('permissions', resolvePermissions(as.roles, ALL_ROLES))
    await next()
  })
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/erasure', erasureRoutes)
  app.route('/api/erasure', erasureRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

interface Listed { requests?: { id: string; userId: string | null }[]; total?: number; jobs?: { id: string }[] }

async function call(as: Actor, method: string, path: string): Promise<{ status: number; body: Listed & Record<string, unknown> }> {
  const res = await appAs(as).request(path, {
    method,
    ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ justification: 'because' }) }),
  })
  return { status: res.status, body: (await res.json()) as Listed & Record<string, unknown> }
}

const ids = (body: Listed) => (body.requests ?? []).map(r => r.id)

beforeAll(async () => {
  for (const [id, name] of [[HUB_A, 'Erasure hub A'], [HUB_B, 'Erasure hub B']]) {
    await db.insert(hubs).values({ id, name, slug: id, createdBy: 'integration-test' })
  }
  await db.insert(users).values(
    [...ACTORS, ...SUBJECTS].map(a => ({
      pubkey: a.pubkey,
      displayName: null,
      phone: '+15550002363',
      roles: a.roles,
      hubRoles: a.hubRoles,
      active: true,
    })),
  )
  const executeAt = new Date(Date.now() + 72 * 3600_000)
  const person = (label: keyof typeof REQ, subject: Actor) => ({ label, row: { scope: 'user', userId: subject.pubkey, status: 'pending', requestedBy: subject.pubkey, executeAt } })
  const shred = (label: keyof typeof REQ, hubId: string) => ({ label, row: { scope: 'hub', hubId, status: 'pending', requestedBy: HUB_A_ADMIN.pubkey, executeAt } })
  const seeded = [
    person('inA', IN_A), person('inB', IN_B), person('inAB', IN_A_AND_B), person('noHub', IN_NO_HUB), person('goneHub', IN_GONE_HUB),
    shred('shredA', HUB_A), shred('shredB', HUB_B), shred('shredGone', GONE_HUB),
  ]
  for (const { label, row } of seeded) {
    const [inserted] = await db.insert(erasureRequests).values(row).returning({ id: erasureRequests.id })
    REQ[label] = inserted!.id
  }
  for (const [label, hubId, userId] of [['a', HUB_A, IN_A.pubkey], ['b', HUB_B, IN_B.pubkey]] as const) {
    const [job] = await db.insert(reEncryptionJobs).values({ hubId, userId }).returning({ id: reEncryptionJobs.id })
    JOB[label] = job!.id
  }
})

afterAll(async () => {
  await db.delete(reEncryptionJobs).where(inArray(reEncryptionJobs.id, Object.values(JOB)))
  await db.delete(erasureRequests).where(inArray(erasureRequests.id, Object.values(REQ)))
  await db.delete(users).where(inArray(users.pubkey, ownPubkeys))
  await db.delete(hubs).where(inArray(hubs.id, [HUB_A, HUB_B]))
})

describe('GET /api/hubs/:hubId/erasure/requests — a hub lists only the requests that concern it', () => {
  it('hub A’s admin sees hub A’s requests and NONE of hub B’s, nor a hub-less subject’s', async () => {
    const { status, body } = await call(HUB_A_ADMIN, 'GET', `/api/hubs/${HUB_A}/erasure/requests`)
    expect(status).toBe(200)
    const listed = ids(body)
    // Hub A's own: its member, the person in both hubs, and the shred of hub A.
    expect(listed).toContain(REQ.inA)
    expect(listed).toContain(REQ.inAB)
    expect(listed).toContain(REQ.shredA)
    // Everything else is another organisation's, or nobody's.
    for (const foreign of [REQ.inB, REQ.shredB, REQ.noHub, REQ.goneHub, REQ.shredGone]) {
      expect(listed, `request ${foreign} leaked into hub A's list`).not.toContain(foreign)
    }
    // The subject ids, not just the request ids.
    const subjects = (body.requests ?? []).map(r => r.userId)
    expect(subjects).not.toContain(IN_B.pubkey)
    expect(subjects).not.toContain(IN_NO_HUB.pubkey)
    expect(body.total).toBe(listed.length)
  })

  it('hub B’s admin sees the mirror image', async () => {
    const { body } = await call(HUB_B_ADMIN, 'GET', `/api/hubs/${HUB_B}/erasure/requests`)
    const listed = ids(body)
    expect(listed.sort()).toEqual([REQ.inB, REQ.inAB, REQ.shredB].sort())
  })

  it('a status filter narrows within the hub and never widens past it', async () => {
    const { body } = await call(HUB_A_ADMIN, 'GET', `/api/hubs/${HUB_A}/erasure/requests?status=pending`)
    expect(ids(body)).toContain(REQ.inA)
    expect(ids(body)).not.toContain(REQ.inB)
    const none = await call(HUB_A_ADMIN, 'GET', `/api/hubs/${HUB_A}/erasure/requests?status=completed`)
    expect(none.body.requests).toEqual([])
    expect(none.body.total).toBe(0)
  })

  it('refuses hub A’s admin the list of hub B, where they hold nothing', async () => {
    const { status, body } = await call(HUB_A_ADMIN, 'GET', `/api/hubs/${HUB_B}/erasure/requests`)
    expect(status).toBe(403)
    expect(body.requests).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(REQ.inB)
  })

  it('refuses an admin of hub A who is only a volunteer in hub B the list of hub B', async () => {
    const own = await call(A_ADMIN_B_VOLUNTEER, 'GET', `/api/hubs/${HUB_A}/erasure/requests`)
    expect(own.status).toBe(200)
    expect(ids(own.body)).toContain(REQ.inA)
    const foreign = await call(A_ADMIN_B_VOLUNTEER, 'GET', `/api/hubs/${HUB_B}/erasure/requests`)
    expect(foreign.status).toBe(403)
    expect(foreign.body.requests).toBeUndefined()
  })

  it('a super-admin inside a hub still sees only that hub’s requests', async () => {
    const { status, body } = await call(SUPER_ADMIN, 'GET', `/api/hubs/${HUB_A}/erasure/requests`)
    expect(status).toBe(200)
    expect(ids(body)).toContain(REQ.inA)
    for (const foreign of [REQ.inB, REQ.shredB, REQ.noHub, REQ.goneHub]) expect(ids(body)).not.toContain(foreign)
  })
})

describe('GET /api/erasure/requests — there is no hub-less roster', () => {
  it('lists nothing for a global erasure:admin holder: a hub is required', async () => {
    const { status, body } = await call(SUPER_ADMIN, 'GET', '/api/erasure/requests')
    expect(status).toBe(400)
    expect(body.requests).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(REQ.inA)
  })
})

describe('GET /api/erasure/platform/requests — the platform scope is its own endpoint', () => {
  it('shows a platform reader the requests that concern no hub, and nothing of any hub’s', async () => {
    const { status, body } = await call(PLATFORM_READER, 'GET', '/api/erasure/platform/requests')
    expect(status).toBe(200)
    const listed = ids(body)
    expect(listed).toContain(REQ.noHub)
    expect(listed).toContain(REQ.goneHub)
    expect(listed).toContain(REQ.shredGone)
    for (const hubs of [REQ.inA, REQ.inB, REQ.inAB, REQ.shredA, REQ.shredB]) {
      expect(listed, `request ${hubs} (a hub's) reached the platform reader`).not.toContain(hubs)
    }
  })

  it('does not widen for a super-admin: holding everything still reads only the hub-less', async () => {
    const { body } = await call(SUPER_ADMIN, 'GET', '/api/erasure/platform/requests')
    expect(ids(body)).toContain(REQ.noHub)
    for (const hubs of [REQ.inA, REQ.inB, REQ.inAB, REQ.shredA, REQ.shredB]) expect(ids(body)).not.toContain(hubs)
  })

  it('refuses a hub admin: erasure:admin inside a hub is not the platform permission', async () => {
    const { status, body } = await call(HUB_A_ADMIN, 'GET', '/api/erasure/platform/requests')
    expect(status).toBe(403)
    expect(body.requests).toBeUndefined()
  })

  it('is not served under a hub path, so a hub-resolved permission can never stand in for it', async () => {
    const { status, body } = await call(SUPER_ADMIN, 'GET', `/api/hubs/${HUB_A}/erasure/platform/requests`)
    expect(status).toBe(400)
    expect(body.requests).toBeUndefined()
  })
})

describe('GET /api/hubs/:hubId/erasure/re-encryption-jobs', () => {
  it('lists the hub’s jobs only', async () => {
    const { status, body } = await call(HUB_A_ADMIN, 'GET', `/api/hubs/${HUB_A}/erasure/re-encryption-jobs`)
    expect(status).toBe(200)
    const listed = (body.jobs ?? []).map(j => j.id)
    expect(listed).toContain(JOB.a)
    expect(listed, 'hub B’s job leaked into hub A').not.toContain(JOB.b)
  })

  it('has no hub-less listing', async () => {
    const { status, body } = await call(SUPER_ADMIN, 'GET', '/api/erasure/re-encryption-jobs')
    expect(status).toBe(400)
    expect(body.jobs).toBeUndefined()
  })
})

describe('POST /erasure/:userId/wipe-device/:devicePubkey — only on a person the caller may erase', () => {
  const wipe = (as: Actor, subject: Actor, hubId?: string) =>
    call(as, 'POST', `${hubId ? `/api/hubs/${hubId}` : '/api'}/erasure/${subject.pubkey}/wipe-device/${'a'.repeat(64)}`)

  it('lets a hub’s admin act on that hub’s member', async () => {
    expect((await wipe(HUB_A_ADMIN, IN_A, HUB_A)).status).toBe(200)
  })

  it('refuses hub A’s admin a person who belongs only to hub B', async () => {
    expect((await wipe(HUB_A_ADMIN, IN_B, HUB_A)).status).toBe(403)
  })

  it('refuses hub A’s admin a person in both hubs: they hold erasure:admin in only one of them', async () => {
    expect((await wipe(HUB_A_ADMIN, IN_A_AND_B, HUB_A)).status).toBe(403)
  })

  it('refuses an admin of hub A and volunteer of hub B a person in both hubs', async () => {
    expect((await wipe(A_ADMIN_B_VOLUNTEER, IN_A_AND_B, HUB_A)).status).toBe(403)
  })

  it('refuses a super-admin outside a hub a person who belongs to one', async () => {
    expect((await wipe(SUPER_ADMIN, IN_A)).status).toBe(403)
  })

  it('lets a super-admin act on a hub’s member from inside that hub', async () => {
    expect((await wipe(SUPER_ADMIN, IN_A, HUB_A)).status).toBe(200)
    expect((await wipe(SUPER_ADMIN, IN_A_AND_B, HUB_A)).status).toBe(200)
  })

  it('leaves a person who belongs to no hub to the platform permission, outside a hub', async () => {
    expect((await wipe(HUB_A_ADMIN, IN_NO_HUB, HUB_A)).status).toBe(403)
    // A platform reader holds no erasure:admin, so the route guard refuses before the subject is read.
    expect((await wipe(PLATFORM_READER, IN_NO_HUB)).status).toBe(403)
    expect((await wipe(SUPER_ADMIN, IN_NO_HUB)).status).toBe(200)
  })
})

describe('POST /erasure/:userId — the same boundary, before anything is erased', () => {
  const erase = (as: Actor, subject: Actor, hubId?: string) =>
    call(as, 'POST', `${hubId ? `/api/hubs/${hubId}` : '/api'}/erasure/${subject.pubkey}`)

  it('refuses hub A’s admin a person who belongs only to hub B', async () => {
    const { status, body } = await erase(HUB_A_ADMIN, IN_B, HUB_A)
    expect(status).toBe(403)
    expect(body.ok).toBeUndefined()
  })

  it('refuses hub A’s admin a person in both hubs', async () => {
    expect((await erase(HUB_A_ADMIN, IN_A_AND_B, HUB_A)).status).toBe(403)
  })

  it('refuses a super-admin outside a hub a person who belongs to one', async () => {
    expect((await erase(SUPER_ADMIN, IN_A)).status).toBe(403)
  })
})
