import { describe, it, expect, vi } from 'vitest'
import { tick, type TickDeps, type DispatchOutcome } from '../../orchestrator/src/tick.js'
import { failureBreaker, type Limits } from '../../orchestrator/src/circuit.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { WorkItem } from '../../orchestrator/src/source.js'
import type { RunRecord } from '../../orchestrator/src/ledger.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'

const LIMITS: Limits = { maxDispatchesPerHour: 8, consecutiveFailuresToHalt: 3, quotaCooldownMs: 3_600_000 }

const lane = (mode: Lane['mode'] = 'live'): Lane => ({
  id: 'ios', mode, cap: 1, engine: 'claude',
  requireLabel: 'agent-dispatchable',
  vetoLabels: ['needs-human'],
  scope: { owned: ['apps/ios/'], notOwned: [] },
})
const item = (id = '1'): WorkItem =>
  ({ id, title: `t${id}`, body: 'x'.repeat(300), url: 'u', labels: [] })

const passingVerify: VerifyReport = {
  passed: true, reasons: [], changedFiles: ['apps/ios/a.swift'], addedLines: 3,
  impact: 'low', impactReasons: [], testsRun: ['orchestrator'], testsPassed: true, verifiedCommit: 'c0ffee',
}

function baseDeps(over: Partial<TickDeps> = {}): TickDeps {
  return {
    lanes: [lane()],
    now: () => 1000,
    acquireLock: () => ({ held: true, release: () => {} }),
    checkHalt: async () => ({ halted: false }),
    resumeFleet: vi.fn(),
    readLedger: () => [],
    resumedAt: () => 0,
    listItems: async () => ({ ok: true as const, items: [item()] }),
    readLabels: async () => ['agent-dispatchable', 'lane:ios'],
    findOpenPr: async () => undefined,
    dispatch: vi.fn(async (): Promise<DispatchOutcome> =>
      ({ outcome: 'SUCCESS', branch: 'fleet/ios/1', pr: '42', worktree: '/wt/ios-1' })),
    verifyMechanical: vi.fn(async () => passingVerify),
    prDiff: vi.fn(async () => 'diff --git a/x b/x'),
    secondOpinion: vi.fn(async () => ({ verdict: 'PASS' as const, text: 'VERDICT: PASS' })),
    postReview: vi.fn(async () => {}),
    reviseWithWorker: vi.fn(async () => {}),
    haltFleet: vi.fn(),
    enableAutoMerge: vi.fn(async () => {}),
    disableAutoMerge: vi.fn(async () => {}),
    commentOnIssue: vi.fn(async () => {}),
    commentOnPr: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    record: vi.fn(),
    log: () => {},
    ...over,
  }
}

