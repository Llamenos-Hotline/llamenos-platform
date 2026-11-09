import { describe, it, expect, vi, afterEach } from 'vitest'
import { ShiftsService, isShiftActive, shiftWallClock } from '@worker/services/shifts'
import { ServiceError } from '@worker/services/settings'
import { createMockDb } from './mock-db'

describe('ShiftsService', () => {
  function setup() {
    const { db } = createMockDb(['shifts', 'pushRemindersSent'])
    const service = new ShiftsService(db as any)
    return { db, service }
  }

  /** The select sequence the roster reads: the hub's shifts, then (only if any) the hub's zone. */
  function seedRoster(db: { $setSelectResults: (r: unknown[][]) => void }, shiftRows: unknown[], timezone = 'UTC') {
    db.$setSelectResults(shiftRows.length > 0 ? [shiftRows, [{ timezone }]] : [shiftRows])
  }

  function makeShift(overrides: Partial<{ id: string; hubId: string; encryptedName: string; startTime: string; endTime: string; days: number[]; userPubkeys: string[] }> = {}) {
    return {
      id: 'shift-1',
      hubId: 'hub-1',
      encryptedName: 'Morning',
      startTime: '08:00',
      endTime: '12:00',
      days: [1, 2, 3, 4, 5],
      userPubkeys: ['pk1', 'pk2'],
      createdAt: new Date(),
      ...overrides,
    }
  }

  describe('create', () => {
    it('creates a shift with valid times', async () => {
      const { db, service } = setup()
      const shift = makeShift()
      db.$setInsertResult([shift])

      const result = await service.create('hub-1', {
        encryptedName: 'Morning',
        startTime: '08:00',
        endTime: '12:00',
        days: [1, 2, 3, 4, 5],
        userPubkeys: ['pk1', 'pk2'],
      })

      expect(result.encryptedName).toBe('Morning')
    })

    it('rejects invalid time format', async () => {
      const { service } = setup()
      await expect(service.create('hub-1', {
        encryptedName: 'Bad',
        startTime: '8:00',
        endTime: '12:00',
        days: [1],
        userPubkeys: [],
      })).rejects.toThrow(ServiceError)
    })

    it('rejects 24:00', async () => {
      const { service } = setup()
      await expect(service.create('hub-1', {
        encryptedName: 'Bad',
        startTime: '24:00',
        endTime: '12:00',
        days: [1],
        userPubkeys: [],
      })).rejects.toThrow(ServiceError)
    })

    it('rejects invalid minutes', async () => {
      const { service } = setup()
      await expect(service.create('hub-1', {
        encryptedName: 'Bad',
        startTime: '08:60',
        endTime: '12:00',
        days: [1],
        userPubkeys: [],
      })).rejects.toThrow(ServiceError)
    })
  })

  describe('update', () => {
    it('updates a shift', async () => {
      const { db, service } = setup()
      const updated = makeShift({ encryptedName: 'Updated' })
      db.$setUpdateResult([updated])

      const result = await service.update('hub-1', 'shift-1', { encryptedName: 'Updated' })
      expect(result.encryptedName).toBe('Updated')
    })

    it('throws 404 if shift not found', async () => {
      const { db, service } = setup()
      db.$setUpdateResult([])

      await expect(service.update('hub-1', 'shift-1', { encryptedName: 'Updated' }))
        .rejects.toThrow('Shift not found')
    })

    it('validates startTime format', async () => {
      const { service } = setup()
      await expect(service.update('hub-1', 'shift-1', { startTime: '8:00' }))
        .rejects.toThrow('Invalid time format')
    })
  })

  describe('delete', () => {
    it('deletes existing shift', async () => {
      const { db, service } = setup()
      db.$setDeleteResult([{ id: 'shift-1' }])

      const result = await service.delete('hub-1', 'shift-1')
      expect(result.ok).toBe(true)
    })

    it('throws 404 for missing shift', async () => {
      const { db, service } = setup()
      db.$setDeleteResult([])

      await expect(service.delete('hub-1', 'shift-1'))
        .rejects.toThrow('Shift not found')
    })
  })

  describe('getCurrentVolunteers', () => {
    it('returns active volunteers', async () => {
      const { db, service } = setup()
      const now = new Date()
      const currentDay = now.getUTCDay()
      const currentHour = String(now.getUTCHours()).padStart(2, '0')
      const nextHour = String((now.getUTCHours() + 1) % 24).padStart(2, '0')

      seedRoster(db, [makeShift({
        days: [currentDay],
        startTime: `${currentHour}:00`,
        endTime: `${nextHour}:00`,
        userPubkeys: ['pk1', 'pk2'],
      })])

      const result = await service.getCurrentVolunteers('hub-1')
      expect(result).toContain('pk1')
      expect(result).toContain('pk2')
    })

    it('returns unique volunteers across multiple shifts', async () => {
      const { db, service } = setup()
      const now = new Date()
      const currentDay = now.getUTCDay()
      const currentHour = String(now.getUTCHours()).padStart(2, '0')
      const nextHour = String((now.getUTCHours() + 1) % 24).padStart(2, '0')

      seedRoster(db, [
        makeShift({
          id: 'shift-1',
          days: [currentDay],
          startTime: `${currentHour}:00`,
          endTime: `${nextHour}:00`,
          userPubkeys: ['pk1'],
        }),
        makeShift({
          id: 'shift-2',
          days: [currentDay],
          startTime: `${currentHour}:00`,
          endTime: `${nextHour}:00`,
          userPubkeys: ['pk1', 'pk2'],
        }),
      ])

      const result = await service.getCurrentVolunteers('hub-1')
      expect(result).toHaveLength(2)
      expect(result).toContain('pk1')
      expect(result).toContain('pk2')
    })

    // The fallback group is a ringing policy (services/ringing.ts), not part of the roster.
    it('returns an empty array when no shift is active', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      const result = await service.getCurrentVolunteers('hub-1')
      expect(result).toEqual([])
    })

    describe('overnight shifts (Fri 22:00-06:00)', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      // 2026-01-02 is a Friday, 2026-01-03 a Saturday
      const cases: Array<[string, string, boolean]> = [
        ['Fri 23:00 (before midnight, listed day)', '2026-01-02T23:00:00Z', true],
        ['Sat 02:00 (after midnight, day after listed day)', '2026-01-03T02:00:00Z', true],
        ['Fri 02:00 (early Friday belongs to Thursday night)', '2026-01-02T02:00:00Z', false],
        ['Sat 06:00 (end is exclusive)', '2026-01-03T06:00:00Z', false],
        ['Sat 23:00 (Saturday night is not listed)', '2026-01-03T23:00:00Z', false],
      ]
      for (const [label, iso, expected] of cases) {
        it(`${label} -> ${expected ? 'on' : 'off'} shift`, async () => {
          vi.useFakeTimers()
          vi.setSystemTime(new Date(iso))
          const { db, service } = setup()
          seedRoster(db, [makeShift({ days: [5], startTime: '22:00', endTime: '06:00', userPubkeys: ['pk1'] })])
          const result = await service.getCurrentVolunteers('hub-1')
          expect(result.includes('pk1')).toBe(expected)
        })
      }
    })
  })

  describe('isShiftActive', () => {
    const overnight = { startTime: '22:00', endTime: '06:00', days: [5] }

    it('same-day shift requires listed day and time window', () => {
      const day = { startTime: '08:00', endTime: '12:00', days: [1] }
      expect(isShiftActive(day, 1, '09:00')).toBe(true)
      expect(isShiftActive(day, 2, '09:00')).toBe(false)
      expect(isShiftActive(day, 1, '12:00')).toBe(false)
    })

    it('overnight: active on start day from startTime', () => {
      expect(isShiftActive(overnight, 5, '21:59')).toBe(false)
      expect(isShiftActive(overnight, 5, '22:00')).toBe(true)
      expect(isShiftActive(overnight, 5, '23:59')).toBe(true)
    })

    it('overnight: active the next day until endTime, not on start day morning', () => {
      expect(isShiftActive(overnight, 6, '00:00')).toBe(true)
      expect(isShiftActive(overnight, 6, '05:59')).toBe(true)
      expect(isShiftActive(overnight, 6, '06:00')).toBe(false)
      expect(isShiftActive(overnight, 5, '02:00')).toBe(false)
    })

    it('overnight: Saturday -> Sunday wrap (day 6 -> day 0)', () => {
      const satNight = { startTime: '22:00', endTime: '06:00', days: [6] }
      expect(isShiftActive(satNight, 6, '23:00')).toBe(true)
      expect(isShiftActive(satNight, 0, '02:00')).toBe(true)
      expect(isShiftActive(satNight, 0, '06:00')).toBe(false)
      expect(isShiftActive(satNight, 6, '02:00')).toBe(false)
    })

    it('overnight: the reported repro (yesterday covers now, today has not started)', () => {
      const s = { startTime: '08:55', endTime: '07:55', days: [5] }
      expect(isShiftActive(s, 6, '06:55')).toBe(true)
      expect(isShiftActive({ ...s, days: [6] }, 6, '06:55')).toBe(false)
    })
  })

  describe('getMyStatus', () => {
    it('returns onShift=true when currently in shift', async () => {
      const { db, service } = setup()
      const now = new Date()
      const currentDay = now.getUTCDay()
      const currentHour = String(now.getUTCHours()).padStart(2, '0')
      const nextHour = String((now.getUTCHours() + 1) % 24).padStart(2, '0')

      seedRoster(db, [makeShift({
        days: [currentDay],
        startTime: `${currentHour}:00`,
        endTime: `${nextHour}:00`,
        userPubkeys: ['pk1'],
      })])

      const result = await service.getMyStatus('hub-1', 'pk1')
      expect(result.onShift).toBe(true)
      expect(result.currentShift).not.toBeNull()
    })

    it('returns onShift=false when not in any shift', async () => {
      const { db, service } = setup()
      seedRoster(db, [makeShift({
        days: [1, 2, 3, 4, 5, 6, 0],
        startTime: '08:00',
        endTime: '12:00',
        userPubkeys: ['pk1'],
      })])

      // pk2 is not in any shift, so should always return onShift=false regardless of time
      const result = await service.getMyStatus('hub-1', 'pk2')
      expect(result.onShift).toBe(false)
      expect(result.currentShift).toBeNull()
    })

    it('finds next upcoming shift', async () => {
      const { db, service } = setup()
      const tomorrow = (new Date().getUTCDay() + 1) % 7

      seedRoster(db, [makeShift({
        days: [tomorrow],
        startTime: '09:00',
        endTime: '17:00',
        userPubkeys: ['pk1'],
      })])

      const result = await service.getMyStatus('hub-1', 'pk1')
      expect(result.nextShift).not.toBeNull()
      expect(result.nextShift?.day).toBe(tomorrow)
    })

    it('handles volunteer in no shifts', async () => {
      const { db, service } = setup()
      seedRoster(db, [makeShift({
        days: [1],
        startTime: '08:00',
        endTime: '12:00',
        userPubkeys: ['pk2'],
      })])

      const result = await service.getMyStatus('hub-1', 'pk1')
      expect(result.onShift).toBe(false)
      expect(result.nextShift).toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Hub time zone (#1054). A shift's startTime/endTime/days are wall-clock values
  // in the HUB's IANA zone. Every instant below is an explicit UTC ISO string so
  // the expected local time is checkable by hand, and none depends on the machine
  // running the test (nor on its TZ).
  // ─────────────────────────────────────────────────────────────────────────
  describe('hub time zone', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    async function onShiftAt(iso: string, timezone: string, shift: { days: number[]; startTime: string; endTime: string }) {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(iso))
      const { db, service } = setup()
      seedRoster(db, [makeShift({ ...shift, userPubkeys: ['pk1'] })], timezone)
      return (await service.getCurrentVolunteers('hub-1')).includes('pk1')
    }

    const everyDay = [0, 1, 2, 3, 4, 5, 6]

    it("the issue's repro: 06:55 UTC is 02:55 in New York, inside a 01:25-04:25 shift", async () => {
      const shift = { days: everyDay, startTime: '01:25', endTime: '04:25' }
      expect(await onShiftAt('2026-07-15T06:55:00Z', 'America/New_York', shift)).toBe(true)
      // The same wall-clock shift in a UTC hub is NOT live at that instant.
      expect(await onShiftAt('2026-07-15T06:55:00Z', 'UTC', shift)).toBe(false)
    })

    it('New York summer (UTC-4): a 09:00-17:00 shift is live 13:00-17:00 UTC, not 09:00-17:00 UTC', async () => {
      const shift = { days: everyDay, startTime: '09:00', endTime: '17:00' }
      const cases: Array<[string, boolean]> = [
        ['2026-07-15T12:59:00Z', false], // 08:59 local
        ['2026-07-15T13:00:00Z', true], // 09:00 local
        ['2026-07-15T20:59:00Z', true], // 16:59 local
        ['2026-07-15T21:00:00Z', false], // 17:00 local — end is exclusive
        ['2026-07-15T10:00:00Z', false], // 06:00 local: inside the UTC window, outside the local one
      ]
      for (const [iso, expected] of cases) {
        expect(await onShiftAt(iso, 'America/New_York', shift), iso).toBe(expected)
      }
    })

    it('Berlin summer (UTC+2): a 09:00-17:00 shift is live 07:00-15:00 UTC', async () => {
      const shift = { days: everyDay, startTime: '09:00', endTime: '17:00' }
      expect(await onShiftAt('2026-07-15T06:59:00Z', 'Europe/Berlin', shift)).toBe(false)
      expect(await onShiftAt('2026-07-15T07:00:00Z', 'Europe/Berlin', shift)).toBe(true)
      expect(await onShiftAt('2026-07-15T14:59:00Z', 'Europe/Berlin', shift)).toBe(true)
      expect(await onShiftAt('2026-07-15T15:00:00Z', 'Europe/Berlin', shift)).toBe(false)
    })

    it('handles a half-hour offset (Asia/Kolkata, UTC+5:30)', async () => {
      const shift = { days: everyDay, startTime: '09:00', endTime: '10:00' }
      expect(await onShiftAt('2026-07-15T03:29:00Z', 'Asia/Kolkata', shift)).toBe(false)
      expect(await onShiftAt('2026-07-15T03:30:00Z', 'Asia/Kolkata', shift)).toBe(true)
      expect(await onShiftAt('2026-07-15T04:29:00Z', 'Asia/Kolkata', shift)).toBe(true)
      expect(await onShiftAt('2026-07-15T04:30:00Z', 'Asia/Kolkata', shift)).toBe(false)
    })

    it('the WEEKDAY is the hub-local weekday, not the UTC one', async () => {
      // 2026-07-14 is a Tuesday. 03:00 UTC Tuesday is 23:00 Monday in New York.
      const mondayNight = { days: [1], startTime: '22:00', endTime: '23:59' }
      expect(await onShiftAt('2026-07-14T03:00:00Z', 'America/New_York', mondayNight)).toBe(true)
      expect(await onShiftAt('2026-07-14T03:00:00Z', 'UTC', mondayNight)).toBe(false)
      // And the other direction: 23:00 UTC Monday is already Tuesday 01:00 in Berlin.
      const tuesdayEarly = { days: [2], startTime: '00:30', endTime: '02:00' }
      expect(await onShiftAt('2026-07-13T23:00:00Z', 'Europe/Berlin', tuesdayEarly)).toBe(true)
      expect(await onShiftAt('2026-07-13T23:00:00Z', 'UTC', tuesdayEarly)).toBe(false)
    })

    // The reason this is an IANA zone and not a stored offset: the offset changes
    // twice a year, and the schedule must keep meaning "09:00 here".
    describe('DST (America/New_York)', () => {
      const sundayDay = { days: [0], startTime: '09:00', endTime: '17:00' }

      it('spring forward, Sun 2026-03-08 (EST -> EDT): the 09:00 start moves from 14:00 UTC to 13:00 UTC', async () => {
        // The Sunday before the change: EST, UTC-5.
        expect(await onShiftAt('2026-03-01T13:59:00Z', 'America/New_York', sundayDay)).toBe(false)
        expect(await onShiftAt('2026-03-01T14:00:00Z', 'America/New_York', sundayDay)).toBe(true)
        // The day of the change: EDT, UTC-4 — the same 09:00 is one UTC hour earlier.
        expect(await onShiftAt('2026-03-08T12:59:00Z', 'America/New_York', sundayDay)).toBe(false)
        expect(await onShiftAt('2026-03-08T13:00:00Z', 'America/New_York', sundayDay)).toBe(true)
        expect(await onShiftAt('2026-03-08T20:59:00Z', 'America/New_York', sundayDay)).toBe(true)
        expect(await onShiftAt('2026-03-08T21:00:00Z', 'America/New_York', sundayDay)).toBe(false)
      })

      it('fall back, Sun 2026-11-01 (EDT -> EST): the 09:00 start moves from 13:00 UTC to 14:00 UTC', async () => {
        expect(await onShiftAt('2026-10-25T12:59:00Z', 'America/New_York', sundayDay)).toBe(false)
        expect(await onShiftAt('2026-10-25T13:00:00Z', 'America/New_York', sundayDay)).toBe(true)
        expect(await onShiftAt('2026-11-01T13:59:00Z', 'America/New_York', sundayDay)).toBe(false)
        expect(await onShiftAt('2026-11-01T14:00:00Z', 'America/New_York', sundayDay)).toBe(true)
        expect(await onShiftAt('2026-11-01T21:59:00Z', 'America/New_York', sundayDay)).toBe(true)
        expect(await onShiftAt('2026-11-01T22:00:00Z', 'America/New_York', sundayDay)).toBe(false)
      })

      it('a shift straddling the spring-forward gap starts when the clock first reaches it', async () => {
        // 02:30 does not exist on 2026-03-08: the clock goes 01:59 EST -> 03:00 EDT.
        const straddle = { days: [0], startTime: '02:30', endTime: '04:00' }
        expect(await onShiftAt('2026-03-08T06:59:00Z', 'America/New_York', straddle)).toBe(false) // 01:59 EST
        expect(await onShiftAt('2026-03-08T07:00:00Z', 'America/New_York', straddle)).toBe(true) // 03:00 EDT
        expect(await onShiftAt('2026-03-08T07:59:00Z', 'America/New_York', straddle)).toBe(true) // 03:59 EDT
        expect(await onShiftAt('2026-03-08T08:00:00Z', 'America/New_York', straddle)).toBe(false) // 04:00 EDT
      })

      it('a shift over the repeated fall-back hour is on for both passes through it', async () => {
        // 01:00-02:00 occurs twice on 2026-11-01: 05:00-06:00 UTC (EDT), then 06:00-07:00 UTC (EST).
        const repeated = { days: [0], startTime: '01:00', endTime: '02:00' }
        expect(await onShiftAt('2026-11-01T04:59:00Z', 'America/New_York', repeated)).toBe(false) // 00:59 EDT
        expect(await onShiftAt('2026-11-01T05:30:00Z', 'America/New_York', repeated)).toBe(true) // 01:30 EDT
        expect(await onShiftAt('2026-11-01T06:30:00Z', 'America/New_York', repeated)).toBe(true) // 01:30 EST
        expect(await onShiftAt('2026-11-01T07:00:00Z', 'America/New_York', repeated)).toBe(false) // 02:00 EST
      })
    })

    it('getMyStatus reports on-shift and the next shift day in the hub zone', async () => {
      // Tue 2026-07-14 03:00 UTC = Mon 23:00 in New York. Monday 22:00-23:59 is live now;
      // Tuesday 09:00 is the next one.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-14T03:00:00Z'))
      const { db, service } = setup()
      seedRoster(db, [
        makeShift({ id: 'mon-night', days: [1], startTime: '22:00', endTime: '23:59', userPubkeys: ['pk1'] }),
        makeShift({ id: 'tue-morning', days: [2], startTime: '09:00', endTime: '17:00', userPubkeys: ['pk1'] }),
      ], 'America/New_York')

      const status = await service.getMyStatus('hub-1', 'pk1')
      expect(status.onShift).toBe(true)
      expect(status.currentShift?.id).toBe('mon-night')
      expect(status.nextShift?.id).toBe('tue-morning')
      expect(status.nextShift?.day).toBe(2)
    })

    it('getMyStatus is off-shift at an hour that is on-shift only in UTC', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-15T10:00:00Z')) // 06:00 in New York
      const { db, service } = setup()
      seedRoster(db, [makeShift({ days: everyDay, startTime: '09:00', endTime: '17:00', userPubkeys: ['pk1'] })], 'America/New_York')
      expect((await service.getMyStatus('hub-1', 'pk1')).onShift).toBe(false)
    })

    it('refuses to evaluate a hub that does not exist rather than assuming a zone', async () => {
      const { db, service } = setup()
      db.$setSelectResults([[makeShift()], []])
      await expect(service.getCurrentVolunteers('hub-1')).rejects.toMatchObject({ status: 404 })
    })
  })

  describe('shiftWallClock', () => {
    it('reads weekday and HH:MM in the zone, with midnight as 00 and never 24', () => {
      // 2026-07-15 is a Wednesday. 04:05 UTC = 00:05 Wednesday in New York (EDT).
      expect(shiftWallClock(new Date('2026-07-15T04:05:00Z'), 'America/New_York')).toEqual({ day: 3, time: '00:05', minutes: 5 })
      expect(shiftWallClock(new Date('2026-07-15T03:59:00Z'), 'America/New_York')).toEqual({ day: 2, time: '23:59', minutes: 1439 })
      expect(shiftWallClock(new Date('2026-07-15T00:00:00Z'), 'UTC')).toEqual({ day: 3, time: '00:00', minutes: 0 })
    })

    it('does not depend on the process TZ', () => {
      const before = process.env.TZ
      try {
        const readings = ['Pacific/Auckland', 'America/Los_Angeles'].map((tz) => {
          process.env.TZ = tz
          return shiftWallClock(new Date('2026-07-15T12:00:00Z'), 'Europe/Berlin')
        })
        expect(readings[0]).toEqual(readings[1])
        expect(readings[0]).toEqual({ day: 3, time: '14:00', minutes: 840 })
      } finally {
        if (before === undefined) delete process.env.TZ
        else process.env.TZ = before
      }
    })
  })

  describe('reminder tracking', () => {
    it('marks reminder as sent', async () => {
      const { service } = setup()
      await expect(service.markReminderSent('shift-1', '2024-01-01', 'pk1'))
        .resolves.toBeUndefined()
    })

    it('checks if reminder was sent', async () => {
      const { db, service } = setup()
      db.$setSelectResult([{ shiftId: 'shift-1' }])

      const result = await service.hasReminderBeenSent('shift-1', '2024-01-01', 'pk1')
      expect(result).toBe(true)
    })

    it('returns false if reminder not sent', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      const result = await service.hasReminderBeenSent('shift-1', '2024-01-01', 'pk1')
      expect(result).toBe(false)
    })
  })

  describe('reset', () => {
    it('resets shifts for hub', async () => {
      const { service } = setup()
      const result = await service.reset('hub-1')
      expect(result.ok).toBe(true)
    })
  })
})
