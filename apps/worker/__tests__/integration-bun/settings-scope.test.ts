/**
 * Deployment-wide settings cannot be written through a hub's URL (#2367),
 * against real PostgreSQL, Bun-native driver, through the real routers mounted
 * the way `app.ts` mounts them (`__tests__/unit/settings-scope-mounts.test.ts`
 * pins that `app.ts` really does).
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/settings-scope.test.ts
 *
 * The defect: the settings and CMS routers were each mounted at `/api/settings`
 * AND `/api/hubs/:hubId/settings`. The default hub admin role holds `settings:*`
 * in its hub, and every handler below calls a service that takes no hub id — so
 * hub A's admin wrote the ONE deployment row every hub reads: the messaging
 * sender credentials and webhook secret all hubs send through, the login
 * policy, the custom-field and report-type vocabularies, TTLs, geocoding, setup
 * state, the cross-hub switch, and (via templates/apply) case management for
 * every hub.
 *
 * Every case asserts on the ROW, not the status code: a test that checked for
 * 200 passed against the defect, which is how it survived. For each route:
 *   - hub A's admin calls it under `/api/hubs/A/settings/...`: refused, and the
 *     deployment column is byte-identical afterwards;
 *   - a holder of the instance permission calls the unscoped route: the
 *     deployment column changes to what was sent. (So the fix is a scope fix,
 *     not a blanket break.)
 *
 * The deployment row is shared by every test database user, so it is
 * snapshotted before and restored after every case. Hubs and per-hub rows
 * created here are removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import {
  customFieldDefinitions,
  entityTypeDefinitions,
  hubs,
  relationshipTypeDefinitions,
  reportTypeDefinitions,
  systemSettings,
} from '../../db/schema'
import { AuditService } from '../../services/audit'
import { IdentityService } from '../../services/identity'
import { ServiceError, SettingsService } from '../../services/settings'
import { hubContext } from '../../middleware/hub'
import settingsRoutes, { hubSettingsRoutes } from '../../routes/settings'
import entitySchemaRoutes, { hubEntitySchemaRoutes } from '../../routes/entity-schema'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const svc = {
  settings: new SettingsService(db),
  audit: new AuditService(db),
  identity: new IdentityService(db),
}

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-scope-a-${suffix}`
const HUB_B = `hub-scope-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')
/** Marks every value an attacker sends, so a leaked write is unmistakable. */
const MARK = `HIJACK-${suffix}`

interface Actor { pubkey: string; roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }
/** Administers hub A and nothing else — the default hub admin bundle, `settings:*` included. */
const ADMIN_A: Actor = { pubkey: hex('a1'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }] }
/** A member of hub A with no global role — reads the vocabulary a note is written in. */
const VOLUNTEER_A: Actor = { pubkey: hex('v1'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-volunteer'] }] }
/** Holds the instance permission: the one who may change the deployment row. */
const INSTANCE: Actor = { pubkey: hex('c1'), roles: ['role-super-admin'], hubRoles: [] }

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
  // Mounted as app.ts mounts them.
  app.route('/api/settings/cms', entitySchemaRoutes)
  app.route('/api/settings', settingsRoutes)
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/settings/cms', hubEntitySchemaRoutes)
  hubScoped.route('/settings', hubSettingsRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  // As app.ts: anything unmatched is a 404.
  app.all('*', (c) => c.json({ error: 'Not Found' }, 404))
  return app
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

async function call(actor: Actor, method: string, url: string, body?: unknown) {
  const res = await appAs(actor).request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ENV)
  return { status: res.status, text: await res.text() }
}

type SettingsRow = typeof systemSettings.$inferSelect
async function deploymentRow(): Promise<SettingsRow> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, 1))
  return row
}
const customFieldRows = () => db.select().from(customFieldDefinitions).orderBy(customFieldDefinitions.id)

let savedRow: SettingsRow
let savedFields: Awaited<ReturnType<typeof customFieldRows>>

/** Put the deployment row and the custom-field vocabulary back exactly as found. */
async function restoreDeployment() {
  const { id: _id, ...columns } = savedRow
  await db.update(systemSettings).set(columns).where(eq(systemSettings.id, 1))
  await db.delete(customFieldDefinitions)
  if (savedFields.length > 0) await db.insert(customFieldDefinitions).values(savedFields)
}

/**
 * A deployment report type for the PATCH/DELETE cases to aim at, plus a second
 * so the target is never the last active one (which the service refuses to
 * archive). Both live in the restored row.
 */
let reportTypeId = ''

beforeAll(async () => {
  await svc.settings.getSpamSettings() // the singleton row exists from here on
  savedRow = await deploymentRow()
  savedFields = await customFieldRows()
  await db.insert(hubs).values([
    { id: HUB_A, name: HUB_A, slug: HUB_A, createdBy: ADMIN_A.pubkey },
    { id: HUB_B, name: HUB_B, slug: HUB_B, createdBy: INSTANCE.pubkey },
  ])
})

