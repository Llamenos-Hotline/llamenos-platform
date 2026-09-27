import { describe, it, expect, vi } from 'vitest'
import {
  hasSuccessfulReview, checkRunConclusion, evaluateMergeReadiness, describeOutcome,
  runReviewAndMerge, REVIEW_AND_MERGE_MODEL,
  type CheckRunInfo, type RequiredCheck, type ReviewAndMergeDeps, type PrSnapshotFacts,
} from '../../orchestrator/src/review-and-merge.js'
import { REVIEW_JOB } from '../../orchestrator/src/ci.js'
import type { SecondOpinionResult } from '../../orchestrator/src/review.js'

const facts = (over: Partial<PrSnapshotFacts> = {}): PrSnapshotFacts => ({
  headSha: 'head111',
  baseSha: 'base000',
  changedFiles: ['orchestrator/src/foo.ts'],
  addedLines: 10,
  authorLogin: 'rhonda-rodododo',
  authorIsBot: false,
  ...over,
})

const requiredChecks = (over: Partial<RequiredCheck>[] = []): RequiredCheck[] => [
  { name: 'ci-status', state: 'SUCCESS', bucket: 'pass' },
  { name: REVIEW_JOB, state: 'SUCCESS', bucket: 'pass' },
  ...over.map((o) => ({ name: 'x', state: 'SUCCESS', bucket: 'pass' as const, ...o })),
]

/** No `-reviewer` label and no `fleet/review/*` check on `headSha` — the
 *  state of every PR that never asked for a specialist (#1092). */

describe('hasSuccessfulReview', () => {
  it('is true only when a check-run explicitly concluded success', () => {
    expect(hasSuccessfulReview([{ id: 1, status: 'completed', conclusion: 'success' }])).toBe(true)
  })
  it('is false for a failure, a neutral, or an in-progress run — never reused as fresh', () => {
    expect(hasSuccessfulReview([{ id: 1, status: 'completed', conclusion: 'failure' }])).toBe(false)
    expect(hasSuccessfulReview([{ id: 1, status: 'completed', conclusion: 'neutral' }])).toBe(false)
    expect(hasSuccessfulReview([{ id: 1, status: 'in_progress', conclusion: null }])).toBe(false)
  })
  it('is false for no check-runs at all, and for an unreadable (undefined) lookup', () => {
    expect(hasSuccessfulReview([])).toBe(false)
    expect(hasSuccessfulReview(undefined)).toBe(false)
  })
  it('is true if ANY recorded run for the sha succeeded, even alongside an earlier failure', () => {
    const runs: CheckRunInfo[] = [
      { id: 1, status: 'completed', conclusion: 'failure' },
      { id: 2, status: 'completed', conclusion: 'success' },
    ]
    expect(hasSuccessfulReview(runs)).toBe(true)
  })
})

describe('checkRunConclusion', () => {
  it('maps PASS to success and everything else to failure', () => {
    expect(checkRunConclusion('PASS')).toBe('success')
    expect(checkRunConclusion('FAIL')).toBe('failure')
    expect(checkRunConclusion('UNREADABLE')).toBe('failure')
  })
})

