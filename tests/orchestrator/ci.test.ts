import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  runVerifyCi, runReviewCi, laneIdFromBranch, itemIdFromBranch, fleetBranchFor, verdictSummary, ciContextFromEnv,
  REVIEW_KEY_ENV, UNSCOPED_LANE, type CiContext, type VerifyCiDeps, type ReviewCiDeps,
} from '../../orchestrator/src/ci.js'
import { parseVerdict } from '../../orchestrator/src/review.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { VerifyInput, VerifyReport } from '../../orchestrator/src/verify.js'

const lane = (): Lane => ({
  id: 'ios', mode: 'off', cap: 1, engine: 'claude',
  requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
  scope: { owned: ['apps/ios/'], notOwned: [] },
})

const ctx = (over: Partial<CiContext> = {}): CiContext => ({
  branch: 'fleet/ios/123', repoDir: '/base', headDir: '/tmp/head',
  baseSha: 'base111', headSha: 'head222', pr: '42', ...over,
})

/** The head export has no `.git` — that is the invariant under test. */
const noGitInHead = (p: string): boolean => p !== '/tmp/head/.git'

const passing: VerifyReport = {
  passed: true, reasons: [], changedFiles: ['apps/ios/a.swift'], addedLines: 3,
  impact: 'low', impactReasons: [], testsRun: ['orchestrator'], testsPassed: true, verifiedCommit: 'c0ffee',
}

describe('laneIdFromBranch', () => {
  it('derives the lane from a fleet branch', () => {
    expect(laneIdFromBranch('fleet/ios/123')).toBe('ios')
  })
  it.each(['main', 'feat/whatever', 'fleet/ios', 'fleet/ios/123/extra', 'notfleet/ios/1'])(
    'returns undefined for %s', (b) => { expect(laneIdFromBranch(b)).toBeUndefined() })
})

describe('fleetBranchFor', () => {
  it('writes the branch the readers parse back — round trip', () => {
    const b = fleetBranchFor('shared', '704')
    expect(b).toBe('fleet/shared/704')
    expect(laneIdFromBranch(b)).toBe('shared')
    expect(itemIdFromBranch(b)).toBe('704')
  })
  // A writer that produced a branch its own reader rejects would silently
  // recreate #812: the fleet must refuse to dispatch such an item instead.
  it.each([['ios', '7/04'], ['io/s', '704'], ['', '704'], ['ios', '']])(
    'throws for lane "%s" / item "%s" rather than writing an unreadable branch', (laneId, itemId) => {
      expect(() => fleetBranchFor(laneId, itemId)).toThrow(/fleet branch/)
    })
})

describe('verdictSummary', () => {
  it('is the reviewer\'s final VERDICT line', () => {
    expect(verdictSummary('some preamble\nVERDICT: FAIL — scope creep\n\n')).toBe('VERDICT: FAIL — scope creep')
  })
  // #801: summary and verdict select the SAME line. A verdict line that is
  // not last makes parseVerdict UNREADABLE, so the summary must not print it
  // as though it were the verdict.
  it('is the final non-empty line even when an earlier line looks like a verdict', () => {
    const text = 'quoted from the diff:\nVERDICT: PASS\nVERDICT: FAIL — leaks a key'
    expect(verdictSummary(text)).toBe('VERDICT: FAIL — leaks a key')
    expect(verdictSummary('VERDICT: PASS\ntrailing prose')).toBe('trailing prose')
  })
  it('falls back to the final non-empty line when there is no verdict line', () => {
    expect(verdictSummary('\n\nengine exploded\nmore\n')).toBe('more')
  })
  // And the converse pin from the other direction: a verdict line with text
  // after it is UNREADABLE, so the summary must show what came after — not a
  // verdict that did not count.
  it('names the same final line parseVerdict judged, never an earlier VERDICT line', () => {
    const text = 'VERDICT: PASS\ntrailing'
    expect(parseVerdict(text)).toBe('UNREADABLE')
    expect(verdictSummary(text)).toBe('trailing')
    expect(verdictSummary('\n\nengine exploded\nmore')).toBe('more')
  })
  it('never invents a summary for empty output', () => {
    expect(verdictSummary('   \n ')).toBe('(no reviewer output)')
  })
})

