/**
 * Every client-sealed record write must name an admin reader of ITS hub (#2174),
 * against real PostgreSQL, Bun-native driver, through the real routers behind
 * the real `hubContext`, with the REAL reader sets.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is `bun-jsonb`):
 *   bun test apps/worker/__tests__/integration-bun/sealed-write-readers.test.ts
 *
 * The route unit tests stub the reader set; this proves the guard resolves the
 * same set the hub invariant protects, per route: the founder admin's registered
 * device key is accepted, a volunteer's device key, an Ed25519 identity key and
 * ANOTHER hub's admin key are all refused (422), and a hub with no admin device
 * and no escrow key refuses with 503 — in every case NOTHING is stored.
 *
 * Requires postgres at DATABASE_URL with migrations applied, and the Rust
 * crypto library for `publishEvent` (LLAMENOS_CRYPTO_LIB).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { caseNumberSequences, caseRecords, contacts, devices, entityTypeDefinitions, events, hubs, users } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { CasesService } from '../../services/cases'
import { ContactsService } from '../../services/contacts'
import { IdentityService } from '../../services/identity'
import { ServiceError } from '../../services/service-error'
import { createSettingsDomain } from '../../services/settings-domain'
import { hubContext } from '../../middleware/hub'
import recordsRoutes from '../../routes/records'
import eventsRoutes from '../../routes/events'
import contactsRoutes from '../../routes/contacts-v2'
import uploadsRoutes from '../../routes/uploads'
import evidenceRoutes from '../../routes/evidence'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const settings = createSettingsDomain(db)
const cases = new CasesService(db)
const contactsService = new ContactsService(db)

// Uploads and evidence reach their service only past the guard; the refusals
// below must never get that far, and `reached` proves it.
const reached: string[] = []
const services = {
  ...settings,
  identity,
  cases,
  contacts: contactsService,
  audit: new AuditService(db),
  conversations: {
    createFile: async () => { reached.push('createFile') },
    getByIdForHub: async () => ({ id: 'c1', assignedTo: ADMIN_PUBKEY, contactIdentifierHash: 'h', metadata: null }),
    getCaseRecordFile: async () => { reached.push('getCaseRecordFile'); throw new ServiceError(404, 'File not found') },
  },
  shifts: { getCurrentVolunteers: async () => [] as string[] },
}

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
let counter = 0
/** A schema-valid 64-char lowercase hex key, unique to this run. */
const hexKey = (lead: string) => `${lead}${rand}${(counter++).toString(16).padStart(6, '0')}`.padEnd(64, '0')

const HUB = `hub-sealed-${suite}`
const OTHER_HUB = `hub-sealed-other-${suite}`
const EMPTY_HUB = `hub-sealed-empty-${suite}`
const ADMIN_PUBKEY = hexKey('a1')
const ADMIN_DEVICE = hexKey('d1')
const VOLUNTEER_PUBKEY = hexKey('a2')
const VOLUNTEER_DEVICE = hexKey('d2')
const OTHER_ADMIN_PUBKEY = hexKey('a3')
const OTHER_ADMIN_DEVICE = hexKey('d3')
/** Founder of a hub whose only admin registered no device: no admin reader exists. */
const BARE_ADMIN_PUBKEY = hexKey('a4')

interface Actor { pubkey: string; hubRoles: { hubId: string; roleIds: string[] }[] }
const ADMIN: Actor = { pubkey: ADMIN_PUBKEY, hubRoles: [{ hubId: HUB, roleIds: ['role-hub-admin'] }] }
const BARE_ADMIN: Actor = { pubkey: BARE_ADMIN_PUBKEY, hubRoles: [{ hubId: EMPTY_HUB, roleIds: ['role-hub-admin'] }] }