describe('tick: live dispatch pipeline (task 7)', () => {
  it('a live lane dispatches, arms GitHub auto-merge, verifies, and gets a second opinion', async () => {
    const d = baseDeps()
    const r = await tick(d)
    expect(d.dispatch).toHaveBeenCalledTimes(1)
    expect(d.enableAutoMerge).toHaveBeenCalledWith('42')
    expect(d.verifyMechanical).toHaveBeenCalledWith({ worktree: '/wt/ios-1', branch: 'fleet/ios/1', lane: lane() })
    expect(d.secondOpinion).toHaveBeenCalledTimes(1)
    expect(d.postReview).toHaveBeenCalledWith('42', 'PASS', expect.any(String))
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS', pr: '42', branch: 'fleet/ios/1' }))
    expect(r.attempted).toBe(1)
  })

  // THE ordering property, and the one the non-author reviewer caught this
  // PR getting backwards. Arming at PR-open left a window in which a PR the
  // fleet went on to REJECT — its own reviewer returning VERDICT: FAIL —
  // stayed armed and would merge the moment ordinary CI went green. Nothing
  // disarmed it. Auto-merge is now armed only after BOTH gates passed.
  it('arms auto-merge only after verify and review have passed, never before', async () => {
    const order: string[] = []
    const d = baseDeps({
      enableAutoMerge: vi.fn(async () => { order.push('auto-merge') }),
      verifyMechanical: vi.fn(async () => { order.push('verify'); return passingVerify }),
      secondOpinion: vi.fn(async () => { order.push('review'); return { verdict: 'PASS' as const, text: 'VERDICT: PASS' } }),
    })
    await tick(d)
    expect(order).toEqual(['verify', 'review', 'auto-merge'])
  })

  it.each([
    ['a mechanical failure', { verifyMechanical: () => ({ ...passingVerify, passed: false, reasons: ['nope'] }) }],
    ['a failing review', { secondOpinion: () => ({ verdict: 'FAIL' as const, text: 'VERDICT: FAIL' }) }],
  ])('never arms auto-merge after %s, and disarms anything an earlier attempt armed', async (_label, over) => {
    const d = baseDeps(Object.fromEntries(
      Object.entries(over).map(([k, fn]) => [k, vi.fn(async () => (fn as () => unknown)())]),
    ) as Partial<TickDeps>)
    await tick(d)
    expect(d.enableAutoMerge).not.toHaveBeenCalled()
    expect(d.disableAutoMerge).toHaveBeenCalledWith('42')
  })

  /**
   * The gap a human review found: the disarm was keyed on the OUTCOME, and
   * the claimed-SUCCESS branch — a worker that reported success but whose
   * dispatch the fleet could not verify at all (no branch, no worktree) —
   * also records `SUCCESS`. So it armed nothing and disarmed nothing, and an
   * arming left by an EARLIER attempt on the same PR survived into a pass
   * that verified nothing. Keyed on "did THIS pass arm it", both cases
   * disarm.
   */
  it('disarms on a claimed SUCCESS the fleet could not verify — it armed nothing itself', async () => {
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> =>
      ({ outcome: 'SUCCESS', pr: '42', note: 'worker said done' })) // no branch, no worktree
    const d = baseDeps({ dispatch })
    await tick(d)
    expect(d.verifyMechanical).not.toHaveBeenCalled()
    expect(d.enableAutoMerge).not.toHaveBeenCalled()
    expect(d.disableAutoMerge).toHaveBeenCalledWith('42')
  })

  // If arming THREW, this pass did not arm it either — so it must still
  // disarm, or a failed arm would leave an earlier attempt's arming standing.
  it('disarms when its own arming attempt failed', async () => {
    const d = baseDeps({
      enableAutoMerge: vi.fn(async () => { throw new Error('gh: auto-merge unavailable') }),
    })
    await tick(d)
    expect(d.disableAutoMerge).toHaveBeenCalledWith('42')
  })

  /**
   * The liveness gap the non-author reviewer named: a PR that passed both
   * gates but whose arming failed is fail-CLOSED (nothing merges) yet
   * invisible — correct work sitting open forever with a log line as its only
   * explanation. It has to reach a human, and the reason has to travel with
   * it, which means the ledger note the digest's "waiting on a human" section
   * actually renders.
   */
  it('hands a failed arming to a human, with the reason in the note', async () => {
    const recorded: RunRecord[] = []
    const d = baseDeps({
      enableAutoMerge: vi.fn(async () => { throw new Error('gh: auto-merge is not enabled') }),
      record: vi.fn((r: RunRecord) => recorded.push(r)),
    })
    await tick(d)

    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS', needsHuman: true }))
    const terminal = recorded.find((r) => r.outcome === 'SUCCESS')
    expect(terminal?.note).toContain('arm=failed(gh: auto-merge is not enabled)')
    // `sha=` must remain the LAST field — status.ts's extractVerifiedSha and
    // its own comment both depend on it, so the reason prefixes the trace.
    expect(terminal?.note).toMatch(/sha=\S+$/)
  })

  it('leaves a successfully armed PR alone — no human needed', async () => {
    const d = baseDeps()
    await tick(d)
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS', needsHuman: false }))
  })

  it('does not disarm on the success path — that would undo what it just armed', async () => {
    const d = baseDeps()
    await tick(d)
    expect(d.enableAutoMerge).toHaveBeenCalledWith('42')
    expect(d.disableAutoMerge).not.toHaveBeenCalled()
  })

  it('a failure to arm auto-merge is logged and does not fail the item — nothing merges, which is the safe direction', async () => {
    const lines: string[] = []
    const d = baseDeps({
      enableAutoMerge: vi.fn(async () => { throw new Error('gh: auto-merge is not enabled for this repository') }),
      log: (msg: string) => { lines.push(msg) },
    })
    const r = await tick(d)
    expect(r.failed).toBe(0)
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS' }))
    expect(lines.some((l) => l.includes('could not arm'))).toBe(true)
  })

  it('writes a DISPATCHED row BEFORE the worker runs — this is what the rate breaker counts (#638)', async () => {
    const order: string[] = []
    const record = vi.fn((r: RunRecord) => { order.push(`record:${r.outcome}`) })
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> => {
      order.push('dispatch:called')
      return { outcome: 'SUCCESS', branch: 'fleet/ios/1', pr: '42', worktree: '/wt/ios-1' }
    })
    const d = baseDeps({ record, dispatch })
    await tick(d)
    const dispatchedIdx = order.indexOf('record:DISPATCHED')
    const dispatchCallIdx = order.indexOf('dispatch:called')
    expect(dispatchedIdx).toBeGreaterThanOrEqual(0)
    expect(dispatchCallIdx).toBeGreaterThan(dispatchedIdx)
  })

  it('honours inQuotaCooldown and skips the lane without dispatching', async () => {
    const rows: RunRecord[] = [
      { ts: 900, runId: 'a', lane: 'ios', itemId: '9', itemName: 't9', engine: 'claude', outcome: 'QUOTA' },
    ]
    const d = baseDeps({ readLedger: () => rows, now: () => 1000 })
    const r = await tick(d)
    expect(d.dispatch).not.toHaveBeenCalled()
    expect(r.attempted).toBe(0)
  })

  it('does dispatch again once the quota cooldown window has elapsed', async () => {
    const rows: RunRecord[] = [
      { ts: 900, runId: 'a', lane: 'ios', itemId: '9', itemName: 't9', engine: 'claude', outcome: 'QUOTA' },
    ]
    const d = baseDeps({ readLedger: () => rows, now: () => 900 + LIMITS.quotaCooldownMs + 1 })
    await tick(d)
    expect(d.dispatch).toHaveBeenCalledTimes(1)
  })

  it('a QUOTA outcome from dispatch() is recorded as QUOTA and does not feed the consecutive-failure streak', async () => {
    const recorded: RunRecord[] = []
    const record = vi.fn((r: RunRecord) => recorded.push(r))
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> => ({ outcome: 'QUOTA', note: 'provider rate limit' }))
    const d = baseDeps({ record, dispatch })
    await tick(d)
    expect(recorded.some((r) => r.outcome === 'QUOTA')).toBe(true)
    // verify/review must never have been reached for a QUOTA outcome
    expect(d.verifyMechanical).not.toHaveBeenCalled()
    expect(failureBreaker(recorded, LIMITS, 0)).toBeUndefined()
  })

  it('records exactly one terminal row per run (plus the non-terminal DISPATCHED row)', async () => {
    const recorded: RunRecord[] = []
    const d = baseDeps({ record: vi.fn((r: RunRecord) => recorded.push(r)) })
    await tick(d)
    const terminal = recorded.filter((r) => r.outcome !== 'DISPATCHED')
    expect(terminal.length).toBe(1)
    expect(recorded.filter((r) => r.outcome === 'DISPATCHED').length).toBe(1)
  })

  it('records exactly one terminal row even when mechanical verification fails', async () => {
    const recorded: RunRecord[] = []
    const failing: VerifyReport = { ...passingVerify, passed: false, reasons: ['touched a forbidden path'] }
    const d = baseDeps({ record: vi.fn((r: RunRecord) => recorded.push(r)), verifyMechanical: vi.fn(async () => failing) })
    await tick(d)
    const terminal = recorded.filter((r) => r.outcome !== 'DISPATCHED')
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.outcome).toBe('REJECTED')
    expect(d.secondOpinion).not.toHaveBeenCalled() // never rescue a mechanical failure
    expect(d.commentOnIssue).toHaveBeenCalled()
  })

  it('the settle path destroys the worktree on success', async () => {
    const d = baseDeps()
    await tick(d)
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ worktree: '/wt/ios-1', outcome: 'SUCCESS' }))
  })

  it('the settle path destroys the worktree when mechanical verification fails', async () => {
    const failing: VerifyReport = { ...passingVerify, passed: false, reasons: ['nope'] }
    const d = baseDeps({ verifyMechanical: vi.fn(async () => failing) })
    await tick(d)
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ worktree: '/wt/ios-1', outcome: 'REJECTED' }))
  })

  it('the settle path destroys the worktree even when a step throws', async () => {
    const d = baseDeps({ verifyMechanical: vi.fn(async () => { throw new Error('worktree vanished') }) })
    const r = await tick(d)
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ worktree: '/wt/ios-1', outcome: 'FAILED' }))
    expect(r.failed).toBe(1)
    // tick itself must never throw or abort the whole pass over one item's exception
    expect(r.aborted).toBeUndefined()
  })

  it('settle() throwing is swallowed — it must not abort the pass or hide the already-recorded outcome', async () => {
    const recorded: RunRecord[] = []
    const d = baseDeps({
      record: vi.fn((r: RunRecord) => recorded.push(r)),
      settle: vi.fn(async () => { throw new Error('tmux not installed') }),
    })
    const r = await tick(d)
    expect(r.aborted).toBeUndefined()
    expect(recorded.some((row) => row.outcome === 'SUCCESS')).toBe(true)
  })

  it('a review verdict that is not PASS is REJECTED', async () => {
    const d = baseDeps({ secondOpinion: vi.fn(async () => ({ verdict: 'FAIL' as const, text: 'VERDICT: FAIL — nope' })) })
    await tick(d)
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'REJECTED' }))
  })

  // Issue #817: a QUOTA outcome from dispatch() (engines.ts's own
  // FAILED -> QUOTA reclassification off the worker's raw log) is recorded
  // as-is, exactly like BLOCKED/FAILED/TIMEOUT — never run through the
  // verify/review pipeline (there is no diff to verify: the worker never
  // even started), and never armed.
  it('a QUOTA outcome skips verify/review entirely and records the reset fields on the ledger row', async () => {
    const dispatch = vi.fn(async (): Promise<DispatchOutcome> =>
      ({ outcome: 'QUOTA', note: 'dep:abc | quota reset: when the current 5-hour window ends', quotaResetHint: 'when the current 5-hour window ends' }))
    const d = baseDeps({ dispatch })
    await tick(d)
    expect(d.verifyMechanical).not.toHaveBeenCalled()
    expect(d.secondOpinion).not.toHaveBeenCalled()
    expect(d.enableAutoMerge).not.toHaveBeenCalled()
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'QUOTA',
      quotaResetHint: 'when the current 5-hour window ends',
    }))
  })
})

