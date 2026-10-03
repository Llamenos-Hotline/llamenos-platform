/**
 * Ringing requires BOTH the schedule and a clock-in — real PostgreSQL.
 *
 * `resolveRingableVolunteers` used to read only the `shifts` schedule, so
 * clocking in had no effect whatsoever on who was rung: a scheduled volunteer
 * rang whether or not they had clocked in, and a volunteer who clocked in
 * without a roster entry never rang at all. R1 promises "that volunteer clocks
 * in, receives a call"; the two were unconnected.
 *
 * It now intersects the two:
 *
 *   ring = scheduled_now ∩ clocked_in     (empty → the hub's fallback group)
 *
 * Why this test exists in ADDITION to the unit tests in
 * `__tests__/unit/ringing-service.test.ts`: those drive the resolver with a
 * mocked `Services`, so they prove the resolver's logic but say nothing about
 * whether a real `ActiveShiftsService` reading a real `active_shifts` table
 * returns what a real clock-in wrote, or whether a real `ShiftsService`
 * reading a real `shifts` table agrees about the current window. This suite has
 * been burned by exactly that gap before — `calls-service.test.ts`'s mock DB
 * ignores WHERE clauses, and `CallsService.getPresence` passes its unit tests
 * with a `ShiftsService` production never gives it.
 *
 * So every service here is the real one, wired the way `createServices` wires
 * it (`new ShiftsService(db)` — no settings service, so its own internal
 * fallback is as dead here as it is in production), clock-in goes through the
 * real `ActiveShiftsService.clockIn` the route calls, and the fallback group is
 * written through the real `SettingsService.setFallbackGroup`.
 *
 * Requires postgres at DATABASE_URL. Rows are scoped to per-run hub ids and
 * pubkeys and deleted on teardown; nothing global is truncated.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// `services/ringing` imports `lib/crypto`, which dlopens a native library
// through `bun:ffi` — unavailable under Vitest (no `bun:ffi` in the Node
// runtime; no `import.meta.dir` after Vitest's transform). The resolver under
// test performs no crypto, so the FFI surface is stubbed at the module
// boundary. Everything below this line — every service, every query — is real.
vi.mock('@llamenos/crypto/ffi', () => ({
  hpkeSeal: () => { throw new Error('crypto is not exercised by this test') },
  symmetricEncrypt: () => { throw new Error('crypto is not exercised by this test') },
  symmetricDecrypt: () => { throw new Error('crypto is not exercised by this test') },
  hkdfSha256: () => { throw new Error('crypto is not exercised by this test') },
  hmacSha256: () => { throw new Error('crypto is not exercised by this test') },
  sha256: () => { throw new Error('crypto is not exercised by this test') },
  randomBytes: () => { throw new Error('crypto is not exercised by this test') },
}))

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { inArray } from 'drizzle-orm'
import type { Database } from '../../db'
import type { Services } from '../../services'
import * as schema from '../../db/schema'
import { activeShifts, hubs, shifts, users } from '../../db/schema'
import { ShiftsService } from '../../services/shifts'
import { ActiveShiftsService } from '../../services/active-shifts'
import { SettingsService } from '../../services/settings'
import { IdentityService } from '../../services/identity'
import { CallsService } from '../../services/calls'
import { resolveRingableVolunteers } from '../../services/ringing'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 64-hex pubkeys unique to this run, so a parallel run cannot see them. */
const pk = (name: string) => `${name}${RUN}`.padEnd(64, '0').slice(0, 64)

const PK_BOTH = pk('both')
const PK_SCHEDULED_ONLY = pk('schedonly')
const PK_CLOCKED_ONLY = pk('clockonly')
const PK_FALLBACK = pk('fallback')
const ALL_PUBKEYS = [PK_BOTH, PK_SCHEDULED_ONLY, PK_CLOCKED_ONLY, PK_FALLBACK]

/** One hub per scenario, so scenarios cannot see each other's rosters. */
const hubId = (name: string) => `hub-${name}-${RUN}`

let sql: ReturnType<typeof postgres>
let db: Database
let services: Services
let shiftsService: ShiftsService
let activeShiftsService: ActiveShiftsService
let settingsService: SettingsService

