import { describe, it, expect } from 'vitest'
import {
  rateBreaker, failureBreaker, inQuotaCooldown, quotaBreaker, isQuotaHaltReason, parseQuotaResumeAt,
} from '../../orchestrator/src/circuit.js'
import type { RunRecord, Outcome } from '../../orchestrator/src/ledger.js'

const LIMITS = { maxDispatchesPerHour: 6, consecutiveFailuresToHalt: 3, quotaCooldownMs: 3_600_000 }
const r = (outcome: Outcome, ts: number, lane = 'backend', overrides: Partial<RunRecord> = {}): RunRecord =>
  ({ ts, runId: 'x', lane, itemId: '1', itemName: 'n', engine: 'claude', outcome, ...overrides })

describe('rateBreaker', () => {
  it('trips above the hourly dispatch ceiling', () => {
    const rows = Array.from({ length: 7 }, (_, i) => r('DISPATCHED', 1000 + i))
    expect(rateBreaker(rows, LIMITS, 2000)).toMatch(/dispatch rate/i)
  })
  it('does not trip at the ceiling', () => {
    const rows = Array.from({ length: 6 }, (_, i) => r('DISPATCHED', 1000 + i))
    expect(rateBreaker(rows, LIMITS, 2000)).toBeUndefined()
  })
  it('ignores dispatches older than the window', () => {
    const rows = Array.from({ length: 20 }, (_, i) => r('DISPATCHED', i))
    expect(rateBreaker(rows, LIMITS, 10_000_000)).toBeUndefined()
  })
})

