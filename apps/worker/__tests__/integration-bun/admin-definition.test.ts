/**
 * One definition of "admin" (#2190) — real PostgreSQL, Bun-native driver, the
 * real notes router behind the real hubContext.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is a `bun-jsonb`
 * column; see hub-last-admin.test.ts):
 *   bun test apps/worker/__tests__/integration-bun/admin-definition.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`) and the Rust crypto library
 * (LLAMENOS_CRYPTO_LIB).
 *
 * The defect this pins: the hub last-admin invariant (#2126) counted HUB admins
 * and excluded super-admins, while the envelope guard on POST /notes (#2125)
 * accepted super-admin devices and ignored hub admins. A note could satisfy the
 * guard with a reader the invariant did not count, or the reverse. Both now ask
 * `administersHub` in lib/hub-admin.ts, so the tests below hold ONE fact —
 * "who is an admin of this hub" — up against both enforcement points and
 * require that they agree, including for the users the invariant must NOT count.
 *
 * Super-admins are zero-knowledge and NEVER readers (operator decision D1): the
 * definition does not consult `users.roles`, so a super-admin is neither counted
 * nor sealed to for any hub in which it holds no admin role of its own.
 *
 * Fixtures: every user, device and hub carries a per-run suffix and is removed on
 * teardown.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { conversations, devices, erasureRequests, hubs, notes, users } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { CallsService } from '../../services/calls'
import { ConversationsService } from '../../services/conversations'
import { IdentityService } from '../../services/identity'
import { RecordsService } from '../../services/records'
import { ServiceError, SettingsService } from '../../services/settings'
import { assertAdminCanRead } from '../../lib/admin-envelopes'
import { revokedSigningKeys } from '../../lib/revoked-signing-keys'
import { hubContext } from '../../middleware/hub'
import notesRoutes from '../../routes/notes'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const settings = new SettingsService(db)
const audit = new AuditService(db)
const services = {
  identity,
  settings,
  audit,
  records: new RecordsService(db, audit),
  conversations: new ConversationsService(db),
  calls: new CallsService(db),
}

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
let counter = 0
const nextId = (label: string) => `${label}-${suite}-${counter++}`
/** A schema-valid 64-char lowercase hex key, unique to this run. */
const hexKey = (lead: string) => `${lead}${rand}${(counter++).toString(16).padStart(6, '0')}`.padEnd(64, '0')

/** The instance escrow key every shipped client seals to. */
const ESCROW = hexKey('e5')
const createdUsers: string[] = []
const createdHubs: string[] = []
const createdConversations: string[] = []

interface Person { pubkey: string; deviceKey: string }

async function makePerson(_label: string, extra: Partial<typeof users.$inferInsert> = {}, withDevice = true): Promise<Person> {
  // Audit entries require a real 64-hex actor key, so users get one too.
  const pubkey = hexKey('a0')
  await db.insert(users).values({ pubkey, displayName: _label, ...extra })
  createdUsers.push(pubkey)
  const deviceKey = hexKey('d0')
  if (withDevice) await db.insert(devices).values({ pubkey, platform: 'desktop', x25519Pubkey: deviceKey })
  return { pubkey, deviceKey }
}

const makeSuperAdmin = (label: string) => makePerson(label, { roles: ['role-super-admin'] })

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

const recipientsOf = (hubId: string | undefined) => identity.listAdminEnvelopeRecipients(ESCROW, hubId)

/** Resolve to the ServiceError an operation throws, or fail if it succeeds. */
async function refusal(fn: () => Promise<unknown>): Promise<ServiceError> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError)
    return err as ServiceError
  }
  throw new Error('expected a refusal, but the call succeeded')
}

/** Only the sealing target varies; the guard sees `pubkey`s, never ciphertext. */
const sealedTo = (...keys: string[]) => keys.map(pubkey => ({ pubkey, enc: 'b'.repeat(64), ct: 'c'.repeat(32) }))

/** `escrow: null` models a deployment with no ADMIN_DECRYPTION_PUBKEY. */
const guard = (hubId: string | undefined, envelopes: ReturnType<typeof sealedTo>, escrow: string | null = ESCROW) =>
  assertAdminCanRead(services, { ADMIN_DECRYPTION_PUBKEY: escrow ?? undefined }, hubId, envelopes, 'A note')

afterAll(async () => {
  await db.delete(notes).where(inArray(notes.hubId, createdHubs))
  if (createdConversations.length > 0) await db.delete(conversations).where(inArray(conversations.id, createdConversations))
  await db.delete(erasureRequests).where(inArray(erasureRequests.userId, createdUsers))
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  await db.delete(users).where(inArray(users.pubkey, createdUsers))
})

