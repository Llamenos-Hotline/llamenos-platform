/**
 * The records router never reaches across hubs (#2478), against real
 * PostgreSQL, Bun-native driver, through the real router behind the real
 * `hubContext`.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/records-hub-scope.test.ts
 *
 * An automated hook flagged three sites in `routes/records.ts` as possible
 * cross-hub access. Each is exercised here with a victim row that genuinely
 * belongs to hub B and an attacker who administers hub A only (hub-admin
 * holds `cases:*`, which is why `cases:read-cross-hub` is NOT a super-admin-only
 * permission inside a hub):
 *
 *   - `GET /?crossHub=true` replaced the hub filter with "my pubkey is in the
 *     record's summary envelopes", checked against hub A's permissions. A
 *     pubkey that is in hub B's envelopes without being entitled to hub B now
 *     (a removed member, whose envelopes are rewrapped lazily) listed hub B.
 *   - `GET /interactions/by-source/:sourceId` looked a source up across ALL
 *     hubs and returned the other hub's case id.
 *   - `POST /convert-from-report` fetched the report by id alone, so hub A's
 *     admin could create a case from — and flip the conversion status of —
 *     hub B's report.
 *   - `GET /by-number/:number` looked the number up across all hubs, so two
 *     hubs that each use `CASE-1` answered each other's lookups with the wrong
 *     row.
 *
 * What it asserts: the foreign row is never returned or written, the answer
 * for a foreign row is byte-identical to the answer for an id that does not
 * exist, and the legitimate paths (own hub, a member of both hubs, a
 * super-admin) still work.
 *
 * Requires postgres at DATABASE_URL with migrations applied, and the Rust
 * crypto library for `publishEvent` (LLAMENOS_CRYPTO_LIB). Everything created
 * here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { caseInteractions, caseRecords, conversations, entityTypeDefinitions, hubs, reportCases } from '../../db/schema'
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
const audit = new AuditService(db)
const svc = {
  settings: new SettingsService(db),
  audit,
  cases: new CasesService(db),
  // The auto-assign branch of convert-from-report reads these; the entity type
  // seeded here has autoAssign off, so they are never reached.
  shifts: { getCurrentVolunteers: async () => [] as string[] },
  identity: { getUsers: async () => ({ users: [] }) },
}

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-rec-a-${suffix}`
const HUB_B = `hub-rec-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
/** A schema-valid 64-char lowercase hex string, unique to this run. */
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')

interface Actor { pubkey: string; roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }
/** Administers hub A and nothing else — the attacker in every cross-hub case. */
const ADMIN_A: Actor = { pubkey: hex('a1'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }] }
/** Administers hub B and nothing else — owns the victim data. */
const ADMIN_B: Actor = { pubkey: hex('b1'), roles: [], hubRoles: [{ hubId: HUB_B, roleIds: ['role-hub-admin'] }] }
/** Belongs to BOTH hubs (the multi-hub axiom). */
const BOTH: Actor = {
  pubkey: hex('c1'),
  roles: [],
  hubRoles: [
    { hubId: HUB_A, roleIds: ['role-hub-admin'] },
    { hubId: HUB_B, roleIds: ['role-hub-admin'] },
  ],
}
/** Global super-admin: the one actor `cases:read-cross-hub` is meant for. */
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

const SHARED_NUMBER = `CASE-${suffix}`
const ONLY_B_NUMBER = `ONLYB-${suffix}`
const ENTITY_TYPE = crypto.randomUUID()
/** A real entity type of hub A: convert-from-report refuses an unknown or foreign one (#2605). */
let hubAType = ''
let priorCrossHub = false
const MISSING_ID = crypto.randomUUID()

interface HubData { recordId: string; reportId: string; sourceId: string }
const data = {} as Record<'A' | 'B', HubData>

async function seedHub(hubId: string, owner: Actor, numbers: string[], sealedTo: string[]): Promise<HubData> {
  const envelopes = sealedTo.map(pubkey => ({ pubkey, enc: 'b'.repeat(64), ct: 'c'.repeat(32) }))
  const [record] = await db.insert(caseRecords).values({
    hubId, entityTypeId: ENTITY_TYPE, caseNumber: numbers[0], statusHash: 'open', createdBy: owner.pubkey,
    summaryEnvelopes: envelopes,
  }).returning()
  for (const extra of numbers.slice(1)) {
    await db.insert(caseRecords).values({
      hubId, entityTypeId: ENTITY_TYPE, caseNumber: extra, statusHash: 'open', createdBy: owner.pubkey,
      summaryEnvelopes: envelopes,
    })
  }
  const [report] = await db.insert(conversations).values({
    hubId, channelType: 'web', contactIdentifierHash: hex('f1'), metadata: { type: 'report' },
  }).returning()
  const sourceId = crypto.randomUUID()
  await db.insert(caseInteractions).values({
    caseId: record.id, interactionType: 'note', sourceId, authorPubkey: owner.pubkey,
    interactionTypeHash: 'note',
  })
  return { recordId: record.id, reportId: report.id, sourceId }
}