function appAs(actor: Actor) {
  const app = new Hono<AppEnv>()
  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 422 | 503)
    throw err
  })
  app.use('*', async (c, next) => {
    c.set('pubkey', actor.pubkey)
    c.set('user', { pubkey: actor.pubkey, roles: [], hubRoles: actor.hubRoles } as unknown as AppEnv['Variables']['user'])
    c.set('allRoles', ALL_ROLES)
    c.set('permissions', resolvePermissions([], ALL_ROLES))
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/records', recordsRoutes)
  hubScoped.route('/events', eventsRoutes)
  hubScoped.route('/directory', contactsRoutes)
  hubScoped.route('/uploads', uploadsRoutes)
  hubScoped.route('/', evidenceRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

async function call(actor: Actor, hubId: string, method: string, path: string, body?: unknown) {
  const res = await appAs(actor).request(`/api/hubs/${hubId}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ENV)
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* not json */ }
  return { status: res.status, text, json }
}

const sealedTo = (...keys: string[]) => keys.map(pubkey => ({ pubkey, enc: 'b'.repeat(64), ct: 'c'.repeat(32) }))
const asRecipients = (...keys: string[]) => keys.map(recipientPubkey => ({ recipientPubkey, encryptedKey: 'k' }))

// ── Seed ───────────────────────────────────────────────────────────

const PREFIX = `SW${rand.slice(0, 4).toUpperCase()}`
let typeId = ''
let recordId = ''

const recordCount = async () => (await db.select({ id: caseRecords.id }).from(caseRecords).where(eq(caseRecords.hubId, HUB))).length
const eventCount = async () => (await db.select({ id: events.id }).from(events).where(eq(events.hubId, HUB))).length
const contactCount = async () => (await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.hubId, HUB))).length
const sequence = async () =>
  (await db.select().from(caseNumberSequences).where(eq(caseNumberSequences.hubId, HUB))).map(r => r.nextValue)

beforeAll(async () => {
  for (const [pubkey, hubRoles] of [
    [ADMIN_PUBKEY, ADMIN.hubRoles],
    [BARE_ADMIN_PUBKEY, BARE_ADMIN.hubRoles],
    [VOLUNTEER_PUBKEY, [{ hubId: HUB, roleIds: ['role-volunteer'] }]],
    [OTHER_ADMIN_PUBKEY, [{ hubId: OTHER_HUB, roleIds: ['role-hub-admin'] }]],
  ] as const) {
    await db.insert(users).values({ pubkey, displayName: `sealed-${pubkey.slice(0, 6)}`, hubRoles: [...hubRoles] })
  }
  for (const [pubkey, x25519Pubkey] of [
    [ADMIN_PUBKEY, ADMIN_DEVICE],
    [VOLUNTEER_PUBKEY, VOLUNTEER_DEVICE],
    [OTHER_ADMIN_PUBKEY, OTHER_ADMIN_DEVICE],
  ] as const) {
    await db.insert(devices).values({ pubkey, platform: 'desktop', x25519Pubkey })
  }
  for (const [id, founder] of [[HUB, ADMIN_PUBKEY], [OTHER_HUB, OTHER_ADMIN_PUBKEY], [EMPTY_HUB, BARE_ADMIN_PUBKEY]] as const) {
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: founder })
  }
  typeId = (await settings.entitySchema.createEntityType({
    hubId: HUB,
    name: 'sealed_type',
    label: 'sealed_type',
    labelPlural: 'sealed_types',
    category: 'case',
    statuses: [{ value: 'open', label: 'Open', order: 0 }],
    defaultStatus: 'open',
    closedStatuses: [],
    fields: [],
    numberingEnabled: true,
    numberPrefix: PREFIX,
  })).id
  recordId = (await db.insert(caseRecords).values({
    hubId: HUB, entityTypeId: typeId, statusHash: 'open', createdBy: ADMIN_PUBKEY, summaryEnvelopes: sealedTo(ADMIN_DEVICE),
  }).returning())[0].id
})

afterAll(async () => {
  const hubIds = [HUB, OTHER_HUB, EMPTY_HUB]
  await db.delete(caseRecords).where(inArray(caseRecords.hubId, hubIds))
  await db.delete(events).where(inArray(events.hubId, hubIds))
  await db.delete(contacts).where(inArray(contacts.hubId, hubIds))
  await db.delete(caseNumberSequences).where(inArray(caseNumberSequences.hubId, hubIds))
  await db.delete(entityTypeDefinitions).where(inArray(entityTypeDefinitions.hubId, hubIds))
  await db.delete(hubs).where(inArray(hubs.id, hubIds))
  await db.delete(users).where(inArray(users.pubkey, [ADMIN_PUBKEY, BARE_ADMIN_PUBKEY, VOLUNTEER_PUBKEY, OTHER_ADMIN_PUBKEY]))
})

/** The envelope sets a write may NOT rely on: every one is readable by someone, none by an admin of this hub. */
const NOT_ADMIN: Array<[string, string[]]> = [
  ['a volunteer device key', [VOLUNTEER_DEVICE]],
  ["an Ed25519 identity key (the admin's user id)", [ADMIN_PUBKEY]],
  ["another hub's admin device key", [OTHER_ADMIN_DEVICE]],
]

// ── records ────────────────────────────────────────────────────────

describe('records', () => {
  const body = (summary: string[], extra: Record<string, unknown> = {}) => ({
    entityTypeId: typeId, statusHash: 'open', encryptedSummary: 'ct', summaryEnvelopes: sealedTo(...summary), ...extra,
  })

  it('accepts a case sealed to a registered admin device, with a volunteer beside it', async () => {
    const before = await recordCount()
    const res = await call(ADMIN, HUB, 'POST', '/records', body([VOLUNTEER_DEVICE, ADMIN_DEVICE]))
    expect(res.status).toBe(201)
    expect(await recordCount()).toBe(before + 1)
  })

  for (const [label, keys] of NOT_ADMIN) {
    it(`REFUSES (422) a case sealed to ${label}, storing and numbering nothing`, async () => {
      const records = await recordCount()
      const seq = await sequence()
      const res = await call(ADMIN, HUB, 'POST', '/records', body(keys))
      expect(res.status).toBe(422)
      expect(await recordCount()).toBe(records)
      expect(await sequence()).toEqual(seq)
    })
  }

  it('REFUSES (422) a readable summary beside a PII tier sealed to no admin', async () => {
    const records = await recordCount()
    const res = await call(ADMIN, HUB, 'POST', '/records', body([ADMIN_DEVICE], { encryptedPII: 'ct', piiEnvelopes: sealedTo(VOLUNTEER_DEVICE) }))
    expect(res.status).toBe(422)
    expect(await recordCount()).toBe(records)
  })

  it('REFUSES (422) an update that re-seals the fields tier away from every admin, leaving the stored tier untouched', async () => {
    const res = await call(ADMIN, HUB, 'PATCH', `/records/${recordId}`, { encryptedFields: 'new', fieldEnvelopes: sealedTo(VOLUNTEER_DEVICE) })
    expect(res.status).toBe(422)
    const [row] = await db.select().from(caseRecords).where(eq(caseRecords.id, recordId))
    expect(row.encryptedFields).toBeNull()
  })

  it('accepts an update that re-seals the fields tier to an admin', async () => {
    const res = await call(ADMIN, HUB, 'PATCH', `/records/${recordId}`, { encryptedFields: 'new', fieldEnvelopes: sealedTo(ADMIN_DEVICE) })
    expect(res.status).toBe(200)
  })

  it('REFUSES (422) an inline case comment sealed to no admin', async () => {
    const res = await call(ADMIN, HUB, 'POST', `/records/${recordId}/interactions`, {
      interactionType: 'comment', interactionTypeHash: 'h', encryptedContent: 'ct', contentEnvelopes: sealedTo(VOLUNTEER_DEVICE),
    })
    expect(res.status).toBe(422)
  })

  it('REFUSES (503) in a hub whose admin registered no device and set no escrow key', async () => {
    const res = await call(BARE_ADMIN, EMPTY_HUB, 'POST', '/records', body([ADMIN_DEVICE]))
    // The entity type belongs to HUB, so the type lookup would 404 — the guard runs first.
    expect(res.status).toBe(503)
  })
})

// ── events ─────────────────────────────────────────────────────────

describe('events', () => {
  const body = (keys: string[]) => ({
    entityTypeId: typeId, startDate: '2026-12-01', eventTypeHash: 'e', statusHash: 'open',
    encryptedDetails: 'ct', detailEnvelopes: sealedTo(...keys),
  })

  it('accepts an event sealed to a registered admin device', async () => {
    const before = await eventCount()
    const res = await call(ADMIN, HUB, 'POST', '/events', body([ADMIN_DEVICE]))
    expect(res.status).toBe(201)
    expect(await eventCount()).toBe(before + 1)
  })

  for (const [label, keys] of NOT_ADMIN) {
    it(`REFUSES (422) an event sealed to ${label}`, async () => {
      const before = await eventCount()
      const res = await call(ADMIN, HUB, 'POST', '/events', body(keys))
      expect(res.status).toBe(422)
      expect(await eventCount()).toBe(before)
    })
  }
})

// ── contacts ───────────────────────────────────────────────────────

describe('contacts', () => {
  const body = (keys: string[], extra: Record<string, unknown> = {}) => ({
    hubId: HUB, encryptedSummary: 'ct', summaryEnvelopes: sealedTo(...keys), ...extra,
  })
  let contactId = ''

  it('accepts a contact sealed to a registered admin device', async () => {
    const res = await call(ADMIN, HUB, 'POST', '/directory', body([ADMIN_DEVICE]))
    expect(res.status).toBe(201)
    contactId = String(res.json.id)
  })

  for (const [label, keys] of NOT_ADMIN) {
    it(`REFUSES (422) a contact sealed to ${label}`, async () => {
      const before = await contactCount()
      const res = await call(ADMIN, HUB, 'POST', '/directory', body(keys))
      expect(res.status).toBe(422)
      expect(await contactCount()).toBe(before)
    })
  }

  it('REFUSES (422) a contact update that re-seals the summary away from every admin', async () => {
    const res = await call(ADMIN, HUB, 'PATCH', `/directory/${contactId}`, { encryptedSummary: 'new', summaryEnvelopes: sealedTo(VOLUNTEER_DEVICE) })
    expect(res.status).toBe(422)
    const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId))
    expect(row.encryptedSummary).toBe('ct')
  })

  it('REFUSES (422) a bulk batch with one contact sealed to no admin, creating none of them', async () => {
    const before = await contactCount()
    const entry = (key: string) => ({ encryptedSummary: 'ct', summaryEnvelopes: asRecipients(key), blindIndexes: {} })
    const res = await call(ADMIN, HUB, 'POST', '/directory/bulk-create', { contacts: [entry(ADMIN_DEVICE), entry(VOLUNTEER_DEVICE)] })
    expect(res.status).toBe(422)
    expect(await contactCount()).toBe(before)
  })

  it('accepts a bulk batch whose every contact is sealed to an admin', async () => {
    const before = await contactCount()
    const entry = { encryptedSummary: 'ct', summaryEnvelopes: asRecipients(ADMIN_DEVICE), blindIndexes: {} }
    const res = await call(ADMIN, HUB, 'POST', '/directory/bulk-create', { contacts: [entry, entry] })
    expect(res.status).toBe(201)
    expect(await contactCount()).toBe(before + 2)
  })

  it('REFUSES (422) an affinity group sealed to no admin', async () => {
    const res = await call(ADMIN, HUB, 'POST', '/directory/groups', {
      encryptedDetails: 'ct', detailEnvelopes: sealedTo(VOLUNTEER_DEVICE), members: [{ contactId }],
    })
    expect(res.status).toBe(422)
  })

  it('REFUSES (422) relationship notes sealed to no admin', async () => {
    const other = await call(ADMIN, HUB, 'POST', '/directory', body([ADMIN_DEVICE]))
    const res = await call(ADMIN, HUB, 'POST', `/directory/${contactId}/relationships`, {
      contactIdB: String(other.json.id), relationshipType: 'family', encryptedNotes: 'ct', notesEnvelopes: sealedTo(VOLUNTEER_DEVICE),
    })
    expect(res.status).toBe(422)
  })
})

// ── uploads and evidence ───────────────────────────────────────────

describe('uploads', () => {
  const body = (keys: string[]) => ({
    totalSize: 100, totalChunks: 1, owner: { kind: 'conversation', conversationId: 'c1' }, recipientEnvelopes: sealedTo(...keys),
  })

  it('accepts a file key wrapped for a registered admin device', async () => {
    reached.length = 0
    const res = await call(ADMIN, HUB, 'POST', '/uploads/init', body([VOLUNTEER_DEVICE, ADMIN_DEVICE]))
    expect(res.status).toBe(200)
    expect(reached).toContain('createFile')
  })

  for (const [label, keys] of NOT_ADMIN) {
    it(`REFUSES (422) a file key wrapped only for ${label}, creating no file row`, async () => {
      reached.length = 0
      const res = await call(ADMIN, HUB, 'POST', '/uploads/init', body(keys))
      expect(res.status).toBe(422)
      expect(reached).not.toContain('createFile')
    })
  }
})

describe('evidence', () => {
  const body = (extra: Record<string, unknown>) => ({
    fileId: 'file-1', filename: 'e.pdf', mimeType: 'application/pdf', sizeBytes: 10, classification: 'photo', integrityHash: 'a'.repeat(64), ...extra,
  })

  for (const [label, keys] of NOT_ADMIN) {
    it(`REFUSES (422) a description sealed to ${label}, before the file is even looked up`, async () => {
      reached.length = 0
      const res = await call(ADMIN, HUB, 'POST', `/records/${recordId}/evidence`, body({ encryptedDescription: 'ct', descriptionEnvelopes: sealedTo(...keys) }))
      expect(res.status).toBe(422)
      expect(reached).not.toContain('getCaseRecordFile')
    })
  }

  it('lets a description sealed to a registered admin device through to the file check', async () => {
    reached.length = 0
    const res = await call(ADMIN, HUB, 'POST', `/records/${recordId}/evidence`, body({ encryptedDescription: 'ct', descriptionEnvelopes: sealedTo(ADMIN_DEVICE) }))
    // The stubbed file lookup then 404s: the point is that the guard let it pass.
    expect(res.status).toBe(404)
    expect(reached).toContain('getCaseRecordFile')
  })
})
