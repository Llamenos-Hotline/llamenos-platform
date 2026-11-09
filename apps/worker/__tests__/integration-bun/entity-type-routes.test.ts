/**
 * `/settings/cms/entity-types` through the REAL mounted router against the REAL
 * `SettingsService` and real PostgreSQL (Bun-native driver).
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/entity-type-routes.test.ts
 *
 * Why this file exists (#2620): `GET /entity-types/:id` was served by
 * `createEntityRouter`, which reaches a service method by NAME through a
 * `(...args: unknown[])` cast. When `getEntityTypeById` gained a required
 * `hubId`, the factory kept calling it with the id alone, so every lookup
 * compiled to `WHERE hub_id = NULL` and returned 404 for every entity type.
 * `tsc` cannot see through that cast and the unit tests stub the service, so
 * nothing failed. A stubbed service cannot catch this class of break; only the
 * real router driving the real service can. That is what is asserted here, on
 * both mounts the router is served from (`/api/settings/cms` and
 * `/api/hubs/:hubId/settings/cms`), and for the factory-dispatched
 * POST / PATCH / DELETE that share the dispatch table.
 *
 * Requires postgres at DATABASE_URL with migrations applied. Everything created
 * here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { entityTypeDefinitions, hubs } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { ServiceError, SettingsService } from '../../services/settings'
import { hubContext } from '../../middleware/hub'
import entitySchemaRoutes, { hubEntitySchemaRoutes } from '../../routes/entity-schema'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const settings = new SettingsService(db)
const svc = { settings, audit: new AuditService(db) }

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `et-routes-a-${suffix}`
const HUB_B = `et-routes-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')

interface Actor { pubkey: string; roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }
/** Administers hub A and nothing else. */
const ADMIN_A: Actor = { pubkey: hex('a1'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }] }
/** Administers hub B and nothing else — owns the victim row. */
const ADMIN_B: Actor = { pubkey: hex('b1'), roles: [], hubRoles: [{ hubId: HUB_B, roleIds: ['role-hub-admin'] }] }
/** Global super-admin, on the unscoped mount. */
const SUPER: Actor = { pubkey: hex('d1'), roles: ['role-super-admin'], hubRoles: [] }

/** The app as `app.ts` mounts it: the unscoped mount and the hub-scoped one. */
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
  app.route('/api/settings/cms', entitySchemaRoutes)
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/settings/cms', hubEntitySchemaRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

async function call(actor: Actor, path: string, method = 'GET', body?: unknown) {
  const res = await appAs(actor).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ENV)
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* not json */ }
  return { status: res.status, text, json }
}

const inHub = (hubId: string, suffixPath: string) => `/api/hubs/${hubId}/settings/cms/entity-types${suffixPath}`
const unscoped = (suffixPath: string, query = '') => `/api/settings/cms/entity-types${suffixPath}${query}`

const typeBody = (hubId: string, name: string, extra: Record<string, unknown> = {}) => ({
  hubId,
  name,
  label: name,
  labelPlural: `${name}s`,
  category: 'case',
  statuses: [{ value: 'open', label: 'Open', order: 0 }],
  defaultStatus: 'open',
  closedStatuses: [],
  fields: [],
  ...extra,
})

const MISSING_ID = crypto.randomUUID()
let typeA = ''
let typeB = ''
let typePlatform = ''

beforeAll(async () => {
  for (const [id, owner] of [[HUB_A, ADMIN_A], [HUB_B, ADMIN_B]] as const) {
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: owner.pubkey })
  }
  typeA = (await settings.createEntityType(typeBody(HUB_A, 'route_a'))).id
  typeB = (await settings.createEntityType(typeBody(HUB_B, 'route_b'))).id
  // The platform's own entity types are stored under hub ''.
  typePlatform = (await settings.createEntityType(typeBody('', `route_platform_${rand}`))).id
})

