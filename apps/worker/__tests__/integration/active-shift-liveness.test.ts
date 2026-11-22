/**
 * A clock-in only counts while its heartbeat is fresh — real PostgreSQL (#1142).
 *
 * `ring = scheduled_now ∩ clocked_in` made a clock-in load-bearing, and a
 * clock-in that never expires keeps the intersection non-empty for a volunteer
 * who closed the app, which suppresses the hub's fallback group. These tests
 * age `active_shifts.last_heartbeat` directly in the database (no sleeping, no
 * fake timers) and assert what the ring path, the heartbeat route's service
 * method and the reaper actually do with a real table.
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
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../../db'
import type { Services } from '../../services'
import * as schema from '../../db/schema'
import { activeShifts, hubs, shifts, users } from '../../db/schema'
import { ShiftsService } from '../../services/shifts'
import { ActiveShiftsService, DEFAULT_ACTIVE_SHIFT_LIVENESS } from '../../services/active-shifts'
import { runActiveShiftReap } from '../../lib/active-shift-reaper-worker'
import type { AuditService } from '../../services/audit'
import { createSettingsDomain, type SettingsDomainServices } from '../../services/settings-domain'
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
const PK_OTHER = pk('other')
const PK_SCHEDULED_ONLY = pk('schedonly')
const PK_CLOCKED_ONLY = pk('clockonly')
const PK_FALLBACK = pk('fallback')
const ALL_PUBKEYS = [PK_OTHER, PK_BOTH, PK_SCHEDULED_ONLY, PK_CLOCKED_ONLY, PK_FALLBACK]

/** One hub per scenario, so scenarios cannot see each other's rosters. */
const hubId = (name: string) => `hub-${name}-${RUN}`

let sql: ReturnType<typeof postgres>
let db: Database
let services: Services
let shiftsService: ShiftsService
let activeShiftsService: ActiveShiftsService
let settings: SettingsDomainServices

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

/** Grant `pubkey` the volunteer role assignment in `hub` — hub membership is
 * the isolation boundary (#1044): without it, a call to `hub` must not ring
 * them no matter what the schedule says. */