afterEach(restoreDeployment)

afterAll(async () => {
  await restoreDeployment()
  for (const table of [entityTypeDefinitions, relationshipTypeDefinitions, reportTypeDefinitions]) {
    await db.delete(table).where(inArray(table.hubId, [HUB_A, HUB_B]))
  }
  await db.delete(hubs).where(inArray(hubs.id, [HUB_A, HUB_B]))
})

interface DeploymentCase {
  route: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: () => string
  body: (current: SettingsRow) => unknown
  /** The slice of deployment state this route writes. */
  read: () => Promise<unknown>
  /** Optional per-case seeding, run before the snapshot is taken. */
  seed?: () => Promise<void>
}

const column = <K extends keyof SettingsRow>(k: K) => async () => (await deploymentRow())[k]

const seedReportType = async () => {
  reportTypeId = (await svc.settings.createReportType({ name: `Seed ${suffix}` })).id
  await svc.settings.createReportType({ name: `Seed spare ${suffix}` })
}

const CASES: DeploymentCase[] = [
  {
    route: 'PATCH /messaging',
    method: 'PATCH',
    path: () => '/messaging',
    body: () => ({
      sms: { enabled: true, accountSid: `AC${'0'.repeat(32)}`, authToken: MARK, phoneNumber: '+15550001111' },
      telegram: { enabled: true, botToken: MARK, webhookSecret: `${MARK}-secret-that-is-long-enough` },
    }),
    read: column('messagingConfig'),
  },
  {
    route: 'PATCH /webauthn',
    method: 'PATCH',
    path: () => '/webauthn',
    body: (row) => ({ requireForUsers: !((row.webauthnSettings as { requireForUsers?: boolean } | null)?.requireForUsers ?? false) }),
    read: column('webauthnSettings'),
  },
  {
    route: 'PUT /custom-fields',
    method: 'PUT',
    path: () => '/custom-fields',
    body: () => ({ fields: [{ id: crypto.randomUUID(), name: `hijack_${rand}`, label: MARK, type: 'text', required: false, visibleToUsers: true, editableByUsers: true, order: 0 }] }),
    read: customFieldRows,
  },
  {
    route: 'PATCH /transcription',
    method: 'PATCH',
    path: () => '/transcription',
    body: (row) => ({ globalEnabled: !(row.transcriptionEnabled ?? true), allowUserOptOut: !(row.allowUserTranscriptionOptOut ?? false) }),
    read: async () => { const r = await deploymentRow(); return [r.transcriptionEnabled, r.allowUserTranscriptionOptOut] },
  },
  {
    route: 'PATCH /setup',
    method: 'PATCH',
    path: () => '/setup',
    body: () => ({ step: MARK }),
    read: column('setupState'),
  },
  {
    route: 'POST /report-types',
    method: 'POST',
    path: () => '/report-types',
    body: () => ({ name: MARK }),
    read: column('reportTypes'),
  },
  {
    route: 'PATCH /report-types/:id',
    method: 'PATCH',
    path: () => `/report-types/${reportTypeId}`,
    body: () => ({ name: MARK }),
    read: column('reportTypes'),
    seed: seedReportType,
  },
  {
    route: 'DELETE /report-types/:id',
    method: 'DELETE',
    path: () => `/report-types/${reportTypeId}`,
    body: () => undefined,
    read: column('reportTypes'),
    seed: seedReportType,
  },
  {
    route: 'PATCH /ttl',
    method: 'PATCH',
    path: () => '/ttl',
    body: () => ({ captchaChallenge: 123_457 }),
    read: column('ttlOverrides'),
  },
  {
    route: 'PUT /geocoding',
    method: 'PUT',
    path: () => '/geocoding',
    body: () => ({ provider: 'opencage', countries: ['zz'], enabled: true, apiKey: MARK }),
    read: column('geocodingConfig'),
  },
  {
    route: 'PUT /cms/cross-hub',
    method: 'PUT',
    path: () => '/cms/cross-hub',
    body: (row) => ({ enabled: !(row.crossHubSharingEnabled ?? false) }),
    read: column('crossHubSharingEnabled'),
  },
]

describe('a hub admin cannot write deployment-wide settings through their hub (#2367)', () => {
  it.each(CASES.map(c => [c.route, c] as const))('%s under /hubs/A is refused and the deployment row is untouched', async (_route, c) => {
    await c.seed?.()
    const before = await c.read()
    const res = await call(ADMIN_A, c.method, `/api/hubs/${HUB_A}/settings${c.path()}`, c.body(await deploymentRow()))
    // The row first: this is the assertion the defect fails. The status says why.
    expect(await c.read()).toEqual(before)
    expect(res.status).toBe(404)
  })

  it.each(CASES.map(c => [c.route, c] as const))('%s unscoped, by the instance permission, still writes the deployment row', async (_route, c) => {
    await c.seed?.()
    const before = await c.read()
    const res = await call(INSTANCE, c.method, `/api/settings${c.path()}`, c.body(await deploymentRow()))
    expect(res.status).toBeLessThan(300)
    expect(await c.read()).not.toEqual(before)
  })
})

