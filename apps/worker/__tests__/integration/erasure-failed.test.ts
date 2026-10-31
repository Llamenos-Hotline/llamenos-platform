/**
 * A `failed` erasure request, and a subject with no hub (#2347), against real
 * PostgreSQL, built the way production builds it — `createServices` registers
 * the checks, the `incident-checks` runner evaluates them.
 *
 * #2323 gave an OVERDUE (still `pending`) request an incident. The request
 * that actually failed was, by construction, not overdue, so it reached nobody
 * and nothing ever picked it up again; and a subject belonging to no hub had no
 * hub for an incident to open in. A test asserting only the hub-attributed,
 * overdue path passes against that old behaviour — so every scenario here fails
 * the way production fails and asserts both who learns of it and who does not:
 *
 *   - the failure is forced by a REAL tick of the erasure-expiry worker whose
 *     shred executor throws, not by writing `status = 'failed'` — except where
 *     a scenario needs a request in a known state, and says so;
 *   - a holder of `erasure:admin` in the hub learns of it; a member of the same
 *     hub without that permission does not; neither can retry or abandon it;
 *   - retry puts the request back in the queue (and the incident ends);
 *     abandon records who/when/why on the row AND in the audit chain, and an
 *     abandoned request is not a completed one;
 *   - a subject with no hub opens a PLATFORM incident, readable by the platform
 *     permission and by nobody holding only hub roles.
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'
import type { AppEnv } from '../../types'
import { hubContext } from '../../middleware/hub'
import incidentsRoutes from '../../routes/incidents'
import platformIncidentsRoutes from '../../routes/platform-incidents'
import erasureRoutes from '../../routes/erasure'
import * as schema from '../../db/schema'
import type { HubIncidentRow } from '../../db/schema/incidents'
import type { IncidentState } from '@protocol/schemas/incidents'
import { insertHubFounder } from '../helpers/hub-founder'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import type { IncidentNotifier } from '../../services/incidents'
import type { HubShredService } from '../../services/hub-shred'
import { erasureExpiryTick } from '../../lib/erasure-expiry-worker'

const fresh = freshHubDb('erasure_failed')

let services: Services
const sent: { incidentId: string; hubId: string | null; state: IncidentState }[] = []
const interrupted: { incidentId: string; hubId: string | null; state: IncidentState }[] = []
const notifier: IncidentNotifier = {
  async relay(incident, state) {
    sent.push({ incidentId: incident.id, hubId: incident.hubId, state })
  },
  async interrupt(incident: HubIncidentRow, state: IncidentState) {
    interrupted.push({ incidentId: incident.id, hubId: incident.hubId, state })
  },
}

beforeAll(async () => {
  await fresh.setup()
  services = createServices(fresh.db, { hmacSecret: 'a'.repeat(64), serverKek: 'c'.repeat(64), env: { ENVIRONMENT: 'test' } })
  services.incidents.setNotifier(notifier)
}, 180_000)
afterAll(fresh.teardown, 60_000)

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-erf-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await services.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  return id
}

let userCounter = 0
async function user(hubIds: string[]): Promise<string> {
  const pubkey = `${(++userCounter).toString(16).padStart(4, '0')}${'d'.repeat(60)}`
  await fresh.db.insert(schema.users).values({
    pubkey,
    displayName: 'Erasure Subject',
    hubRoles: hubIds.map((hubId) => ({ hubId, roleIds: ['role-volunteer'] })),
  })
  return pubkey
}

const HOUR = 3600

/** A request in a known state; its deadline is `pastSeconds` behind the DATABASE clock. */
async function userRequest(userId: string, pastSeconds: number, status = 'pending'): Promise<string> {
  const [row] = await fresh.db
    .insert(schema.erasureRequests)
    .values({
      scope: 'user',
      userId,
      status,
      requestedBy: userId,
      executeAt: sql`NOW() - make_interval(secs => ${pastSeconds})` as unknown as Date,
    })
    .returning({ id: schema.erasureRequests.id })
  return row!.id
}

