/**
 * Hub reader sets (PROTOCOL §2.4.2; operator decisions D1, D2, A7, A8) — real
 * PostgreSQL, Bun-native driver, the real hubs router behind the real
 * hubContext.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is a `bun-jsonb`
 * column; see hub-last-admin.test.ts):
 *   bun test apps/worker/__tests__/integration-bun/hub-reader-sets.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts ensure --opt-in`) and the Rust crypto library.
 *
 * What this pins:
 *  - `readersFor(hub, purpose)` is decided by the permissions a member's roles
 *    grant IN THAT HUB — never a role id, never the global roles, so a global
 *    super-admin is in no hub's set unless it holds a role there (D1).
 *  - The instance-wide ADMIN_DECRYPTION_PUBKEY is in NO reader set; the write
 *    guard accepts it only as the transitional recipient (D1).
 *  - The hub escrow key is in every purpose's set (A7), and only someone who
 *    already reads every purpose, in the hub's own roles, may set it.
 *  - Removing the escrow key may not empty the hub's admin reader set (A8).
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { devices, hubs, roles, users } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { IdentityService } from '../../services/identity'
import { ServiceError, SettingsService } from '../../services/settings'
import { assertAdminCanRead } from '../../lib/admin-envelopes'
import { hpkeRecipientPubkey, type HpkeRecipientPubkey } from '../../lib/hpke-recipient'
import { assertMayManageHubEscrow, HUB_ESCROW_MANAGE_PERMISSIONS } from '../../lib/readers'
import hubsRoutes from '../../routes/hubs'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, READER_PURPOSE_PERMISSIONS, resolvePermissions, type Role } from '@shared/permissions'
import { hubReadersResponseSchema } from '@protocol/schemas/hubs'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const settings = new SettingsService(db)
const audit = new AuditService(db)
const services = { identity, settings, audit }

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
let counter = 0
const nextId = (label: string) => `${label}-${suite}-${counter++}`
/** A schema-valid 64-char lowercase hex key, unique to this run. */
const hexKey = (lead: string) => `${lead}${rand}${(counter++).toString(16).padStart(6, '0')}`.padEnd(64, '0')
const x25519 = (lead: string): HpkeRecipientPubkey => hpkeRecipientPubkey(hexKey(lead))!

/** The instance-wide key every shipped client still seals to. In no reader set. */
const INSTANCE_KEY = x25519('e1')

const createdUsers: string[] = []
const createdHubs: string[] = []
const createdRoles: string[] = []

interface Person { pubkey: string; deviceKey: string }

async function makePerson(label: string, extra: Partial<typeof users.$inferInsert> = {}, withDevice = true): Promise<Person> {
  const pubkey = hexKey('a0')
  await db.insert(users).values({ pubkey, displayName: label, ...extra })
  createdUsers.push(pubkey)
  const deviceKey = hexKey('d0')
  if (withDevice) await db.insert(devices).values({ pubkey, platform: 'desktop', x25519Pubkey: deviceKey })
  return { pubkey, deviceKey }
}

async function makeHub(label: string, founder: Person): Promise<string> {
  const id = nextId(`hub-${label}`)
  await settings.createHub(
    {
      id, name: label, slug: id, status: 'active', createdBy: founder.pubkey,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    { pubkey: founder.pubkey, roleIds: ['role-hub-admin'] },
  )
  createdHubs.push(id)
  return id
}

async function makeRole(permissions: string[]): Promise<string> {
  const id = nextId('role-custom')
  await db.insert(roles).values({ id, slug: id, permissions, isDefault: false, isSystem: false, description: '' })
  createdRoles.push(id)
  return id
}

async function refusal(fn: () => Promise<unknown> | unknown): Promise<ServiceError> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError)
    return err as ServiceError
  }
  throw new Error('expected a refusal, but the call succeeded')
}

const sealedTo = (...keys: string[]) => keys.map(pubkey => ({ pubkey, enc: 'b'.repeat(64), ct: 'c'.repeat(32) }))

afterAll(async () => {
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  await db.delete(users).where(inArray(users.pubkey, createdUsers))
  if (createdRoles.length > 0) await db.delete(roles).where(inArray(roles.id, createdRoles))
})

