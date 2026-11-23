/**
 * The WRITE (and by-id read) verbs of `/settings/cms` — entity types, report types,
 * relationship types — through the REAL mounted router against the REAL
 * `EntitySchemaService` / `ReportTypesService` and real PostgreSQL (Bun-native driver).
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/entity-schema-hub-scope.test.ts
 *
 * Why this file exists (#2631): `updateEntityType`, `deleteEntityType`,
 * `getCmsReportTypeById`, `updateCmsReportType`, `deleteCmsReportType`,
 * `updateRelationshipType` and `deleteRelationshipType` took an id and no hub, and
 * `createEntityRouter` reached them by NAME through a `(...args: unknown[])` cast, so
 * the route never asked whose row it was. A caller who administers hub A could
 * `PATCH` or `DELETE` hub B's type through hub A's own URL — a cross-hub write and
 * destroy primitive. `GET /relationship-types` was served by the same factory with
 * no hub argument, so it listed EVERY hub's relationship types on a hub mount.
 *
 * A mocked service cannot detect a missing hub argument, so these drive the real
 * router against the real service, on both mounts (`/api/settings/cms` and
 * `/api/hubs/:hubId/settings/cms`). Every cross-hub request is also followed by a
 * read of the victim row straight from the service: a 404 that still wrote is a
 * failure.
 *
 * Requires postgres at DATABASE_URL with migrations applied. Everything created
 * here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import {
  entityTypeDefinitions,
  relationshipTypeDefinitions,
  reportTypeDefinitions,
  hubs,
} from '../../db/schema'
import { AuditService } from '../../services/audit'
import { ServiceError } from '../../services/service-error'
import { EntitySchemaService } from '../../services/entity-schema'
import { ReportTypesService } from '../../services/report-types'
import { HubService } from '../../services/hubs'
import { hubContext } from '../../middleware/hub'
import entitySchemaRoutes, { hubEntitySchemaRoutes } from '../../routes/entity-schema'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const entitySchema = new EntitySchemaService(db)
const reportTypes = new ReportTypesService(db)
const svc = { entitySchema, reportTypes, hubs: new HubService(db), audit: new AuditService(db) }

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `es-scope-a-${suffix}`
const HUB_B = `es-scope-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')

interface Actor { pubkey: string; roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }
/** Administers hub A and nothing else — the attacker. */
const ADMIN_A: Actor = { pubkey: hex('a2'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }] }
/** Administers hub B and nothing else — owns the victim rows. */
const ADMIN_B: Actor = { pubkey: hex('b2'), roles: [], hubRoles: [{ hubId: HUB_B, roleIds: ['role-hub-admin'] }] }
/** Global super-admin, on the unscoped mount. */
const SUPER: Actor = { pubkey: hex('d2'), roles: ['role-super-admin'], hubRoles: [] }

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

const inHub = (hubId: string, resource: string, tail = '') => `/api/hubs/${hubId}/settings/cms/${resource}${tail}`
const unscoped = (resource: string, tail = '', query = '') => `/api/settings/cms/${resource}${tail}${query}`

const entityBody = (hubId: string, name: string) => ({
  hubId,
  name,
  label: name,
  labelPlural: `${name}s`,
  category: 'case',
  statuses: [{ value: 'open', label: 'Open', order: 0 }],
  defaultStatus: 'open',
  closedStatuses: [],
  fields: [],
})
const reportBody = (hubId: string, name: string) => ({
  hubId,
  name,
  label: name,
  labelPlural: `${name}s`,
  statuses: [{ value: 'open', label: 'Open', order: 0 }],
  defaultStatus: 'open',
  closedStatuses: [],
  fields: [],
})
const relBody = (hubId: string, label: string) => ({
  hubId,
  sourceEntityTypeId: 'src',
  targetEntityTypeId: 'dst',
  cardinality: 'M:N',
  label,
  reverseLabel: `${label}-rev`,
  sourceLabel: 'S',
  targetLabel: 'T',
})

const MISSING_ID = crypto.randomUUID()
const ids = { etA: '', etB: '', rtA: '', rtB: '', relA: '', relB: '' }

beforeAll(async () => {
  for (const [id, owner] of [[HUB_A, ADMIN_A], [HUB_B, ADMIN_B]] as const) {
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: owner.pubkey })
  }
  ids.etA = (await entitySchema.createEntityType(entityBody(HUB_A, 'scope_et_a'))).id
  ids.etB = (await entitySchema.createEntityType(entityBody(HUB_B, 'scope_et_b'))).id
  ids.rtA = (await reportTypes.createCmsReportType(reportBody(HUB_A, 'scope_rt_a'))).id
  ids.rtB = (await reportTypes.createCmsReportType(reportBody(HUB_B, 'scope_rt_b'))).id
  ids.relA = (await entitySchema.createRelationshipType(relBody(HUB_A, 'scope-rel-a'))).id
  ids.relB = (await entitySchema.createRelationshipType(relBody(HUB_B, 'scope-rel-b'))).id
})

