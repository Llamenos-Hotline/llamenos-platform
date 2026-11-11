/**
 * Ids a client puts in a `records` request body are bound to the PATH hub, and
 * the cross-hub listing obeys the switch that names it (#2605), against real
 * PostgreSQL, Bun-native driver, through the real router behind the real
 * `hubContext`.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/records-hub-bind.test.ts
 *
 * Nothing in the schema ties `contactLinks`, `parentRecordId`, a linked report
 * or an entity type to a hub (no FK), so each is bound in the service, by the
 * hub of the record being written. The attacker administers hub A only; every
 * foreign id below names a row that genuinely exists in hub B.
 *
 * What it asserts, per id: the foreign id is refused (404), the refusal is
 * byte-identical to the one for an id that does not exist at all, NOTHING is
 * written (no record, no link, no consumed case number), and the legitimate
 * own-hub id still works. For the cross-hub listing: while sharing is off, no
 * caller — including the super-admin who holds `cases:read-cross-hub` — can
 * list across hubs, and the one stored switch is the same whether it is flipped
 * through the cms route's service call or the platform-settings feature flag.
 *
 * Requires postgres at DATABASE_URL with migrations applied, and the Rust
 * crypto library for `publishEvent` (LLAMENOS_CRYPTO_LIB). Everything created
 * here is removed on teardown, and the deployment's cross-hub switch is put
 * back to the value it had.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import {
  caseContacts,
  caseNumberSequences,
  caseRecords,
  contacts,
  conversations,
  entityTypeDefinitions,
  hubs,
  reportCases,
  systemSettings,
} from '../../db/schema'
import { AuditService } from '../../services/audit'
import { CasesService } from '../../services/cases'
import { ServiceError, SettingsService } from '../../services/settings'
import { hubContext } from '../../middleware/hub'
import recordsRoutes from '../../routes/records'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const settings = new SettingsService(db)
const svc = {
  settings,
  audit: new AuditService(db),
  cases: new CasesService(db),
  // The auto-assign branch reads these; the entity types seeded here have
  // autoAssign off, so they are never reached.
  shifts: { getCurrentVolunteers: async () => [] as string[] },
  identity: { getUsers: async () => ({ users: [] }) },
}

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-bind-a-${suffix}`
const HUB_B = `hub-bind-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
/** A schema-valid 64-char lowercase hex string, unique to this run. */
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')

interface Actor { pubkey: string; roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }
/** Administers hub A and nothing else — the attacker in every cross-hub case. */
const ADMIN_A: Actor = { pubkey: hex('a1'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }] }
/** Administers hub B and nothing else — owns the victim rows. */
const ADMIN_B: Actor = { pubkey: hex('b1'), roles: [], hubRoles: [{ hubId: HUB_B, roleIds: ['role-hub-admin'] }] }
/** Global super-admin: holds `cases:read-cross-hub`, the permission the switch must still gate. */
const SUPER: Actor = { pubkey: hex('d1'), roles: ['role-super-admin'], hubRoles: [] }

function appAs(actor: Actor) {
  const app = new Hono<AppEnv>()
  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409)
    throw err
  })
  app.use('*', async (c, next) => {
    c.set('pubkey', actor.pubkey)
    c.set('user', { pubkey: actor.pubkey, roles: actor.roles, hubRoles: actor.hubRoles } as AppEnv['Variables']['user'])
    c.set('allRoles', ALL_ROLES)
    c.set('permissions', resolvePermissions(actor.roles, ALL_ROLES))
    c.set('services', svc as unknown as AppEnv['Variables']['services'])
    await next()
  })
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/records', recordsRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