// Issue #812: dispatch-one.sh cut the worktree on the worker name, so PR #836
// sat on `fleet-shared-704`. resolveDispatchResult (cli.ts) reports that as
// `branchMismatch`; tick must refuse it outright, whatever the worker claimed.
describe('tick: branch mismatch (issue #812)', () => {
  const mismatched = (over: Partial<DispatchOutcome> = {}): TickDeps['dispatch'] =>
    vi.fn(async (): Promise<DispatchOutcome> => ({
      outcome: 'FAILED', branch: 'fleet-ios-1', pr: '836', worktree: '/wt/llamenos-fleet-ios-1',
      branchMismatch: 'fleet-ios-1', note: 'branch-mismatch:fleet-ios-1 dep:abc', ...over,
    }))

  it('never verifies, reviews or arms — and disarms anything an earlier attempt armed', async () => {
    const d = baseDeps({ dispatch: mismatched() })
    await tick(d)
    expect(d.verifyMechanical).not.toHaveBeenCalled()
    expect(d.secondOpinion).not.toHaveBeenCalled()
    expect(d.enableAutoMerge).not.toHaveBeenCalled()
    expect(d.disableAutoMerge).toHaveBeenCalledWith('836')
  })

  it('records FAILED with the branch-mismatch reason and hands the item to a human', async () => {
    const d = baseDeps({ dispatch: mismatched() })
    await tick(d)
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'FAILED', pr: '836', note: expect.stringMatching(/^branch-mismatch:fleet-ios-1\b/),
    }))
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILED', needsHuman: true }))
  })

  it('tells the PR it was not verified by the fleet, naming both branches', async () => {
    const d = baseDeps({ dispatch: mismatched() })
    await tick(d)
    expect(d.commentOnPr).toHaveBeenCalledWith('836', expect.stringContaining('NOT verified by the fleet'))
    expect(d.commentOnPr).toHaveBeenCalledWith('836', expect.stringContaining('fleet-ios-1'))
    expect(d.commentOnPr).toHaveBeenCalledWith('836', expect.stringContaining('fleet/ios/1'))
  })

  it('logs a REFUSED verify line, never the misleading "missing worktree" skip', async () => {
    const lines: string[] = []
    const d = baseDeps({ dispatch: mismatched(), log: (m) => { lines.push(m) } })
    await tick(d)
    expect(lines.some((l) => /verify: item 1 pr 836 REFUSED — branch-mismatch:fleet-ios-1/.test(l))).toBe(true)
    expect(lines.some((l) => /missing worktree/.test(l))).toBe(false)
  })

  it('still hands off to a human when there is no PR to comment on', async () => {
    const d = baseDeps({ dispatch: mismatched({ pr: undefined }) })
    await tick(d)
    expect(d.commentOnPr).not.toHaveBeenCalled()
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILED', needsHuman: true }))
  })

  it('a claimed SUCCESS on the right branch still runs the full pipeline — the mismatch guard does not swallow it', async () => {
    const d = baseDeps()
    await tick(d)
    expect(d.verifyMechanical).toHaveBeenCalled()
    expect(d.enableAutoMerge).toHaveBeenCalledWith('42')
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS', pr: '42' }))
  })
})