describe('evaluateMergeReadiness', () => {
  it('is ready when the head is unmoved and every required check (including fleet/review) is green', () => {
    expect(evaluateMergeReadiness({
      currentHeadSha: 'head111', reviewedHeadSha: 'head111', requiredChecks: requiredChecks(),
    })).toEqual({ ready: true })
  })

  it('refuses when the head moved since the review', () => {
    const r = evaluateMergeReadiness({ currentHeadSha: 'head222', reviewedHeadSha: 'head111', requiredChecks: requiredChecks() })
    expect(r.ready).toBe(false)
    expect(!r.ready && r.reason).toMatch(/head moved/)
  })

  it('refuses when required checks could not be read at all', () => {
    const r = evaluateMergeReadiness({ currentHeadSha: 'h', reviewedHeadSha: 'h', requiredChecks: undefined })
    expect(r.ready).toBe(false)
    expect(!r.ready && r.reason).toMatch(/could not read/)
  })

  it('refuses when fleet/review is not itself in the required-checks list', () => {
    const r = evaluateMergeReadiness({
      currentHeadSha: 'h', reviewedHeadSha: 'h',
      requiredChecks: [{ name: 'ci-status', state: 'SUCCESS', bucket: 'pass' }],
    })
    expect(r.ready).toBe(false)
    expect(!r.ready && r.reason).toContain(REVIEW_JOB)
  })

  it('refuses when fleet/review itself is not passing', () => {
    const r = evaluateMergeReadiness({
      currentHeadSha: 'h', reviewedHeadSha: 'h',
      requiredChecks: [{ name: REVIEW_JOB, state: 'FAILURE', bucket: 'fail' }],
    })
    expect(r.ready).toBe(false)
    expect(!r.ready && r.reason).toMatch(new RegExp(REVIEW_JOB))
  })

  // The scenario the spec calls out by name: some OTHER required check is red.
  it('refuses when another required check is red, even though fleet/review passed', () => {
    const r = evaluateMergeReadiness({
      currentHeadSha: 'h', reviewedHeadSha: 'h',
      requiredChecks: [
        { name: REVIEW_JOB, state: 'SUCCESS', bucket: 'pass' },
        { name: 'fleet/verify', state: 'FAILURE', bucket: 'fail' },
      ],
    })
    expect(r.ready).toBe(false)
    expect(!r.ready && r.reason).toContain('fleet/verify=fail')
  })

  it('refuses on a pending required check rather than merging early', () => {
    const r = evaluateMergeReadiness({
      currentHeadSha: 'h', reviewedHeadSha: 'h',
      requiredChecks: [
        { name: REVIEW_JOB, state: 'SUCCESS', bucket: 'pass' },
        { name: 'CodeQL', state: 'PENDING', bucket: 'pending' },
      ],
    })
    expect(r.ready).toBe(false)
    expect(!r.ready && r.reason).toContain('CodeQL=pending')
  })
})

describe('describeOutcome', () => {
  it('renders one line per outcome kind, naming the PR', () => {
    expect(describeOutcome({ kind: 'already-merged', pr: '9' })).toContain('9')
    expect(describeOutcome({ kind: 'merged', pr: '9', headSha: 'abc' })).toContain('abc')
    expect(describeOutcome({ kind: 'needs-codeowner', pr: '9', headSha: 'abc', authorLogin: 'llamenos-bot' }))
      .toContain('llamenos-bot')
    expect(describeOutcome({ kind: 'not-mergeable', pr: '9', reason: 'because' })).toContain('because')
  })
})

// ---------------------------------------------------------------------------
// runReviewAndMerge — the orchestration, entirely over mocked deps.
// ---------------------------------------------------------------------------

type PrState = 'OPEN' | 'MERGED' | 'CLOSED'
const prStateMock = (s: PrState) => vi.fn(async (): Promise<PrState> => s)

function baseDeps(over: Partial<ReviewAndMergeDeps> = {}): ReviewAndMergeDeps {
  const snapshot = { dir: '/tmp/export', cleanup: vi.fn(async () => {}) }
  return {
    prState: prStateMock('OPEN'),
    readPr: vi.fn(async () => facts()),
    prDiff: vi.fn(async () => 'diff --git a/x b/x'),
    fetchReviewCheckRuns: vi.fn(async () => undefined),
    exportHead: vi.fn(async () => snapshot),
    invokeReviewer: vi.fn(async (): Promise<SecondOpinionResult> => ({ verdict: 'PASS', text: 'VERDICT: PASS' })),
    postCheckRun: vi.fn(async () => {}),
    currentHeadSha: vi.fn(async () => 'head111'),
    requiredChecks: vi.fn(async () => requiredChecks()),
    merge: vi.fn(async () => {}),
    log: vi.fn(),
    ...over,
  }
}