describe('who the envelope guard accepts is who the invariant counts', () => {
  it('a hub admin is an admin recipient of THEIR hub only', async () => {
    const adminOne = await makePerson('h1-admin')
    const adminTwo = await makePerson('h2-admin')
    const hubOne = await makeHub('one', adminOne)
    const hubTwo = await makeHub('two', adminTwo)

    expect(await recipientsOf(hubOne)).toContain(adminOne.deviceKey)
    expect(await recipientsOf(hubOne)).not.toContain(adminTwo.deviceKey)
    expect(await recipientsOf(hubTwo)).toContain(adminTwo.deviceKey)
    expect(await recipientsOf(hubTwo)).not.toContain(adminOne.deviceKey)
    // The escrow key is every shipped client's seal target, valid for any hub.
    expect(await recipientsOf(hubOne)).toContain(ESCROW)
  })

  it('a plain member is not a recipient — and neither does the invariant count them', async () => {
    const founder = await makePerson('m-admin')
    const hubId = await makeHub('member', founder)
    const member = await makePerson('member', { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })

    expect(await recipientsOf(hubId)).not.toContain(member.deviceKey)
    // Invariant side: with only a volunteer left, removing the founder is refused.
    const err = await refusal(() => identity.removeHubRole({ pubkey: founder.pubkey, hubId }))
    expect(err.status).toBe(409)
  })

  it('a super-admin is NOT a recipient of any hub, and the invariant does not count them (D1)', async () => {
    const founder = await makePerson('s-admin')
    const hubId = await makeHub('super', founder)
    const sup = await makeSuperAdmin('s-super')

    expect(await recipientsOf(hubId)).not.toContain(sup.deviceKey)
    expect(await recipientsOf(undefined)).not.toContain(sup.deviceKey)
    // A record with no hub has no hub admins: only the escrow key reads it.
    expect(await recipientsOf(undefined)).toEqual([ESCROW])
    // Invariant side: the super-admin does not carry the hub, so the founder may not leave.
    const err = await refusal(() => identity.removeHubRole({ pubkey: founder.pubkey, hubId }))
    expect(err.status).toBe(409)
    expect((await refusal(() => guard(hubId, sealedTo(sup.deviceKey)))).status).toBe(422)
  })

  it('a super-admin who is also a MEMBER of the hub without an admin role is neither a recipient nor counted', async () => {
    const founder = await makePerson('sm-admin')
    const hubId = await makeHub('super-member', founder)
    const sup = await makePerson('sm-super', {
      roles: ['role-super-admin'],
      hubRoles: [{ hubId, roleIds: ['role-volunteer'] }],
    })

    expect(await recipientsOf(hubId)).not.toContain(sup.deviceKey)
    expect((await refusal(() => identity.removeHubRole({ pubkey: founder.pubkey, hubId }))).status).toBe(409)
  })

  it('a super-admin who also holds an admin role IN the hub counts as that hub\'s admin, like anyone else', async () => {
    const founder = await makePerson('sa-admin')
    const hubId = await makeHub('super-admin-role', founder)
    const sup = await makePerson('sa-super', {
      roles: ['role-super-admin'],
      hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }],
    })

    expect(await recipientsOf(hubId)).toContain(sup.deviceKey)
    await identity.removeHubRole({ pubkey: founder.pubkey, hubId })
    expect((await refusal(() => identity.removeHubRole({ pubkey: sup.pubkey, hubId }))).status).toBe(409)
  })

  it.each([
    ['deactivated', { active: false }],
    ['erased', { status: 'erased', active: false }],
  ] as const)('a %s hub admin is neither a recipient nor counted', async (_label, state) => {
    const founder = await makePerson('gone-admin')
    const hubId = await makeHub('gone', founder)
    const gone = await makePerson('gone-peer', { ...state })
    await db.update(users).set({ hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] }).where(eq(users.pubkey, gone.pubkey))

    expect(await recipientsOf(hubId)).not.toContain(gone.deviceKey)
    // Invariant side: they do not satisfy "the hub keeps an admin".
    expect((await refusal(() => identity.removeHubRole({ pubkey: founder.pubkey, hubId }))).status).toBe(409)
    await guard(hubId, sealedTo(founder.deviceKey)) // the founder still is
    expect((await refusal(() => guard(hubId, sealedTo(gone.deviceKey)))).status).toBe(422)
  })

  it('a hub admin on a revoked signing key is neither a recipient nor counted', async () => {
    const founder = await makePerson('revoked-founder')
    const hubId = await makeHub('revoked', founder)
    const [revokedKey] = [...revokedSigningKeys()]
    // Its private half is published, so it must carry no authority at all. The
    // key is fixed, so clear any row a previously aborted run left behind.
    await db.delete(users).where(eq(users.pubkey, revokedKey))
    await db.insert(users).values({ pubkey: revokedKey, displayName: 'revoked', hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] })
    createdUsers.push(revokedKey)
    const revokedDevice = hexKey('d1')
    await db.insert(devices).values({ pubkey: revokedKey, platform: 'desktop', x25519Pubkey: revokedDevice })

    expect(await recipientsOf(hubId)).not.toContain(revokedDevice)
    expect((await refusal(() => identity.removeHubRole({ pubkey: founder.pubkey, hubId }))).status).toBe(409)
  })

  it('an admin with an erasure in flight is neither a recipient nor counted', async () => {
    const departing = await makePerson('departing')
    const hubId = await makeHub('departing', departing)
    const peer = await makePerson('departing-peer', { hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] })
    await db.insert(erasureRequests).values({
      scope: 'user', userId: departing.pubkey, requestedBy: departing.pubkey, status: 'pending',
      executeAt: new Date(Date.now() + 7 * 86_400_000),
    })

    expect(await recipientsOf(hubId)).not.toContain(departing.deviceKey)
    expect(await recipientsOf(hubId)).toContain(peer.deviceKey)
    // Invariant side, same exclusion: `peer` is the only admin that counts, so
    // they cannot leave even though `departing` still has the role on paper.
    expect((await refusal(() => identity.removeHubRole({ pubkey: peer.pubkey, hubId }))).status).toBe(409)
  })
})