async function call(actor: Actor, hubId: string, method: string, path: string, body?: unknown) {
  const res = await appAs(actor).request(`/api/hubs/${hubId}/records${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ENV)
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* not json */ }
  return { status: res.status, text, json }
}

// ── Seed ───────────────────────────────────────────────────────────

const PREFIX_A = `BA${rand.slice(0, 4).toUpperCase()}`
const PREFIX_B = `BB${rand.slice(0, 4).toUpperCase()}`
const MISSING_ID = crypto.randomUUID()

let typeA = ''
let typeB = ''
let contactA = ''
let contactB = ''
let reportA = ''
let reportB = ''
let recordA = ''
let recordB = ''
let priorCrossHub = false

const typeBody = (hubId: string, name: string, numberPrefix: string) => ({
  hubId,
  name,
  label: name,
  labelPlural: `${name}s`,
  category: 'case',
  statuses: [{ value: 'open', label: 'Open', order: 0 }],
  defaultStatus: 'open',
  closedStatuses: [],
  fields: [],
  numberingEnabled: true,
  numberPrefix,
})

const envelopes = (pubkey: string) => [{ pubkey, enc: 'b'.repeat(64), ct: 'c'.repeat(32) }]
const createBody = (entityTypeId: string, extra: Record<string, unknown> = {}) => ({
  entityTypeId,
  statusHash: 'open',
  encryptedSummary: 'ciphertext',
  summaryEnvelopes: envelopes(ADMIN_A.pubkey),
  ...extra,
})

const recordCount = async (hubId: string) =>
  (await db.select({ id: caseRecords.id }).from(caseRecords).where(eq(caseRecords.hubId, hubId))).length
const sequenceValue = async (hubId: string, prefix: string) =>
  (await db.select().from(caseNumberSequences).where(eq(caseNumberSequences.hubId, hubId)))
    .filter(r => r.prefix === prefix).map(r => r.nextValue)

beforeAll(async () => {
  priorCrossHub = (await settings.getCrossHubSharingEnabled()).enabled
  for (const [id, owner] of [[HUB_A, ADMIN_A], [HUB_B, ADMIN_B]] as const) {
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: owner.pubkey })
  }
  typeA = (await settings.createEntityType(typeBody(HUB_A, 'bind_a', PREFIX_A))).id
  typeB = (await settings.createEntityType(typeBody(HUB_B, 'bind_b', PREFIX_B))).id
  const insertContact = async (hubId: string) =>
    (await db.insert(contacts).values({ hubId, encryptedSummary: 'x' }).returning())[0].id
  contactA = await insertContact(HUB_A)
  contactB = await insertContact(HUB_B)
  const insertReport = async (hubId: string) =>
    (await db.insert(conversations).values({
      hubId, channelType: 'web', contactIdentifierHash: hex('f1'), metadata: { type: 'report' },
    }).returning())[0].id
  reportA = await insertReport(HUB_A)
  reportB = await insertReport(HUB_B)
  const insertRecord = async (hubId: string, entityTypeId: string, owner: Actor) =>
    (await db.insert(caseRecords).values({
      hubId, entityTypeId, statusHash: 'open', createdBy: owner.pubkey,
      summaryEnvelopes: envelopes(owner.pubkey),
    }).returning())[0].id
  recordA = await insertRecord(HUB_A, typeA, ADMIN_A)
  recordB = await insertRecord(HUB_B, typeB, ADMIN_B)
})

afterAll(async () => {
  const ids = [HUB_A, HUB_B]
  const rows = await db.select({ id: caseRecords.id }).from(caseRecords).where(inArray(caseRecords.hubId, ids))
  const caseIds = rows.map(r => r.id)
  if (caseIds.length > 0) {
    await db.delete(caseContacts).where(inArray(caseContacts.caseId, caseIds))
    await db.delete(reportCases).where(inArray(reportCases.caseId, caseIds))
  }
  await db.delete(caseRecords).where(inArray(caseRecords.hubId, ids))
  await db.delete(contacts).where(inArray(contacts.hubId, ids))
  await db.delete(conversations).where(inArray(conversations.hubId, ids))
  await db.delete(caseNumberSequences).where(inArray(caseNumberSequences.hubId, ids))
  await db.delete(entityTypeDefinitions).where(inArray(entityTypeDefinitions.hubId, ids))
  await db.delete(hubs).where(inArray(hubs.id, ids))
  await settings.setCrossHubSharingEnabled({ enabled: priorCrossHub })
})

// ── POST / : entity type ───────────────────────────────────────────

describe('POST / — entity type', () => {
  it("applies the path hub's own entity type (numbering prefix included)", async () => {
    const res = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeA))
    expect(res.status).toBe(201)
    expect(String(res.json.caseNumber)).toStartWith(`${PREFIX_A}-`)
  })

  it("refuses another hub's entity type, identically to a missing one, and consumes no case number", async () => {
    const records = await recordCount(HUB_A)
    const seqB = await sequenceValue(HUB_A, PREFIX_B)
    const cross = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeB))
    const missing = await call(ADMIN_A, HUB_A, 'POST', '', createBody(MISSING_ID))
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect(await recordCount(HUB_A)).toBe(records)
    expect(await sequenceValue(HUB_A, PREFIX_B)).toEqual(seqB)
  })

  it('does not swallow a nonexistent entity type into a record created with defaults', async () => {
    const records = await recordCount(HUB_A)
    const res = await call(ADMIN_A, HUB_A, 'POST', '', createBody(MISSING_ID))
    expect(res.status).toBe(404)
    expect(await recordCount(HUB_A)).toBe(records)
  })
})

// ── POST / : parentRecordId, contactLinks ──────────────────────────

describe('POST / — parentRecordId and contactLinks', () => {
  it("refuses another hub's parent record, identically to a missing one, and writes nothing", async () => {
    const records = await recordCount(HUB_A)
    const cross = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeA, { parentRecordId: recordB }))
    const missing = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeA, { parentRecordId: MISSING_ID }))
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect(await recordCount(HUB_A)).toBe(records)
  })

  it("accepts a parent record of the path hub", async () => {
    const res = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeA, { parentRecordId: recordA }))
    expect(res.status).toBe(201)
    expect(res.json.parentRecordId).toBe(recordA)
  })

  it("refuses a contactLink to another hub's contact, identically to a missing one, and writes nothing", async () => {
    const records = await recordCount(HUB_A)
    const cross = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeA, { contactLinks: [{ contactId: contactB, role: 'subject' }] }))
    const missing = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeA, { contactLinks: [{ contactId: MISSING_ID, role: 'subject' }] }))
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect(await recordCount(HUB_A)).toBe(records)
    expect(await db.select().from(caseContacts).where(eq(caseContacts.contactId, contactB))).toHaveLength(0)
  })

  it('refuses the whole request when only one of several contactLinks is foreign', async () => {
    const records = await recordCount(HUB_A)
    const res = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeA, {
      contactLinks: [{ contactId: contactA, role: 'subject' }, { contactId: contactB, role: 'witness' }],
    }))
    expect(res.status).toBe(404)
    expect(await recordCount(HUB_A)).toBe(records)
    expect(await db.select().from(caseContacts).where(eq(caseContacts.contactId, contactA))).toHaveLength(0)
  })

  it("links the path hub's own contact", async () => {
    const res = await call(ADMIN_A, HUB_A, 'POST', '', createBody(typeA, { contactLinks: [{ contactId: contactA, role: 'subject' }] }))
    expect(res.status).toBe(201)
    expect(res.json.contactCount).toBe(1)
  })
})

// ── POST /:id/contacts, POST /:id/reports ──────────────────────────

describe('POST /:id/contacts', () => {
  it("refuses another hub's contact, identically to a missing one, and links nothing", async () => {
    const cross = await call(ADMIN_A, HUB_A, 'POST', `/${recordA}/contacts`, { contactId: contactB, role: 'subject' })
    const missing = await call(ADMIN_A, HUB_A, 'POST', `/${recordA}/contacts`, { contactId: MISSING_ID, role: 'subject' })
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect(await db.select().from(caseContacts).where(eq(caseContacts.contactId, contactB))).toHaveLength(0)
    const [row] = await db.select().from(caseRecords).where(eq(caseRecords.id, recordA))
    expect(row.contactCount).toBe(0)
  })

  it("links the path hub's own contact", async () => {
    const res = await call(ADMIN_A, HUB_A, 'POST', `/${recordA}/contacts`, { contactId: contactA, role: 'subject' })
    expect(res.status).toBe(201)
  })
})

describe('POST /:id/reports', () => {
  it("refuses another hub's report, identically to a missing one, and links nothing", async () => {
    const cross = await call(ADMIN_A, HUB_A, 'POST', `/${recordA}/reports`, { reportId: reportB })
    const missing = await call(ADMIN_A, HUB_A, 'POST', `/${recordA}/reports`, { reportId: MISSING_ID })
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect(await db.select().from(reportCases).where(eq(reportCases.reportId, reportB))).toHaveLength(0)
    const [row] = await db.select().from(caseRecords).where(eq(caseRecords.id, recordA))
    expect(row.reportCount).toBe(0)
  })

  it("links the path hub's own report", async () => {
    const res = await call(ADMIN_A, HUB_A, 'POST', `/${recordA}/reports`, { reportId: reportA })
    expect(res.status).toBe(201)
  })
})

// ── POST /convert-from-report : entity type ────────────────────────

describe('POST /convert-from-report — entity type', () => {
  const reportMeta = async (id: string) =>
    (await db.select().from(conversations).where(eq(conversations.id, id)))[0].metadata

  it("refuses another hub's entity type, identically to a missing one: no record, no numbering, report untouched", async () => {
    const records = await recordCount(HUB_A)
    const seqB = await sequenceValue(HUB_A, PREFIX_B)
    const metaBefore = await reportMeta(reportA)
    const cross = await call(ADMIN_A, HUB_A, 'POST', '/convert-from-report', { reportId: reportA, entityTypeId: typeB })
    const missing = await call(ADMIN_A, HUB_A, 'POST', '/convert-from-report', { reportId: reportA, entityTypeId: MISSING_ID })
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect(await recordCount(HUB_A)).toBe(records)
    expect(await sequenceValue(HUB_A, PREFIX_B)).toEqual(seqB)
    expect(await reportMeta(reportA)).toEqual(metaBefore)
  })

  it("converts with the path hub's own entity type", async () => {
    const res = await call(ADMIN_A, HUB_A, 'POST', '/convert-from-report', { reportId: reportA, entityTypeId: typeA })
    expect(res.status).toBe(201)
    expect(String(res.json.caseNumber)).toStartWith(`${PREFIX_A}-`)
  })
})

// ── GET /?crossHub=true : the switch ───────────────────────────────

describe('GET /?crossHub=true honours crossHubSharingEnabled', () => {
  it('is refused for a caller who holds cases:read-cross-hub while sharing is off', async () => {
    await settings.setCrossHubSharingEnabled({ enabled: false })
    const asSuper = await call(SUPER, HUB_A, 'GET', '?crossHub=true')
    const asAdmin = await call(ADMIN_A, HUB_A, 'GET', '?crossHub=true')
    expect(asSuper.status).toBe(403)
    expect(asAdmin.status).toBe(403)
    expect(asSuper.text).not.toContain(recordB)
  })

  it('leaves the ordinary hub-scoped list alone while sharing is off', async () => {
    await settings.setCrossHubSharingEnabled({ enabled: false })
    const res = await call(ADMIN_A, HUB_A, 'GET', `?entityTypeId=${typeA}`)
    expect(res.status).toBe(200)
  })

  it('lists again once sharing is switched on', async () => {
    await settings.setCrossHubSharingEnabled({ enabled: true })
    const res = await call(ADMIN_A, HUB_A, 'GET', '?crossHub=true')
    expect(res.status).toBe(200)
  })

  it('has ONE stored switch: the platform-settings feature flag moves the same value the list enforces', async () => {
    await settings.setCrossHubSharingEnabled({ enabled: false })
    expect(((await settings.getPlatformSettings()).featureFlags as Record<string, unknown>).crossHubSharingEnabled).toBe(false)

    await settings.updatePlatformSettings({ featureFlags: { crossHubSharingEnabled: true } })
    expect((await call(ADMIN_A, HUB_A, 'GET', '?crossHub=true')).status).toBe(200)
    expect(((await settings.getPlatformSettings()).featureFlags as Record<string, unknown>).crossHubSharingEnabled).toBe(true)

    await settings.updatePlatformSettings({ featureFlags: { crossHubSharingEnabled: false } })
    expect((await call(ADMIN_A, HUB_A, 'GET', '?crossHub=true')).status).toBe(403)
    expect((await settings.getCrossHubSharingEnabled()).enabled).toBe(false)
  })

  it('keeps no second stored copy of the flag in the platform-settings document', async () => {
    await settings.updatePlatformSettings({ featureFlags: { crossHubSharingEnabled: true, mlsEnabled: false } })
    const [row] = await db.select({ doc: systemSettings.platformSettings }).from(systemSettings).where(eq(systemSettings.id, 1))
    const flags = ((row.doc ?? {}) as { featureFlags?: Record<string, unknown> }).featureFlags ?? {}
    expect(flags).not.toHaveProperty('crossHubSharingEnabled')
  })
})

// ── The service, called directly ───────────────────────────────────
//
// The router above has its own lookups in front of the service. These call the
// service with no router, because a guard that lives only in the handler leaves
// every other caller of the service unguarded — which is how these holes kept
// coming back.

describe('the service enforces the binding without the router', () => {
  it("SettingsService.getEntityTypeById resolves a type only inside its own hub", async () => {
    expect((await settings.getEntityTypeById(typeA, HUB_A)).id).toBe(typeA)
    await expect(settings.getEntityTypeById(typeB, HUB_A)).rejects.toMatchObject({ status: 404 })
    await expect(settings.getEntityTypeById(MISSING_ID, HUB_A)).rejects.toMatchObject({ status: 404 })
  })

  it("CasesService.create refuses a foreign entity type, parent record and contact, and writes nothing", async () => {
    const before = await recordCount(HUB_A)
    const base = { ...createBody(typeA), hubId: HUB_A, createdBy: ADMIN_A.pubkey }
    await expect(svc.cases.create({ ...base, entityTypeId: typeB })).rejects.toMatchObject({ status: 404 })
    await expect(svc.cases.create({ ...base, parentRecordId: recordB })).rejects.toMatchObject({ status: 404 })
    await expect(
      svc.cases.create({ ...base, contactLinks: [{ contactId: contactB, role: 'subject' }] }),
    ).rejects.toMatchObject({ status: 404 })
    expect(await recordCount(HUB_A)).toBe(before)
  })

  it("CasesService.convertFromReport refuses a foreign entity type and leaves the report unconverted", async () => {
    const [fresh] = await db.insert(conversations).values({
      hubId: HUB_A, channelType: 'web', contactIdentifierHash: hex('f2'), metadata: { type: 'report' },
    }).returning()
    await expect(
      svc.cases.convertFromReport({
        reportId: fresh.id, entityTypeId: typeB, additionalFields: {}, hubId: HUB_A, createdBy: ADMIN_A.pubkey,
      }),
    ).rejects.toMatchObject({ status: 404 })
    const [after] = await db.select().from(conversations).where(eq(conversations.id, fresh.id))
    expect(after.metadata).toEqual({ type: 'report' })
  })

  it("CasesService.linkContact and linkReportCase refuse ids outside the record's hub", async () => {
    await expect(svc.cases.linkContact(recordA, contactB, 'subject', ADMIN_A.pubkey)).rejects.toMatchObject({ status: 404 })
    await expect(svc.cases.linkReportCase(recordA, reportB, ADMIN_A.pubkey)).rejects.toMatchObject({ status: 404 })
  })

  it('CasesService.list refuses a cross-hub listing while sharing is off, whoever asks', async () => {
    await settings.setCrossHubSharingEnabled({ enabled: false })
    await expect(
      svc.cases.list({ hubId: HUB_A, crossHub: { hubIds: null, requestingPubkey: SUPER.pubkey } }),
    ).rejects.toMatchObject({ status: 403 })
    await settings.setCrossHubSharingEnabled({ enabled: true })
    await expect(
      svc.cases.list({ hubId: HUB_A, crossHub: { hubIds: null, requestingPubkey: SUPER.pubkey } }),
    ).resolves.toBeDefined()
  })
})
