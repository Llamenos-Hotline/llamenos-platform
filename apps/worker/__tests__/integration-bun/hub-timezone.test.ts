/**
 * A hub's time zone decides who is on shift (#1054) — real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is a `bun-jsonb`
 * column; see hub-last-admin.test.ts):
 *   bun test apps/worker/__tests__/integration-bun/hub-timezone.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`).
 *
 * Three things are pinned against the real schema, none of which a mocked
 * database can show:
 *  - the migration's default: a hub row written without a zone (the previous
 *    release's INSERT) reads back as UTC, not NULL and not an error;
 *  - a PATCH that omits `timezone` leaves the stored zone alone — the body goes
 *    through the real `updateHubBodySchema`, so a default materialised by
 *    `.partial()` (#1643) would reset the hub to UTC here;
 *  - the roster the ringing path reads follows the stored zone, DST included.
 */
import { describe, it, expect, afterAll, afterEach, setSystemTime } from 'bun:test'
import { inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs, shifts, users } from '../../db/schema'
import { SettingsService } from '../../services/settings'
import { ShiftsService } from '../../services/shifts'
import { createHubBodySchema, updateHubBodySchema } from '@protocol/schemas/hubs'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const settings = new SettingsService(db)
const shiftsService = new ShiftsService(db)

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
let counter = 0
const hexKey = (lead: string) => `${lead}${rand}${(counter++).toString(16).padStart(6, '0')}`.padEnd(64, '0')

const createdUsers: string[] = []
const createdHubs: string[] = []

async function makeFounder(): Promise<string> {
  const pubkey = hexKey('a1')
  await db.insert(users).values({ pubkey, displayName: 'founder' })
  createdUsers.push(pubkey)
  return pubkey
}

/** Found a hub through the same body parse + service call `POST /hubs` makes. */
async function foundHub(body: { timezone?: string }): Promise<string> {
  const founder = await makeFounder()
  const id = `hub-timezone-${suite}-${counter++}`
  const parsed = createHubBodySchema.parse({ name: id, slug: id, ...body })
  const now = new Date().toISOString()
  await settings.createHub(
    { id, name: parsed.name, slug: id, status: 'active', timezone: parsed.timezone, createdBy: founder, createdAt: now, updatedAt: now },
    { pubkey: founder },
  )
  createdHubs.push(id)
  return id
}

afterEach(() => {
  setSystemTime()
})

afterAll(async () => {
  if (createdHubs.length > 0) {
    await db.delete(shifts).where(inArray(shifts.hubId, createdHubs))
    await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  }
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.pubkey, createdUsers))
})

describe('hub time zone: storage', () => {
  it('a hub row written without a zone reads back as UTC (the migration default)', async () => {
    const founder = await makeFounder()
    const id = `hub-timezone-default-${suite}`
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: founder })
    createdHubs.push(id)

    const { hub } = await settings.getHub(id)
    expect(hub.timezone).toBe('UTC')
  })

  it('a hub created without a zone in the body is UTC; one created with a zone keeps it', async () => {
    const plain = await foundHub({})
    const berlin = await foundHub({ timezone: 'Europe/Berlin' })
    expect((await settings.getHub(plain)).hub.timezone).toBe('UTC')
    expect((await settings.getHub(berlin)).hub.timezone).toBe('Europe/Berlin')
  })

  it('a PATCH that omits timezone leaves the zone unchanged (#1643)', async () => {
    const id = await foundHub({ timezone: 'America/New_York' })

    // Exactly what `PATCH /hubs/:id` hands the service: the parsed body.
    const body = updateHubBodySchema.parse({ name: 'Renamed' })
    expect('timezone' in body).toBe(false)
    await settings.updateHub(id, body)

    const { hub } = await settings.getHub(id)
    expect(hub.name).toBe('Renamed')
    expect(hub.timezone).toBe('America/New_York')
  })

  it('a PATCH that names a zone changes it, and only it', async () => {
    const id = await foundHub({ timezone: 'America/New_York' })
    await settings.updateHub(id, updateHubBodySchema.parse({ timezone: 'Asia/Kolkata' }))

    const { hub } = await settings.getHub(id)
    expect(hub.timezone).toBe('Asia/Kolkata')
    expect(hub.name).toBe(id)
  })
})

describe('hub time zone: the roster follows the stored zone', () => {
  async function rosterAt(iso: string, timezone: string, shift: { days: number[]; startTime: string; endTime: string }) {
    const hubId = await foundHub({ timezone })
    const pubkey = hexKey('b2')
    await shiftsService.create(hubId, { encryptedName: 'x', ...shift, userPubkeys: [pubkey] })
    setSystemTime(new Date(iso))
    return (await shiftsService.getCurrentVolunteers(hubId)).includes(pubkey)
  }

  const everyDay = [0, 1, 2, 3, 4, 5, 6]

  it("the issue's repro: 06:55 UTC is 02:55 in New York, inside a 01:25-04:25 shift", async () => {
    const shift = { days: everyDay, startTime: '01:25', endTime: '04:25' }
    expect(await rosterAt('2026-07-15T06:55:00Z', 'America/New_York', shift)).toBe(true)
    expect(await rosterAt('2026-07-15T06:55:00Z', 'UTC', shift)).toBe(false)
  })

  it('moving the hub to another zone moves the same shift', async () => {
    const hubId = await foundHub({ timezone: 'UTC' })
    const pubkey = hexKey('b3')
    await shiftsService.create(hubId, { encryptedName: 'x', days: everyDay, startTime: '09:00', endTime: '17:00', userPubkeys: [pubkey] })

    setSystemTime(new Date('2026-07-15T10:00:00Z'))
    expect(await shiftsService.getCurrentVolunteers(hubId)).toContain(pubkey) // 10:00 UTC

    await settings.updateHub(hubId, updateHubBodySchema.parse({ timezone: 'America/New_York' }))
    expect(await shiftsService.getCurrentVolunteers(hubId)).not.toContain(pubkey) // 06:00 EDT
  })

  it('DST: the same 09:00 shift starts an hour earlier in UTC once New York springs forward', async () => {
    const sunday = { days: [0], startTime: '09:00', endTime: '17:00' }
    expect(await rosterAt('2026-03-01T13:59:00Z', 'America/New_York', sunday)).toBe(false) // 08:59 EST
    expect(await rosterAt('2026-03-01T14:00:00Z', 'America/New_York', sunday)).toBe(true) // 09:00 EST
    expect(await rosterAt('2026-03-08T12:59:00Z', 'America/New_York', sunday)).toBe(false) // 08:59 EDT
    expect(await rosterAt('2026-03-08T13:00:00Z', 'America/New_York', sunday)).toBe(true) // 09:00 EDT
  })
})
