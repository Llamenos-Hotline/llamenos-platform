/**
 * `GET /api/hubs/:hubId/directory/envelope-recipients` — who a contact write is
 * sealed to (#2741) — against real PostgreSQL, Bun-native driver, through the
 * real contacts router behind the real `hubContext`.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is `bun-jsonb`):
 *   bun test apps/worker/__tests__/integration-bun/contact-readers.test.ts
 *
 * "The contact was saved" passes with every reader missing, so this asserts the
 * ANSWER: the entitled member's device key IS in the tier they are entitled to,
 * a member without `contacts:view-pii` is NOT in the `pii` tier, and an admin is
 * in every tier. Then it closes the loop with real HPKE: a contact sealed to the
 * answer opens with the entitled member's device secret, and does not open with
 * the secret of a member the answer left out.
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts ensure --opt-in`) and the Rust crypto library.
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
import { hubContext } from '../../middleware/hub'
import contactsRoutes from '../../routes/contacts-v2'
import { hpkeRecipientPubkey } from '../../lib/hpke-recipient'
import { HUB_ESCROW_MANAGE_PERMISSIONS } from '../../lib/readers'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'
import { contactEnvelopeRecipientsResponseSchema } from '@protocol/schemas/contacts-v2'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { caseOpen, caseSeal } from '@llamenos/crypto/ffi'

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
const hexKey = (lead: string) => `${lead}${rand}${(counter++).toString(16).padStart(6, '0')}`.padEnd(64, '0')

const createdUsers: string[] = []
const createdHubs: string[] = []
const createdRoles: string[] = []

interface Person { pubkey: string; deviceKey: string; hubRoles: { hubId: string; roleIds: string[] }[] }

async function makePerson(
  label: string,
  hubRoles: { hubId: string; roleIds: string[] }[] = [],
  opts: { device?: string | false; roles?: string[] } = {},
): Promise<Person> {
  const pubkey = hexKey('a0')
  await db.insert(users).values({ pubkey, displayName: label, hubRoles, roles: opts.roles ?? [] })
  createdUsers.push(pubkey)
  const deviceKey = opts.device === false ? '' : (opts.device ?? hexKey('d0'))
  if (deviceKey) await db.insert(devices).values({ pubkey, platform: 'desktop', x25519Pubkey: deviceKey })
  return { pubkey, deviceKey, hubRoles }
}

async function makeHub(label: string, founder: Person): Promise<string> {
  const id = nextId(`hub-${label}`)
  await settings.createHub(
    {
      id, name: label, slug: id, status: 'active', timezone: 'UTC', createdBy: founder.pubkey,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    { pubkey: founder.pubkey, roleIds: ['role-hub-admin'] },
  )
  createdHubs.push(id)
  founder.hubRoles.push({ hubId: id, roleIds: ['role-hub-admin'] })
  return id
}

async function makeRole(permissions: string[]): Promise<string> {
  const id = nextId('role-custom')
  await db.insert(roles).values({ id, slug: id, permissions, isDefault: false, isSystem: false, description: '' })
  createdRoles.push(id)
  return id
}

afterAll(async () => {
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  await db.delete(users).where(inArray(users.pubkey, createdUsers))
  if (createdRoles.length > 0) await db.delete(roles).where(inArray(roles.id, createdRoles))
})

const catalog = async (): Promise<Role[]> => {
  const custom = await db.select().from(roles)
  const known = new Set(custom.map(r => r.id))
  const all = [
    ...DEFAULT_ROLES.filter(r => !known.has(r.id)).map(r => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
    ...custom.map(r => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
  ]
  return all as unknown as Role[]
}

async function appAs(actor: Person, globalRoles: string[] = []) {
  const allRoles = await catalog()
  const app = new Hono<AppEnv>()
  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409)
    throw err
  })
  app.use('*', async (c, next) => {
    c.set('pubkey', actor.pubkey)
    c.set('user', { pubkey: actor.pubkey, active: true, roles: globalRoles, hubRoles: actor.hubRoles } as unknown as AppEnv['Variables']['user'])
    c.set('allRoles', allRoles)
    c.set('permissions', resolvePermissions(globalRoles, allRoles))
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/directory', contactsRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  // The unscoped mount of the same router, exactly as app.ts has it.
  app.route('/api/directory', contactsRoutes)
  return app
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

async function recipients(actor: Person, hubId: string, globalRoles: string[] = []) {
  const res = await (await appAs(actor, globalRoles)).request(`/api/hubs/${hubId}/directory/envelope-recipients`, {}, ENV)
  const json = await res.json() as unknown
  return { status: res.status, json }
}

async function readers(actor: Person, hubId: string) {
  const { status, json } = await recipients(actor, hubId)
  expect(status).toBe(200)
  return contactEnvelopeRecipientsResponseSchema.parse(json)
}

describe('GET /directory/envelope-recipients: who is a reader of which tier', () => {
  it('names the entitled member\'s device key in the tier they are entitled to, and nobody else\'s', async () => {
    const founder = await makePerson('cr-founder')
    const hubId = await makeHub('cr-tiers', founder)
    const viewerRole = await makeRole(['contacts:view'])
    const piiRole = await makeRole(['contacts:view-pii'])
    const searchRole = await makeRole(['contacts:search'])
    const viewer = await makePerson('cr-viewer', [{ hubId, roleIds: [viewerRole] }])
    const piiHolder = await makePerson('cr-pii', [{ hubId, roleIds: [piiRole] }])
    const searcher = await makePerson('cr-searcher', [{ hubId, roleIds: [searchRole] }])
    const bystander = await makePerson('cr-bystander', [{ hubId, roleIds: ['role-volunteer'] }])

    const r = await readers(founder, hubId)

    // The admin is in EVERY tier.
    for (const tier of [r.summary, r.pii, r.admin]) expect(tier).toContain(founder.deviceKey)

    // contacts:view reads the summary and not the PII.
    expect(r.summary).toContain(viewer.deviceKey)
    expect(r.pii).not.toContain(viewer.deviceKey)
    expect(r.admin).not.toContain(viewer.deviceKey)

    // contacts:view-pii reads the PII, and the summary that labels it.
    expect(r.pii).toContain(piiHolder.deviceKey)
    expect(r.summary).toContain(piiHolder.deviceKey)
    expect(r.admin).not.toContain(piiHolder.deviceKey)

    // Finding a contact is not reading it; a volunteer holds neither permission.
    for (const tier of [r.summary, r.pii, r.admin]) {
      expect(tier).not.toContain(searcher.deviceKey)
      expect(tier).not.toContain(bystander.deviceKey)
    }

    // Never an Ed25519 identity key: every entry is some registered device's key.
    for (const person of [founder, viewer, piiHolder]) {
      for (const tier of [r.summary, r.pii, r.admin]) expect(tier).not.toContain(person.pubkey)
    }
    // pii is a subset of summary, which is a subset of... admin is a subset of pii.
    expect(r.pii.every(k => r.summary.includes(k))).toBe(true)
    expect(r.admin.every(k => r.pii.includes(k))).toBe(true)
  })

  it('is decided by permission, not role: a custom role granting contacts:* is a reader of both tiers', async () => {
    const founder = await makePerson('cr-wild-founder')
    const hubId = await makeHub('cr-wild', founder)
    const wild = await makeRole(['contacts:*'])
    const member = await makePerson('cr-wild', [{ hubId, roleIds: [wild] }])
    const r = await readers(founder, hubId)
    expect(r.summary).toContain(member.deviceKey)
    expect(r.pii).toContain(member.deviceKey)
    expect(r.admin).not.toContain(member.deviceKey)
  })

  it('holds a permission only in the hub it is held in', async () => {
    const founderA = await makePerson('cr-a')
    const hubA = await makeHub('cr-a', founderA)
    const founderB = await makePerson('cr-b')
    const hubB = await makeHub('cr-b', founderB)
    const a = await readers(founderA, hubA)
    expect(a.summary).not.toContain(founderB.deviceKey)
    expect(a.pii).not.toContain(founderB.deviceKey)
    expect(a.admin).not.toContain(founderB.deviceKey)
    expect((await readers(founderB, hubB)).admin).not.toContain(founderA.deviceKey)
  })

  it('a global super-admin is in no tier of a hub it holds no role in (D1)', async () => {
    const founder = await makePerson('cr-sa-founder')
    const hubId = await makeHub('cr-sa', founder)
    const superAdmin = await makePerson('cr-sa', [], { roles: ['role-super-admin'] })
    const r = await readers(founder, hubId)
    for (const tier of [r.summary, r.pii, r.admin]) expect(tier).not.toContain(superAdmin.deviceKey)
  })

  it('excludes a deactivated holder and a holder with no device', async () => {
    const founder = await makePerson('cr-ex-founder')
    const hubId = await makeHub('cr-ex', founder)
    const piiRole = await makeRole(['contacts:view-pii'])
    const gone = await makePerson('cr-gone', [{ hubId, roleIds: [piiRole] }])
    await db.update(users).set({ active: false }).where(inArray(users.pubkey, [gone.pubkey]))
    const deviceless = await makePerson('cr-nodev', [{ hubId, roleIds: [piiRole] }], { device: false })
    const r = await readers(founder, hubId)
    expect(r.pii).not.toContain(gone.deviceKey)
    // No device, nothing to seal to: the member simply is not in the answer.
    expect(r.pii.length).toBe(1)
    expect(deviceless.deviceKey).toBe('')
  })

  it('includes the hub escrow key in every tier', async () => {
    const founder = await makePerson('cr-esc-founder')
    const hubId = await makeHub('cr-esc', founder)
    const escrow = hpkeRecipientPubkey(hexKey('ec'))
    if (!escrow) throw new Error('fixture key is not a valid recipient key')
    await identity.setHubEscrowKey(hubId, escrow, undefined)
    const r = await readers(founder, hubId)
    for (const tier of [r.summary, r.pii, r.admin]) expect(tier).toContain(escrow)
  })

  it('refuses to name a set with no admin in it (503) rather than answering with the members alone', async () => {
    const founder = await makePerson('cr-none-founder', [], { device: false })
    const hubId = await makeHub('cr-none', founder)
    const writerRole = await makeRole(['contacts:create', 'contacts:view-pii'])
    const holder = await makePerson('cr-none-writer', [{ hubId, roleIds: [writerRole] }])
    // The founder administers the hub but has no device and there is no escrow key.
    const { status, json } = await recipients(holder, hubId)
    expect(status).toBe(503)
    expect(json).not.toHaveProperty('pii')
  })

  it('the escrow key is a reader of contacts, so setting it needs the contact permissions too', () => {
    expect(HUB_ESCROW_MANAGE_PERMISSIONS).toEqual(expect.arrayContaining(['contacts:view', 'contacts:view-pii']))
  })
})

describe('who may ask, and from where', () => {
  it('a hub-only member (no global role) is answered on the hub mount, and refused on the bare path', async () => {
    const founder = await makePerson('ask-founder')
    const hubId = await makeHub('ask', founder)
    const creatorRole = await makeRole(['contacts:create'])
    const creator = await makePerson('ask-creator', [{ hubId, roleIds: [creatorRole] }])
    const app = await appAs(creator)

    const inHub = await app.request(`/api/hubs/${hubId}/directory/envelope-recipients`, {}, ENV)
    expect(inHub.status).toBe(200)
    expect(contactEnvelopeRecipientsResponseSchema.parse(await inHub.json()).admin).toContain(founder.deviceKey)

    // Bare path: the member holds no global role, and a hubless call has no hub to answer for.
    const bare = await app.request('/api/directory/envelope-recipients', {}, ENV)
    expect([403, 404]).toContain(bare.status)
  })

  it('a global super-admin gets nothing from the bare path either: there is no hubless answer', async () => {
    const founder = await makePerson('ask-sa-founder')
    await makeHub('ask-sa', founder)
    const superAdmin = await makePerson('ask-sa', [], { roles: ['role-super-admin'] })
    const bare = await (await appAs(superAdmin, ['role-super-admin'])).request('/api/directory/envelope-recipients', {}, ENV)
    expect(bare.status).toBe(404)
  })

  it('a member with no contact permission is refused (403), and a non-member never reaches it', async () => {
    const founder = await makePerson('ask-403-founder')
    const hubId = await makeHub('ask-403', founder)
    const outsider = await makePerson('ask-outsider', [{ hubId, roleIds: ['role-volunteer'] }])
    expect((await recipients(outsider, hubId)).status).toBe(403)

    const otherFounder = await makePerson('ask-other')
    const otherHub = await makeHub('ask-other', otherFounder)
    expect((await recipients(otherFounder, hubId)).status).toBeGreaterThanOrEqual(403)
    expect((await recipients(founder, otherHub)).status).toBeGreaterThanOrEqual(403)
  })

  it('is not read as a contact id: no :id route answers the literal segment', async () => {
    const founder = await makePerson('ask-lit-founder')
    const hubId = await makeHub('ask-lit', founder)
    const { status, json } = await recipients(founder, hubId)
    expect(status).toBe(200)
    expect(json).not.toHaveProperty('error')
  })
})

/** An X25519 keypair held by a client — the server never sees `secret`. */
function keypair() {
  const secret = x25519.utils.randomSecretKey()
  return { secret, publicKey: bytesToHex(x25519.getPublicKey(secret)) }
}

