import { describe, test, expect } from 'bun:test'
import { mayRewrapHistoryTo } from '../history-rewrap-gate'

const T = Date.parse('2026-10-01T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(T + offsetMs).toISOString()

describe('mayRewrapHistoryTo (#2143)', () => {
  test('a key set before the record may receive it', () => {
    expect(mayRewrapHistoryTo({ keySetAt: iso(-1), confirmed: false }, iso(0))).toBe(true)
  })

  test('a key set at the very instant of the record may receive it', () => {
    expect(mayRewrapHistoryTo({ keySetAt: iso(0), confirmed: false }, iso(0))).toBe(true)
  })

  test('an unconfirmed key set after the record may not', () => {
    expect(mayRewrapHistoryTo({ keySetAt: iso(1), confirmed: false }, iso(0))).toBe(false)
  })

  test('a confirmed key set after the record may', () => {
    expect(mayRewrapHistoryTo({ keySetAt: iso(1), confirmed: true }, iso(0))).toBe(true)
  })

  test('accepts Dates and epoch milliseconds as well as ISO strings', () => {
    expect(mayRewrapHistoryTo({ keySetAt: new Date(T + 5), confirmed: false }, T)).toBe(false)
    expect(mayRewrapHistoryTo({ keySetAt: T - 5, confirmed: false }, new Date(T))).toBe(true)
  })

  test('fails closed on a timestamp that does not parse', () => {
    expect(mayRewrapHistoryTo({ keySetAt: 'not a date', confirmed: false }, iso(0))).toBe(false)
    expect(mayRewrapHistoryTo({ keySetAt: iso(-1), confirmed: false }, 'not a date')).toBe(false)
    // …but confirmation does not depend on the clock.
    expect(mayRewrapHistoryTo({ keySetAt: 'not a date', confirmed: true }, iso(0))).toBe(true)
  })
})
