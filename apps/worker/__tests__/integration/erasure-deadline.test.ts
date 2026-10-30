/**
 * The erasure-deadline detector (#2323), against real PostgreSQL, built the
 * way production builds it — `createServices` registers the check, the
 * `incident-checks` runner (`IncidentService.runChecks`) evaluates it.
 *
 * The defect: when `erasure-expiry` was not running, a caller-erasure request
 * past its deadline produced NOTHING anywhere. So the central property is
 * asserted with that worker never started at all — if the incident only
 * opened while the erasure worker ran, this would be the same bug rebuilt.
 *
 * Also asserted by breaking things for real (the `erasure_requests` table is
 * renamed out from under the query, not a mock that throws):
 *   - a check that cannot answer raises `worker_failing`, never a zero count;
 *   - the erasure worker's own poll failing three times raises `worker_failing`
 *     (L2) — previously a log line and nothing else.
 *
 * And who sees it, through the real `hubContext` and incidents route: a holder
 * of `erasure:admin` does; a member of the SAME hub without it (a volunteer,
 * who holds `erasure:request-self` — the permission the routes split from
 * `erasure:admin`) does not.
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { DEFAULT_ROLES, type Role } from '@shared/permissions'
import type { AppEnv } from '../../types'
import { hubContext } from '../../middleware/hub'
import incidentsRoutes from '../../routes/incidents'
import * as schema from '../../db/schema'
import type { HubIncidentRow } from '../../db/schema/incidents'
import type { IncidentState } from '@protocol/schemas/incidents'
import { insertHubFounder } from '../helpers/hub-founder'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import { ERASURE_DEADLINE_GRACE_MS } from '../../services/erasure'
import { WORKER_FAILURE_THRESHOLD, type IncidentNotifier } from '../../services/incidents'
import { erasureExpiryTick } from '../../lib/erasure-expiry-worker'

const fresh = freshHubDb('erasure_deadline')

let services: Services
const sent: { incidentId: string; state: IncidentState }[] = []
const notifier: IncidentNotifier = {
  async relay(incident: HubIncidentRow, state: IncidentState) {
    sent.push({ incidentId: incident.id, state })
  },
  async interrupt() {},
}

beforeAll(async () => {
  await fresh.setup()
  services = createServices(fresh.db, { hmacSecret: 'a'.repeat(64), serverKek: 'c'.repeat(64), env: { ENVIRONMENT: 'test' } })
  services.incidents.setNotifier(notifier)
}, 180_000)
afterAll(fresh.teardown, 60_000)

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-erd-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
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
async function memberOf(hubIds: string[]): Promise<string> {
  const pubkey = `${(++userCounter).toString(16).padStart(4, '0')}${'e'.repeat(60)}`
  await fresh.db.insert(schema.users).values({
    pubkey,
    displayName: 'Erasure Subject',
    hubRoles: hubIds.map((hubId) => ({ hubId, roleIds: ['role-volunteer'] })),
  })
  return pubkey
}

/** A request whose deadline is `pastSeconds` behind the DATABASE clock (negative = in the future). */
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

async function hubShredRequest(hubId: string, pastSeconds: number): Promise<string> {
  const [row] = await fresh.db
    .insert(schema.erasureRequests)
    .values({
      scope: 'hub',
      hubId,
      status: 'pending',
      requestedBy: 'integration-test',
      executeAt: sql`NOW() - make_interval(secs => ${pastSeconds})` as unknown as Date,
    })
    .returning({ id: schema.erasureRequests.id })
  return row!.id
}

async function openIncident(hubId: string) {
  const rows = await fresh.db
    .select()
    .from(schema.hubIncidents)
    .where(and(
      eq(schema.hubIncidents.hubId, hubId),
      eq(schema.hubIncidents.category, 'erasure-deadline'),
      isNull(schema.hubIncidents.closedAt),
    ))
  expect(rows.length).toBeLessThanOrEqual(1)
  return rows[0] ?? null
}

const GRACE_SECONDS = ERASURE_DEADLINE_GRACE_MS / 1000
const HOUR = 3600

