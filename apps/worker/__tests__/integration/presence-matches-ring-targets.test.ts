/**
 * `/calls/presence` reports who a call would ring — through the services the
 * PRODUCTION factory builds, against real PostgreSQL.
 *
 * The defect: `createServices` (services/index.ts) constructed
 * `new CallsService(db)` while `getPresence` was gated on an optional
 * `ShiftsService` second argument. On every deployment the branch was dead and
 * presence answered `{ activeCalls: 0, availableVolunteers: 0, users: [] }` —
 * nobody is ever on shift — while `/shifts/active` listed the volunteer who had
 * just clocked in. Measured live on origin/main before this change.
 *
 * Why these tests are here and not only in the unit suite: the unit tests were
 * green throughout, because they constructed `CallsService` WITH a stub and one
 * of them pinned the empty answer as correct behaviour ("works without shifts
 * service"). A test that builds the object itself cannot see a wiring defect. So
 * this suite calls `createServices` — the one function production calls — and
 * then only ever asks it questions. If presence is ever given a dependency the
 * factory does not supply, every case below goes red.
 *
 * The second property proved here is the anti-drift one: presence does not
 * re-derive "on shift", it calls `resolveRingableVolunteers`, the same resolver
 * the ringing and answer paths use. So whatever the ring rule is — the schedule
 * alone today, `scheduled ∩ clocked_in` once #1469 lands — presence reports
 * exactly that set. `presence agrees with the ringing resolver` asserts the two
 * by comparison, not by restating either one.
 *
 * Requires postgres at DATABASE_URL. Each run creates its own database with the
 * real migrations and drops it on teardown, so it never touches the shared
 * development database. Run against an isolated worktree database
 * (`bun scripts/worktree-db.ts use-isolated`).
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
// `createServices` pulls in lib/crypto, which loads the Rust library through
// bun:ffi — unavailable under Vitest's Node runtime. Same mock the other
// integration suites use; nothing on the presence path calls into it.
import '../mocks/llamenos-crypto-ffi'

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { createServices, type Services } from '../../services'
import { getHubPresence } from '../../services/presence'
import { hubRoutingReadiness } from '../../services/routing-readiness'
import { resolveRingableVolunteers } from '../../services/ringing'
import callsRoutes from '../../routes/calls'
import type { AppEnv } from '../../types'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const DB_NAME = `presence_ring_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const HMAC_SECRET = 'a'.repeat(64)

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

let sql: ReturnType<typeof postgres>
let db: Database
let services: Services

let counter = 0
const nextId = () => `${++counter}-${Math.random().toString(36).slice(2, 8)}`

/** A pubkey-shaped identifier; nothing here verifies signatures. */
function freshPubkey(): string {
  return `${(++counter).toString(16).padStart(2, '0')}`.repeat(32)
}

async function createHub(): Promise<string> {
  const id = `hub-${nextId()}`
  await services.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never)
  return id
}

/**
 * A hub member with a role that can answer calls, via the real IdentityService.
 *
 * `hubScopedOnly` drops the global role `createUser` also grants, leaving the
 * volunteer a member of this hub and nowhere else — the only way to build
 * somebody another hub's call must not reach.
 */
async function createVolunteer(
  hubId: string,
  opts: { onBreak?: boolean; active?: boolean; hubScopedOnly?: boolean } = {},
): Promise<string> {
  const pubkey = freshPubkey()
  await services.identity.createUser({
    pubkey,
    name: `Volunteer ${pubkey.slice(0, 4)}`,
    phone: '+10000000000',
    roleIds: ['role-volunteer'],
    encryptedSecretKey: 'not-used-here',
    hubId,
  })
  const updates: Record<string, unknown> = {}
  if (opts.onBreak) updates.onBreak = true
  if (opts.active === false) updates.active = false
  if (opts.hubScopedOnly) {
    updates.roles = []
    updates.hubRoles = [{ hubId, roleIds: ['role-volunteer'] }]
  }
  if (Object.keys(updates).length > 0) {
    await services.identity.updateUser(pubkey, updates as never, true)
  }
  return pubkey
}

/**
 * A shift that is active right now, every day, naming these volunteers.
 *
 * The window is ±1h around the current UTC hour so it neither depends on nor
 * trips over `isShiftActive`'s half-open end boundary (#1336).
 */