afterAll(async () => {
  const hubIds = [HUB_A, HUB_B]
  await db.delete(entityTypeDefinitions).where(inArray(entityTypeDefinitions.hubId, hubIds))
  await db.delete(reportTypeDefinitions).where(inArray(reportTypeDefinitions.hubId, hubIds))
  await db.delete(relationshipTypeDefinitions).where(inArray(relationshipTypeDefinitions.hubId, hubIds))
  await db.delete(hubs).where(inArray(hubs.id, hubIds))
})

/** The victim rows, read straight from the service so a wrongly-answered 404 cannot hide a write. */
const entityB = () => entitySchema.getEntityTypeById(ids.etB, HUB_B)
const reportB = () => reportTypes.getCmsReportTypeById(ids.rtB, HUB_B)
const relB = async () => {
  const [row] = await db.select().from(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.id, ids.relB))
  return row
}

describe('entity types — PATCH / DELETE / customize are bound to the path hub', () => {
  it("refuses to PATCH another hub's type, and writes nothing", async () => {
    const cross = await call(ADMIN_A, inHub(HUB_A, 'entity-types', `/${ids.etB}`), 'PATCH', { label: 'pwned' })
    const missing = await call(ADMIN_A, inHub(HUB_A, 'entity-types', `/${MISSING_ID}`), 'PATCH', { label: 'pwned' })
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect((await entityB()).label).toBe('scope_et_b')
  })

  it("refuses to DELETE another hub's type, and deletes nothing", async () => {
    const cross = await call(ADMIN_A, inHub(HUB_A, 'entity-types', `/${ids.etB}`), 'DELETE')
    const missing = await call(ADMIN_A, inHub(HUB_A, 'entity-types', `/${MISSING_ID}`), 'DELETE')
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect((await entityB()).id).toBe(ids.etB)
  })

  it("refuses to customize another hub's type, and writes nothing", async () => {
    const res = await call(ADMIN_A, inHub(HUB_A, 'entity-types', `/${ids.etB}/customize`), 'PATCH', { label: 'pwned' })
    expect(res.status).toBe(404)
    expect((await entityB()).label).toBe('scope_et_b')
  })

  it("still updates and customizes the hub's own type", async () => {
    const patched = await call(ADMIN_A, inHub(HUB_A, 'entity-types', `/${ids.etA}`), 'PATCH', { label: 'mine' })
    expect(patched.status).toBe(200)
    expect(patched.json.label).toBe('mine')
    const custom = await call(ADMIN_A, inHub(HUB_A, 'entity-types', `/${ids.etA}/customize`), 'PATCH', { label: 'mine too' })
    expect(custom.status).toBe(200)
    expect((await entitySchema.getEntityTypeById(ids.etA, HUB_A)).label).toBe('mine too')
  })

  it('on the unscoped mount, no hub named means the platform scope — a hub type is not reachable', async () => {
    const res = await call(SUPER, unscoped('entity-types', `/${ids.etB}`), 'PATCH', { label: 'pwned' })
    expect(res.status).toBe(404)
    expect((await entityB()).label).toBe('scope_et_b')
    const del = await call(SUPER, unscoped('entity-types', `/${ids.etB}`), 'DELETE')
    expect(del.status).toBe(404)
    expect((await entityB()).id).toBe(ids.etB)
  })

  it('on the unscoped mount, a caller cannot name a hub they cannot manage types in', async () => {
    const res = await call(ADMIN_A, unscoped('entity-types', `/${ids.etB}`, `?hubId=${HUB_B}`), 'PATCH', { label: 'pwned' })
    expect(res.status).toBe(403)
    expect((await entityB()).label).toBe('scope_et_b')
    const del = await call(ADMIN_A, unscoped('entity-types', `/${ids.etB}`, `?hubId=${HUB_B}`), 'DELETE')
    expect(del.status).toBe(403)
    expect((await entityB()).id).toBe(ids.etB)
  })

  it('does not honour a ?hubId= that disagrees with the path hub', async () => {
    const res = await call(ADMIN_A, inHub(HUB_A, 'entity-types', `/${ids.etB}?hubId=${HUB_B}`), 'PATCH', { label: 'pwned' })
    expect(res.status).toBe(403)
    expect((await entityB()).label).toBe('scope_et_b')
  })

  it('on the unscoped mount, a caller who can manage types in the named hub may write there', async () => {
    const res = await call(SUPER, unscoped('entity-types', `/${ids.etB}`, `?hubId=${HUB_B}`), 'PATCH', { description: 'by super' })
    expect(res.status).toBe(200)
    expect((await entityB()).description).toBe('by super')
  })
})