// Issue #1755: a dispatch refused BEFORE any worker launched (the lane's
// worktree is wedged on a salvage branch holding real work) is recorded as
// the distinct WEDGED outcome — handed to a human, never verified or armed,
// and never fed to the consecutive-failure breaker as if a worker had run
// and failed three times.
describe('tick: salvage-wedge refusal (issue #1755)', () => {
  const wedged = (): TickDeps['dispatch'] =>
    vi.fn(async (): Promise<DispatchOutcome> => ({
      outcome: 'WEDGED',
      worktree: '/wt/llamenos-fleet-ios-1',
      branch: 'salvage/fleet/ios/1-1790000000000',
      note: 'wedged: worktree /wt/llamenos-fleet-ios-1 is on salvage branch salvage/fleet/ios/1-1790000000000 — salvage branch holds real work (2 file(s): a.ts)',
    }))

  it('records WEDGED, hands the item to a human, and never runs the verify/review/arm pipeline', async () => {
    const d = baseDeps({ dispatch: wedged() })
    const r = await tick(d)
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'WEDGED', branch: 'salvage/fleet/ios/1-1790000000000',
    }))
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'WEDGED', needsHuman: true }))
    expect(d.verifyMechanical).not.toHaveBeenCalled()
    expect(d.secondOpinion).not.toHaveBeenCalled()
    expect(d.enableAutoMerge).not.toHaveBeenCalled()
    // The refusal was detected, not thrown — it must not count in `failed`.
    expect(r.attempted).toBe(1)
    expect(r.failed).toBe(0)
  })

  it('comments on the issue naming the worktree and salvage branch a human must reconcile', async () => {
    const d = baseDeps({ dispatch: wedged() })
    await tick(d)
    expect(d.commentOnIssue).toHaveBeenCalledWith('1', expect.stringContaining('salvage/fleet/ios/1-1790000000000'))
    expect(d.commentOnIssue).toHaveBeenCalledWith('1', expect.stringContaining('/wt/llamenos-fleet-ios-1'))
  })

  it('three consecutive WEDGED rows do not trip the consecutive-failure breaker', async () => {
    const rows: RunRecord[] = [
      { ts: 1, runId: 'a', lane: 'ios', itemId: '1', itemName: 't1', engine: 'claude', outcome: 'WEDGED' },
      { ts: 2, runId: 'b', lane: 'ios', itemId: '1', itemName: 't1', engine: 'claude', outcome: 'WEDGED' },
      { ts: 3, runId: 'c', lane: 'ios', itemId: '1', itemName: 't1', engine: 'claude', outcome: 'WEDGED' },
    ]
    expect(failureBreaker(rows, LIMITS, 0)).toBeUndefined()
  })
})