/** A pending hub shred, already due, with a co-approved override so retention floors are not consulted. */
async function dueHubShred(hubId: string): Promise<string> {
  await fresh.db.update(schema.hubs).set({ status: 'shred_pending' }).where(eq(schema.hubs.id, hubId))
  const [row] = await fresh.db
    .insert(schema.erasureRequests)
    .values({
      scope: 'hub',
      hubId,
      previousStatus: 'active',
      status: 'pending',
      requestedBy: 'integration-test',
      emergencyOverride: true,
      executeAt: sql`NOW() - make_interval(secs => ${60})` as unknown as Date,
    })
    .returning({ id: schema.erasureRequests.id })
  return row!.id
}

/** One REAL erasure-expiry tick whose shred executor refuses — the request is marked failed by the worker itself. */
async function tickWithFailingShred(): Promise<void> {
  const hubShred = {
    execute: async () => {
      throw new Error('provider refused to delete')
    },
  } as unknown as HubShredService
  await erasureExpiryTick({
    erasureService: services.erasure,
    auditService: services.audit,
    hubShred,
    providerMedia: services.providerRecordings.eraser(async () => null),
    incidents: services.incidents,
  })
}

async function statusOf(requestId: string) {
  const [row] = await fresh.db.select().from(schema.erasureRequests).where(eq(schema.erasureRequests.id, requestId))
  return row!
}

async function openIncident(hubId: string | null) {
  const rows = await fresh.db
    .select()
    .from(schema.hubIncidents)
    .where(and(
      hubId === null ? isNull(schema.hubIncidents.hubId) : eq(schema.hubIncidents.hubId, hubId),
      eq(schema.hubIncidents.category, 'erasure-deadline'),
      isNull(schema.hubIncidents.closedAt),
    ))
  expect(rows.length).toBeLessThanOrEqual(1)
  return rows[0] ?? null
}

beforeEach(async () => {
  sent.length = 0
  interrupted.length = 0
  await fresh.db.delete(schema.erasureRequests)
  await fresh.db.delete(schema.hubIncidents)
  await fresh.db.delete(schema.auditLog)
})

