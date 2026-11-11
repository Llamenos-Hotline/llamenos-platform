/**
 * The shift the dev seeding routes create is on shift at EVERY instant (#2573).
 *
 * `POST /api/test-create-shift` (and the shift block of `/api/test-seed`) built a
 * window around "now": `[hour-1]:00` to `min(23, hour+1):59`. A shift window is
 * half-open (`startTime <= now < endTime`, `isShiftActive`), so during hour 23
 * that window closed at 23:59:00 — for the last minute of every UTC day the
 * seeded volunteer was scheduled for nothing. Ring eligibility is
 * `scheduled ∩ clocked in`, so a volunteer who clocked in then was shown as
 * clocked in by the app while the server (correctly) would not ring them. The
 * Android M1 probe's `shifts[role-hub-admin]` flow tripped on exactly that when
 * its merge-queue run reached the seed at 23:59:44 UTC.
 *
 * The assertion is the ring rule's own predicate (`isShiftActive` over
 * `shiftWallClock`), evaluated at the instants the old window got wrong, not a
 * restatement of the window's fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// apps/worker/routes/dev.ts imports apps/worker/db, which uses Bun's native SQL
// driver — unavailable under vitest's worker pool. The route under test only
// reaches `services.shifts.create`, which is stubbed.
vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))

import { Hono } from 'hono'
import dev from '@worker/routes/dev'
import { isShiftActive, shiftWallClock } from '@worker/services/shifts'
import type { AppEnv } from '@worker/types'

const SECRET = 'test-reset-secret'
const PUBKEY = 'a'.repeat(64)
const HUB_ID = '11111111-1111-4111-8111-111111111111'

type CreatedShift = { startTime: string; endTime: string; days: number[]; userPubkeys: string[] }

function appWithShiftsStub(created: CreatedShift[]) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', {
      shifts: {
        create: vi.fn(async (_hubId: string, data: CreatedShift) => {
          created.push(data)
          return { id: 'shift-1', ...data }
        }),
      },
    } as never)
    await next()
  })
  app.route('/', dev)
  return app
}

const ENV = { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }

/** Instants around the boundaries the old window got wrong, plus an ordinary one. */
const INSTANTS = [
  '2026-11-10T23:59:30Z', // the last minute of the UTC day (the merge-queue failure)
  '2026-11-10T23:59:59Z',
  '2026-11-11T00:00:00Z', // the day rolls over
  '2026-11-10T00:00:00Z',
  '2026-11-10T12:30:00Z',
  '2026-11-08T23:59:30Z', // a Sunday: day index 0
]

describe('dev shift seeding is on shift at every instant (#2573)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
  afterEach(() => vi.useRealTimers())

  it.each(INSTANTS)('POST /test-create-shift rosters the volunteer at %s', async (iso) => {
    vi.setSystemTime(new Date(iso))
    const created: CreatedShift[] = []
    const res = await appWithShiftsStub(created).request(
      '/test-create-shift',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Test-Secret': SECRET },
        body: JSON.stringify({ pubkey: PUBKEY, hubId: HUB_ID }),
      },
      ENV,
    )

    expect(res.status).toBe(200)
    expect(created).toHaveLength(1)
    expect(created[0].userPubkeys).toEqual([PUBKEY])
    const { day, time } = shiftWallClock(new Date(iso), 'UTC')
    expect(isShiftActive(created[0], day, time)).toBe(true)
  })

  it('stays on shift for a full day after it was seeded', async () => {
    vi.setSystemTime(new Date('2026-11-10T23:59:30Z'))
    const created: CreatedShift[] = []
    await appWithShiftsStub(created).request(
      '/test-create-shift',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Test-Secret': SECRET },
        body: JSON.stringify({ pubkey: PUBKEY, hubId: HUB_ID }),
      },
      ENV,
    )

    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const at = new Date(Date.parse('2026-11-10T23:59:30Z') + minute * 60_000)
      const { day, time } = shiftWallClock(at, 'UTC')
      expect(isShiftActive(created[0], day, time), at.toISOString()).toBe(true)
    }
  })
})
