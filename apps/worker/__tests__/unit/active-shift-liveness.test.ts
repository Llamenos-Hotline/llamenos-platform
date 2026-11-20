import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACTIVE_SHIFT_LIVENESS,
  parseActiveShiftLiveness,
} from '@worker/services/active-shifts'
import {
  ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS,
  ACTIVE_SHIFT_MIN_BEATS_BEFORE_STALE,
} from '@shared/active-shift-liveness'

describe('parseActiveShiftLiveness (#1142)', () => {
  it('uses the defaults when nothing is set, or the values are blank', () => {
    expect(parseActiveShiftLiveness()).toEqual(DEFAULT_ACTIVE_SHIFT_LIVENESS)
    expect(parseActiveShiftLiveness({ ACTIVE_SHIFT_STALE_AFTER_MINUTES: '  ', ACTIVE_SHIFT_REAP_INTERVAL_SECONDS: '' }))
      .toEqual(DEFAULT_ACTIVE_SHIFT_LIVENESS)
  })

  it('the default window survives the minimum number of missed heartbeats', () => {
    // The default must itself satisfy the rule the parser enforces on operators.
    expect(DEFAULT_ACTIVE_SHIFT_LIVENESS.staleAfterMs)
      .toBeGreaterThanOrEqual(ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * ACTIVE_SHIFT_MIN_BEATS_BEFORE_STALE)
    expect(DEFAULT_ACTIVE_SHIFT_LIVENESS.reapIntervalMs).toBeLessThanOrEqual(DEFAULT_ACTIVE_SHIFT_LIVENESS.staleAfterMs)
  })

  it('reads both settings', () => {
    expect(parseActiveShiftLiveness({ ACTIVE_SHIFT_STALE_AFTER_MINUTES: '10', ACTIVE_SHIFT_REAP_INTERVAL_SECONDS: '30' }))
      .toEqual({ staleAfterMs: 600_000, reapIntervalMs: 30_000 })
  })

  it.each(['0', '-1', '1.5', 'soon', '1e3x'])('refuses a stale window of %s', (value) => {
    expect(() => parseActiveShiftLiveness({ ACTIVE_SHIFT_STALE_AFTER_MINUTES: value })).toThrow(/ACTIVE_SHIFT_STALE_AFTER_MINUTES/)
  })

  it.each(['0', '-5', '2.5', 'often'])('refuses a reap interval of %s', (value) => {
    expect(() => parseActiveShiftLiveness({ ACTIVE_SHIFT_REAP_INTERVAL_SECONDS: value })).toThrow(/ACTIVE_SHIFT_REAP_INTERVAL_SECONDS/)
  })

  it('refuses a window shorter than the minimum number of heartbeats — it would evict present volunteers', () => {
    // 1 minute = 2 beats at 30s; the minimum is 3.
    expect(() => parseActiveShiftLiveness({ ACTIVE_SHIFT_STALE_AFTER_MINUTES: '1' })).toThrow(/heartbeat/)
    // 2 minutes = 4 beats is fine.
    expect(parseActiveShiftLiveness({ ACTIVE_SHIFT_STALE_AFTER_MINUTES: '2' }).staleAfterMs).toBe(120_000)
  })

  it('refuses a reap interval longer than the window — the reaper would run less often than rows go stale', () => {
    expect(() => parseActiveShiftLiveness({
      ACTIVE_SHIFT_STALE_AFTER_MINUTES: '2',
      ACTIVE_SHIFT_REAP_INTERVAL_SECONDS: '121',
    })).toThrow(/must not exceed/)
    expect(parseActiveShiftLiveness({
      ACTIVE_SHIFT_STALE_AFTER_MINUTES: '2',
      ACTIVE_SHIFT_REAP_INTERVAL_SECONDS: '120',
    }).reapIntervalMs).toBe(120_000)
  })

  it('checks a lone reap interval against the DEFAULT window', () => {
    expect(() => parseActiveShiftLiveness({ ACTIVE_SHIFT_REAP_INTERVAL_SECONDS: '301' })).toThrow(/must not exceed/)
  })
})