async function rosterOnShiftNow(hubId: string, pubkeys: string[]): Promise<void> {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  await services.shifts.create(hubId, {
    id: crypto.randomUUID(),
    encryptedName: 'encrypted-shift-name',
    startTime: `${pad((now.getUTCHours() + 23) % 24)}:00`,
    endTime: `${pad((now.getUTCHours() + 1) % 24)}:00`,
    days: [0, 1, 2, 3, 4, 5, 6],
    userPubkeys: pubkeys,
  } as never)
}

/**
 * The HTTP route an admin dashboard actually polls, mounted over the real
 * service registry. Going through the route is what makes a revert of the route
 * wiring visible as well as a revert of the derivation.
 */
async function getPresenceViaRoute(hubId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', 'a'.repeat(64))
    c.set('permissions', ['*'])
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'presence-integration')
    c.set('hubId', hubId)
    c.env = {} as AppEnv['Bindings']
    await next()
  })
  app.route('/', callsRoutes)
  const res = await app.request('/presence')
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

/** Clock in through the service the /shifts/clock-in route calls. */
async function clockIn(hubId: string, pubkeys: string[]): Promise<void> {
  for (const pubkey of pubkeys) await services.activeShifts.clockIn(pubkey, hubId)
}

beforeAll(async () => {
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`)
  } finally {
    await admin.end()
  }

  const migrate = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: urlFor(DB_NAME) },
    encoding: 'utf-8',
    timeout: 120_000,
  })
  if (migrate.status !== 0) {
    throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
  }

  sql = postgres(urlFor(DB_NAME), { max: 4 })
  db = drizzle(sql, { schema }) as unknown as Database

  // THE point of this suite: the production service registry, built exactly as
  // src/server/index.ts builds it. No service is constructed by hand below.
  services = createServices(db, { hmacSecret: HMAC_SECRET, env: { ENVIRONMENT: 'test' } })

  // Roles must exist before permissions resolve, same as at boot.
  await services.settings.ensureInit()
}, 180_000)

afterAll(async () => {
  await sql?.end()
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}, 60_000)

describe('GET /calls/presence against the production service registry', () => {
  let hubId: string

  beforeEach(async () => {
    hubId = await createHub()
  })

  it('reports the rostered, clocked-in volunteer — the case that was blank on every deployment', async () => {
    const pubkey = await createVolunteer(hubId)
    await rosterOnShiftNow(hubId, [pubkey])
    await clockIn(hubId, [pubkey])

    // What the operator compares it against: /shifts/active and /shifts/my-status.
    const { activeShifts } = await services.activeShifts.listActiveByHub(hubId)
    expect(activeShifts.map(r => r.pubkey)).toEqual([pubkey])
    expect((await services.shifts.getMyStatus(hubId, pubkey)).onShift).toBe(true)

    const presence = await getHubPresence(services, hubId)

    expect(presence.users).toEqual([{ pubkey, status: 'available' }])
    expect(presence.availableVolunteers).toBe(1)
    expect(presence.activeCalls).toBe(0)
  })

  it('GET /presence answers with that volunteer too — end to end over the real registry', async () => {
    const pubkey = await createVolunteer(hubId)
    await rosterOnShiftNow(hubId, [pubkey])
    await clockIn(hubId, [pubkey])

    const { status, body } = await getPresenceViaRoute(hubId)

    expect(status).toBe(200)
    expect(body.users).toEqual([{ pubkey, status: 'available' }])
    expect(body.availableVolunteers).toBe(1)
  })

  it('labels the volunteer on a live call as on-call and stops counting them available', async () => {
    const [onCall, free] = [await createVolunteer(hubId), await createVolunteer(hubId)]
    await rosterOnShiftNow(hubId, [onCall, free])
    await clockIn(hubId, [onCall, free])

    const callId = `call-${nextId()}`
    await services.calls.addCall(hubId, { callId, callerNumber: 'hashed-number', callerLast4: '1234' })
    await services.calls.answerCall(hubId, callId, onCall)

    const presence = await getHubPresence(services, hubId)

    expect(presence.activeCalls).toBe(1)
    expect(presence.availableVolunteers).toBe(1)
    expect(presence.users).toEqual(expect.arrayContaining([
      { pubkey: onCall, status: 'on-call' },
      { pubkey: free, status: 'available' },
    ]))
    expect(presence.users).toHaveLength(2)
  })

  it('does not report an on-break volunteer as available — a call would not ring them', async () => {
    const onBreak = await createVolunteer(hubId, { onBreak: true })
    const free = await createVolunteer(hubId)
    await rosterOnShiftNow(hubId, [onBreak, free])
    await clockIn(hubId, [onBreak, free])

    const presence = await getHubPresence(services, hubId)

    expect(presence.users).toEqual([{ pubkey: free, status: 'available' }])
  })

  it('does not report a deactivated volunteer', async () => {
    const deactivated = await createVolunteer(hubId, { active: false })
    const free = await createVolunteer(hubId)
    await rosterOnShiftNow(hubId, [deactivated, free])
    await clockIn(hubId, [deactivated, free])

    const presence = await getHubPresence(services, hubId)

    expect(presence.users).toEqual([{ pubkey: free, status: 'available' }])
  })

  it('does not report somebody rostered in this hub who is a member of another one', async () => {
    const otherHub = await createHub()
    const outsider = await createVolunteer(otherHub, { hubScopedOnly: true })
    const member = await createVolunteer(hubId, { hubScopedOnly: true })
    // A stale roster entry naming a user from another hub: they cannot answer
    // this hub's call, so presence must not claim they are available for it.
    await rosterOnShiftNow(hubId, [outsider, member])
    await clockIn(hubId, [outsider, member])

    const presence = await getHubPresence(services, hubId)

    expect(presence.users).toEqual([{ pubkey: member, status: 'available' }])
  })

  it('reports the fallback group when nobody is on shift — that is who the call reaches', async () => {
    const fallback = await createVolunteer(hubId)
    await services.settings.setFallbackGroup({ userPubkeys: [fallback] }, hubId)

    const presence = await getHubPresence(services, hubId)

    expect(presence.users).toEqual([{ pubkey: fallback, status: 'available' }])
  })

  it('reports nobody for a hub with no shift and no fallback group', async () => {
    await createVolunteer(hubId)

    const presence = await getHubPresence(services, hubId)

    expect(presence).toEqual({ activeCalls: 0, availableVolunteers: 0, users: [] })
  })

  it('agrees with the ringing resolver over a mixed roster, by derivation', async () => {
    const ok = await createVolunteer(hubId)
    const onBreak = await createVolunteer(hubId, { onBreak: true })
    const inactive = await createVolunteer(hubId, { active: false })
    await rosterOnShiftNow(hubId, [ok, onBreak, inactive])
    await clockIn(hubId, [ok, onBreak, inactive])

    const presence = await getHubPresence(services, hubId)
    const ringable = await resolveRingableVolunteers(services, hubId)

    expect(presence.users.map(u => u.pubkey).sort())
      .toEqual((ringable?.available ?? []).map(v => v.pubkey).sort())
    expect(presence.users.map(u => u.pubkey)).toEqual([ok])
  })
})

describe('hubRoutingReadiness against the production service registry', () => {
  it('a hub as the wizard leaves it can ring nobody, and says so until a shift or fallback exists', async () => {
    const hubId = await createHub()
    const pubkey = await createVolunteer(hubId)

    // A hub with members but no routing: the state a fresh install is in.
    const fresh = await hubRoutingReadiness(services, hubId)
    expect(fresh.canEverRing).toBe(false)
    expect(fresh.rosteredVolunteers).toBe(0)
    expect(fresh.fallbackVolunteers).toBe(0)

    await rosterOnShiftNow(hubId, [pubkey])

    const rostered = await hubRoutingReadiness(services, hubId)
    expect(rostered.canEverRing).toBe(true)
    expect(rostered.rosteredVolunteers).toBe(1)
  })

  it('a fallback group alone makes a hub routable', async () => {
    const hubId = await createHub()
    const pubkey = await createVolunteer(hubId)
    await services.settings.setFallbackGroup({ userPubkeys: [pubkey] }, hubId)

    const readiness = await hubRoutingReadiness(services, hubId)

    expect(readiness).toMatchObject({ canEverRing: true, rosteredVolunteers: 0, fallbackVolunteers: 1 })
  })
})
