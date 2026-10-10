import { describe, it, expect } from 'vitest'
import { parseLedger, failedAttemptsIn, sinceIn, type RunRecord } from '../../orchestrator/src/ledger.js'

const rec = (o: Partial<RunRecord>): RunRecord => ({
  ts: 0, runId: 'r', lane: 'backend', itemId: '1', itemName: 'n',
  engine: 'claude', outcome: 'SUCCESS', ...o,
})

describe('ledger', () => {
  it('survives a truncated final line', () => {
    const good = JSON.stringify(rec({ runId: 'a' }))
    const parsed = parseLedger(good + '\n' + '{"ts":123,"runI')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.runId).toBe('a')
  })

  it('counts failed attempts back to the most recent success', () => {
    const rows = [
      rec({ itemId: '7', outcome: 'FAILED', ts: 1 }),
      rec({ itemId: '7', outcome: 'SUCCESS', ts: 2 }),
      rec({ itemId: '7', outcome: 'FAILED', ts: 3 }),
      rec({ itemId: '7', outcome: 'FAILED', ts: 4 }),
    ]
    expect(failedAttemptsIn(rows, '7')).toBe(2)
  })

  it('does not count QUOTA as a failed attempt', () => {
    const rows = [rec({ itemId: '7', outcome: 'QUOTA', ts: 1 }), rec({ itemId: '7', outcome: 'FAILED', ts: 2 })]
    expect(failedAttemptsIn(rows, '7')).toBe(1)
  })

  // Issue #705/#724/#729/#775/#784/#785 (extending #857/#870's own
  // classification): UNVERIFIED means the fleet's own verification pipeline
  // never reached a real verdict on the work — a reviewer-engine outage, or
  // (this incident's shape) a brand-new worker re-dispatched onto a branch
  // that already held a correct, finished PR. That is not the worker's diff
  // failing, so — exactly like QUOTA — it must not decrement the item's own
  // retry budget. `needsHuman` (tick.ts) is what actually stops re-claiming
  // while the label stands; this is a separate question ("how many attempts
  // are left once a human clears that label") and conflating the two is
  // what let three UNVERIFIED rows silently exhaust an item's whole budget.
  it('does not count UNVERIFIED as a failed attempt, same as QUOTA', () => {
    const rows = [rec({ itemId: '7', outcome: 'UNVERIFIED', ts: 1 }), rec({ itemId: '7', outcome: 'FAILED', ts: 2 })]
    expect(failedAttemptsIn(rows, '7')).toBe(1)
  })

  // The mutation rail 2's own PR must guard against: reclassifying a genuine
  // reviewer FAIL (REJECTED — a real second opinion read the diff and
  // objected) the same way as an infrastructure gap. REJECTED is
  // attributable to the worker's own diff and must still cost an attempt.
  it('still counts REJECTED as a failed attempt — only fleet-infra gaps are excused', () => {
    const rows = [rec({ itemId: '7', outcome: 'REJECTED', ts: 1 }), rec({ itemId: '7', outcome: 'UNVERIFIED', ts: 2 })]
    expect(failedAttemptsIn(rows, '7')).toBe(1)
  })

  it('ignores DISPATCHED rows when counting attempts', () => {
    const rows = [rec({ itemId: '7', outcome: 'DISPATCHED', ts: 1 }), rec({ itemId: '7', outcome: 'FAILED', ts: 2 })]
    expect(failedAttemptsIn(rows, '7')).toBe(1)
  })

  // Issue #1755: WEDGED is excused from the FLEET-WIDE breaker (one stuck
  // condition is not three failures) but NOT from the item's own attempt
  // budget — a wedge is the item's lane state, so three wedges with the
  // `needs-human` label cleared must still exhaust the item rather than
  // retry the same refusal forever.
  it('counts WEDGED as a failed attempt — the per-item bound still closes over it', () => {
    const rows = [
      rec({ itemId: '7', outcome: 'WEDGED', ts: 1 }),
      rec({ itemId: '7', outcome: 'WEDGED', ts: 2 }),
      rec({ itemId: '7', outcome: 'WEDGED', ts: 3 }),
    ]
    expect(failedAttemptsIn(rows, '7')).toBe(3)
  })

  it('selects rows inside a window relative to an injected now', () => {
    const rows = [rec({ ts: 1000 }), rec({ ts: 5000 })]
    expect(sinceIn(rows, 2000, 6000)).toHaveLength(1)
  })
})