describe('the shared messaging sender (#2367)', () => {
  // The single most valuable assertion here: hub A's admin can neither read nor
  // replace the credentials and webhook secret EVERY hub sends through.
  const SECRET = `deployment-sender-${suffix}`

  it("hub A's admin cannot read or replace the deployment's sender credentials", async () => {
    await svc.settings.updateMessagingConfig({
      sms: { enabled: true, accountSid: `AC${'1'.repeat(32)}`, authToken: SECRET, phoneNumber: '+15550002222' },
    } as Parameters<SettingsService['updateMessagingConfig']>[0])
    const before = (await deploymentRow()).messagingConfig

    const read = await call(ADMIN_A, 'GET', `/api/hubs/${HUB_A}/settings/messaging`)
    expect(read.status).toBe(404)
    expect(read.text).not.toContain(SECRET)

    const write = await call(ADMIN_A, 'PATCH', `/api/hubs/${HUB_A}/settings/messaging`, {
      sms: { enabled: true, accountSid: `AC${'0'.repeat(32)}`, authToken: MARK, phoneNumber: '+15550001111' },
    })
    expect(write.status).toBe(404)

    const after = (await deploymentRow()).messagingConfig
    expect(after).toEqual(before)
    expect(JSON.stringify(after)).toContain(SECRET)
    expect(JSON.stringify(after)).not.toContain(MARK)
    // And what the messaging router actually sends with is the operator's config.
    expect(JSON.stringify(await svc.settings.getMessagingConfig())).toContain(SECRET)
  })

  it('the instance permission on the unscoped route replaces them', async () => {
    const res = await call(INSTANCE, 'PATCH', '/api/settings/messaging', {
      sms: { enabled: true, accountSid: `AC${'0'.repeat(32)}`, authToken: MARK, phoneNumber: '+15550001111' },
    })
    expect(res.status).toBe(200)
    expect(JSON.stringify((await deploymentRow()).messagingConfig)).toContain(MARK)
  })
})

describe('templates/apply under a hub turns on that hub only (#2367)', () => {
  it("enables case management in hub A, not in the deployment default hub B inherits", async () => {
    await db.update(systemSettings).set({ caseManagementEnabled: false }).where(eq(systemSettings.id, 1))
    expect((await svc.settings.getCaseManagementEnabled(HUB_B)).enabled).toBe(false)

    const res = await call(ADMIN_A, 'POST', `/api/hubs/${HUB_A}/settings/cms/templates/apply`, { templateId: 'general-hotline' })
    expect(res.status).toBe(201)

    expect((await deploymentRow()).caseManagementEnabled).toBe(false)
    expect((await svc.settings.getHubSettings(HUB_A)).caseManagementEnabled).toBe(true)
    expect((await svc.settings.getCaseManagementEnabled(HUB_A)).enabled).toBe(true)
    expect((await svc.settings.getCaseManagementEnabled(HUB_B)).enabled).toBe(false)
    // The template's definitions landed in hub A's rows.
    const rows = await db.select().from(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, HUB_A))
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('the custom-field vocabulary stays readable inside a hub (#2367)', () => {
  // Load-bearing: iOS loads a note's custom fields through the hub mount, and a
  // hub-only member has no global role for the unscoped route to accept.
  it("a hub-only member reads the deployment's fields under their hub, and cannot write them", async () => {
    await svc.settings.updateCustomFields({ fields: [{ id: crypto.randomUUID(), name: `shared_${rand}`, label: 'Shared', type: 'text', required: false, visibleToUsers: true, editableByUsers: true, order: 0 }] } as Parameters<SettingsService['updateCustomFields']>[0])
    const read = await call(VOLUNTEER_A, 'GET', `/api/hubs/${HUB_A}/settings/custom-fields`)
    expect(read.status).toBe(200)
    expect((JSON.parse(read.text) as { fields: { name: string }[] }).fields.map(f => f.name)).toContain(`shared_${rand}`)
    expect((await call(VOLUNTEER_A, 'GET', '/api/settings/custom-fields')).status).toBe(403)

    const before = await customFieldRows()
    const write = await call(ADMIN_A, 'PUT', `/api/hubs/${HUB_A}/settings/custom-fields`, { fields: [] })
    expect(await customFieldRows()).toEqual(before)
    expect(write.status).toBe(404)
  })
})