describe('tick: G1 needs-human handoff and G2 gate-trace observability', () => {
  it('a verified, reviewed, auto-merge-armed SUCCESS does NOT get needs-human — GitHub holds it, not a label', async () => {
    const d = baseDeps()
    await tick(d)
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS', needsHuman: false }))
  })

  it('an ordinary mechanical REJECTED does NOT get needs-human — it is still retryable', async () => {
    const failing: VerifyReport = { ...passingVerify, passed: false, reasons: ['touched never-write paths: .env'] }
    const d = baseDeps({ verifyMechanical: vi.fn(async () => failing) })
    await tick(d)
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'REJECTED', needsHuman: false }))
  })

  it('a review-exhausted REJECTED does NOT get needs-human — it is still retryable', async () => {
    const d = baseDeps({ secondOpinion: vi.fn(async () => ({ verdict: 'FAIL' as const, text: 'VERDICT: FAIL — nope' })) })
    await tick(d)
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'REJECTED', needsHuman: false }))
  })

  // Issue #870: a review loop that ends UNREADABLE (the fleet's own
  // verification — a reviewer-engine outage, a tamper halt, or an
  // unreachable worker mid-revise — never reached a verdict) must NOT be
  // recorded the same way as an ordinary REJECTED. REJECTED means a real
  // reviewer read the diff and objected; UNREADABLE means this fleet never
  // got an answer at all. Conflating the two is exactly how three
  // genuinely-successful workers (fleet-backend-705, fleet-desktop-775,
  // fleet-infra-722) tripped the consecutive-failure breaker on nothing but
  // the fleet's own plumbing.
  it('a review loop ending UNREADABLE is recorded UNVERIFIED, not REJECTED or FAILED, WITH needs-human', async () => {
    const d = baseDeps({ secondOpinion: vi.fn(async () => ({ verdict: 'UNREADABLE' as const, text: 'reviewer engine was unreachable' })) })
    const r = await tick(d)
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'UNVERIFIED', pr: '42', branch: 'fleet/ios/1' }))
    expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'UNVERIFIED', needsHuman: true }))
    expect(r.failed).toBe(0) // this is not a `threw` / uncaught-exception FAILED
  })

  // The actual bug this fixes: mutating `UNVERIFIED` back into `REJECTED`
  // (or `FAILED`) here would make this pass but `circuit.test.ts`'s
  // companion mutation-guard fail — see that file for the other half.
  it('an UNVERIFIED outcome does not feed circuit.ts\'s consecutive-failure streak', async () => {
    const recorded: RunRecord[] = []
    const d = baseDeps({
      record: vi.fn((rec: RunRecord) => recorded.push(rec)),
      secondOpinion: vi.fn(async () => ({ verdict: 'UNREADABLE' as const, text: 'unreachable' })),
    })
    await tick(d)
    const terminal = recorded.find((rec) => rec.outcome !== 'DISPATCHED')
    expect(terminal?.outcome).toBe('UNVERIFIED')
    expect(failureBreaker(recorded, LIMITS, 0)).toBeUndefined()
  })

  it('logs one line per gate stage reached: verify and review', async () => {
    const lines: string[] = []
    const d = baseDeps({ log: (msg: string) => { lines.push(msg) } })
    await tick(d)
    expect(lines.some((l) => l.startsWith('verify:'))).toBe(true)
    expect(lines.some((l) => l.startsWith('review:'))).toBe(true)
  })

  it('a mechanical failure logs a verify line but no review line — the operator can tell the gate never reached review', async () => {
    const lines: string[] = []
    const failing: VerifyReport = { ...passingVerify, passed: false, reasons: ['touched never-write paths: .env'] }
    const d = baseDeps({ verifyMechanical: vi.fn(async () => failing), log: (msg: string) => { lines.push(msg) } })
    await tick(d)
    expect(lines.some((l) => l.startsWith('verify:'))).toBe(true)
    expect(lines.some((l) => l.startsWith('review:'))).toBe(false)
  })

  it('the terminal note is a compact gate trace carrying scope, impact, tests, review and sha', async () => {
    const d = baseDeps()
    await tick(d)
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'SUCCESS',
      note: expect.stringMatching(/scope=\S+ impact=\S+ tests=\S+ review=PASS sha=c0ffee/),
    }))
  })

  // G3: the root-caused fix for issue #660/PR #662 — a worker-reported
  // SUCCESS whose dispatch result is missing branch/worktree must NEVER be
  // silently treated as a real, verified merge. The whole pipeline is
  // skipped, so it must be flagged for a human and the PR told it received
  // no automated verification.
  describe('G3: a claimed SUCCESS the fleet cannot verify (issue #660/PR #662)', () => {
    it('is recorded as-is, flagged needs-human, and comments on the PR that no verification ran', async () => {
      const dispatch = vi.fn(async (): Promise<DispatchOutcome> =>
        ({ outcome: 'SUCCESS', pr: '662', note: 'dep:abc123 worker summary here' })) // no branch, no worktree
      const d = baseDeps({ dispatch })
      await tick(d)

      expect(d.verifyMechanical).not.toHaveBeenCalled()
      expect(d.secondOpinion).not.toHaveBeenCalled()
      expect(d.commentOnPr).toHaveBeenCalledWith('662', expect.stringContaining('NO automated verification'))
      expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS', needsHuman: true }))
      expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'SUCCESS',
        note: expect.stringContaining('scope=not-run'),
      }))
    })

    it('still carries the worker\'s own note alongside the not-run trace', async () => {
      const dispatch = vi.fn(async (): Promise<DispatchOutcome> =>
        ({ outcome: 'SUCCESS', pr: '662', note: 'dep:abc123 worker summary here' }))
      const d = baseDeps({ dispatch })
      await tick(d)
      expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
        note: expect.stringContaining('dep:abc123 worker summary here'),
      }))
    })

    it('does not comment on a PR that does not exist (no pr field at all)', async () => {
      const dispatch = vi.fn(async (): Promise<DispatchOutcome> => ({ outcome: 'SUCCESS', note: 'no pr yet' }))
      const d = baseDeps({ dispatch })
      await tick(d)
      expect(d.commentOnPr).not.toHaveBeenCalled()
      expect(d.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS', needsHuman: true }))
    })
  })
})