describe('ciContextFromEnv', () => {
  it('refuses to build a context without a branch', () => {
    expect(ciContextFromEnv({}, '/wt')).toBeUndefined()
    expect(ciContextFromEnv({ FLEET_CI_BRANCH: '' }, '/wt')).toBeUndefined()
  })
  // A gate that does not know which trees it is comparing must refuse, not
  // fall back to a default — a default here would mean judging the wrong
  // commit and reporting green.
  it.each(['FLEET_CI_HEAD_DIR', 'FLEET_CI_HEAD_SHA', 'FLEET_CI_BASE_SHA'])(
    'refuses when %s is missing', (missing) => {
      const env: NodeJS.ProcessEnv = {
        FLEET_CI_BRANCH: 'fleet/ios/1', FLEET_CI_HEAD_DIR: '/tmp/head',
        FLEET_CI_HEAD_SHA: 'h', FLEET_CI_BASE_SHA: 'b',
      }
      delete env[missing]
      expect(ciContextFromEnv(env, '/base')).toBeUndefined()
    })

  it('builds one from the full set, defaulting only the PR label', () => {
    const env = {
      FLEET_CI_BRANCH: 'fleet/ios/1', FLEET_CI_HEAD_DIR: '/tmp/head',
      FLEET_CI_HEAD_SHA: 'h', FLEET_CI_BASE_SHA: 'b', FLEET_CI_PR: '9',
    }
    expect(ciContextFromEnv(env, '/base')).toEqual({
      branch: 'fleet/ios/1', repoDir: '/base', headDir: '/tmp/head',
      headSha: 'h', baseSha: 'b', pr: '9',
    })
    expect(ciContextFromEnv({ ...env, FLEET_CI_PR: undefined }, '/base')?.pr).toBe('(unknown)')
  })
})