/** Rename the table out from under every query that reads it — a real failure, not a mocked throw. */
async function withErasureTableGone(fn: () => Promise<void>): Promise<void> {
  await fresh.db.execute(sql`ALTER TABLE erasure_requests RENAME TO erasure_requests_gone`)
  try {
    await fn()
  } finally {
    await fresh.db.execute(sql`ALTER TABLE erasure_requests_gone RENAME TO erasure_requests`)
  }
}

beforeEach(async () => {
  sent.length = 0
  // Every scenario starts from no requests and no open incidents.
  await fresh.db.delete(schema.erasureRequests)
  await fresh.db.delete(schema.hubIncidents)
})

describe('erasure-deadline check (#2323)', () => {
  it('is registered by the production service registry, for the erasure-deadline category', () => {
    const check = services.incidents.getChecks().find((c) => c.name === 'erasure-deadline')
    expect(check).toBeDefined()
    expect(check!.category).toBe('erasure-deadline')
    expect(check!.kind).toBe('overdue')
  })

  it('opens an incident for an overdue erasure with the erasure worker never started', async () => {
    const hubId = await createHub()
    const subject = await memberOf([hubId])
    const requestId = await userRequest(subject, 2 * HOUR)

    // No scheduler, no erasure-expiry worker: only the incident-checks runner.
    await services.incidents.runChecks()

    const row = await openIncident(hubId)
    expect(row, 'an overdue erasure must open an incident even when its worker is down').not.toBeNull()
    expect(row!.severity).toBe('notify')
    expect(row!.counts).toEqual({ overdue: 1 })
    expect(row!.oldestAgeSeconds).toBeGreaterThanOrEqual(2 * HOUR - 5)
    expect(row!.oldestAgeSeconds).toBeLessThan(2 * HOUR + 120)
    expect(sent.some((s) => s.incidentId === row!.id && s.state === 'opened')).toBe(true)

    // Counts only: neither the request id nor the subject reaches the incident.
    const stored = JSON.stringify(row)
    expect(stored).not.toContain(requestId)
    expect(stored).not.toContain(subject)
  })

  it('counts a person\'s erasure in every hub they belong to, and a hub shred only in its own hub', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    const hubC = await createHub()
    const subject = await memberOf([hubA, hubB])
    await userRequest(subject, HOUR)
    await hubShredRequest(hubB, 3 * HOUR)

    await services.incidents.runChecks()

    expect((await openIncident(hubA))!.counts).toEqual({ overdue: 1 })
    const b = await openIncident(hubB)
    expect(b!.counts).toEqual({ overdue: 2 })
    expect(b!.oldestAgeSeconds).toBeGreaterThanOrEqual(3 * HOUR - 5)
    expect(await openIncident(hubC), 'a hub with no overdue erasure opens nothing').toBeNull()
  })

  it('a request inside its grace window or not yet due is not overdue', async () => {
    const hubId = await createHub()
    await userRequest(await memberOf([hubId]), GRACE_SECONDS - 60)
    await userRequest(await memberOf([hubId]), -HOUR)

    expect(await services.erasure.countOverdueForHub(hubId, new Date())).toEqual({ count: 0, oldestAgeSeconds: null })
    await services.incidents.runChecks()
    expect(await openIncident(hubId)).toBeNull()
  })

  it('counts a request stranded in executing; finished ones are not overdue', async () => {
    const hubId = await createHub()
    await userRequest(await memberOf([hubId]), HOUR, 'executing')
    for (const status of ['completed', 'cancelled', 'failed']) {
      await userRequest(await memberOf([hubId]), HOUR, status)
    }

    const result = await services.erasure.countOverdueForHub(hubId, new Date())
    expect(result.count).toBe(1)
  })

  it('a check that cannot query raises worker_failing — it never reads as a zero count', async () => {
    const hubId = await createHub()

    await withErasureTableGone(async () => {
      await expect(services.erasure.countOverdueForHub(hubId, new Date())).rejects.toThrow()
      for (let i = 1; i <= WORKER_FAILURE_THRESHOLD; i++) {
        const { failed } = await services.incidents.runChecks()
        expect(failed).toBeGreaterThan(0)
        if (i < WORKER_FAILURE_THRESHOLD) expect(await openIncident(hubId)).toBeNull()
      }
    })

    const row = await openIncident(hubId)
    expect(row).not.toBeNull()
    expect(row!.counts).toEqual({ worker_failing: 1 })
    expect(row!.counts).not.toHaveProperty('overdue')

    // A recovered check resets the streak; the next tick observes normally.
    await services.incidents.runChecks()
  })
})