const ROLES: Role[] = [
  ...DEFAULT_ROLES.map((r) => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
  {
    id: 'role-erasure-desk',
    name: 'Erasure desk',
    slug: 'erasure-desk',
    permissions: ['erasure:admin'],
    isDefault: false,
    isSystem: false,
    description: 'Holds erasure:admin and nothing else',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]

const ACTOR = 'f'.repeat(64)

interface Caller {
  /** Global role ids (platform authority). */
  roles?: string[]
  hubRoles?: { hubId: string; roleIds: string[] }[]
}

/** The real routers behind the real hubContext, mounted as app.ts mounts them. */
function appFor(caller: Caller) {
  const app = new Hono<AppEnv>()
  const roles = caller.roles ?? []
  const hubRoles = caller.hubRoles ?? []
  app.use('*', async (c, next) => {
    c.set('pubkey', ACTOR)
    c.set('user', { pubkey: ACTOR, roles, hubRoles } as unknown as AppEnv['Variables']['user'])
    c.set('allRoles', ROLES)
    // Unscoped routes see the GLOBAL permission set; hubContext replaces it inside a hub.
    c.set('permissions', resolvePermissions(roles, ROLES))
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/api/erasure', erasureRoutes)
  app.route('/api/incidents/platform', platformIncidentsRoutes)
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/incidents', incidentsRoutes)
  hubScoped.route('/erasure', erasureRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

const ENV = { ENVIRONMENT: 'test' }
type IncidentBody = { incidents?: { category: string; counts: Record<string, number> }[] }

async function hubIncidentsAs(caller: Caller, hubId: string) {
  const res = await appFor(caller).request(`/api/hubs/${hubId}/incidents?open=true`, {}, ENV)
  return { status: res.status, body: (await res.json()) as IncidentBody }
}

async function platformIncidentsAs(caller: Caller) {
  const res = await appFor(caller).request('/api/incidents/platform?open=true', {}, ENV)
  return { status: res.status, body: (await res.json()) as IncidentBody & { error?: string } }
}

async function postAs(caller: Caller, path: string, body?: unknown) {
  const res = await appFor(caller).request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
    ENV,
  )
  return { status: res.status, body: (await res.json()) as { request?: { status: string }; error?: string } }
}

const erasureDesk = (hubId: string): Caller => ({ hubRoles: [{ hubId, roleIds: ['role-erasure-desk'] }] })
const volunteer = (hubId: string): Caller => ({ hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })
const platformOperator: Caller = { roles: ['role-super-admin'] }

describe('the failed state reaches erasure:admin (#2347 part 1)', () => {
  it('the erasure worker marking a request failed opens an incident for the hub\'s erasure admins, and only them', async () => {
    const hubId = await createHub()
    const requestId = await dueHubShred(hubId)

    // The worker itself fails the request — nothing writes 'failed' by hand.
    await tickWithFailingShred()
    expect((await statusOf(requestId)).status).toBe('failed')

    // Not overdue (it is no longer pending): the pre-#2347 detector sees nothing.
    expect(await services.erasure.countOverdueForHub(hubId, new Date())).toEqual({ count: 0, oldestAgeSeconds: null })

    await services.incidents.runChecks()

    const row = await openIncident(hubId)
    expect(row, 'a failed erasure must open an incident').not.toBeNull()
    expect(row!.severity).toBe('notify')
    expect(row!.counts).toEqual({ failed: 1 })
    expect(interrupted.some((i) => i.incidentId === row!.id && i.hubId === hubId && i.state === 'opened')).toBe(true)

    // Counts only: nothing identifying the request reaches the incident.
    expect(JSON.stringify(row)).not.toContain(requestId)

    const holder = await hubIncidentsAs(erasureDesk(hubId), hubId)
    expect(holder.status).toBe(200)
    expect(holder.body.incidents!.map((i) => [i.category, i.counts])).toEqual([['erasure-deadline', { failed: 1 }]])

    // The negative: same hub, holds erasure:request-self but not erasure:admin.
    const member = await hubIncidentsAs(volunteer(hubId), hubId)
    expect(member.status).toBe(200)
    expect(member.body.incidents).toEqual([])
  })

  it('a failed request in one hub does not open an incident in another', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    await userRequest(await user([hubA]), HOUR, 'failed')

    await services.incidents.runChecks()

    expect((await openIncident(hubA))!.counts).toEqual({ failed: 1 })
    expect(await openIncident(hubB)).toBeNull()
  })

  it('retrying a failed request queues it again; the incident ends once nothing is failed', async () => {
    const hubId = await createHub()
    const requestId = await dueHubShred(hubId)
    await tickWithFailingShred()
    await services.incidents.runChecks()
    expect(await openIncident(hubId)).not.toBeNull()

    const res = await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/${requestId}/retry`)
    expect(res.status).toBe(200)
    expect(res.body.request!.status).toBe('pending')
    expect((await statusOf(requestId)).status).toBe('pending')
    const retried = await fresh.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'erasureRetried'))
    expect(retried).toHaveLength(1)
    expect(retried[0]!.hubId).toBe(hubId)
    expect(retried[0]!.actorPubkey).toBe(ACTOR)

    // Nothing is failed any more: the level check stops re-signalling and the closer ends the incident.
    await services.incidents.runChecks()
    const open = (await openIncident(hubId))!
    const { closed } = await services.incidents.closeQuiet({ hubId, asOf: new Date(open.lastSignalAt.getTime() + 31 * 60_000) })
    expect(closed).toBe(1)
    expect(await openIncident(hubId)).toBeNull()

    // A retry that fails again is a fresh failure, surfaced again.
    await tickWithFailingShred()
    expect((await statusOf(requestId)).status).toBe('failed')
    await services.incidents.runChecks()
    expect((await openIncident(hubId))!.counts).toEqual({ failed: 1 })
  })

  it('abandoning records who, when and why — on the row and in the audit chain — and is not "completed"', async () => {
    const hubId = await createHub()
    const requestId = await dueHubShred(hubId)
    await tickWithFailingShred()

    const blank = await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/${requestId}/abandon`, { justification: '   ' })
    expect(blank.status).toBe(400)
    expect((await statusOf(requestId)).status).toBe('failed')

    const res = await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/${requestId}/abandon`, {
      justification: 'Operator gave up: provider account closed',
    })
    expect(res.status).toBe(200)
    expect(res.body.request!.status).toBe('abandoned')

    const row = await statusOf(requestId)
    expect(row.status).toBe('abandoned')
    expect(row.status).not.toBe('completed')
    expect(row.executedAt, 'nothing was erased').toBeNull()
    expect(row.abandonedBy).toBe(ACTOR)
    expect(row.abandonedAt).toBeInstanceOf(Date)
    expect(row.abandonJustification).toBe('Operator gave up: provider account closed')

    const entries = await fresh.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'erasureAbandoned'))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.hubId).toBe(hubId)
    expect(entries[0]!.actorPubkey).toBe(ACTOR)

    // A hub whose shred was abandoned is thawed, not left shred_pending behind a request that will never run.
    const [hub] = await fresh.db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))
    expect(hub!.status).toBe('active')

    // An abandoned request is not failed any more, so it stops being an incident…
    await services.incidents.runChecks()
    expect(await openIncident(hubId)).toBeNull()
    // …and it cannot be retried or abandoned a second time.
    const again = await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/${requestId}/retry`)
    expect(again.status).toBe(409)
  })

  it('abandoning a failed shred leaves the hub frozen while another shred for it is still in flight', async () => {
    const hubId = await createHub()
    const failed = await dueHubShred(hubId)
    await tickWithFailingShred()
    expect((await statusOf(failed)).status).toBe('failed')

    // The failed request is not `pending`, so a second shred can be scheduled — through the real path.
    const second = await services.erasure.createHubShredRequest(hubId, 'integration-test')
    expect(second.status).toBe('pending')

    const res = await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/${failed}/abandon`, {
      justification: 'Superseded by a new shred request',
    })
    expect(res.status).toBe(200)
    expect((await statusOf(failed)).status).toBe('abandoned')

    // Thawing here would lift the freeze the second shred depends on.
    const [hub] = await fresh.db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))
    expect(hub!.status).toBe('shred_pending')
    expect((await statusOf(second.id)).status).toBe('pending')
  })

  it('a member of the hub without erasure:admin, and an admin of another hub, can neither retry nor abandon', async () => {
    const hubId = await createHub()
    const otherHub = await createHub()
    const requestId = await dueHubShred(hubId)
    await tickWithFailingShred()

    const denied: { who: string; caller: Caller; hub: string }[] = [
      { who: 'same-hub member without the permission', caller: volunteer(hubId), hub: hubId },
      { who: 'erasure admin of another hub, via their own hub', caller: erasureDesk(otherHub), hub: otherHub },
      { who: 'erasure admin of another hub, via this hub', caller: erasureDesk(otherHub), hub: hubId },
    ]
    for (const { who, caller, hub } of denied) {
      const retry = await postAs(caller, `/api/hubs/${hub}/erasure/requests/${requestId}/retry`)
      expect(retry.status, `${who}: retry`).toBe(403)
      const abandon = await postAs(caller, `/api/hubs/${hub}/erasure/requests/${requestId}/abandon`, { justification: 'no' })
      expect(abandon.status, `${who}: abandon`).toBe(403)
    }
    expect((await statusOf(requestId)).status, 'nothing moved').toBe('failed')
    expect(await fresh.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'erasureRetried'))).toHaveLength(0)
  })

  it('a person\'s erasure may be retried by a hub\'s erasure admin but abandoned only by the platform permission', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    const subject = await user([hubA, hubB])
    const requestId = await userRequest(subject, HOUR, 'failed')

    // The subject's data lives in both hubs: neither hub's admin can give up on it for the other.
    for (const hub of [hubA, hubB]) {
      const res = await postAs(erasureDesk(hub), `/api/hubs/${hub}/erasure/requests/${requestId}/abandon`, { justification: 'not mine to drop' })
      expect(res.status, `hub ${hub}`).toBe(403)
    }
    expect((await statusOf(requestId)).status).toBe('failed')

    // A role INSIDE a hub that carries the platform permission does not confer platform authority.
    const rogue: Caller = { hubRoles: [{ hubId: hubA, roleIds: ['role-erasure-desk', 'role-super-admin'] }] }
    const viaHubRole = await postAs(rogue, `/api/hubs/${hubA}/erasure/requests/${requestId}/abandon`, { justification: 'x' })
    expect(viaHubRole.status).toBe(403)

    // Retry is the subject's own request going again: a concerned hub's erasure admin may.
    const retry = await postAs(erasureDesk(hubA), `/api/hubs/${hubA}/erasure/requests/${requestId}/retry`)
    expect(retry.status).toBe(200)
    await fresh.db.update(schema.erasureRequests).set({ status: 'failed' }).where(eq(schema.erasureRequests.id, requestId))

    const abandon = await postAs(platformOperator, `/api/erasure/requests/${requestId}/abandon`, { justification: 'Subject asked us to stop' })
    expect(abandon.status).toBe(200)
    expect((await statusOf(requestId)).status).toBe('abandoned')
    // Written to the platform chain and to every hub the erasure concerned.
    const entries = await fresh.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'erasureAbandoned'))
    expect(entries.map((e) => e.hubId).sort()).toEqual([hubA, hubB, null].sort())
  })

  it('refuses to retry a request that is not failed, or when another request for the subject is in flight', async () => {
    const hubId = await createHub()
    const subject = await user([hubId])
    const pending = await userRequest(subject, HOUR, 'pending')
    expect((await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/${pending}/retry`)).status).toBe(409)

    const failed = await userRequest(subject, 2 * HOUR, 'failed')
    const clash = await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/${failed}/retry`)
    expect(clash.status).toBe(409)
    expect((await statusOf(failed)).status).toBe('failed')

    expect((await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/does-not-exist/retry`)).status).toBe(404)
  })

  it('a failing failed-count query raises worker_failing — it never reads as zero failures', async () => {
    const hubId = await createHub()
    await fresh.db.execute(sql`ALTER TABLE erasure_requests RENAME TO erasure_requests_gone`)
    try {
      for (let i = 0; i < 3; i++) {
        const { failed } = await services.incidents.runChecks()
        expect(failed).toBeGreaterThan(0)
      }
    } finally {
      await fresh.db.execute(sql`ALTER TABLE erasure_requests_gone RENAME TO erasure_requests`)
    }
    const row = await openIncident(hubId)
    expect(row).not.toBeNull()
    expect(row!.counts).not.toHaveProperty('failed')
    expect(row!.counts).toHaveProperty('worker_failing')
  })
})

