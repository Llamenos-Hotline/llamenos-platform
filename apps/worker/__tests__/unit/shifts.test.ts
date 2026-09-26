import { describe, it, expect, vi, afterEach } from 'vitest'
import { ShiftsService, isShiftActive } from '@worker/services/shifts'
import { ServiceError } from '@worker/services/settings'
import { createMockDb } from './mock-db'

describe('ShiftsService', () => {
  function setup() {
    const { db } = createMockDb(['shifts', 'pushRemindersSent'])
    const service = new ShiftsService(db as any)
    return { db, service }
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

      db.$setSelectResult([makeShift({
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

      db.$setSelectResult([
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
          db.$setSelectResult([makeShift({ days: [5], startTime: '22:00', endTime: '06:00', userPubkeys: ['pk1'] })])
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

      db.$setSelectResult([makeShift({
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
      db.$setSelectResult([makeShift({
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

      db.$setSelectResult([makeShift({
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
      db.$setSelectResult([makeShift({
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