describe('fleet/verify in CI', () => {
  const deps = (over: Partial<VerifyCiDeps> = {}): VerifyCiDeps => ({
    ctx: ctx(),
    lanes: async () => [lane()],
    verify: vi.fn(async () => passing),
    pathExists: noGitInHead,
    log: () => {},
    ...over,
  })

  // No opt-out: a human's branch is verified too. It has no lane, so there
  // is no owned-path scope to hold it to — but never-write still binds it,
  // which is exactly what an empty `owned` list means to `checkScope` (the
  // "never-write binds even an unrestricted lane" rail in guards.test.ts
  // proves that half; this proves CI actually hands it that lane).
  it('still verifies a non-fleet branch, against a lane with no owned scope', async () => {
    const d = deps({ ctx: ctx({ branch: 'feat/human-work' }) })
    expect((await runVerifyCi(d)).ok).toBe(true)
    const input = (d.verify as Mock).mock.calls[0]?.[0] as VerifyInput | undefined
    expect(input?.lane).toBe(UNSCOPED_LANE)
    expect(input?.lane.scope.owned).toEqual([])
  })

  it('fails a non-fleet branch whose diff failed the never-write check', async () => {
    const failed: VerifyReport = {
      ...passing, passed: false, reasons: ['touched never-write paths: deploy/secrets/prod.pem'],
    }
    const d = deps({ ctx: ctx({ branch: 'feat/human-work' }), verify: vi.fn(async () => failed) })
    const v = await runVerifyCi(d)
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('touched never-write paths')
  })

  describe('scope:<lane> grants (#1115)', () => {
    const desktopLane = (): Lane => ({
      id: 'desktop', mode: 'off', cap: 1, engine: 'claude',
      requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
      scope: { owned: ['src/client/'], notOwned: [] },
    })
    const bothLanes = async (): Promise<Lane[]> => [lane(), desktopLane()]
    const grantedIn = (d: VerifyCiDeps): string[] =>
      (((d.verify as Mock).mock.calls[0]?.[0] as VerifyInput).grantedLanes ?? []).map((l) => l.id)

    it('passes the granted lane through to verify', async () => {
      const d = deps({ lanes: bothLanes, prLabels: async () => ['review', 'scope:desktop'] })
      await runVerifyCi(d)
      expect(grantedIn(d)).toEqual(['desktop'])
    })

    it('grants nothing when the PR carries no scope label', async () => {
      const d = deps({ lanes: bothLanes, prLabels: async () => ['review'] })
      await runVerifyCi(d)
      expect(grantedIn(d)).toEqual([])
    })

    // Unreadable labels must not be confused with "no labels": the gate is
    // judging whether a diff is authorised, so not knowing has to mean not
    // granted.
    it('fails closed when the labels cannot be read', async () => {
      const d = deps({ lanes: bothLanes, prLabels: async () => undefined })
      await runVerifyCi(d)
      expect(grantedIn(d)).toEqual([])
    })

    it('ignores a label naming something that is not a lane, rather than treating it as a wildcard', async () => {
      const logged: string[] = []
      const d = deps({ lanes: bothLanes, prLabels: async () => ['scope:everything'], log: (m) => logged.push(m) })
      await runVerifyCi(d)
      expect(grantedIn(d)).toEqual([])
      expect(logged.join('\n')).toContain('not a known lane')
    })

    it('never duplicates the PR\'s own lane into the grant list', async () => {
      const d = deps({ lanes: bothLanes, prLabels: async () => ['scope:ios', 'scope:desktop'] })
      await runVerifyCi(d)
      expect(grantedIn(d)).toEqual(['desktop'])
    })

    it('deduplicates a repeated grant', async () => {
      const d = deps({ lanes: bothLanes, prLabels: async () => ['scope:desktop', 'scope: desktop'] })
      await runVerifyCi(d)
      expect(grantedIn(d)).toEqual(['desktop'])
    })

    // The tests run against the head export get the same grants as the
    // mechanical pass — otherwise the second call would re-judge the diff
    // against the bare lane and contradict the first.
    it('applies the same grants to the tested run, not just the mechanical pass', async () => {
      const d = deps({ lanes: bothLanes, prLabels: async () => ['scope:desktop'] })
      await runVerifyCi(d)
      const calls = (d.verify as Mock).mock.calls as [VerifyInput][]
      expect(calls.length).toBeGreaterThan(1)
      for (const [input] of calls) {
        expect((input.grantedLanes ?? []).map((l) => l.id)).toEqual(['desktop'])
      }
    })

    // The fail-open the review gate caught on this PR's first revision: an
    // `off` lane legitimately has an empty scope, and honouring a grant for
    // it would have made the whole PR unrestricted.
    it('drops a grant for a lane that owns nothing, rather than letting it widen the PR', async () => {
      const emptyLane = (): Lane => ({
        id: 'shared', mode: 'off', cap: 1, engine: 'claude',
        requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
        scope: { owned: [], notOwned: [] },
      })
      const logged: string[] = []
      const d = deps({
        lanes: async () => [lane(), emptyLane()],
        prLabels: async () => ['scope:shared'],
        log: (m) => logged.push(m),
      })
      await runVerifyCi(d)
      expect(grantedIn(d)).toEqual([])
      expect(logged.join('\n')).toContain('grants nothing')
    })

    it('a deps object with no prLabels at all behaves exactly like a PR with no grants', async () => {
      const d = deps({ lanes: bothLanes })
      await runVerifyCi(d)
      expect(grantedIn(d)).toEqual([])
    })
  })

  it('passes with the gate trace as its summary when verification passes', async () => {
    expect(await runVerifyCi(deps())).toEqual({
      ok: true,
      summary: 'scope=pass impact=low tests=orchestrator:pass review=not-run sha=c0ffee',
    })
  })

  it('prints the result-file evidence behind a passing test verdict', async () => {
    const evidenced: VerifyReport = {
      ...passing, testResults: ['orchestrator: result file read — 0 failed test(s), 0 failed suite(s), 12 passed, 0 skipped/todo, of 12 test(s)'],
    }
    const v = await runVerifyCi(deps({ verify: vi.fn(async () => evidenced) }))
    expect(v.ok).toBe(true)
    expect(v.summary).toBe([
      'scope=pass impact=low tests=orchestrator:pass review=not-run sha=c0ffee',
      '- orchestrator: result file read — 0 failed test(s), 0 failed suite(s), 12 passed, 0 skipped/todo, of 12 test(s)',
    ].join('\n'))
  })

  it('runs the diff-targeted tests — it must never quietly skip them', async () => {
    const d = deps()
    await runVerifyCi(d)
    // Phase 2 (call 1) is the one that runs tests; phase 1 must not.
    const calls = (d.verify as Mock).mock.calls.map((c) => c[0] as VerifyInput)
    expect(calls[0]?.skipTests).toBe(true)
    expect(calls[1]?.skipTests).not.toBe(true)
    expect(calls[1]?.lane.id).toBe('ios')
  })

  it('fails when scope fails, naming the offending path', async () => {
    const failed: VerifyReport = {
      ...passing, passed: false, testsRun: undefined, testsPassed: undefined,
      reasons: ['touched never-write paths: .env'],
    }
    const v = await runVerifyCi(deps({ verify: vi.fn(async () => failed) }))
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('scope=fail(touched never-write paths: .env)')
  })

  // verifyMechanical already refuses to set `passed` for a real test failure;
  // this asserts the CI entry point carries that through rather than passing
  // on a report it did not read.
  it('fails when the tests failed, even though scope passed', async () => {
    const failed: VerifyReport = { ...passing, passed: false, testsPassed: false, reasons: ['diff-targeted tests failed'] }
    expect((await runVerifyCi(deps({ verify: vi.fn(async () => failed) }))).ok).toBe(false)
  })

  // A branch that PARSES as a fleet branch but names no real lane is a
  // misconfiguration and must fail — never be quietly downgraded to the
  // unscoped check a human branch gets.
  it('fails for a fleet branch naming a lane that does not exist', async () => {
    const d = deps({ ctx: ctx({ branch: 'fleet/nosuchlane/1' }) })
    const v = await runVerifyCi(d)
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('unknown lane')
    expect(d.verify).not.toHaveBeenCalled()
  })
})