describe('sealed to the answer, a contact opens for the entitled member and for nobody the answer left out', () => {
  it('the entitled member decrypts what was stored; a member without contacts:view-pii cannot open the pii tier', async () => {
    const founder = await makePerson('seal-founder', [], { device: false })
    const hubId = await makeHub('seal', founder)
    const viewerRole = await makeRole(['contacts:view'])
    const piiRole = await makeRole(['contacts:view-pii'])
    const admin = keypair()
    const viewer = keypair()
    const piiHolder = keypair()
    await db.insert(devices).values({ pubkey: founder.pubkey, platform: 'desktop', x25519Pubkey: admin.publicKey })
    await makePerson('seal-viewer', [{ hubId, roleIds: [viewerRole] }], { device: viewer.publicKey })
    await makePerson('seal-pii', [{ hubId, roleIds: [piiRole] }], { device: piiHolder.publicKey })

    const r = await readers(founder, hubId)
    expect(r.summary).toEqual(expect.arrayContaining([viewer.publicKey, piiHolder.publicKey, admin.publicKey]))
    expect(r.pii).toEqual(expect.arrayContaining([piiHolder.publicKey, admin.publicKey]))
    expect(r.pii).not.toContain(viewer.publicKey)

    // A client seals each tier to exactly what the server named. Real HPKE.
    const pii = caseSeal('fields', JSON.stringify({ legalName: 'Reader Test' }), r.pii)
    const summary = caseSeal('summary', JSON.stringify({ displayName: 'R. T.' }), r.summary)

    // The entitled member opens what was stored.
    expect(JSON.parse(caseOpen('fields', piiHolder.secret, pii))).toEqual({ legalName: 'Reader Test' })
    expect(JSON.parse(caseOpen('fields', admin.secret, pii))).toEqual({ legalName: 'Reader Test' })
    expect(JSON.parse(caseOpen('summary', viewer.secret, summary))).toEqual({ displayName: 'R. T.' })

    // The member the answer left out of the pii tier cannot open it: no envelope is addressed to them.
    expect(pii.readerEnvelopes.map(e => e.pubkey)).not.toContain(viewer.publicKey)
    expect(() => caseOpen('fields', viewer.secret, pii)).toThrow()
  })
})