describe('failureBreaker', () => {
  it('trips on three consecutive terminal failures', () => {
    const rows = [r('FAILED', 1), r('TIMEOUT', 2), r('FAILED', 3)]
    expect(failureBreaker(rows, LIMITS, 0)).toMatch(/consecutive/i)
  })
  it('does not count QUOTA toward the failure streak', () => {
    const rows = [r('FAILED', 1), r('QUOTA', 2), r('FAILED', 3)]
    expect(failureBreaker(rows, LIMITS, 0)).toBeUndefined()
  })
  it('resets the streak on a success', () => {
    const rows = [r('FAILED', 1), r('FAILED', 2), r('SUCCESS', 3), r('FAILED', 4)]
    expect(failureBreaker(rows, LIMITS, 0)).toBeUndefined()
  })
  it('ignores failures recorded before the resume marker', () => {
    const rows = [r('FAILED', 1), r('FAILED', 2), r('FAILED', 3)]
    expect(failureBreaker(rows, LIMITS, 100)).toBeUndefined()
  })
  it('trips on three consecutive FAILED outcomes alone (genuine execution failures)', () => {
    const rows = [r('FAILED', 1), r('FAILED', 2), r('FAILED', 3)]
    expect(failureBreaker(rows, LIMITS, 0)).toMatch(/consecutive/i)
  })

  // Issue #944: a full queue with no genuinely dispatchable work produced
  // three independent, unrelated mechanical-verify REJECTEDs (three
  // different items, three different lanes, one common root cause — a
  // lane-scope config gap, fixed separately in #938) and the fleet halted
  // itself, then kept re-halting for over a day needing more than a dozen
  // manual `resume`s. REJECTED sits in the exact same per-item
  // `TERMINAL_FAILURES` bound as BLOCKED (ledger.ts) — a mechanical
  // scope/test failure or a review FAIL is the verification pipeline
  // catching a bad diff and refusing to merge it, the system working as
  // designed, not a runaway fleet — so it must not also feed a fleet-wide
  // halt, the same way BLOCKED does not.
  it('does not trip on three consecutive REJECTED outcomes — issue #944', () => {
    const rows = [r('REJECTED', 1), r('REJECTED', 2), r('REJECTED', 3)]
    expect(failureBreaker(rows, LIMITS, 0)).toBeUndefined()
  })

  it('a SUCCESS still resets the streak even with REJECTED rows before and after it', () => {
    const rows = [r('REJECTED', 1), r('REJECTED', 2), r('SUCCESS', 3), r('FAILED', 4)]
    expect(failureBreaker(rows, LIMITS, 0)).toBeUndefined()
  })
  it('trips on three FAILED rows interleaved with SHADOW rows', () => {
    // F4: a shadow lane writes a SHADOW row every pass it runs, so in the
    // mixed ramp (some lanes live, some shadow) the newest row is very often
    // a SHADOW row. If SHADOW reset the streak, the newest SHADOW row would
    // reset it on every single pass and the breaker could never trip for a
    // live lane running alongside a shadow one. SHADOW must be ignored
    // entirely, like QUOTA, not treated as a reset.
    const rows = [r('FAILED', 1), r('SHADOW', 2), r('FAILED', 3), r('SHADOW', 4), r('FAILED', 5)]
    expect(failureBreaker(rows, LIMITS, 0)).toMatch(/consecutive/i)
  })
  it('does not trip on three consecutive BLOCKED outcomes', () => {
    // BLOCKED means a worker correctly reported it cannot proceed (e.g. a
    // scope conflict) — that is the system working as designed, and the
    // per-item attempt limit already bounds it, so it must not also feed a
    // fleet-wide halt — the same treatment REJECTED now gets (issue #944).
    const rows = [r('BLOCKED', 1), r('BLOCKED', 2), r('BLOCKED', 3)]
    expect(failureBreaker(rows, LIMITS, 0)).toBeUndefined()
  })

  // Issue #870: three real SUCCESS workers (fleet-backend-705,
  // fleet-desktop-775, fleet-infra-722) were recorded FAILED and tripped
  // this exact breaker — "3 consecutive failures since last success" — over
  // nothing but the fleet's own launch/revise plumbing losing contact with
  // workers that had already finished correctly. UNVERIFIED exists so that
  // never happens again: a mutation that added it back to `STREAK_FAILURES`
  // would make this fail.
  it('does not count UNVERIFIED toward the failure streak — the fleet-backend-705/desktop-775/infra-722 incident', () => {
    const rows = [r('UNVERIFIED', 1), r('UNVERIFIED', 2), r('UNVERIFIED', 3)]
    expect(failureBreaker(rows, LIMITS, 0)).toBeUndefined()
  })

  it('an UNVERIFIED row does not reset the streak either — it is simply invisible to it, like QUOTA', () => {
    const rows = [r('FAILED', 1), r('FAILED', 2), r('UNVERIFIED', 3), r('FAILED', 4)]
    expect(failureBreaker(rows, LIMITS, 0)).toMatch(/consecutive/i)
  })

  // Issue #1755: three identical salvage-wedge refusals for the same
  // lane+item are ONE stuck condition, not three failures — this exact shape
  // (a staged `.test-encrypted-seed.sqlite` wedging 32 lanes) halted the
  // whole fleet for 25 hours when refusals were recorded as plain FAILEDs.
  it('does not count WEDGED toward the failure streak — one stuck condition is not three failures', () => {
    const rows = [
      r('WEDGED', 1, 'backend', { note: 'wedged: worktree /x is on salvage branch salvage/fleet/backend/1-2' }),
      r('WEDGED', 2, 'backend', { note: 'wedged: worktree /x is on salvage branch salvage/fleet/backend/1-2' }),
      r('WEDGED', 3, 'backend', { note: 'wedged: worktree /x is on salvage branch salvage/fleet/backend/1-2' }),
    ]
    expect(failureBreaker(rows, LIMITS, 0)).toBeUndefined()
  })

  it('a WEDGED row does not reset the streak either — invisible to it, like QUOTA and UNVERIFIED', () => {
    const rows = [r('FAILED', 1), r('FAILED', 2), r('WEDGED', 3), r('FAILED', 4)]
    expect(failureBreaker(rows, LIMITS, 0)).toMatch(/consecutive/i)
  })

  // Issue #1755: the halt reason must carry the cause, not just a count —
  // "3 consecutive failures" alone took a manual audit of 39 salvage
  // branches to diagnose. The newest failing row's lane/item/note travels
  // into halt-reason.txt.
  it('names the latest failure (lane, item, note) in the halt reason, not just the count', () => {
    const rows = [
      r('FAILED', 1, 'ios', { itemId: '41' }),
      r('FAILED', 2, 'backend', { itemId: '42' }),
      r('FAILED', 3, 'desktop', { itemId: '43', note: 'worker died on turn 1' }),
    ]
    const reason = failureBreaker(rows, LIMITS, 0)
    expect(reason).toMatch(/3 consecutive failures since last success/)
    expect(reason).toContain('desktop/43')
    expect(reason).toContain('worker died on turn 1')
  })
})