const createdHubs: string[] = []

/**
 * A shift that is unambiguously active right now: every weekday, and a window
 * from an hour ago to an hour ahead. Spanning both directions keeps the test
 * independent of the UTC day rolling over mid-run, and of `isShiftActive`'s
 * half-open end boundary (a 00:00–23:59 shift is *not* active at 23:59 — see
 * the note at the bottom of this file).
 */
function activeWindow(): { startTime: string; endTime: string; days: number[] } {
  const hhmm = (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  const now = Date.now()
  return {
    startTime: hhmm(new Date(now - 60 * 60 * 1000)),
    endTime: hhmm(new Date(now + 60 * 60 * 1000)),
    days: [0, 1, 2, 3, 4, 5, 6],
  }
}

/**
 * A real `hubs` row — `hub_settings` has a foreign key to it, so the fallback
 * group cannot be written for a hub that does not exist.
 */
async function makeHub(name: string): Promise<string> {
  const id = hubId(name)
  await db.insert(hubs).values({
    id,
    name: id,
    slug: id,
    status: 'active',
    createdBy: PK_BOTH,
  }).onConflictDoNothing()
  createdHubs.push(id)
  return id
}

/** Put `pubkeys` on a shift covering right now in `hub`, via the real service. */
async function schedule(hub: string, pubkeys: string[]): Promise<void> {
  await shiftsService.create(hub, {
    encryptedName: `enc-${hub}`,
    userPubkeys: pubkeys,
    ...activeWindow(),
  })
}

/** Who a call to `hub` would actually ring, as pubkeys. */
async function wouldRing(hub: string): Promise<string[]> {
  const resolved = await resolveRingableVolunteers(services, hub)
  return (resolved?.available ?? []).map(v => v.pubkey).sort()
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL, { max: 4 })
  db = drizzle(sql, { schema }) as unknown as Database

  shiftsService = new ShiftsService(db)
  activeShiftsService = new ActiveShiftsService(db)
  settingsService = new SettingsService(db)

  // Seeds the roles table; without roles, `resolveHubPermissions` grants nobody
  // access to any hub and the resolver would reject everyone for the wrong reason.
  await settingsService.ensureInit()

  services = {
    shifts: shiftsService,
    activeShifts: activeShiftsService,
    settings: settingsService,
    identity: new IdentityService(db),
    calls: new CallsService(db),
  } as unknown as Services

  // Every test user is an active, non-break volunteer with the global volunteer
  // role (which resolves to permissions in every hub), reachable by phone.
  await db.insert(users).values(
    ALL_PUBKEYS.map((pubkey, i) => ({
      pubkey,
      roles: ['role-volunteer'],
      displayName: pubkey.slice(0, 12),
      phone: `+1555000${String(i).padStart(4, '0')}`,
      active: true,
      onBreak: false,
      callPreference: 'phone',
      hubRoles: [],
    })),
  ).onConflictDoNothing()
})

afterAll(async () => {
  if (createdHubs.length > 0) {
    await db.delete(shifts).where(inArray(shifts.hubId, createdHubs))
    await db.delete(activeShifts).where(inArray(activeShifts.hubId, createdHubs))
    // hub_settings, hub_keys etc. cascade from hubs.
    await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  }
  await db.delete(users).where(inArray(users.pubkey, ALL_PUBKEYS))
  await sql.end({ timeout: 5 })
})

