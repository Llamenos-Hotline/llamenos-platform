/**
 * GET /api/identity/members — the admin member directory the iOS Volunteers
 * tab reads (#1701, #1046), against real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/identity-members-directory.test.ts
 *
 * Why this tier: membership and role are read from `users.hub_roles`, a
 * `bun-jsonb` column with no `toDriver`. The vitest tier runs Node's
 * postgres-js driver, which serializes it differently — a hub-membership
 * assertion there would test a driver production never uses (same reasoning
 * as recovery-group-share-membership.test.ts).
 *
 * What it pins, through the real router, the real `requirePermission` guard
 * and the real `IdentityService` over real rows:
 *   - the response shape iOS decodes into `UsersListResponse` / `ClientUser`
 *     (apps/ios/Sources/Models/Admin.swift), and nothing more — no phone, no
 *     hub memberships, no role ids;
 *   - the authorisation boundary: a global `users:read` holder (super-admin)
 *     reads the instance directory; a volunteer is refused; a hub admin is
 *     refused the INSTANCE directory (it lists other hubs' people) but reads
 *     their own hub's under /api/hubs/:hubId/identity/members;
 *   - role is resolved per hub: someone who administers hub B but volunteers
 *     in hub A is a volunteer in hub A's directory.
 *
 * The middleware below sets exactly what the auth middleware and hubContext
 * set for these routes — `permissions` from the global roles, replaced inside
 * a hub by the hub-resolved set — using the same `@shared/permissions`
 * resolvers, so the guard sees the authority a real request carries.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres) with
 * migrations applied. Everything created here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs, users } from '../../db/schema'
import { IdentityService } from '../../services/identity'
import identityRoutes from '../../routes/identity'
import type { AppEnv } from '../../types'
import { revokedSigningKeys } from '../../lib/revoked-signing-keys'
import { memberDirectoryResponseSchema } from '@protocol/schemas/users'
import {
  DEFAULT_ROLES,
  permissionGranted,
  resolveHubPermissions,
  resolvePermissions,
  type Role,
} from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-idm-a-${suffix}`
const HUB_B = `hub-idm-b-${suffix}`

type HubRole = { hubId: string; roleIds: string[] }
interface Actor { pubkey: string; roles: string[]; hubRoles: HubRole[] }

const uniq = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
const key = (lead: string) => `${lead}${uniq}`.padEnd(64, '0')

const SUPER_ADMIN: Actor = { pubkey: key('a1'), roles: ['role-super-admin'], hubRoles: [] }
const HUB_A_ADMIN: Actor = { pubkey: key('a2'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }] }
/** Volunteers in hub A, administers hub B. */
const SPLIT_ROLE: Actor = {
  pubkey: key('a3'),
  roles: [],
  hubRoles: [
    { hubId: HUB_A, roleIds: ['role-volunteer'] },
    { hubId: HUB_B, roleIds: ['role-hub-admin'] },
  ],
}
const INACTIVE_VOLUNTEER: Actor = { pubkey: key('a4'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-volunteer'] }] }
/**
 * Holds a non-super-admin GLOBAL admin role (as `createUser` under a hub
 * writes one) but only volunteers in hub A. A global role other than
 * super-admin carries no authority inside a hub (#1037), so hub A's directory
 * must not call them an admin.
 */
const GLOBAL_ROLE_VOLUNTEER: Actor = {
  pubkey: key('a6'),
  roles: ['role-hub-admin'],
  hubRoles: [{ hubId: HUB_A, roleIds: ['role-volunteer'] }],
}
/** A member of hub B only. */
const HUB_B_VOLUNTEER: Actor = { pubkey: key('a5'), roles: [], hubRoles: [{ hubId: HUB_B, roleIds: ['role-volunteer'] }] }

/** A key whose private half is public: never a member of anything. */
const REVOKED = [...revokedSigningKeys()][0]

const PHONE = '+15550001701'
const ownPubkeys = [SUPER_ADMIN, HUB_A_ADMIN, SPLIT_ROLE, INACTIVE_VOLUNTEER, HUB_B_VOLUNTEER, GLOBAL_ROLE_VOLUNTEER].map(a => a.pubkey)
let insertedRevoked = false

/** The router mounted as app.ts mounts it, behind what auth + hubContext set. */
function appAs(actor: Actor) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', actor.pubkey)
    c.set('services', { identity } as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', ALL_ROLES)
    // auth middleware: global roles only
    c.set('permissions', resolvePermissions(actor.roles, ALL_ROLES))
    await next()
  })
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', async (c, next) => {
    // hubContext: the hub-resolved set REPLACES the global one
    const hubId = c.req.param('hubId') as string
    c.set('hubId', hubId)
    c.set('permissions', resolveHubPermissions(actor.roles, actor.hubRoles, ALL_ROLES, hubId))
    await next()
  })
  hubScoped.route('/identity', identityRoutes)
  app.route('/api/identity', identityRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

interface Member {
  id: string
  pubkey: string
  displayName: string | null
  role: string
  status: string
  createdAt: string
}

async function directory(actor: Actor, hubId?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = hubId ? `/api/hubs/${hubId}/identity/members` : '/api/identity/members'
  const res = await appAs(actor).request(path)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

function byPubkey(body: Record<string, unknown>): Map<string, Member> {
  return new Map((body.members as Member[]).map(m => [m.pubkey, m]))
}

beforeAll(async () => {
  for (const [id, name] of [[HUB_A, 'Directory hub A'], [HUB_B, 'Directory hub B']]) {
    await db.insert(hubs).values({ id, name, slug: id, createdBy: 'integration-test' })
  }
  const row = (a: Actor, displayName: string | null, active = true) => ({
    pubkey: a.pubkey,
    displayName,
    phone: PHONE,
    roles: a.roles,
    hubRoles: a.hubRoles,
    active,
  })
  await db.insert(users).values([
    row(SUPER_ADMIN, 'Directory Super'),
    row(HUB_A_ADMIN, 'Directory Hub Admin'),
    row(SPLIT_ROLE, 'Directory Split'),
    row(INACTIVE_VOLUNTEER, null, false),
    row(HUB_B_VOLUNTEER, 'Directory B Volunteer'),
    row(GLOBAL_ROLE_VOLUNTEER, 'Directory Global Role'),
  ])
  const revoked = await db
    .insert(users)
    .values({ pubkey: REVOKED, displayName: 'Revoked key', roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-volunteer'] }] })
    .onConflictDoNothing()
    .returning({ pubkey: users.pubkey })
  insertedRevoked = revoked.length === 1
})

afterAll(async () => {
  await db.delete(users).where(inArray(users.pubkey, insertedRevoked ? [...ownPubkeys, REVOKED] : ownPubkeys))
  await db.delete(hubs).where(inArray(hubs.id, [HUB_A, HUB_B]))
})

describe('GET /api/identity/members — response shape (iOS UsersListResponse)', () => {
  it('returns { members: ClientUser[] } with exactly the keys the client decodes', async () => {
    const { status, body } = await directory(SUPER_ADMIN)
    expect(status).toBe(200)
    expect(Object.keys(body)).toEqual(['members'])

    const members = byPubkey(body)
    for (const pubkey of ownPubkeys) {
      const found = members.get(pubkey)
      expect(found, `${pubkey} missing from the instance directory`).toBeDefined()
      const m = found as Member
      // ClientUser's stored properties, nothing else. Every key is camelCase
      // with no underscore, which APIService's `.convertFromSnakeCase` leaves
      // verbatim — so these names ARE the Swift property names.
      expect(Object.keys(m).sort()).toEqual(['createdAt', 'displayName', 'id', 'pubkey', 'role', 'status'])
      expect(m.id).toBe(pubkey)
      // UserRole / ClientUserStatus raw values
      expect(['admin', 'volunteer']).toContain(m.role)
      expect(['active', 'inactive', 'suspended']).toContain(m.status)
      expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false)
    }
  })

  it('withholds phone numbers and hub memberships from the directory', async () => {
    const { body } = await directory(SUPER_ADMIN)
    const raw = JSON.stringify(body)
    expect(raw).not.toContain(PHONE)
    expect(raw).not.toContain(HUB_A)
    expect(raw).not.toContain(HUB_B)
    expect(raw).not.toContain('role-hub-admin')
  })

  it('matches the protocol schema every client decodes from, in the instance and a hub directory', async () => {
    for (const { body } of [await directory(SUPER_ADMIN), await directory(HUB_A_ADMIN, HUB_A)]) {
      expect(memberDirectoryResponseSchema.safeParse(body).success).toBe(true)
    }
  })

  it('carries no role id, role name, hub membership or phone on any member, instance or hub', async () => {
    // The point of this surface over /api/users: role is resolved server-side to
    // admin|volunteer, so a hub never learns who administers a different hub.
    // Asserted on the key set AND on the serialised text (a role id smuggled in
    // under a renamed key would pass the first check and fail the second).
    for (const { body } of [await directory(SUPER_ADMIN), await directory(HUB_A_ADMIN, HUB_A)]) {
      for (const member of body.members as Record<string, unknown>[]) {
        for (const forbidden of ['roles', 'roleIds', 'hubRoles', 'hubs', 'phone']) {
          expect(Object.keys(member), `member exposes ${forbidden}`).not.toContain(forbidden)
        }
      }
      const raw = JSON.stringify(body)
      expect(raw).not.toMatch(/role-[a-z-]+/)
      expect(raw).not.toContain(PHONE)
    }
  })

  it('maps role, status and a missing name the way the Volunteers screen reads them', async () => {
    const members = byPubkey((await directory(SUPER_ADMIN)).body)
    expect(members.get(SUPER_ADMIN.pubkey)).toMatchObject({ role: 'admin', status: 'active', displayName: 'Directory Super' })
    expect(members.get(HUB_A_ADMIN.pubkey)).toMatchObject({ role: 'admin', status: 'active' })
    // The instance view describes the account: an admin anywhere is an admin.
    expect(members.get(SPLIT_ROLE.pubkey)).toMatchObject({ role: 'admin' })
    expect(members.get(INACTIVE_VOLUNTEER.pubkey)).toMatchObject({ role: 'volunteer', status: 'inactive', displayName: null })
    expect(members.get(HUB_B_VOLUNTEER.pubkey)).toMatchObject({ role: 'volunteer', status: 'active' })
    expect(members.get(GLOBAL_ROLE_VOLUNTEER.pubkey)).toMatchObject({ role: 'admin' })
  })

  it('never lists a revoked signing key', async () => {
    const members = byPubkey((await directory(SUPER_ADMIN)).body)
    expect(members.has(REVOKED)).toBe(false)
  })
})

describe('GET /api/identity/members — authorisation boundary', () => {
  it('refuses a volunteer, and the refusal carries no member data', async () => {
    const { status, body } = await directory(INACTIVE_VOLUNTEER)
    expect(status).toBe(403)
    expect(body.members).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('Directory')
  })

  it('refuses a hub admin the instance directory, which lists other hubs’ people', async () => {
    const { status, body } = await directory(HUB_A_ADMIN)
    expect(status).toBe(403)
    expect(body.members).toBeUndefined()
  })

  it('refuses a hub-B admin reading hub A, where they are only a volunteer', async () => {
    const { status, body } = await directory(SPLIT_ROLE, HUB_A)
    expect(status).toBe(403)
    expect(body.members).toBeUndefined()
  })
})

describe('GET /api/hubs/:hubId/identity/members — one hub’s directory', () => {
  it('serves a hub admin who holds users:read in the hub and NOT globally — the Android member directory', async () => {
    // The precondition IS the scenario: hub-scoped users:read, no global users:read.
    // Android reads this route for VolunteersTab, UserDetail, ShiftDetail, Conversations
    // and Blasts; the unscoped route would 403 a hub admin out of all five (#1992).
    expect(permissionGranted(resolvePermissions(HUB_A_ADMIN.roles, ALL_ROLES), 'users:read')).toBe(false)
    expect(
      permissionGranted(resolveHubPermissions(HUB_A_ADMIN.roles, HUB_A_ADMIN.hubRoles, ALL_ROLES, HUB_A), 'users:read'),
    ).toBe(true)

    const scoped = await directory(HUB_A_ADMIN, HUB_A)
    expect(scoped.status).toBe(200)
    const members = byPubkey(scoped.body)
    for (const actor of [HUB_A_ADMIN, SPLIT_ROLE, INACTIVE_VOLUNTEER, GLOBAL_ROLE_VOLUNTEER]) {
      expect(members.has(actor.pubkey), `${actor.pubkey} missing from hub A`).toBe(true)
    }
    expect(memberDirectoryResponseSchema.safeParse(scoped.body).success).toBe(true)
    // Same confidentiality properties as the instance directory, on the hub-scoped response.
    const raw = JSON.stringify(scoped.body)
    expect(raw).not.toMatch(/role-[a-z-]+/)
    expect(raw).not.toContain(PHONE)
    for (const member of scoped.body.members as Record<string, unknown>[]) {
      for (const forbidden of ['roles', 'roleIds', 'hubRoles', 'hubs', 'phone']) {
        expect(Object.keys(member)).not.toContain(forbidden)
      }
    }

    // The unscoped route still refuses the same actor — the reason Android must not use it.
    const unscoped = await directory(HUB_A_ADMIN)
    expect(unscoped.status).toBe(403)
    expect(unscoped.body.members).toBeUndefined()
  })

  it('lets a hub admin read their own hub, confined to its members', async () => {
    const { status, body } = await directory(HUB_A_ADMIN, HUB_A)
    expect(status).toBe(200)
    const members = byPubkey(body)
    expect(members.has(HUB_A_ADMIN.pubkey)).toBe(true)
    expect(members.has(SPLIT_ROLE.pubkey)).toBe(true)
    expect(members.has(INACTIVE_VOLUNTEER.pubkey)).toBe(true)
    expect(members.has(HUB_B_VOLUNTEER.pubkey), 'a hub-B-only member leaked into hub A').toBe(false)
    expect(members.has(REVOKED)).toBe(false)
  })

  it('resolves role inside the hub: a hub-B admin is a volunteer in hub A', async () => {
    const inA = byPubkey((await directory(HUB_A_ADMIN, HUB_A)).body)
    expect(inA.get(SPLIT_ROLE.pubkey)).toMatchObject({ role: 'volunteer' })
    expect(inA.get(HUB_A_ADMIN.pubkey)).toMatchObject({ role: 'admin' })
    expect(
      inA.get(GLOBAL_ROLE_VOLUNTEER.pubkey),
      'a non-super-admin global role was counted inside the hub',
    ).toMatchObject({ role: 'volunteer' })

    const inB = byPubkey((await directory(SPLIT_ROLE, HUB_B)).body)
    expect(inB.get(SPLIT_ROLE.pubkey)).toMatchObject({ role: 'admin' })
    expect(inB.has(HUB_A_ADMIN.pubkey), 'a hub-A-only member leaked into hub B').toBe(false)
  })
})