describe('inQuotaCooldown', () => {
  it('sits the lane out after a quota outcome', () => {
    expect(inQuotaCooldown([r('QUOTA', 1000, 'ios')], 'ios', 1000 + 60_000, LIMITS)).toBe(true)
  })
  it('releases the lane after the cooldown', () => {
    expect(inQuotaCooldown([r('QUOTA', 1000, 'ios')], 'ios', 1000 + 3_700_000, LIMITS)).toBe(false)
  })
  it('is per-lane, not global', () => {
    expect(inQuotaCooldown([r('QUOTA', 1000, 'ios')], 'backend', 1000 + 60_000, LIMITS)).toBe(false)
  })
  it('honours a non-default cooldown value from limits', () => {
    const shortCooldown = { ...LIMITS, quotaCooldownMs: 30_000 }
    // 60s after the QUOTA outcome: still inside the default 1h cooldown, but
    // past this limits object's 30s cooldown — proves the value actually read
    // is limits.quotaCooldownMs, not a hardcoded default.
    expect(inQuotaCooldown([r('QUOTA', 1000, 'ios')], 'ios', 1000 + 60_000, shortCooldown)).toBe(false)
  })
})

// Issue #817: real 2026-09-18/19 incident — two workers on the same engine
// (opencode/Kimi) both died at turn <= 1 on a provider quota rejection, and
// the fleet halted with "failure breaker tripped: 7 consecutive failures"
// (2026-09-18T15:30:12Z) then again with "3 consecutive failures"
// (2026-09-19T05:30:13Z) — a reason that named nothing about WHY, and a halt
// that then sat for hours until a human happened to notice and clear it by
// hand. `quotaBreaker` gives that exact condition its own, separate,
// self-describing halt path.
describe('quotaBreaker', () => {
  it('does not trip on a single QUOTA outcome — one rejection could still be a blip', () => {
    expect(quotaBreaker([r('QUOTA', 1000, 'android', { engine: 'opencode' })], 0, 2000)).toBeUndefined()
  })

  it('trips on two QUOTA outcomes for the SAME engine, even across different lanes/items', () => {
    const rows = [
      r('QUOTA', 1000, 'android', { engine: 'opencode', itemId: '765' }),
      r('QUOTA', 2000, 'backend', { engine: 'opencode', itemId: '729' }),
    ]
    const reason = quotaBreaker(rows, 0, 3000)
    expect(reason).toMatch(/^engine quota exhausted \(opencode\) — retry after /)
    expect(reason).not.toMatch(/consecutive/i)
  })

  it('does NOT trip when two QUOTA outcomes are split across two DIFFERENT engines', () => {
    const rows = [
      r('QUOTA', 1000, 'android', { engine: 'opencode' }),
      r('QUOTA', 2000, 'ios', { engine: 'claude' }),
    ]
    expect(quotaBreaker(rows, 0, 3000)).toBeUndefined()
  })

  it('ignores QUOTA rows recorded before the resume marker', () => {
    const rows = [r('QUOTA', 1000, 'a', { engine: 'opencode' }), r('QUOTA', 2000, 'b', { engine: 'opencode' })]
    expect(quotaBreaker(rows, 2500, 3000)).toBeUndefined()
  })

  it('retries at the latest known reset time among the tripping rows', () => {
    const rows = [
      r('QUOTA', 1000, 'a', { engine: 'opencode', quotaResetAt: 5000 }),
      r('QUOTA', 2000, 'b', { engine: 'opencode', quotaResetAt: 9000 }),
    ]
    const reason = quotaBreaker(rows, 0, 3000) ?? ''
    expect(reason).toContain(new Date(9000).toISOString())
  })

  it('falls back to a 60-minute cooldown from now when no tripping row parsed an absolute reset time', () => {
    // The real fleet-android-765 fixture: "reset when the current 5-hour
    // window ends" has no clock time engines.ts can resolve, so
    // `quotaResetAt` is left unset on the ledger row (see engines.test.ts).
    const rows = [r('QUOTA', 1000, 'a', { engine: 'opencode' }), r('QUOTA', 2000, 'b', { engine: 'opencode' })]
    const now = 3000
    const reason = quotaBreaker(rows, 0, now) ?? ''
    expect(reason).toContain(new Date(now + 3_600_000).toISOString())
  })

  it('never fires from FAILED/TIMEOUT/REJECTED rows — only QUOTA counts', () => {
    const rows = [r('FAILED', 1000, 'a', { engine: 'opencode' }), r('TIMEOUT', 2000, 'b', { engine: 'opencode' })]
    expect(quotaBreaker(rows, 0, 3000)).toBeUndefined()
  })

  // Issue #944 changed only STREAK_FAILURES (failureBreaker's input set);
  // quotaBreaker never looked at REJECTED before and must not start now —
  // it groups strictly by `outcome === 'QUOTA'` and `engine`.
  it('is unaffected by three consecutive REJECTED rows, even for the same engine', () => {
    const rows = [
      r('REJECTED', 1000, 'a', { engine: 'opencode' }),
      r('REJECTED', 2000, 'b', { engine: 'opencode' }),
      r('REJECTED', 3000, 'c', { engine: 'opencode' }),
    ]
    expect(quotaBreaker(rows, 0, 4000)).toBeUndefined()
  })
})