describe('a note satisfying one definition but not the other is refused (it can no longer exist)', () => {
  it('sealed only to a former hub admin: refused', async () => {
    const founder = await makePerson('former-founder')
    const successor = await makePerson('former-successor')
    const hubId = await makeHub('former', founder)
    await identity.setHubRole({ pubkey: successor.pubkey, hubId, roleIds: ['role-hub-admin'] })
    await identity.removeHubRole({ pubkey: founder.pubkey, hubId })

    expect((await refusal(() => guard(hubId, sealedTo(founder.deviceKey)))).status).toBe(422)
    await guard(hubId, sealedTo(founder.deviceKey, successor.deviceKey))
  })

  it("sealed only to another hub's admin: refused", async () => {
    const adminOne = await makePerson('x-admin-one')
    const adminTwo = await makePerson('x-admin-two')
    const hubOne = await makeHub('x-one', adminOne)
    await makeHub('x-two', adminTwo)

    expect((await refusal(() => guard(hubOne, sealedTo(adminTwo.deviceKey)))).status).toBe(422)
  })

  it('sealed only to a hub admin that the OLD guard ignored: accepted — the reader the invariant protects can open it', async () => {
    const founder = await makePerson('only-hub-admin')
    const hubId = await makeHub('only-hub-admin', founder)
    await guard(hubId, sealedTo(founder.deviceKey), null)
  })

  it('a super-admin can never be the last admin: it is freely removable, and a real hub admin is not', async () => {
    const founder = await makePerson('chain-founder')
    const hubId = await makeHub('chain', founder)
    const sup = await makePerson('chain-super', {
      roles: ['role-super-admin'],
      hubRoles: [{ hubId, roleIds: ['role-volunteer'] }],
    })

    // The founder is the hub's only admin; the super-admin member does not help.
    expect((await refusal(() => identity.removeHubRole({ pubkey: founder.pubkey, hubId }))).status).toBe(409)
    expect((await refusal(() => identity.updateUser(founder.pubkey, { active: false }, true))).status).toBe(409)
    expect((await refusal(() => identity.deleteUser(founder.pubkey))).status).toBe(409)

    // The super-admin is not an admin of the hub, so nothing stops it from going.
    await identity.updateUser(sup.pubkey, { roles: ['role-volunteer'] }, true)
    await identity.updateUser(sup.pubkey, { active: false }, true)
    await identity.deleteUser(sup.pubkey)

    // A new hub admin takes over; now the founder may go.
    const successor = await makePerson('chain-successor')
    await identity.setHubRole({ pubkey: successor.pubkey, hubId, roleIds: ['role-hub-admin'] })
    await identity.removeHubRole({ pubkey: founder.pubkey, hubId })
    expect(await recipientsOf(hubId)).not.toContain(founder.deviceKey)
    expect(await recipientsOf(hubId)).toContain(successor.deviceKey)
  })
})