describe('fleet/review in CI', () => {
  const deps = (over: Partial<ReviewCiDeps> = {}): ReviewCiDeps => ({
    ctx: ctx(),
    apiKey: 'a-key',
    lanes: async () => [lane()],
    verify: vi.fn(async () => passing),
    pathExists: noGitInHead,
    log: () => {},
    prDiff: vi.fn(async () => 'diff --git a/x b/x'),
    secondOpinion: vi.fn(async () => ({ verdict: 'PASS' as const, text: 'looks fine\nVERDICT: PASS' })),
    ...over,
  })

  // Every PR gets the non-author review, fleet or not: the user's policy is
  // green CI plus a non-author review for all work, and author login could
  // not discriminate anyway — the fleet pushes with the operator's account.
  it('reviews a non-fleet branch too, with the non-author engine', async () => {
    const d = deps({ ctx: ctx({ branch: 'feat/human-work' }) })
    expect((await runReviewCi(d)).ok).toBe(true)
    expect(d.secondOpinion).toHaveBeenCalledWith(expect.objectContaining({ authorEngine: 'claude' }))
  })

  // A missing secret must FAIL, never skip and never pass: a review that
  // could not run is not a review that passed.
  it.each([undefined, ''])('fails, naming the secret, when the review key is %p', async (apiKey) => {
    const d = deps({ apiKey })
    const v = await runReviewCi(d)
    expect(v.ok).toBe(false)
    expect(v.summary).toContain(REVIEW_KEY_ENV)
    expect(d.secondOpinion).not.toHaveBeenCalled()
  })

  it('passes, carrying the reviewer\'s own verdict line, on PASS', async () => {
    const v = await runReviewCi(deps())
    expect(v.ok).toBe(true)
    expect(v.summary).toContain('VERDICT: PASS')
  })

  it('fails on FAIL, carrying the reviewer\'s reason', async () => {
    const v = await runReviewCi(deps({
      secondOpinion: vi.fn(async () => ({ verdict: 'FAIL' as const, text: 'VERDICT: FAIL — widens scope' })),
    }))
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('VERDICT: FAIL — widens scope')
    expect(v.summary).not.toContain('review unavailable')
  })

  // "The reviewer could not be run" and "the reviewer found a problem" both
  // fail the job, but they are different facts and the summary says which.
  it('fails and says the review was UNAVAILABLE when the verdict is UNREADABLE with no failureKind (or an engine-unavailable one)', async () => {
    const v = await runReviewCi(deps({
      secondOpinion: vi.fn(async () => ({ verdict: 'UNREADABLE' as const, text: '(reviewer engine was unreachable)' })),
    }))
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('review unavailable: (reviewer engine was unreachable)')

    const v2 = await runReviewCi(deps({
      secondOpinion: vi.fn(async () => ({
        verdict: 'UNREADABLE' as const, text: '(reviewer engine was unreachable)', failureKind: 'engine-unavailable' as const,
      })),
    }))
    expect(v2.ok).toBe(false)
    expect(v2.summary).toContain('review unavailable: (reviewer engine was unreachable)')
  })

  // #866: an unresolvable `--model`/engine id is a MISCONFIGURATION, never
  // an "unavailability" — the exact diagnostic that read as an opaque
  // outage on #866's own live incident (a bare model shorthand handed to
  // the wrong engine) when it was, underneath, a fixable configuration
  // defect. `runReviewCi` must say so, not fold this into the same
  // "unavailable" wording every other UNREADABLE reason gets.
  it('fails and says the review is MISCONFIGURED, not merely unavailable, when the verdict carries failureKind engine-misconfigured', async () => {
    const v = await runReviewCi(deps({
      secondOpinion: vi.fn(async () => ({
        verdict: 'UNREADABLE' as const,
        text: 'VERDICT: unreadable — bad model id',
        failureKind: 'engine-misconfigured' as const,
      })),
    }))
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('review misconfigured: VERDICT: unreadable — bad model id')
    expect(v.summary).not.toContain('review unavailable:')
  })

  it('fails and says UNAVAILABLE when secondOpinion throws (a tamper detection, a crashed engine)', async () => {
    const v = await runReviewCi(deps({
      secondOpinion: vi.fn(async () => { throw new Error('worktree changed mid-review') }),
    }))
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('review unavailable: worktree changed mid-review')
  })

  // The same invariant secondOpinion enforces by throwing: a review may only
  // downgrade a mechanical pass, never rescue a failure.
  it('requests no review at all for a diff that failed scope', async () => {
    const failed: VerifyReport = {
      ...passing, passed: false,
      reasons: ['touched files outside lane "ios"\'s scope: apps/worker/x.ts'],
    }
    const d = deps({ verify: vi.fn(async () => failed) })
    const v = await runReviewCi(d)
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('no review requested')
    expect(d.secondOpinion).not.toHaveBeenCalled()
  })

  // fleet/verify is the job that runs the tests; running them twice doubles
  // every fleet PR's CI cost for no extra signal.
  it('re-checks scope but does not re-run the diff-targeted tests', async () => {
    const d = deps()
    await runReviewCi(d)
    expect(((d.verify as Mock).mock.calls[0]?.[0] as VerifyInput | undefined)?.skipTests).toBe(true)
  })

  // The judge must never execute the judged commit's code. `snapshotDir` is
  // an export that already exists; `worktree` would mean exporting from — and
  // running git against — a PR-controlled tree inside the job that holds the
  // review key.
  it('hands the reviewer the export, never a worktree', async () => {
    const d = deps()
    await runReviewCi(d)
    expect(d.secondOpinion).toHaveBeenCalledWith(expect.objectContaining({ snapshotDir: '/tmp/head' }))
    expect((d.secondOpinion as Mock).mock.calls[0]?.[0]).not.toHaveProperty('worktree')
  })

  it('asks the non-author engine, derived from the lane that wrote the diff', async () => {
    const d = deps()
    await runReviewCi(d)
    expect(d.secondOpinion).toHaveBeenCalledWith(
      expect.objectContaining({ authorEngine: 'claude', pr: '42', snapshotDir: '/tmp/head' }))
  })
})