describe('isQuotaHaltReason', () => {
  it('is true for exactly the shape quotaBreaker produces', () => {
    expect(isQuotaHaltReason('engine quota exhausted (opencode) — retry after 2026-09-19T06:30:00.000Z')).toBe(true)
  })
  it('is false for a human-declared halt, a rate breaker, or the consecutive-failure breaker', () => {
    expect(isQuotaHaltReason('halted by hand')).toBe(false)
    expect(isQuotaHaltReason('rate breaker tripped: dispatch rate 9/h exceeds ceiling of 8')).toBe(false)
    expect(isQuotaHaltReason('failure breaker tripped: 3 consecutive failures since last success')).toBe(false)
  })
  it('is false for undefined', () => {
    expect(isQuotaHaltReason(undefined)).toBe(false)
  })
})

describe('parseQuotaResumeAt', () => {
  it('extracts the absolute ISO instant quotaBreaker embedded', () => {
    const at = parseQuotaResumeAt('engine quota exhausted (opencode) — retry after 2026-09-19T06:30:00.000Z')
    expect(at).toBe(Date.parse('2026-09-19T06:30:00.000Z'))
  })
  it('returns undefined for a reason with no parseable "retry after" clause', () => {
    expect(parseQuotaResumeAt('engine quota exhausted, just checking')).toBeUndefined()
  })
  it('returns undefined for an unrelated halt reason', () => {
    expect(parseQuotaResumeAt('3 consecutive failures since last success')).toBeUndefined()
  })
})
