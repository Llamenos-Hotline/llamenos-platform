import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assessOpenPr, latestMechanicalRejection, linkTrustedModules, MAX_CRASH_RETRIES_PER_HEAD,
} from '../../orchestrator/src/reverify.js'
import { tick, type TickDeps } from '../../orchestrator/src/tick.js'
import { buildGateTrace } from '../../orchestrator/src/trace.js'
import { judgeTargetRun } from '../../orchestrator/src/verify.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { RunRecord } from '../../orchestrator/src/ledger.js'
import type { WorkItem } from '../../orchestrator/src/source.js'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)

const row = (over: Partial<RunRecord>): RunRecord => ({
  ts: 1, runId: 'r', lane: 'infra', itemId: '7', itemName: 't', engine: 'claude', outcome: 'REJECTED', ...over,
})
const rejected = (sha: string, tests = 'fail', ts = 1): RunRecord =>
  row({
    ts, note: `rounds=1 scope=pass impact=low tests=orchestrator:${tests} review=not-run sha=${sha}`,
    verification: { failedSha: sha, runnerCrashed: tests === 'crash' },
  })

describe('assessOpenPr (#2738)', () => {
  it('a failed verification on an older commit is owed a re-verification once the head moves', () => {
    expect(assessOpenPr([rejected(OLD)], '7', NEW)).toEqual({ kind: 'head-moved', failedSha: OLD, headSha: NEW })
  })

  it('a real red result on the SAME head is never re-run to get green', () => {
    expect(assessOpenPr([rejected(OLD)], '7', OLD)).toEqual({ kind: 'abandoned', failedSha: OLD, headSha: OLD })
  })

  it('a runner crash on the same head earns exactly the bounded retry', () => {
    expect(MAX_CRASH_RETRIES_PER_HEAD).toBe(1)
    expect(assessOpenPr([rejected(OLD, 'crash')], '7', OLD)).toEqual({ kind: 'runner-crash', failedSha: OLD })
    const twice = [rejected(OLD, 'crash', 1), rejected(OLD, 'crash', 2)]
    expect(assessOpenPr(twice, '7', OLD).kind).toBe('abandoned')
  })

  it('an unreadable head is neither "unchanged" nor "moved"', () => {
    expect(assessOpenPr([rejected(OLD)], '7', undefined)).toEqual({ kind: 'abandoned', failedSha: OLD, headSha: undefined })
  })

  it('nothing is owed when the newest terminal row is not a mechanical rejection', () => {
    const later = row({ ts: 5, outcome: 'UNVERIFIED', note: `review=not-run sha=${OLD}` })
    const noField = row({ ts: 9, note: `tests=orchestrator:fail review=not-run sha=${OLD}` })
    expect(assessOpenPr([rejected(OLD), noField], '7', NEW).kind).toBe('none')
    expect(assessOpenPr([rejected(OLD), later], '7', NEW).kind).toBe('none')
    const reviewerFail = row({ note: `tests=orchestrator:pass review=FAIL sha=${OLD}` })
    const forged = row({ note: 'sha=zzz', verification: { failedSha: 'not-a-sha', runnerCrashed: false } })
    expect(latestMechanicalRejection([forged], '7')).toBeUndefined()
    expect(latestMechanicalRejection([reviewerFail], '7')).toBeUndefined()
    expect(assessOpenPr([rejected(OLD)], 'other-item', NEW).kind).toBe('none')
  })
})

describe('the tests= field tells a crashed runner from a failing suite (#2738)', () => {
  const report = (extra: Partial<VerifyReport>): VerifyReport => ({
    passed: false, reasons: ['x'], changedFiles: [], addedLines: 0, impact: 'low', impactReasons: [],
    testsRun: ['orchestrator'], testsPassed: false, verifiedCommit: OLD, ...extra,
  })

  it('renders crash only when the runner reached no verdict', () => {
    expect(buildGateTrace({ report: report({}) })).toContain('tests=orchestrator:fail')
    expect(buildGateTrace({ report: report({ testsRunnerCrashed: true }) })).toContain('tests=orchestrator:crash')
  })

  it('judgeTargetRun marks a runner that wrote no result as no-verdict, and a read red result as a verdict', () => {
    const noFile = judgeTargetRun('orchestrator', { exitCode: 1, signal: undefined, output: 'boom' }, undefined)
    expect(noFile).toMatchObject({ passed: false, noVerdict: true })
    const red = JSON.stringify({
      numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0,
      numFailedTestSuites: 1, numTotalTestSuites: 1, success: false, testResults: [],
    })
    const verdict = judgeTargetRun('orchestrator', { exitCode: 1, signal: undefined, output: '' }, red)
    expect(verdict.passed).toBe(false)
    expect((verdict as { noVerdict?: true }).noVerdict).toBeUndefined()
  })
})