async function makeMember(pubkey: string, hub: string): Promise<void> {
  const [row] = await db.select({ hubRoles: users.hubRoles }).from(users).where(eq(users.pubkey, pubkey))
  const existing = (row?.hubRoles ?? []) as Array<{ hubId: string; roleIds: string[] }>
  if (existing.some(hr => hr.hubId === hub)) return
  await db.update(users)
    .set({ hubRoles: [...existing, { hubId: hub, roleIds: ['role-volunteer'] }] })
    .where(eq(users.pubkey, pubkey))
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
  settings = createSettingsDomain(db)

  // Seeds the roles table; without roles, `resolveHubPermissions` grants nobody
  // access to any hub and the resolver would reject everyone for the wrong reason.
  await settings.settingsBootstrap.ensureInit()

  services = {
    shifts: shiftsService,
    activeShifts: activeShiftsService,
    ...settings,
    identity: new IdentityService(db),
    calls: new CallsService(db),
  } as unknown as Services

  // Every test user is an active, non-break volunteer reachable by phone. Hub
  // authority comes from the per-hub assignment each test grants with
  // `makeMember` — a global role that is not super-admin grants nothing inside
  // a hub (#1044), so scheduling alone must not make anyone ringable.
  await db.insert(users).values(
    ALL_PUBKEYS.map((pubkey, i) => ({
      pubkey,
      roles: [],
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


const STALE_MS = DEFAULT_ACTIVE_SHIFT_LIVENESS.staleAfterMs

/** Move a clock-in's last heartbeat to `ageMs` ago, as if the client went quiet then. */
async function ageHeartbeat(pubkey: string, hub: string, ageMs: number): Promise<void> {
  await db.update(activeShifts)
    .set({ lastHeartbeat: new Date(Date.now() - ageMs) })
    .where(and(eq(activeShifts.pubkey, pubkey), eq(activeShifts.hubId, hub)))
}

async function rowExists(pubkey: string, hub: string): Promise<boolean> {
  const rows = await db.select({ pubkey: activeShifts.pubkey }).from(activeShifts)
    .where(and(eq(activeShifts.pubkey, pubkey), eq(activeShifts.hubId, hub)))
  return rows.length > 0
}

describe('a stale clock-in does not ring', () => {
  it('rings on a fresh clock-in, and the same volunteer stops ringing once the heartbeat goes quiet', async () => {
    const hub = await makeHub('goes-stale')
    await makeMember(PK_BOTH, hub)
    await schedule(hub, [PK_BOTH])
    await activeShiftsService.clockIn(PK_BOTH, hub)
    expect(await wouldRing(hub)).toEqual([PK_BOTH])

    await ageHeartbeat(PK_BOTH, hub, STALE_MS + 1_000)

    // Scheduled, and the row is still in the table — only the heartbeat is old.
    expect(await shiftsService.getCurrentVolunteers(hub)).toEqual([PK_BOTH])
    expect(await rowExists(PK_BOTH, hub)).toBe(true)
    expect(await resolveRingableVolunteers(services, hub)).toBeNull()
  })

  it('a stale clock-in does not suppress the fallback group', async () => {
    // The sharp edge: before this, one abandoned clock-in kept the intersection
    // non-empty, so the call rang a phone nobody held and the fallback group
    // that exists for exactly this case was never tried.
    const hub = await makeHub('fallback-reached')
    await makeMember(PK_BOTH, hub)
    await makeMember(PK_FALLBACK, hub)
    await schedule(hub, [PK_BOTH])
    await settings.callSettings.setFallbackGroup({ userPubkeys: [PK_FALLBACK] }, hub)
    await activeShiftsService.clockIn(PK_BOTH, hub)
    expect(await wouldRing(hub)).toEqual([PK_BOTH])

    await ageHeartbeat(PK_BOTH, hub, STALE_MS + 1_000)

    expect(await wouldRing(hub)).toEqual([PK_FALLBACK])
  })

  it('a clock-in just inside the window still rings', async () => {
    const hub = await makeHub('inside-window')
    await makeMember(PK_BOTH, hub)
    await schedule(hub, [PK_BOTH])
    await activeShiftsService.clockIn(PK_BOTH, hub)
    await ageHeartbeat(PK_BOTH, hub, STALE_MS - 30_000)

    expect(await wouldRing(hub)).toEqual([PK_BOTH])
  })

  it('a heartbeat keeps a clock-in alive past the moment its silent neighbour goes stale', async () => {
    const hub = await makeHub('kept-alive')
    await activeShiftsService.clockIn(PK_BOTH, hub)
    await activeShiftsService.clockIn(PK_OTHER, hub)
    // Both nearly stale: thirty seconds of further silence and they would drop off.
    await ageHeartbeat(PK_BOTH, hub, STALE_MS - 30_000)
    await ageHeartbeat(PK_OTHER, hub, STALE_MS - 30_000)

    await activeShiftsService.heartbeat(PK_BOTH, hub)

    // Judge both a minute from now, with no waiting: the heartbeated volunteer is
    // still present, the one who stayed silent is not.
    const aMinuteOn = new Date(Date.now() + 60_000)
    expect(await activeShiftsService.listClockedInPubkeys(hub, aMinuteOn)).toEqual(new Set([PK_BOTH]))
  })

  it('a heartbeat does not revive a stale clock-in; the volunteer must clock in again', async () => {
    const hub = await makeHub('no-revive')
    await makeMember(PK_BOTH, hub)
    await schedule(hub, [PK_BOTH])
    await activeShiftsService.clockIn(PK_BOTH, hub)
    await ageHeartbeat(PK_BOTH, hub, STALE_MS + 1_000)

    await expect(activeShiftsService.heartbeat(PK_BOTH, hub)).rejects.toMatchObject({ status: 404 })
    expect(await activeShiftsService.getActive(PK_BOTH, hub)).toBeNull()
    expect(await resolveRingableVolunteers(services, hub)).toBeNull()

    // Consent is renewed by clocking in, which starts a fresh row.
    await activeShiftsService.clockIn(PK_BOTH, hub)
    expect(await wouldRing(hub)).toEqual([PK_BOTH])
  })

  it('the admin roster and the volunteer\'s own status agree with the ring path', async () => {
    const hub = await makeHub('roster-agrees')
    await activeShiftsService.clockIn(PK_BOTH, hub)
    await activeShiftsService.clockIn(PK_OTHER, hub)
    await ageHeartbeat(PK_OTHER, hub, STALE_MS + 1_000)

    const { activeShifts: roster } = await activeShiftsService.listActiveByHub(hub)
    expect(roster.map(r => r.pubkey)).toEqual([PK_BOTH])
    expect(await activeShiftsService.getActive(PK_OTHER, hub)).toBeNull()
    expect(await activeShiftsService.listClockedInPubkeys(hub)).toEqual(new Set([PK_BOTH]))
  })

  it('judges each hub on its own clock-in: stale in one hub, live in another', async () => {
    // Multi-hub axiom: nothing here depends on which hub is "active".
    const hubA = await makeHub('multi-a')
    const hubB = await makeHub('multi-b')
    await makeMember(PK_BOTH, hubA)
    await makeMember(PK_BOTH, hubB)
    await schedule(hubA, [PK_BOTH])
    await schedule(hubB, [PK_BOTH])
    await activeShiftsService.clockIn(PK_BOTH, hubA)
    await activeShiftsService.clockIn(PK_BOTH, hubB)
    expect(await wouldRing(hubA)).toEqual([PK_BOTH])
    expect(await wouldRing(hubB)).toEqual([PK_BOTH])

    await ageHeartbeat(PK_BOTH, hubA, STALE_MS + 1_000)

    expect(await resolveRingableVolunteers(services, hubA)).toBeNull()
    expect(await wouldRing(hubB)).toEqual([PK_BOTH])
  })

  it('honours a configured window: the same row is fresh under the default and stale under a tighter one', async () => {
    const hub = await makeHub('configured')
    await activeShiftsService.clockIn(PK_BOTH, hub)
    await ageHeartbeat(PK_BOTH, hub, 2 * 60_000)

    expect(await activeShiftsService.listClockedInPubkeys(hub)).toEqual(new Set([PK_BOTH]))

    const tight = new ActiveShiftsService(db, { staleAfterMs: 90_000, reapIntervalMs: 30_000 })
    expect(await tight.listClockedInPubkeys(hub)).toEqual(new Set())
  })
})

describe('the reaper', () => {
  function auditStub() {
    const log = vi.fn(async () => undefined)
    return { service: { log } as unknown as AuditService, log }
  }

  it('deletes stale clock-ins in every hub, keeps fresh ones, and audits each eviction', async () => {
    const hubA = await makeHub('reap-a')
    const hubB = await makeHub('reap-b')
    await activeShiftsService.clockIn(PK_BOTH, hubA)      // stale, hub A
    await activeShiftsService.clockIn(PK_BOTH, hubB)      // fresh, hub B — same user
    await activeShiftsService.clockIn(PK_OTHER, hubB)     // stale, hub B
    await ageHeartbeat(PK_BOTH, hubA, STALE_MS + 1_000)
    await ageHeartbeat(PK_OTHER, hubB, STALE_MS + 60_000)
    const audit = auditStub()

    const removed = await runActiveShiftReap(activeShiftsService, audit.service)

    // Other runs' rows may also be stale in a shared database; ours must be gone
    // and the fresh one must not be.
    expect(removed).toBeGreaterThanOrEqual(2)
    expect(await rowExists(PK_BOTH, hubA)).toBe(false)
    expect(await rowExists(PK_OTHER, hubB)).toBe(false)
    expect(await rowExists(PK_BOTH, hubB)).toBe(true)
    expect(audit.log).toHaveBeenCalledWith('shiftClockOut', PK_BOTH, expect.objectContaining({ reason: 'heartbeat_stale' }), hubA)
    expect(audit.log).toHaveBeenCalledWith('shiftClockOut', PK_OTHER, expect.objectContaining({ reason: 'heartbeat_stale' }), hubB)
    expect(audit.log).not.toHaveBeenCalledWith('shiftClockOut', PK_BOTH, expect.anything(), hubB)
  })

  it('a failed audit write does not undo or abort the eviction', async () => {
    const hub = await makeHub('reap-audit-fails')
    await activeShiftsService.clockIn(PK_BOTH, hub)
    await ageHeartbeat(PK_BOTH, hub, STALE_MS + 1_000)
    const failing = { log: vi.fn(async () => { throw new Error('audit unavailable') }) } as unknown as AuditService

    await expect(runActiveShiftReap(activeShiftsService, failing)).resolves.toBeGreaterThanOrEqual(1)
    expect(await rowExists(PK_BOTH, hub)).toBe(false)
  })
})