describe('tick: labels re-read at dispatch time (task 9, issue #639)', () => {
  it('re-reads labels immediately before dispatch and skips an item that gained a veto label since selection', async () => {
    let calls = 0
    const readLabels = vi.fn(async () => {
      calls++
      // First read (selection phase) is clean; second read (immediately
      // before dispatch) reflects a human adding needs-human mid-pass.
      return calls === 1 ? ['agent-dispatchable', 'lane:ios'] : ['agent-dispatchable', 'lane:ios', 'needs-human']
    })
    const d = baseDeps({ readLabels })
    const r = await tick(d)
    expect(d.dispatch).not.toHaveBeenCalled()
    expect(r.rejections).toContainEqual({ id: '1', reason: 'vetoed' })
  })

  it('skips dispatch (rather than dispatching on stale data) when labels are unreadable at dispatch time', async () => {
    let calls = 0
    const readLabels = vi.fn(async () => {
      calls++
      return calls === 1 ? ['agent-dispatchable', 'lane:ios'] : undefined
    })
    const d = baseDeps({ readLabels })
    const r = await tick(d)
    expect(d.dispatch).not.toHaveBeenCalled()
    expect(r.rejections).toContainEqual({ id: '1', reason: 'labels-unreadable' })
  })

  it('still dispatches on the happy path where labels are unchanged at dispatch time', async () => {
    const d = baseDeps()
    await tick(d)
    expect(d.dispatch).toHaveBeenCalledTimes(1)
  })
})
