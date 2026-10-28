/**
 * Authority over invites is per hub (#2153, #1099), against real PostgreSQL,
 * Bun-native driver, through the real invites router.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/hub-invite-authority.test.ts
 *
 * `/api/invites` is mounted outside `/hubs/:hubId`, and it used to authorise with
 * the request's GLOBAL permissions. A hub admin's grant lives in `hubRoles` only
 * (adding a member no longer writes the account-wide `roles` column), so that
 * check would have locked every hub admin out of their own invites; and before
 * the grant moved, it gave every hub admin the invites of EVERY hub. What it
 * asserts now:
 *   - a hub-only admin can create, list and revoke the invites of their hub;
 *   - they cannot see, revoke or create an invite for another hub, and the
 *     refusal for another hub's invite is the 404 a missing one gets;
 *   - a member without invite permission in their hub can do none of it;
 *   - a super-admin keeps the instance view: every hub's invites;
 *   - redeeming an invite grants the hub role in `hubRoles` only.
 *
 * Only the signature check of the auth middleware is replaced (the test names
 * the caller in a header); the caller is then loaded from the database and the
 * request's permissions resolved from the GLOBAL roles, exactly as the real
 * middleware does.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres) with
 * migrations applied. Everything created here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs, inviteCodes, users } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { IdentityService } from '../../services/identity'
import { ServiceError, SettingsService } from '../../services/settings'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const svc = { identity, settings: new SettingsService(db), audit: new AuditService(db) }

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

mock.module('../../middleware/auth', () => ({
  auth: async (c: { req: { header(n: string): string | undefined }; set(k: string, v: unknown): void; json(b: unknown, s: number): Response }, next: () => Promise<void>) => {
    const user = await identity.getUserInternal(c.req.header('x-test-pubkey') ?? '')
    if (!user) return c.json({ error: 'Authentication failed' }, 401)
    c.set('pubkey', user.pubkey)
    c.set('user', user)
    c.set('allRoles', ALL_ROLES)
    c.set('permissions', resolvePermissions(user.roles, ALL_ROLES))
    await next()
  },
}))
const { default: invitesRoutes } = await import('../../routes/invites')

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-inv-a-${suffix}`
const HUB_B = `hub-inv-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')

const SUPER = hex('51')
const ADMIN_A = hex('a1')
const ADMIN_B = hex('b1')
const VOL_A = hex('a2')
const NEWCOMER = hex('f3')
const ALL_PUBKEYS = [SUPER, ADMIN_A, ADMIN_B, VOL_A, NEWCOMER]

function app() {
  const a = new Hono<AppEnv>()
  a.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409)
    throw err
  })
  a.use('*', async (c, next) => {
    c.set('services', svc as unknown as AppEnv['Variables']['services'])
    await next()
  })
  a.route('/api/invites', invitesRoutes)
  return a
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

async function call(as: string, method: string, path: string, body?: unknown) {
  const res = await app().request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-pubkey': as },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ENV)
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
  return { status: res.status, json }
}

async function mintInvite(hubId: string, roleIds: string[] = ['role-volunteer']): Promise<string> {
  const { invite } = await identity.createInvite({ name: 'seeded', phone: '', roleIds, hubId, createdBy: SUPER })
  return invite.code
}

const codesOf = (json: Record<string, unknown>) => (json.invites as Array<{ code: string }>).map(i => i.code)

let inviteB: string

beforeAll(async () => {
  await db.insert(users).values({ pubkey: SUPER, displayName: 'Super', phone: '', roles: ['role-super-admin'], encryptedSecretKey: '' })
  for (const id of [HUB_A, HUB_B]) await db.insert(hubs).values({ id, name: id, slug: id, createdBy: SUPER })
  for (const [hubId, pubkey, roleIds] of [
    [HUB_A, ADMIN_A, ['role-hub-admin']],
    [HUB_B, ADMIN_B, ['role-hub-admin']],
    [HUB_A, VOL_A, ['role-volunteer']],
  ] as const) {
    await identity.createUser({ pubkey, name: pubkey.slice(0, 4), phone: '+15550000000', roleIds: [...roleIds], encryptedSecretKey: '', hubId })
  }
  inviteB = await mintInvite(HUB_B)
})

afterAll(async () => {
  await db.delete(inviteCodes).where(inArray(inviteCodes.hubId, [HUB_A, HUB_B]))
  await db.delete(users).where(inArray(users.pubkey, ALL_PUBKEYS))
  await db.delete(hubs).where(inArray(hubs.id, [HUB_A, HUB_B]))
})

describe('a hub admin whose grant lives in hubRoles only', () => {
  it('holds no global role, so no global permission', async () => {
    expect((await identity.getUserInternal(ADMIN_A))!.roles).toEqual([])
  })

  it('creates an invite for their hub — the hub is named, the invite is stamped with it', async () => {
    const res = await call(ADMIN_A, 'POST', '/api/invites', { name: 'Newcomer', phone: '', roleIds: ['role-volunteer'], hubId: HUB_A })
    expect(res.status).toBe(201)
    expect((res.json.invite as { hubId: string }).hubId).toBe(HUB_A)
  })

  it('lists their hub\'s invites and not another hub\'s', async () => {
    const mine = await mintInvite(HUB_A)
    const res = await call(ADMIN_A, 'GET', '/api/invites')
    expect(res.status).toBe(200)
    expect(codesOf(res.json)).toContain(mine)
    expect(codesOf(res.json), 'a hub A admin listed hub B\'s invite').not.toContain(inviteB)
  })

  it('revokes an invite of their hub', async () => {
    const mine = await mintInvite(HUB_A)
    expect((await call(ADMIN_A, 'DELETE', `/api/invites/${mine}`)).status).toBe(200)
    expect((await identity.validateInvite(mine)).valid).toBe(false)
  })

  it('cannot create an invite for another hub', async () => {
    const res = await call(ADMIN_A, 'POST', '/api/invites', { name: 'Intruder', phone: '', roleIds: ['role-volunteer'], hubId: HUB_B })
    expect(res.status).toBe(403)
    expect((await identity.getInvites(HUB_B)).invites.map(i => i.code)).toEqual([inviteB])
  })

  it('cannot revoke another hub\'s invite — a 404, the same as a missing one', async () => {
    const cross = await call(ADMIN_A, 'DELETE', `/api/invites/${inviteB}`)
    const missing = await call(ADMIN_A, 'DELETE', '/api/invites/does-not-exist')
    expect(cross.status).toBe(404)
    expect(cross.json).toEqual(missing.json)
    expect((await identity.validateInvite(inviteB)).valid).toBe(true)
  })

  it('cannot invite with a role broader than their own', async () => {
    const res = await call(ADMIN_A, 'POST', '/api/invites', { name: 'Escalate', phone: '', roleIds: ['role-super-admin'], hubId: HUB_A })
    expect(res.status).toBe(403)
  })
})

describe('a member without invite permission in their hub', () => {
  it('cannot create, list or revoke', async () => {
    expect((await call(VOL_A, 'POST', '/api/invites', { name: 'x', phone: '', roleIds: [], hubId: HUB_A })).status).toBe(403)
    expect((await call(VOL_A, 'GET', '/api/invites')).status).toBe(403)
    const mine = await mintInvite(HUB_A)
    expect((await call(VOL_A, 'DELETE', `/api/invites/${mine}`)).status).toBe(403)
    expect((await identity.validateInvite(mine)).valid).toBe(true)
  })
})

describe('the super-admin keeps the instance view', () => {
  it('lists every hub\'s invites and revokes any', async () => {
    const res = await call(SUPER, 'GET', '/api/invites')
    expect(res.status).toBe(200)
    expect(codesOf(res.json)).toContain(inviteB)
    const extra = await mintInvite(HUB_A)
    expect((await call(SUPER, 'DELETE', `/api/invites/${extra}`)).status).toBe(200)
  })
})

describe('redeeming an invite grants the hub role in hubRoles only', () => {
  it('creates a member of the hub with no global role', async () => {
    const code = await mintInvite(HUB_A, ['role-hub-admin'])
    const { volunteer } = await identity.redeemInvite({ code, pubkey: NEWCOMER })
    expect(volunteer.roles).toEqual([])
    expect(volunteer.hubRoles).toEqual([{ hubId: HUB_A, roleIds: ['role-hub-admin'] }])

    const [row] = await db.select().from(users).where(eq(users.pubkey, NEWCOMER))
    expect(row.roles).toEqual([])
  })
})