describe('erasure-expiry worker failure hook (L2, #2323)', () => {
  const tickOpts = () => ({
    erasureService: services.erasure,
    auditService: services.audit,
    hubShred: services.hubShred,
    providerMedia: services.providerRecordings.eraser(async () => null),
    incidents: services.incidents,
  })

  it('three consecutive failing polls raise worker_failing in every hub; a success resets the streak', async () => {
    const hubA = await createHub()
    const hubB = await createHub()

    await withErasureTableGone(async () => {
      for (let i = 1; i < WORKER_FAILURE_THRESHOLD; i++) {
        await expect(erasureExpiryTick(tickOpts())).rejects.toThrow()
      }
      expect(await openIncident(hubA), 'below the threshold nothing opens').toBeNull()
      await expect(erasureExpiryTick(tickOpts())).rejects.toThrow()
    })

    for (const hubId of [hubA, hubB]) {
      const row = await openIncident(hubId)
      expect(row, 'a failing erasure worker is every hub\'s incident').not.toBeNull()
      expect(row!.counts).toEqual({ worker_failing: 1 })
    }

    // Recovery resets: two further failures after a success stay below the threshold.
    await erasureExpiryTick(tickOpts())
    await fresh.db.delete(schema.hubIncidents)
    await withErasureTableGone(async () => {
      for (let i = 1; i < WORKER_FAILURE_THRESHOLD; i++) {
        await expect(erasureExpiryTick(tickOpts())).rejects.toThrow()
      }
    })
    expect(await openIncident(hubA)).toBeNull()
  })
})

describe('who sees the erasure-deadline incident (#2323)', () => {
  const ROLES: Role[] = [
    ...DEFAULT_ROLES.map((r) => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
    { id: 'role-erasure-desk', name: 'Erasure desk', slug: 'erasure-desk', permissions: ['erasure:admin'] },
  ]

  /** The incidents router mounted as app.ts mounts it, behind the real hubContext. */
  async function listAs(hubRoles: { hubId: string; roleIds: string[] }[], hubId: string) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('pubkey', 'f'.repeat(64))
      c.set('user', { pubkey: 'f'.repeat(64), roles: [], hubRoles } as unknown as AppEnv['Variables']['user'])
      c.set('allRoles', ROLES)
      c.set('permissions', [])
      c.set('services', services as unknown as AppEnv['Variables']['services'])
      await next()
    })
    const hubScoped = new Hono<AppEnv>()
    hubScoped.use('*', hubContext)
    hubScoped.route('/incidents', incidentsRoutes)
    app.route('/api/hubs/:hubId', hubScoped)
    const res = await app.request(`/api/hubs/${hubId}/incidents?open=true`, {}, { ENVIRONMENT: 'test' })
    return { status: res.status, body: (await res.json()) as { incidents?: { category: string; counts: Record<string, number> }[] } }
  }

  it('an erasure:admin holder sees it; a member of the same hub without that permission does not', async () => {
    const hubId = await createHub()
    const otherHub = await createHub()
    await userRequest(await memberOf([hubId]), 2 * HOUR)
    await services.incidents.runChecks()

    for (const roleId of ['role-erasure-desk', 'role-hub-admin']) {
      const holder = await listAs([{ hubId, roleIds: [roleId] }], hubId)
      expect(holder.status).toBe(200)
      expect(holder.body.incidents!.map((i) => [i.category, i.counts])).toEqual([['erasure-deadline', { overdue: 1 }]])
    }

    // The negative case: same hub, holds erasure:request-self, not erasure:admin.
    const volunteer = await listAs([{ hubId, roleIds: ['role-volunteer'] }], hubId)
    expect(volunteer.status).toBe(200)
    expect(volunteer.body.incidents).toEqual([])

    // An erasure admin of another hub is not admitted to this one at all.
    const outsider = await listAs([{ hubId: otherHub, roleIds: ['role-erasure-desk'] }], hubId)
    expect(outsider.status).toBe(403)
  })
})