describe('no resolvable admin recipient refuses instead of storing (the old fail-open)', () => {
  it('503s when there is no escrow key and the hub admin has registered no device', async () => {
    const founder = await makePerson('nodevice', {}, false)
    const hubId = await makeHub('nodevice', founder)

    expect(await identity.listAdminEnvelopeRecipients(undefined, hubId)).toEqual([])
    const err = await refusal(() => guard(hubId, sealedTo(hexKey('aa')), null))
    expect(err.status).toBe(503)
  })
})

describe('POST /api/hubs/:hubId/notes, end to end', () => {
  const ENV = { ENVIRONMENT: 'test', ADMIN_DECRYPTION_PUBKEY: ESCROW }

  interface Fixture { hubId: string; conversationId: string; author: Person; admin: Person }
  async function fixture(label: string): Promise<Fixture> {
    const admin = await makePerson(`${label}-admin`)
    const hubId = await makeHub(label, admin)
    const author = await makePerson(`${label}-author`, { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })
    const [conversation] = await db.insert(conversations).values({
      hubId, channelType: 'sms', contactIdentifierHash: nextId('contact'),
    }).returning()
    createdConversations.push(conversation.id)
    return { hubId, conversationId: conversation.id, author, admin }
  }

  async function postNote(f: Fixture, adminEnvelopes: ReturnType<typeof sealedTo> | undefined, env: Record<string, string> = ENV) {
    const app = new Hono<AppEnv>()
    app.onError((err, c) => {
      if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 422 | 503)
      throw err
    })
    app.use('*', async (c, next) => {
      const user = { pubkey: f.author.pubkey, roles: [], hubRoles: [{ hubId: f.hubId, roleIds: ['role-volunteer'] }] }
      c.set('pubkey', f.author.pubkey)
      c.set('user', user as unknown as AppEnv['Variables']['user'])
      c.set('allRoles', ALL_ROLES)
      c.set('permissions', resolvePermissions([], ALL_ROLES))
      c.set('services', services as unknown as AppEnv['Variables']['services'])
      await next()
    })
    const hubScoped = new Hono<AppEnv>()
    hubScoped.use('*', hubContext)
    hubScoped.route('/notes', notesRoutes)
    app.route('/api/hubs/:hubId', hubScoped)

    const res = await app.request(`/api/hubs/${f.hubId}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: f.conversationId,
        encryptedContent: 'ciphertext',
        authorEnvelope: { enc: 'b'.repeat(64), ct: 'c'.repeat(32) },
        adminEnvelopes,
      }),
    }, env)
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }

  const storedNotes = async (f: Fixture) =>
    (await db.select({ id: notes.id }).from(notes).where(eq(notes.hubId, f.hubId))).length

  it('a normal note — sealed to the escrow key, as every client does — is stored', async () => {
    const f = await fixture('e2e-escrow')
    const res = await postNote(f, sealedTo(ESCROW))
    expect(res.status).toBe(201)
    expect(await storedNotes(f)).toBe(1)
  })

  it("a note sealed to the hub admin's own device is stored", async () => {
    const f = await fixture('e2e-hubadmin')
    const res = await postNote(f, sealedTo(f.admin.deviceKey))
    expect(res.status).toBe(201)
    expect(await storedNotes(f)).toBe(1)
  })

  it.each([
    ['no admin envelope', []],
    ['an envelope no admin holds', sealedTo(hexKey('bb'))],
  ])('refuses (422) a note with %s and stores nothing', async (_label, envelopes) => {
    const f = await fixture('e2e-refused')
    const res = await postNote(f, envelopes)
    expect(res.status).toBe(422)
    expect(await storedNotes(f)).toBe(0)
  })

  it('refuses (503) and stores nothing when the deployment has no admin recipient at all', async () => {
    const admin = await makePerson('e2e-bare-admin', {}, false)
    const hubId = await makeHub('e2e-bare', admin)
    const author = await makePerson('e2e-bare-author', { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })
    const [conversation] = await db.insert(conversations).values({
      hubId, channelType: 'sms', contactIdentifierHash: nextId('contact'),
    }).returning()
    createdConversations.push(conversation.id)
    const f = { hubId, conversationId: conversation.id, author, admin }

    const res = await postNote(f, sealedTo(ESCROW), { ENVIRONMENT: 'test' })
    expect(res.status).toBe(503)
    expect(await storedNotes(f)).toBe(0)
  })
})