const lane: Lane = {
  id: 'infra', mode: 'live', cap: 1, engine: 'claude', requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
  scope: { owned: ['deploy/'], notOwned: [] },
}
const item: WorkItem = { id: '7', title: 't7', body: 'x'.repeat(300), url: 'u', labels: [] }
const passing: VerifyReport = {
  passed: true, reasons: [], changedFiles: ['deploy/a'], addedLines: 1, impact: 'low', impactReasons: [],
  testsRun: ['orchestrator'], testsPassed: true, verifiedCommit: NEW,
}

function deps(over: Partial<TickDeps> = {}): TickDeps {
  return {
    lanes: [lane], now: () => 1000,
    acquireLock: () => ({ held: true, release: () => {} }),
    checkHalt: async () => ({ halted: false }), resumeFleet: vi.fn(),
    readLedger: () => [rejected(OLD)], resumedAt: () => 0,
    listItems: async () => ({ ok: true as const, items: [item] }),
    readLabels: async () => ['agent-dispatchable', 'lane:infra'],
    findOpenPr: async () => '55',
    prHead: vi.fn(async () => ({ sha: NEW, branch: 'fleet/infra/7' })),
    verifyOpenPrHead: vi.fn(async () => passing),
    requestReviewOnNewHead: vi.fn(async () => 'Review re-requested from llamenos-auto.'),
    dispatch: vi.fn(async () => ({ outcome: 'SUCCESS' as const })),
    verifyMechanical: vi.fn(), prDiff: vi.fn(), secondOpinion: vi.fn(), postReview: vi.fn(), reviseWithWorker: vi.fn(),
    haltFleet: vi.fn(), enableAutoMerge: vi.fn(async () => {}), disableAutoMerge: vi.fn(async () => {}),
    commentOnIssue: vi.fn(async () => {}), commentOnPr: vi.fn(async () => {}),
    settle: vi.fn(async () => {}), record: vi.fn(), log: () => {},
    ...over,
  } as TickDeps
}