describe('readersFor: who is in a purpose\'s reader set', () => {
  it('admin = every device of every hub admin, and nobody else', async () => {
    const founder = await makePerson('rs-founder')
    const hubId = await makeHub('rs-admin', founder)
    const second = await makePerson('rs-second', { hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] })
    const secondLaptop = hexKey('d1')
    await db.insert(devices).values({ pubkey: second.pubkey, platform: 'desktop', x25519Pubkey: secondLaptop })
    const volunteer = await makePerson('rs-vol', { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })

    const readers = await identity.readersFor(hubId, 'admin')
    expect(new Set(readers)).toEqual(new Set([founder.deviceKey, second.deviceKey, secondLaptop]))
    expect(readers).not.toContain(volunteer.deviceKey)
    // Never an Ed25519 identity key.
    expect(readers).not.toContain(founder.pubkey)
  })

  it('a global super-admin is in NO hub\'s set unless it holds a role in that hub (D1)', async () => {
    const founder = await makePerson('rs-sa-founder')
    const hubId = await makeHub('rs-sa', founder)
    const superAdmin = await makePerson('rs-sa', { roles: ['role-super-admin'] })

    for (const purpose of ['admin', 'call-history'] as const) {
      expect(await identity.readersFor(hubId, purpose)).not.toContain(superAdmin.deviceKey)
    }

    await identity.setHubRole({ pubkey: superAdmin.pubkey, hubId, roleIds: ['role-hub-admin'] })
    expect(await identity.readersFor(hubId, 'admin')).toContain(superAdmin.deviceKey)
  })

  it('is decided by permission, not role: a custom role is a call-history reader without being an admin (D2)', async () => {
    const founder = await makePerson('rs-ch-founder')
    const hubId = await makeHub('rs-ch', founder)
    const historyOnly = await makeRole([...READER_PURPOSE_PERMISSIONS['call-history']])
    const analyst = await makePerson('rs-analyst', { hubRoles: [{ hubId, roleIds: [historyOnly] }] })
    const customAdminRole = await makeRole([...READER_PURPOSE_PERMISSIONS.admin])
    const customAdmin = await makePerson('rs-custom-admin', { hubRoles: [{ hubId, roleIds: [customAdminRole] }] })

    const history = await identity.readersFor(hubId, 'call-history')
    expect(history).toContain(analyst.deviceKey)
    expect(history).toContain(founder.deviceKey) // role-hub-admin grants calls:*
    expect(history).not.toContain(customAdmin.deviceKey) // the admin minimum carries no calls:read-history

    const admins = await identity.readersFor(hubId, 'admin')
    expect(admins).toContain(customAdmin.deviceKey)
    expect(admins).not.toContain(analyst.deviceKey)
  })

  it('holds a role only for the hub it is held in', async () => {
    const founderA = await makePerson('rs-a')
    const hubA = await makeHub('rs-a', founderA)
    const founderB = await makePerson('rs-b')
    const hubB = await makeHub('rs-b', founderB)
    expect(await identity.readersFor(hubA, 'admin')).not.toContain(founderB.deviceKey)
    expect(await identity.readersFor(hubB, 'admin')).not.toContain(founderA.deviceKey)
  })

  it('excludes a deactivated admin', async () => {
    const founder = await makePerson('rs-deact-founder')
    const hubId = await makeHub('rs-deact', founder)
    const gone = await makePerson('rs-gone', { active: false, hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] })
    expect(await identity.readersFor(hubId, 'admin')).not.toContain(gone.deviceKey)
  })

  it('never contains the instance-wide ADMIN_DECRYPTION_PUBKEY, but the guard still accepts it transitionally', async () => {
    const founder = await makePerson('rs-inst')
    const hubId = await makeHub('rs-inst', founder)

    for (const purpose of ['admin', 'call-history'] as const) {
      expect(await identity.readersFor(hubId, purpose)).not.toContain(INSTANCE_KEY)
    }
    // Shipped clients seal to it and nothing else; refusing it would refuse every note.
    await assertAdminCanRead(services, { ADMIN_DECRYPTION_PUBKEY: INSTANCE_KEY }, hubId, sealedTo(INSTANCE_KEY), 'A note')
    expect(await identity.listAdminEnvelopeRecipients(INSTANCE_KEY, hubId)).toContain(INSTANCE_KEY)
  })
})