describe('runReviewAndMerge', () => {
  it('already-merged: an already-MERGED PR is left alone, with no review and no merge attempt', async () => {
    const deps = baseDeps({ prState: prStateMock('MERGED') })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome).toEqual({ kind: 'already-merged', pr: '9' })
    expect(deps.readPr).not.toHaveBeenCalled()
    expect(deps.invokeReviewer).not.toHaveBeenCalled()
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('refuses a closed (never merged) PR without touching anything else', async () => {
    const deps = baseDeps({ prState: prStateMock('CLOSED') })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('refuses when the PR itself cannot be read', async () => {
    const deps = baseDeps({ readPr: vi.fn(async () => undefined) })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(deps.invokeReviewer).not.toHaveBeenCalled()
  })

  it('freshness hit: a prior successful check-run for this exact head skips the engine entirely', async () => {
    const deps = baseDeps({
      fetchReviewCheckRuns: vi.fn(async () => [{ id: 1, status: 'completed', conclusion: 'success' }]),
    })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome).toEqual({ kind: 'merged', pr: '9', headSha: 'head111' })
    expect(deps.invokeReviewer).not.toHaveBeenCalled()
    expect(deps.postCheckRun).not.toHaveBeenCalled()
    expect(deps.exportHead).not.toHaveBeenCalled()
    expect(deps.merge).toHaveBeenCalledWith('9')
  })

  it('freshness miss: no cached success invokes the engine and posts the check-run', async () => {
    const deps = baseDeps({ fetchReviewCheckRuns: vi.fn(async () => undefined) })
    const outcome = await runReviewAndMerge('9', deps)
    expect(deps.invokeReviewer).toHaveBeenCalledTimes(1)
    expect(deps.postCheckRun).toHaveBeenCalledWith('head111', 'PASS', 'VERDICT: PASS')
    expect(outcome).toEqual({ kind: 'merged', pr: '9', headSha: 'head111' })
  })

  it('a prior FAIL for this head is never reused as fresh — it is reviewed again', async () => {
    const deps = baseDeps({
      fetchReviewCheckRuns: vi.fn(async () => [{ id: 1, status: 'completed', conclusion: 'failure' }]),
    })
    await runReviewAndMerge('9', deps)
    expect(deps.invokeReviewer).toHaveBeenCalledTimes(1)
  })

  it('UNREADABLE: posts a failing check-run and refuses to merge', async () => {
    const deps = baseDeps({
      invokeReviewer: vi.fn(async (): Promise<SecondOpinionResult> => ({ verdict: 'UNREADABLE', text: '(no output)' })),
    })
    const outcome = await runReviewAndMerge('9', deps)
    expect(deps.postCheckRun).toHaveBeenCalledWith('head111', 'UNREADABLE', '(no output)')
    expect(outcome.kind).toBe('not-mergeable')
    expect(outcome.kind === 'not-mergeable' && outcome.reason).toContain('UNREADABLE')
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('FAIL: posts a failing check-run and refuses to merge', async () => {
    const deps = baseDeps({
      invokeReviewer: vi.fn(async (): Promise<SecondOpinionResult> => ({ verdict: 'FAIL', text: 'VERDICT: FAIL — leaks a key' })),
    })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('always cleans up the export snapshot, even when the reviewer throws', async () => {
    const cleanup = vi.fn(async () => {})
    const deps = baseDeps({
      exportHead: vi.fn(async () => ({ dir: '/tmp/export', cleanup })),
      invokeReviewer: vi.fn(async () => { throw new Error('engine exploded') }),
    })
    await expect(runReviewAndMerge('9', deps)).rejects.toThrow('engine exploded')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('head-moved: refuses to merge when the head advanced after the review', async () => {
    const deps = baseDeps({ currentHeadSha: vi.fn(async () => 'head999') })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(outcome.kind === 'not-mergeable' && outcome.reason).toMatch(/head moved/)
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('other-required-check-red: refuses to merge even though fleet/review itself passed', async () => {
    const deps = baseDeps({
      requiredChecks: vi.fn(async (): Promise<RequiredCheck[]> => [
        { name: REVIEW_JOB, state: 'SUCCESS', bucket: 'pass' },
        { name: 'fleet/verify', state: 'FAILURE', bucket: 'fail' },
      ]),
    })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(outcome.kind === 'not-mergeable' && outcome.reason).toContain('fleet/verify')
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('bot-authored PR: stops short of merging and asks for a human code-owner, never approving itself', async () => {
    const deps = baseDeps({ readPr: vi.fn(async () => facts({ authorIsBot: true, authorLogin: 'llamenos-bot' })) })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome).toEqual({ kind: 'needs-codeowner', pr: '9', headSha: 'head111', authorLogin: 'llamenos-bot' })
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('idempotent: a second run against an unchanged, already-merged head performs no second review or merge', async () => {
    const deps = baseDeps()
    const first = await runReviewAndMerge('9', deps)
    expect(first.kind).toBe('merged')
    expect(deps.merge).toHaveBeenCalledTimes(1)

    // The second invocation observes the PR as MERGED (as `gh` would report
    // after the first call's real merge) — never a second review, never a
    // second merge attempt.
    const deps2 = baseDeps({ prState: prStateMock('MERGED') })
    const second = await runReviewAndMerge('9', deps2)
    expect(second).toEqual({ kind: 'already-merged', pr: '9' })
    expect(deps2.invokeReviewer).not.toHaveBeenCalled()
    expect(deps2.merge).not.toHaveBeenCalled()
  })

  it('review-and-merge always reviews with a model tier different from the authoring lanes\' default', () => {
    // cli.ts's DEFAULT_MODEL for a dispatched worker is 'sonnet' — this
    // command must never silently converge on reviewing with the same tier
    // that wrote the diff.
    expect(REVIEW_AND_MERGE_MODEL).not.toBe('sonnet')
  })
})

// ---------------------------------------------------------------------------
// Mutation checks named directly in the spec: a naive implementation would
// pass every test above yet still let either of these through.
// ---------------------------------------------------------------------------

describe('mutation: reusing a FAIL as fresh must fail', () => {
  it('hasSuccessfulReview must not treat a FAIL conclusion as fresh', () => {
    // If this ever regressed to `.some((c) => c.conclusion != null)` or
    // similar, this assertion — not just the orchestration test above —
    // catches it directly against the pure predicate.
    expect(hasSuccessfulReview([{ id: 1, status: 'completed', conclusion: 'failure' }])).toBe(false)
  })
})

describe('mutation: merging without the review check present must fail', () => {
  it('evaluateMergeReadiness refuses when fleet/review is simply absent from the required list', () => {
    const r = evaluateMergeReadiness({
      currentHeadSha: 'h', reviewedHeadSha: 'h',
      requiredChecks: [{ name: 'ci-status', state: 'SUCCESS', bucket: 'pass' }],
    })
    expect(r.ready).toBe(false)
  })
})

// #1158 — there is no separate specialist check left for this command to
// bind: every reviewer a PR needs runs inside the one `fleet/review` job, so
// a profile's FAIL is already the required check's FAIL, and GitHub itself
// refuses the merge. This command reads no labels and no `fleet/review/*`
// context any more.
describe('evaluateMergeReadiness: no second specialist tree (#1158)', () => {
  it('a leftover fleet/review/<agent> context from the retired design is not consulted', () => {
    // It is not in the required list, and nothing else reads it — the only
    // thing that decides is `fleet/review` itself.
    expect(evaluateMergeReadiness({
      currentHeadSha: 'h', reviewedHeadSha: 'h', requiredChecks: requiredChecks(),
    })).toEqual({ ready: true })
  })
})