afterAll(async () => {
  // The platform row is removed by id: hub '' holds the deployment's own types too.
  await db.delete(entityTypeDefinitions).where(inArray(entityTypeDefinitions.hubId, [HUB_A, HUB_B]))
  await db.delete(entityTypeDefinitions).where(eq(entityTypeDefinitions.id, typePlatform))
  await db.delete(hubs).where(inArray(hubs.id, [HUB_A, HUB_B]))
})

describe('GET /entity-types/:id — hub-scoped mount', () => {
  it("returns the hub's own entity type, with its real content", async () => {
    const res = await call(ADMIN_A, inHub(HUB_A, `/${typeA}`))
    expect(res.status).toBe(200)
    expect(res.json.id).toBe(typeA)
    expect(res.json.name).toBe('route_a')
    expect(res.json.hubId).toBe(HUB_A)
  })

  it("refuses another hub's entity type, byte-identically to one that does not exist", async () => {
    const cross = await call(ADMIN_A, inHub(HUB_A, `/${typeB}`))
    const missing = await call(ADMIN_A, inHub(HUB_A, `/${MISSING_ID}`))
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect(cross.json.id).toBeUndefined()
  })

  it('serves hub B its own type — the refusal above is the hub, not the id', async () => {
    const res = await call(ADMIN_B, inHub(HUB_B, `/${typeB}`))
    expect(res.status).toBe(200)
    expect(res.json.id).toBe(typeB)
  })

  it('does not honour a ?hubId= that disagrees with the path hub', async () => {
    const res = await call(ADMIN_A, inHub(HUB_A, `/${typeB}?hubId=${HUB_B}`))
    expect(res.status).toBe(403)
  })
})

describe('GET /entity-types/:id — unscoped mount', () => {
  it("returns a platform-level entity type (stored under hub '')", async () => {
    const res = await call(SUPER, unscoped(`/${typePlatform}`))
    expect(res.status).toBe(200)
    expect(res.json.id).toBe(typePlatform)
  })

  it("does not return a hub's type when no hub is named", async () => {
    const res = await call(SUPER, unscoped(`/${typeA}`))
    expect(res.status).toBe(404)
  })

  it('returns a hub type when the caller names that hub and can read settings there', async () => {
    const res = await call(SUPER, unscoped(`/${typeA}`, `?hubId=${HUB_A}`))
    expect(res.status).toBe(200)
    expect(res.json.id).toBe(typeA)
  })

  it('refuses a named hub the caller cannot read settings in', async () => {
    const res = await call(ADMIN_A, unscoped(`/${typeB}`, `?hubId=${HUB_B}`))
    expect(res.status).toBe(403)
  })
})

// The factory-dispatched verbs share the by-name dispatch table that hid the
// regression. They are driven end to end here so the next signature change to
// any of them fails in a test that runs the real service, not a stub.
describe('POST / PATCH / DELETE /entity-types — factory dispatch against the real service', () => {
  it('creates, updates and deletes an entity type, and the by-id read follows', async () => {
    const created = await call(ADMIN_A, inHub(HUB_A, ''), 'POST', typeBody(HUB_A, 'route_crud'))
    expect(created.status).toBe(201)
    const id = String(created.json.id)
    expect(created.json.hubId).toBe(HUB_A)

    expect((await call(ADMIN_A, inHub(HUB_A, `/${id}`))).json.name).toBe('route_crud')

    const patched = await call(ADMIN_A, inHub(HUB_A, `/${id}`), 'PATCH', { label: 'Renamed' })
    expect(patched.status).toBe(200)
    expect(patched.json.label).toBe('Renamed')
    expect((await call(ADMIN_A, inHub(HUB_A, `/${id}`))).json.label).toBe('Renamed')

    const deleted = await call(ADMIN_A, inHub(HUB_A, `/${id}`), 'DELETE')
    expect(deleted.status).toBe(200)
    expect((await call(ADMIN_A, inHub(HUB_A, `/${id}`))).status).toBe(404)
  })
})