// The load-bearing invariant of the round that fixed the gate: a `.git` in
// the head directory means the workflow CHECKED OUT the commit under
// judgement instead of exporting it — which is how the judge came to be
// running the defendant's code in the first place. Both gates must refuse,
// loudly, rather than proceed on a tree they could also be executing from.
describe('the commit under judgement is data, never a checkout', () => {
  const hasGitInHead = (): boolean => true

  it('verify-ci refuses when the head dir contains a .git', async () => {
    const verify = vi.fn(async () => passing)
    const v = await runVerifyCi({
      ctx: ctx(), lanes: async () => [lane()], verify, pathExists: hasGitInHead, log: () => {},
    })
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('must be exported as data')
    expect(verify).not.toHaveBeenCalled()
  })

  it('review-ci refuses when the head dir contains a .git, before touching the key', async () => {
    const secondOpinion = vi.fn(async () => ({ verdict: 'PASS' as const, text: 'VERDICT: PASS' }))
    const v = await runReviewCi({
      ctx: ctx(), apiKey: 'a-key', lanes: async () => [lane()], verify: vi.fn(async () => passing),
      pathExists: hasGitInHead, log: () => {},
      prDiff: vi.fn(async () => ''), secondOpinion,
    })
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('must be exported as data')
    expect(secondOpinion).not.toHaveBeenCalled()
  })

  // Every decision is computed in the BASE checkout over the fetched head
  // object. If the adapter ever pointed git at the head dir (or at cwd), the
  // PR would be describing its own diff.
  it('computes the diff inside the base checkout, over base...head', async () => {
    const verify = vi.fn(async () => passing)
    await runVerifyCi({
      ctx: ctx(), lanes: async () => [lane()], verify, pathExists: noGitInHead, log: () => {},
    })
    const first = (verify as Mock).mock.calls[0]?.[0] as VerifyInput
    expect(first.worktree).toBe('/base')
    expect(first.base).toBe('base111')
    expect(first.branch).toBe('head222')
  })

  it('runs the diff-targeted tests in the head export, not in the base checkout', async () => {
    const verify = vi.fn(async () => passing)
    await runVerifyCi({
      ctx: ctx(), lanes: async () => [lane()], verify, pathExists: noGitInHead, log: () => {},
    })
    const second = (verify as Mock).mock.calls[1]?.[0] as VerifyInput
    expect(second.testDir).toBe('/tmp/head')
    expect(second.worktree).toBe('/base')
  })

  // Phase 2 exists only to AND in. A scope failure must stop before any of
  // the judged commit's code runs at all.
  it('never reaches the test phase when scope already failed', async () => {
    const failed: VerifyReport = { ...passing, passed: false, reasons: ['touched never-write paths: .env'] }
    const verify = vi.fn(async () => failed)
    const v = await runVerifyCi({
      ctx: ctx(), lanes: async () => [lane()], verify, pathExists: noGitInHead, log: () => {},
    })
    expect(v.ok).toBe(false)
    expect(verify).toHaveBeenCalledTimes(1)
  })
})