beforeAll(async () => {
  // The cross-hub list is the deployment's opt-in (#2605): these cases are about
  // WHICH hubs it reaches once sharing is on, so the switch is set explicitly.
  priorCrossHub = (await svc.settings.getCrossHubSharingEnabled()).enabled
  await svc.settings.setCrossHubSharingEnabled({ enabled: true })
  for (const [id, owner] of [[HUB_A, ADMIN_A], [HUB_B, ADMIN_B]] as const) {
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: owner.pubkey })
  }
  // Hub A's admin is sealed into hub B's record envelopes: they once belonged
  // to hub B (or were sealed there as a reader) and are not entitled to it now.
  // That is the case that distinguishes "the envelope says so" from "the
  // caller may read this hub".
  hubAType = (await svc.settings.createEntityType({
    hubId: HUB_A, name: 'scope_a', label: 'scope_a', labelPlural: 'scope_as', category: 'case',
    statuses: [{ value: 'open', label: 'Open', order: 0 }], defaultStatus: 'open', closedStatuses: [],
    fields: [], numberingEnabled: false,
  })).id
  data.A = await seedHub(HUB_A, ADMIN_A, [SHARED_NUMBER], [ADMIN_A.pubkey, BOTH.pubkey, SUPER.pubkey])
  data.B = await seedHub(HUB_B, ADMIN_B, [SHARED_NUMBER, ONLY_B_NUMBER], [ADMIN_B.pubkey, ADMIN_A.pubkey, BOTH.pubkey, SUPER.pubkey])
})

afterAll(async () => {
  const ids = [HUB_A, HUB_B]
  const rows = await db.select({ id: caseRecords.id }).from(caseRecords).where(inArray(caseRecords.hubId, ids))
  const caseIds = rows.map(r => r.id)
  if (caseIds.length > 0) {
    await db.delete(caseInteractions).where(inArray(caseInteractions.caseId, caseIds))
    await db.delete(reportCases).where(inArray(reportCases.caseId, caseIds))
  }
  await db.delete(caseRecords).where(inArray(caseRecords.hubId, ids))
  await db.delete(conversations).where(inArray(conversations.hubId, ids))
  await db.delete(entityTypeDefinitions).where(inArray(entityTypeDefinitions.hubId, ids))
  await db.delete(hubs).where(inArray(hubs.id, ids))
  await svc.settings.setCrossHubSharingEnabled({ enabled: priorCrossHub })
})

const recordHubs = (json: Record<string, unknown>) =>
  (json.records as { hubId: string | null }[]).map(r => r.hubId)

// ── crossHub list ──────────────────────────────────────────────────

describe('GET /?crossHub=true', () => {
  it("a hub A admin sealed into hub B's envelopes lists only hub A", async () => {
    const res = await call(ADMIN_A, HUB_A, 'GET', '?crossHub=true')
    expect(res.status).toBe(200)
    const hubIds = recordHubs(res.json)
    expect(hubIds).toContain(HUB_A)
    expect(hubIds).not.toContain(HUB_B)
  })

  it('a hub A admin gets no hub B row, and no hub B total, through any filter', async () => {
    const res = await call(ADMIN_A, HUB_A, 'GET', `?crossHub=true&entityTypeId=${ENTITY_TYPE}`)
    expect(res.status).toBe(200)
    expect(recordHubs(res.json)).toEqual([HUB_A])
    expect(res.json.total).toBe(1)
  })

  it('a member of both hubs lists both, since they hold cases:read-cross-hub in each', async () => {
    const res = await call(BOTH, HUB_A, 'GET', `?crossHub=true&entityTypeId=${ENTITY_TYPE}`)
    expect(res.status).toBe(200)
    expect(new Set(recordHubs(res.json))).toEqual(new Set([HUB_A, HUB_B]))
  })

  it('a super-admin lists every hub that sealed a record to them', async () => {
    const res = await call(SUPER, HUB_A, 'GET', `?crossHub=true&entityTypeId=${ENTITY_TYPE}`)
    expect(res.status).toBe(200)
    expect(new Set(recordHubs(res.json))).toEqual(new Set([HUB_A, HUB_B]))
  })

  it('without crossHub the list stays on the path hub', async () => {
    const res = await call(BOTH, HUB_A, 'GET', `?entityTypeId=${ENTITY_TYPE}`)
    expect(recordHubs(res.json)).toEqual([HUB_A])
  })
})