describe('report types — every verb is bound to the path hub', () => {
  it("returns the hub's own report type, with its real content", async () => {
    const res = await call(ADMIN_A, inHub(HUB_A, 'report-types', `/${ids.rtA}`))
    expect(res.status).toBe(200)
    expect(res.json.id).toBe(ids.rtA)
    expect(res.json.hubId).toBe(HUB_A)
  })

  it("refuses another hub's report type on read, byte-identically to one that does not exist", async () => {
    const cross = await call(ADMIN_A, inHub(HUB_A, 'report-types', `/${ids.rtB}`))
    const missing = await call(ADMIN_A, inHub(HUB_A, 'report-types', `/${MISSING_ID}`))
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect(cross.json.id).toBeUndefined()
  })

  it("refuses to PATCH another hub's report type, and writes nothing", async () => {
    const res = await call(ADMIN_A, inHub(HUB_A, 'report-types', `/${ids.rtB}`), 'PATCH', { label: 'pwned' })
    expect(res.status).toBe(404)
    expect((await reportB()).label).toBe('scope_rt_b')
  })

  it("refuses to DELETE (archive) another hub's report type, and archives nothing", async () => {
    const res = await call(ADMIN_A, inHub(HUB_A, 'report-types', `/${ids.rtB}`), 'DELETE')
    expect(res.status).toBe(404)
    expect((await reportB()).isArchived).toBe(false)
  })

  it("still updates and archives the hub's own report type", async () => {
    const patched = await call(ADMIN_A, inHub(HUB_A, 'report-types', `/${ids.rtA}`), 'PATCH', { label: 'mine' })
    expect(patched.status).toBe(200)
    expect(patched.json.label).toBe('mine')
    const archived = await call(ADMIN_A, inHub(HUB_A, 'report-types', `/${ids.rtA}`), 'DELETE')
    expect(archived.status).toBe(200)
    expect((await reportTypes.getCmsReportTypeById(ids.rtA, HUB_A)).isArchived).toBe(true)
  })

  it('on the unscoped mount, no hub named means the platform scope', async () => {
    expect((await call(SUPER, unscoped('report-types', `/${ids.rtB}`))).status).toBe(404)
    expect((await call(SUPER, unscoped('report-types', `/${ids.rtB}`), 'PATCH', { label: 'pwned' })).status).toBe(404)
    expect((await call(SUPER, unscoped('report-types', `/${ids.rtB}`), 'DELETE')).status).toBe(404)
    expect((await reportB()).label).toBe('scope_rt_b')
  })

  it('on the unscoped mount, a caller cannot name a hub they cannot read or manage in', async () => {
    const read = await call(ADMIN_A, unscoped('report-types', `/${ids.rtB}`, `?hubId=${HUB_B}`))
    expect(read.status).toBe(403)
    const write = await call(ADMIN_A, unscoped('report-types', `/${ids.rtB}`, `?hubId=${HUB_B}`), 'PATCH', { label: 'pwned' })
    expect(write.status).toBe(403)
    expect((await reportB()).label).toBe('scope_rt_b')
  })

  describe('POST — the hub is bound by the route, not the body', () => {
    const created: string[] = []
    afterAll(async () => {
      if (created.length > 0) await db.delete(reportTypeDefinitions).where(inArray(reportTypeDefinitions.id, created))
    })

    it('a type created on the hub mount with no hubId in the body belongs to that hub', async () => {
      const { hubId: _omit, ...body } = reportBody(HUB_A, 'bound_by_path_rt')
      const res = await call(ADMIN_A, inHub(HUB_A, 'report-types'), 'POST', body)
      expect(res.status).toBe(201)
      created.push(String(res.json.id))
      expect(res.json.hubId).toBe(HUB_A)
    })

    it('refuses a body hubId that names a different hub than the path, and stores nothing', async () => {
      const res = await call(ADMIN_A, inHub(HUB_A, 'report-types'), 'POST', reportBody(HUB_B, 'smuggled_rt'))
      expect(res.status).toBe(403)
      const rows = await db.select().from(reportTypeDefinitions).where(eq(reportTypeDefinitions.name, 'smuggled_rt'))
      expect(rows).toHaveLength(0)
    })

    it('on the unscoped mount, a caller cannot create into a hub they cannot manage types in', async () => {
      const res = await call(ADMIN_A, unscoped('report-types'), 'POST', reportBody(HUB_B, 'unscoped_into_b_rt'))
      expect(res.status).toBe(403)
      const rows = await db.select().from(reportTypeDefinitions).where(eq(reportTypeDefinitions.name, 'unscoped_into_b_rt'))
      expect(rows).toHaveLength(0)
    })
  })
})