describe('tick re-enters a PR whose verification failed when its head moves (#2738)', () => {
  it('re-verifies the NEW head, requests the skipped review, comments, and records a non-failure row', async () => {
    const d = deps()
    await tick(d)
    expect(d.verifyOpenPrHead).toHaveBeenCalledWith(expect.objectContaining({ pr: '55', headSha: NEW, branch: 'fleet/infra/7' }))
    expect(d.requestReviewOnNewHead).toHaveBeenCalledWith('55', 'fleet/infra/7')
    expect(d.commentOnPr).toHaveBeenCalledWith('55', expect.stringContaining('mechanical verification now passes'))
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'UNVERIFIED', pr: '55', note: expect.stringContaining(`sha=${NEW}`) }))
    expect(d.dispatch).not.toHaveBeenCalled()
  })

  it('a head that still fails is recorded against the NEW sha and says so on the PR, without a review request', async () => {
    const failing: VerifyReport = { ...passing, passed: false, testsPassed: false, reasons: ['orchestrator: tests failed — 1 failed'] }
    const d = deps({ verifyOpenPrHead: vi.fn(async () => failing) })
    await tick(d)
    expect(d.requestReviewOnNewHead).not.toHaveBeenCalled()
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'REJECTED', note: expect.stringContaining(`sha=${NEW}`), verification: { failedSha: NEW, runnerCrashed: false },
    }))
    expect(d.commentOnPr).toHaveBeenCalledWith('55', expect.stringContaining('no review was requested'))
  })

  it('refuses a PR that is not this item\'s own: wrong branch, or not the PR the failure was recorded against', async () => {
    const wrongBranch = deps({ prHead: vi.fn(async () => ({ sha: NEW, branch: 'someone/else' })) })
    await tick(wrongBranch)
    expect(wrongBranch.verifyOpenPrHead).not.toHaveBeenCalled()

    const otherPr = deps({ readLedger: () => [{ ...rejected(OLD), pr: '12' }] })
    await tick(otherPr)
    expect(otherPr.verifyOpenPrHead).not.toHaveBeenCalled()

    const samePr = deps({ readLedger: () => [{ ...rejected(OLD), pr: 'https://github.com/o/r/pull/55' }] })
    await tick(samePr)
    expect(samePr.verifyOpenPrHead).toHaveBeenCalledTimes(1)
  })

  it('does nothing while the head has not moved past a real red result', async () => {
    const d = deps({ prHead: vi.fn(async () => ({ sha: OLD, branch: 'fleet/infra/7' })) })
    await tick(d)
    expect(d.verifyOpenPrHead).not.toHaveBeenCalled()
    expect(d.record).not.toHaveBeenCalled()
  })

  it('is not frozen by an exhausted attempt budget — it spends no worker attempt', async () => {
    const rows = [rejected(OLD, 'fail', 1), rejected('c'.repeat(40), 'fail', 2), rejected('d'.repeat(40), 'fail', 3)]
    const d = deps({ readLedger: () => rows })
    await tick(d)
    expect(d.verifyOpenPrHead).toHaveBeenCalledTimes(1)
  })

  it('a re-verification that throws is logged, records nothing, and leaves the pass intact', async () => {
    const log = vi.fn()
    const d = deps({ verifyOpenPrHead: vi.fn(async () => { throw new Error('gh down') }), log })
    const r = await tick(d)
    expect(r.ran).toBe(true)
    expect(d.record).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not be re-verified this pass: gh down'))
  })
})

describe('the original failure is visible on the PR itself (#2738)', () => {
  it('comments the failed verification on the PR, not only the issue', async () => {
    const failing: VerifyReport = { ...passing, passed: false, testsPassed: false, testsRunnerCrashed: true, reasons: ['orchestrator: runner-exit — died'] }
    const d = deps({
      readLedger: () => [],
      findOpenPr: async () => undefined,
      dispatch: vi.fn(async () => ({ outcome: 'SUCCESS' as const, branch: 'fleet/infra/7', pr: '55', worktree: '/wt' })),
      verifyMechanical: vi.fn(async () => failing),
    })
    await tick(d)
    expect(d.commentOnIssue).toHaveBeenCalled()
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'REJECTED', verification: { failedSha: NEW, runnerCrashed: true },
    }))
    expect(d.commentOnPr).toHaveBeenCalledWith('55', expect.stringMatching(/no review was requested[\s\S]*runner-exit/))
    expect(d.commentOnPr).toHaveBeenCalledWith('55', expect.stringContaining('crashed before producing a result'))
  })
})

describe('the head export gets the trusted install, and only the trusted install (#2738)', () => {
  const scratch = (): { root: string; trusted: string; head: string } => {
    const root = mkdtempSync(join(tmpdir(), 'reverify-link-'))
    const trusted = join(root, 'trusted', 'node_modules')
    const head = join(root, 'head')
    mkdirSync(trusted, { recursive: true })
    mkdirSync(head)
    return { root, trusted, head }
  }

  it('links node_modules so it resolves, by realpath, to the trusted install — what prepareTestRoot demands', async () => {
    const { root, trusted, head } = scratch()
    try {
      await linkTrustedModules(head, trusted)
      expect(realpathSync(join(head, 'node_modules'))).toBe(realpathSync(trusted))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it.each([
    ['a committed directory', (h: string) => mkdirSync(join(h, 'node_modules'))],
    ['a committed file', (h: string) => writeFileSync(join(h, 'node_modules'), 'x')],
    ['a committed symlink elsewhere', (h: string) => symlinkSync('/tmp', join(h, 'node_modules'))],
    ['a committed DANGLING symlink', (h: string) => symlinkSync('/nonexistent-reverify-target', join(h, 'node_modules'))],
  ])('refuses an export that supplies its own node_modules: %s', async (_name, plant) => {
    const { root, trusted, head } = scratch()
    try {
      plant(head)
      await expect(linkTrustedModules(head, trusted)).rejects.toThrow(/contains node_modules/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