describe('a subject with no hub reaches the platform (#2347 part 2)', () => {
  it('opens a PLATFORM incident, in no hub, for an overdue and a failed request', async () => {
    const hubId = await createHub()
    const stray = await user([])
    const gone = await user(['hub-that-was-deleted'])
    const overdue = await userRequest(stray, 2 * HOUR, 'pending')
    await userRequest(gone, HOUR, 'failed')

    await services.incidents.runChecks()

    const row = await openIncident(null)
    expect(row, 'a hub-less subject must be surfaced at the platform level').not.toBeNull()
    expect(row!.hubId).toBeNull()
    expect(row!.counts).toEqual({ overdue: 1, failed: 1 })
    expect(row!.severity).toBe('notify')
    expect(interrupted.some((i) => i.incidentId === row!.id && i.hubId === null && i.state === 'opened')).toBe(true)
    expect(sent.filter((s) => s.incidentId === row!.id), 'no hub to relay to').toEqual([])
    expect(await openIncident(hubId), 'a hub that owns neither subject opens nothing').toBeNull()

    // Counts only: neither a request id nor a subject reaches the incident or its audit entry.
    const stored = JSON.stringify(row)
    for (const secret of [overdue, stray, gone]) expect(stored).not.toContain(secret)
    const audited = await fresh.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'incidentOpened'))
    expect(audited).toHaveLength(1)
    expect(audited[0]!.hubId, 'the platform audit chain').toBeNull()
    for (const secret of [overdue, stray, gone]) expect(JSON.stringify(audited[0])).not.toContain(secret)
  })

  it('a subject with a hub is counted in that hub and NOT at the platform level', async () => {
    const hubId = await createHub()
    await userRequest(await user([hubId]), 2 * HOUR, 'pending')
    await userRequest(await user([hubId]), 2 * HOUR, 'failed')

    await services.incidents.runChecks()

    expect((await openIncident(hubId))!.counts).toEqual({ overdue: 1, failed: 1 })
    expect(await openIncident(null)).toBeNull()
  })

  it('is readable by the platform permission and by nobody holding only hub roles', async () => {
    const hubId = await createHub()
    await userRequest(await user([]), 2 * HOUR)
    await services.incidents.runChecks()

    const operator = await platformIncidentsAs(platformOperator)
    expect(operator.status).toBe(200)
    expect(operator.body.incidents!.map((i) => [i.category, i.counts])).toEqual([['erasure-deadline', { overdue: 1 }]])
    expect(JSON.stringify(operator.body)).not.toContain('hubId')

    // erasure:admin AND hub-admin in a hub: neither is the platform permission.
    for (const caller of [erasureDesk(hubId), { hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] }, volunteer(hubId)]) {
      const res = await platformIncidentsAs(caller)
      expect(res.status).toBe(403)
      expect(res.body.incidents).toBeUndefined()
    }

    // And the hub's own incident list does not carry it.
    expect((await hubIncidentsAs(erasureDesk(hubId), hubId)).body.incidents).toEqual([])
  })

  it('a hub-less request is retried and abandoned by the platform permission alone, on the platform audit chain', async () => {
    const hubId = await createHub()
    const requestId = await userRequest(await user([]), HOUR, 'failed')

    // A hub's erasure admin has no claim on a subject who belongs to no hub.
    const byHubAdmin = await postAs(erasureDesk(hubId), `/api/hubs/${hubId}/erasure/requests/${requestId}/retry`)
    expect(byHubAdmin.status).toBe(403)

    const retry = await postAs(platformOperator, `/api/erasure/requests/${requestId}/retry`)
    expect(retry.status).toBe(200)
    expect((await statusOf(requestId)).status).toBe('pending')
    const retried = await fresh.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'erasureRetried'))
    expect(retried.map((e) => e.hubId)).toEqual([null])

    await fresh.db.update(schema.erasureRequests).set({ status: 'failed' }).where(eq(schema.erasureRequests.id, requestId))
    const abandon = await postAs(platformOperator, `/api/erasure/requests/${requestId}/abandon`, { justification: 'Subject has no data left' })
    expect(abandon.status).toBe(200)
    const row = await statusOf(requestId)
    expect(row.status).toBe('abandoned')
    expect(row.abandonedBy).toBe(ACTOR)
    const abandoned = await fresh.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'erasureAbandoned'))
    expect(abandoned.map((e) => e.hubId)).toEqual([null])
  })

  it('a platform check that cannot answer raises worker_failing at the platform level, never a zero count', async () => {
    await createHub()
    await fresh.db.execute(sql`ALTER TABLE erasure_requests RENAME TO erasure_requests_gone`)
    try {
      for (let i = 0; i < 3; i++) await services.incidents.runChecks()
    } finally {
      await fresh.db.execute(sql`ALTER TABLE erasure_requests_gone RENAME TO erasure_requests`)
    }
    const row = await openIncident(null)
    expect(row).not.toBeNull()
    expect(row!.counts).toHaveProperty('worker_failing')
    expect(row!.counts).not.toHaveProperty('overdue')
  })
})