describe('the hub escrow key (D1, A7)', () => {
  it('is a member of every purpose\'s set, and an escrow-only note is accepted', async () => {
    const founder = await makePerson('esc-founder')
    const hubId = await makeHub('esc', founder)
    const escrow = x25519('ec')
    await identity.setHubEscrowKey(hubId, escrow, INSTANCE_KEY)

    expect(await identity.getHubEscrowKey(hubId)).toBe(escrow)
    for (const purpose of ['admin', 'call-history'] as const) {
      expect(await identity.readersFor(hubId, purpose)).toContain(escrow)
    }
    // No transitional key configured at all: the hub's own set suffices.
    await assertAdminCanRead(services, {}, hubId, sealedTo(escrow), 'A note')
  })

  it('a hub with no admin device but an escrow key accepts writes instead of 503ing', async () => {
    const founder = await makePerson('esc-nodev', {}, false)
    const hubId = await makeHub('esc-nodev', founder)
    expect(await identity.readersFor(hubId, 'admin')).toEqual([])
    const before = await refusal(() => assertAdminCanRead(services, {}, hubId, sealedTo(hexKey('aa')), 'A note'))
    expect(before.status).toBe(503)

    const escrow = x25519('ed')
    await identity.setHubEscrowKey(hubId, escrow, undefined)
    await assertAdminCanRead(services, {}, hubId, sealedTo(escrow), 'A note')
  })

  it('rotates: the new key replaces the old one in the set', async () => {
    const founder = await makePerson('esc-rot')
    const hubId = await makeHub('esc-rot', founder)
    const first = x25519('f1')
    const second = x25519('f2')
    await identity.setHubEscrowKey(hubId, first, undefined)
    await identity.setHubEscrowKey(hubId, second, undefined)
    const readers = await identity.readersFor(hubId, 'admin')
    expect(readers).toContain(second)
    expect(readers).not.toContain(first)
  })

  it('refuses (409) a registered device key and the instance key', async () => {
    const founder = await makePerson('esc-bad')
    const hubId = await makeHub('esc-bad', founder)
    const deviceKey = hpkeRecipientPubkey(founder.deviceKey)!
    expect((await refusal(() => identity.setHubEscrowKey(hubId, deviceKey, INSTANCE_KEY))).status).toBe(409)
    expect((await refusal(() => identity.setHubEscrowKey(hubId, INSTANCE_KEY, INSTANCE_KEY))).status).toBe(409)
    expect(await identity.getHubEscrowKey(hubId)).toBeUndefined()
  })

  it('may not be removed when it is the hub\'s only admin reader (A8); may be once an admin has a device', async () => {
    const founder = await makePerson('esc-only', {}, false)
    const hubId = await makeHub('esc-only', founder)
    const escrow = x25519('ee')
    await identity.setHubEscrowKey(hubId, escrow, undefined)

    expect((await refusal(() => identity.clearHubEscrowKey(hubId))).status).toBe(409)
    expect(await identity.getHubEscrowKey(hubId)).toBe(escrow)

    await db.insert(devices).values({ pubkey: founder.pubkey, platform: 'desktop', x25519Pubkey: hexKey('d2') })
    await identity.clearHubEscrowKey(hubId)
    expect(await identity.getHubEscrowKey(hubId)).toBeUndefined()
  })

  describe('who may manage it', () => {
    const catalog = () => db.select({ id: roles.id, permissions: roles.permissions }).from(roles)

    it('a hub admin of THAT hub may', async () => {
      const founder = await makePerson('esc-who')
      const hubId = await makeHub('esc-who', founder)
      assertMayManageHubEscrow({ active: true, hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] }, hubId, await catalog())
    })

    it('a global super-admin with no role in the hub may NOT (D1)', async () => {
      const founder = await makePerson('esc-sa')
      const hubId = await makeHub('esc-sa', founder)
      const roleCatalog = await catalog()
      const err = await refusal(() => assertMayManageHubEscrow({ active: true, hubRoles: [] }, hubId, roleCatalog))
      expect(err.status).toBe(403)
    })

    it('a custom role with only hubs:manage-keys may NOT: it would confer read access it does not hold', async () => {
      const founder = await makePerson('esc-keys')
      const hubId = await makeHub('esc-keys', founder)
      const keysOnly = await makeRole(['hubs:manage-keys'])
      const roleCatalog = await catalog()
      const err = await refusal(() => assertMayManageHubEscrow({ active: true, hubRoles: [{ hubId, roleIds: [keysOnly] }] }, hubId, roleCatalog))
      expect(err.status).toBe(403)
      expect(HUB_ESCROW_MANAGE_PERMISSIONS).toEqual(expect.arrayContaining([
        'hubs:manage-keys', ...READER_PURPOSE_PERMISSIONS.admin, ...READER_PURPOSE_PERMISSIONS['call-history'],
      ]))
    })

    it('an admin of ANOTHER hub may NOT', async () => {
      const founderA = await makePerson('esc-other-a')
      const hubA = await makeHub('esc-other-a', founderA)
      const founderB = await makePerson('esc-other-b')
      const hubB = await makeHub('esc-other-b', founderB)
      const roleCatalog = await catalog()
      const err = await refusal(() => assertMayManageHubEscrow({ active: true, hubRoles: [{ hubId: hubA, roleIds: ['role-hub-admin'] }] }, hubB, roleCatalog))
      expect(err.status).toBe(403)
    })
  })
})