describe('ring = scheduled_now ∩ clocked_in (real services, real Postgres)', () => {
  it('scheduled AND clocked in — rings', async () => {
    const hub = await makeHub('both')
    await schedule(hub, [PK_BOTH])
    await activeShiftsService.clockIn(PK_BOTH, hub)

    expect(await wouldRing(hub)).toEqual([PK_BOTH])
  })

  it('scheduled but NOT clocked in — does not ring', async () => {
    // The row the previous behaviour relied on is present and correct: the
    // volunteer IS on a shift covering right now. Only their own consent is
    // missing. With no fallback group, the call is unroutable.
    const hub = await makeHub('schedonly')
    await schedule(hub, [PK_SCHEDULED_ONLY])

    // The schedule really does name them — otherwise this test would pass for
    // the wrong reason (an inactive shift window rather than the conjunct).
    expect(await shiftsService.getCurrentVolunteers(hub)).toEqual([PK_SCHEDULED_ONLY])
    expect(await activeShiftsService.listClockedInPubkeys(hub)).toEqual(new Set())

    expect(await resolveRingableVolunteers(services, hub)).toBeNull()
  })

  it('clocked in but NOT scheduled — does not ring', async () => {
    // Clocking in cannot enrol you: only an admin's schedule entry can.
    const hub = await makeHub('clockonly')
    await activeShiftsService.clockIn(PK_CLOCKED_ONLY, hub)

    expect(await activeShiftsService.listClockedInPubkeys(hub)).toEqual(new Set([PK_CLOCKED_ONLY]))
    expect(await shiftsService.getCurrentVolunteers(hub)).toEqual([])

    expect(await resolveRingableVolunteers(services, hub)).toBeNull()
  })

  it('neither scheduled nor clocked in — does not ring', async () => {
    const hub = await makeHub('neither')

    expect(await resolveRingableVolunteers(services, hub)).toBeNull()
  })

  it('rings only the intersection when part of the roster has clocked in', async () => {
    const hub = await makeHub('partial')
    await schedule(hub, [PK_BOTH, PK_SCHEDULED_ONLY])
    await activeShiftsService.clockIn(PK_BOTH, hub)
    // Clocked into the hub but absent from its schedule — must not ring either.
    await activeShiftsService.clockIn(PK_CLOCKED_ONLY, hub)

    expect(await wouldRing(hub)).toEqual([PK_BOTH])
  })

  it('falls through to the fallback group when the schedule is populated but unmanned', async () => {
    // An unmanned schedule is now a far more likely state than before, so this
    // path matters more, not less: the call must reach the fallback group rather
    // than be dropped. The fallback is deliberately NOT gated on clocking in —
    // PK_FALLBACK never clocks in anywhere in this test.
    const hub = await makeHub('unmanned')
    await schedule(hub, [PK_SCHEDULED_ONLY])
    await settingsService.setFallbackGroup({ userPubkeys: [PK_FALLBACK] }, hub)

    expect(await wouldRing(hub)).toEqual([PK_FALLBACK])
  })

  it('clocking out returns the hub to the fallback group', async () => {
    // The full R1 clock-in lifecycle through the real routes' service methods.
    const hub = await makeHub('lifecycle')
    await schedule(hub, [PK_BOTH])
    await settingsService.setFallbackGroup({ userPubkeys: [PK_FALLBACK] }, hub)

    expect(await wouldRing(hub)).toEqual([PK_FALLBACK])

    await activeShiftsService.clockIn(PK_BOTH, hub)
    expect(await wouldRing(hub)).toEqual([PK_BOTH])

    await activeShiftsService.heartbeat(PK_BOTH, hub)
    expect(await wouldRing(hub)).toEqual([PK_BOTH])

    await activeShiftsService.clockOut(PK_BOTH, hub)
    expect(await wouldRing(hub)).toEqual([PK_FALLBACK])
  })

  it('reads the clock-in roster of the hub the call belongs to, not any other', async () => {
    // A clock-in is per hub. Clocking into hub X must not make you ringable in
    // hub Y, even when hub Y's schedule names you.
    const scheduledIn = await makeHub('xhub-scheduled')
    const clockedIn = await makeHub('xhub-clocked')
    await schedule(scheduledIn, [PK_BOTH])
    await activeShiftsService.clockIn(PK_BOTH, clockedIn)

    expect(await resolveRingableVolunteers(services, scheduledIn)).toBeNull()
  })
})

/**
 * Known, NOT fixed here: `isShiftActive` treats the shift window as half-open
 * (`currentTime < endTime`), so a 00:00–23:59 "always on" shift is off shift
 * for the last minute of every day, and a genuine 24h shift has to be written
 * `start == end`. `activeWindow()` above deliberately avoids 00:00–23:59, so
 * these tests neither depend on nor detect that bug — it belongs to the
 * schedule half of the conjunct, which this change does not touch.
 */
