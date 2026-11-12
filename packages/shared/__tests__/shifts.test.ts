import { describe, expect, test } from 'bun:test'
import { isShiftActive } from '../../../apps/worker/services/shifts'
import { ALWAYS_ON_SHIFT, shiftWindowAroundHour } from '../shifts'

const minute = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

describe('ALWAYS_ON_SHIFT', () => {
  test('is active at every minute of every weekday, 23:59 included', () => {
    for (let day = 0; day < 7; day++) {
      for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m++) {
          expect(isShiftActive(ALWAYS_ON_SHIFT, day, minute(h, m))).toBe(true)
        }
      }
    }
  })
})

describe('shiftWindowAroundHour', () => {
  test('is active throughout the hour it is built around, for every hour, with no 23:59 gap', () => {
    for (let hour = 0; hour < 24; hour++) {
      const window = shiftWindowAroundHour(hour)
      for (let day = 0; day < 7; day++) {
        for (const m of [0, 30, 59]) {
          expect(isShiftActive(window, day, minute(hour, m))).toBe(true)
        }
      }
    }
  })

  test('wraps past midnight instead of clamping', () => {
    expect(shiftWindowAroundHour(23)).toMatchObject({ startTime: '22:00', endTime: '01:00' })
    expect(shiftWindowAroundHour(0)).toMatchObject({ startTime: '23:00', endTime: '02:00' })
  })

  test('is bounded: a distant hour is off shift', () => {
    expect(isShiftActive(shiftWindowAroundHour(12), 3, '20:00')).toBe(false)
  })

  test('rejects an hour outside 0..23', () => {
    expect(() => shiftWindowAroundHour(24)).toThrow(RangeError)
    expect(() => shiftWindowAroundHour(-1)).toThrow(RangeError)
    expect(() => shiftWindowAroundHour(1.5)).toThrow(RangeError)
  })
})