// ── by-source ──────────────────────────────────────────────────────

describe('GET /interactions/by-source/:sourceId', () => {
  it("a hub A admin cannot learn that hub B's source is linked, or to which case", async () => {
    const cross = await call(ADMIN_A, HUB_A, 'GET', `/interactions/by-source/${data.B.sourceId}`)
    const missing = await call(ADMIN_A, HUB_A, 'GET', `/interactions/by-source/${MISSING_ID}`)
    expect(cross.json).toEqual({ linked: false })
    expect(cross.text).toBe(missing.text)
    expect(cross.text).not.toContain(data.B.recordId)
  })

  it("hub B's admin still sees their own source linked", async () => {
    const res = await call(ADMIN_B, HUB_B, 'GET', `/interactions/by-source/${data.B.sourceId}`)
    expect(res.json.linked).toBe(true)
    expect(res.json.caseId).toBe(data.B.recordId)
  })

  it("the same source is not linked through hub A's URL even for a member of both hubs", async () => {
    const res = await call(BOTH, HUB_A, 'GET', `/interactions/by-source/${data.B.sourceId}`)
    expect(res.json).toEqual({ linked: false })
  })
})

// ── convert-from-report ────────────────────────────────────────────

describe('POST /convert-from-report', () => {
  const reportRow = async (id: string) =>
    (await db.select().from(conversations).where(eq(conversations.id, id)))[0]

  it("a hub A admin cannot convert hub B's report: 404, identical to a missing id, nothing written", async () => {
    const before = await reportRow(data.B.reportId)
    const cross = await call(ADMIN_A, HUB_A, 'POST', '/convert-from-report', { reportId: data.B.reportId, entityTypeId: hubAType })
    const missing = await call(ADMIN_A, HUB_A, 'POST', '/convert-from-report', { reportId: MISSING_ID, entityTypeId: hubAType })

    expect(cross.status).toBe(404)
    expect(missing.status).toBe(404)
    // The service's own message names the id asked for; apart from that id the
    // two answers are the same.
    expect(String(cross.json.error).replace(data.B.reportId, '<id>'))
      .toBe(String(missing.json.error).replace(MISSING_ID, '<id>'))

    const after = await reportRow(data.B.reportId)
    expect(after.metadata).toEqual(before.metadata)
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect(await db.select().from(reportCases).where(eq(reportCases.reportId, data.B.reportId))).toEqual([])
    const linked = await db.select().from(caseInteractions).where(eq(caseInteractions.sourceId, data.B.reportId))
    expect(linked).toEqual([])
  })

  it("converts a report of the path hub into a case of that hub", async () => {
    const res = await call(ADMIN_A, HUB_A, 'POST', '/convert-from-report', { reportId: data.A.reportId, entityTypeId: hubAType })
    expect(res.status).toBe(201)
    const [created] = await db.select().from(caseRecords).where(eq(caseRecords.id, res.json.recordId as string))
    expect(created.hubId).toBe(HUB_A)
    expect((await reportRow(data.A.reportId)).metadata).toMatchObject({ conversionStatus: 'completed' })
  })
})

// ── by-number ──────────────────────────────────────────────────────

describe('GET /by-number/:number', () => {
  it('two hubs that each use the same case number each get their own record', async () => {
    const a = await call(ADMIN_A, HUB_A, 'GET', `/by-number/${SHARED_NUMBER}`)
    const b = await call(ADMIN_B, HUB_B, 'GET', `/by-number/${SHARED_NUMBER}`)
    expect(a.status).toBe(200)
    expect(a.json.id).toBe(data.A.recordId)
    expect(b.status).toBe(200)
    expect(b.json.id).toBe(data.B.recordId)
  })

  it("a number that exists only in hub B is a 404 through hub A, same as a missing number", async () => {
    const cross = await call(ADMIN_A, HUB_A, 'GET', `/by-number/${ONLY_B_NUMBER}`)
    const missing = await call(ADMIN_A, HUB_A, 'GET', '/by-number/NO-SUCH-NUMBER')
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
  })
})