describe('the routes, end to end', () => {
  const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }))

  function appAs(pubkey: string, user: { roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('pubkey', pubkey)
      c.set('user', { pubkey, active: true, ...user } as unknown as AppEnv['Variables']['user'])
      c.set('allRoles', ALL_ROLES)
      c.set('permissions', resolvePermissions(user.roles, ALL_ROLES))
      c.set('services', services as unknown as AppEnv['Variables']['services'])
      await next()
    })
    app.route('/api/hubs', hubsRoutes)
    return app
  }
  const env = { ENVIRONMENT: 'test', ADMIN_DECRYPTION_PUBKEY: INSTANCE_KEY }

  it('GET /readers returns the set to any member, and 400s an unknown purpose', async () => {
    const founder = await makePerson('rt-founder')
    const hubId = await makeHub('rt', founder)
    const vol = await makePerson('rt-vol', { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })
    const app = appAs(vol.pubkey, { roles: [], hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })

    const res = await app.request(`/api/hubs/${hubId}/readers?purpose=admin`, {}, env)
    expect(res.status).toBe(200)
    const body = hubReadersResponseSchema.parse(await res.json())
    expect(body).toEqual({ hubId, purpose: 'admin', recipients: [founder.deviceKey] })

    expect((await app.request(`/api/hubs/${hubId}/readers?purpose=notes:read-all`, {}, env)).status).toBe(400)
  })

  it('GET /readers is 403 for a non-member', async () => {
    const founder = await makePerson('rt-nm-founder')
    const hubId = await makeHub('rt-nm', founder)
    const outsider = await makePerson('rt-outsider')
    const app = appAs(outsider.pubkey, { roles: [], hubRoles: [] })
    expect((await app.request(`/api/hubs/${hubId}/readers?purpose=admin`, {}, env)).status).toBe(403)
  })

  it('PUT /escrow-key: the hub admin sets it; a super-admin without a hub role is refused', async () => {
    const founder = await makePerson('rt-esc-founder')
    const hubId = await makeHub('rt-esc', founder)
    const superAdmin = await makePerson('rt-esc-sa', { roles: ['role-super-admin'] })
    const escrow = x25519('ef')
    const put = (app: Hono<AppEnv>, key: string) => app.request(`/api/hubs/${hubId}/escrow-key`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ escrowPubkey: key }),
    }, env)

    const saRes = await put(appAs(superAdmin.pubkey, { roles: ['role-super-admin'], hubRoles: [] }), escrow)
    expect(saRes.status).toBe(403)
    expect(await identity.getHubEscrowKey(hubId)).toBeUndefined()

    const adminApp = appAs(founder.pubkey, { roles: [], hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] })
    expect((await put(adminApp, INSTANCE_KEY)).status).toBe(409)
    expect((await put(adminApp, escrow)).status).toBe(200)

    const got = await adminApp.request(`/api/hubs/${hubId}/escrow-key`, {}, env)
    expect(await got.json()).toEqual({ escrowPubkey: escrow })
    const readers = await adminApp.request(`/api/hubs/${hubId}/readers?purpose=call-history`, {}, env)
    expect(((await readers.json()) as { recipients: string[] }).recipients).toContain(escrow)

    expect((await adminApp.request(`/api/hubs/${hubId}/escrow-key`, { method: 'DELETE' }, env)).status).toBe(200)
    expect(await identity.getHubEscrowKey(hubId)).toBeUndefined()
  })
})