describe('relationship types — list and every write are bound to the path hub', () => {
  it("lists only the path hub's relationship types", async () => {
    const res = await call(ADMIN_A, inHub(HUB_A, 'relationship-types'))
    expect(res.status).toBe(200)
    const listed = (res.json.relationshipTypes as { id: string; hubId: string }[])
    expect(listed.map(r => r.id)).toContain(ids.relA)
    expect(listed.map(r => r.id)).not.toContain(ids.relB)
    expect(listed.every(r => r.hubId === HUB_A)).toBe(true)
  })

  it("refuses to PATCH another hub's relationship type, and writes nothing", async () => {
    const cross = await call(ADMIN_A, inHub(HUB_A, 'relationship-types', `/${ids.relB}`), 'PATCH', { label: 'pwned' })
    const missing = await call(ADMIN_A, inHub(HUB_A, 'relationship-types', `/${MISSING_ID}`), 'PATCH', { label: 'pwned' })
    expect(cross.status).toBe(404)
    expect(cross.text).toBe(missing.text)
    expect((await relB()).label).toBe('scope-rel-b')
  })

  it("refuses to DELETE another hub's relationship type, and deletes nothing", async () => {
    const cross = await call(ADMIN_A, inHub(HUB_A, 'relationship-types', `/${ids.relB}`), 'DELETE')
    expect(cross.status).toBe(404)
    expect((await relB())?.id).toBe(ids.relB)
  })

  it("still updates and deletes the hub's own relationship type", async () => {
    const patched = await call(ADMIN_A, inHub(HUB_A, 'relationship-types', `/${ids.relA}`), 'PATCH', { label: 'mine' })
    expect(patched.status).toBe(200)
    expect(patched.json.label).toBe('mine')
    const deleted = await call(ADMIN_A, inHub(HUB_A, 'relationship-types', `/${ids.relA}`), 'DELETE')
    expect(deleted.status).toBe(200)
    const rows = await db.select().from(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.id, ids.relA))
    expect(rows).toHaveLength(0)
  })

  it('on the unscoped mount, no hub named means the platform scope', async () => {
    expect((await call(SUPER, unscoped('relationship-types', `/${ids.relB}`), 'PATCH', { label: 'pwned' })).status).toBe(404)
    expect((await call(SUPER, unscoped('relationship-types', `/${ids.relB}`), 'DELETE')).status).toBe(404)
    expect((await relB()).label).toBe('scope-rel-b')
  })

  it('on the unscoped mount, a caller cannot name a hub they cannot manage types in', async () => {
    const res = await call(ADMIN_A, unscoped('relationship-types', `/${ids.relB}`, `?hubId=${HUB_B}`), 'DELETE')
    expect(res.status).toBe(403)
    expect((await relB())?.id).toBe(ids.relB)
  })

  describe('POST — the hub is bound by the route, not the body', () => {
    const created: string[] = []
    afterAll(async () => {
      if (created.length > 0) await db.delete(relationshipTypeDefinitions).where(inArray(relationshipTypeDefinitions.id, created))
    })

    it('a type created on the hub mount with no hubId in the body belongs to that hub', async () => {
      const { hubId: _omit, ...body } = relBody(HUB_A, 'bound-by-path-rel')
      const res = await call(ADMIN_A, inHub(HUB_A, 'relationship-types'), 'POST', body)
      expect(res.status).toBe(201)
      created.push(String(res.json.id))
      expect(res.json.hubId).toBe(HUB_A)
    })

    it('refuses a body hubId that names a different hub than the path, and stores nothing', async () => {
      const res = await call(ADMIN_A, inHub(HUB_A, 'relationship-types'), 'POST', relBody(HUB_B, 'smuggled-rel'))
      expect(res.status).toBe(403)
      const rows = await db.select().from(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.label, 'smuggled-rel'))
      expect(rows).toHaveLength(0)
    })
  })
})

describe('the victim hub is untouched by every request above', () => {
  it('hub B can still read and use its own rows', async () => {
    expect((await call(ADMIN_B, inHub(HUB_B, 'entity-types', `/${ids.etB}`))).status).toBe(200)
    expect((await call(ADMIN_B, inHub(HUB_B, 'report-types', `/${ids.rtB}`))).status).toBe(200)
    const rels = await call(ADMIN_B, inHub(HUB_B, 'relationship-types'))
    expect((rels.json.relationshipTypes as { id: string }[]).map(r => r.id)).toContain(ids.relB)
  })
})
