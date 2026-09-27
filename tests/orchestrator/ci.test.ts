import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  runVerifyCi, runReviewCi, decideReviewGate, laneIdFromBranch, itemIdFromBranch, fleetBranchFor,
  verdictSummary, ciContextFromEnv,
  REVIEW_KEY_ENV, GENERAL_REVIEWER, UNSCOPED_LANE,
  type CiContext, type VerifyCiDeps, type ReviewCiDeps, type ReviewSetDecision,
} from '../../orchestrator/src/ci.js'
import { cacheArtifactName, diffHash, reviewSetTag, type CachedVerdict, type ReviewCache, type ReviewCacheKey } from '../../orchestrator/src/review-cache.js'
import type { SecondOpinionResult } from '../../orchestrator/src/review.js'
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
    // #1158: the review SET. Empty is the ordinary case — the general
    // non-author review alone, which is mandatory and never listed here.
    reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
    resolveProfile: vi.fn(async (name: string) => ({ ok: true as const, profile: { agent: name, instructions: `be a ${name}` } })),
    stripExport: vi.fn(async () => {}),
    publishReport: vi.fn(async () => {}),
    profileReview: vi.fn(async () => ({ verdict: 'PASS' as const, text: 'nothing in my scope\nVERDICT: PASS' })),
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
      reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
      resolveProfile: async (n) => ({ ok: true, profile: { agent: n, instructions: 'x' } }),
      stripExport: async () => {},
      publishReport: async () => {},
      profileReview: async () => ({ verdict: 'PASS', text: 'VERDICT: PASS' }),
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

// ---------------------------------------------------------------------------
// #1158 — the batch. One job, one check, N reviews, ANY FAIL FAILS.
// ---------------------------------------------------------------------------

describe('fleet/review runs the whole review set in one job', () => {
  const CRYPTO = 'crypto-security-reviewer'
  const passing: VerifyReport = {
    passed: true, reasons: [], changedFiles: ['packages/crypto/src/x.rs'], addedLines: 3,
    impact: 'high', impactReasons: ['crypto'], testsRun: [], testsPassed: true, verifiedCommit: 'c0ffee',
  }
  const PASS = (who: string): SecondOpinionResult => ({ verdict: 'PASS', text: `${who} ok\nVERDICT: PASS` })

  function memCache(): ReviewCache & { names: string[]; recorded: string[] } {
    const store = new Map<string, CachedVerdict>()
    const self = {
      names: [] as string[], recorded: [] as string[],
      async lookup(k: ReviewCacheKey) { return store.get(`${k.pr}:${k.diffHash}`) },
      async record(k: ReviewCacheKey, v: CachedVerdict) { self.recorded.push(`${k.pr}:${k.diffHash}`); store.set(`${k.pr}:${k.diffHash}`, v) },
    }
    return self
  }

  const deps = (over: Partial<ReviewCiDeps> = {}): ReviewCiDeps => ({
    ctx: ctx(),
    apiKey: 'a-key',
    lanes: async () => [lane()],
    verify: vi.fn(async () => passing),
    pathExists: () => false,
    log: () => {},
    prDiff: vi.fn(async () => 'diff --git a/x b/x'),
    secondOpinion: vi.fn(async () => PASS('general')),
    reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
    resolveProfile: vi.fn(async (name: string) => ({ ok: true as const, profile: { agent: name, instructions: `be a ${name}` } })),
    stripExport: vi.fn(async () => {}),
    publishReport: vi.fn(async () => {}),
    profileReview: vi.fn(async () => PASS(CRYPTO)),
    ...over,
  })

  it('runs the general review and every profile, in one call, and passes when all pass', async () => {
    const d = deps({ reviewSet: async () => ({ ok: true, profiles: [CRYPTO, 'a-reviewer'], fromLabels: [], reasons: [] }) })
    const v = await runReviewCi(d)
    expect(v.ok).toBe(true)
    expect(d.secondOpinion).toHaveBeenCalledTimes(1)
    expect(d.profileReview).toHaveBeenCalledTimes(2)
    expect(v.summary).toContain('3 reviews')
    expect(v.summary).toContain(`${GENERAL_REVIEWER}: PASS`)
    expect(v.summary).toContain(`${CRYPTO}: PASS`)
  })

  it('starts every reviewer before any of them finishes — the batch is concurrent, not serial', async () => {
    let live = 0
    let peak = 0
    const hold = async (): Promise<SecondOpinionResult> => {
      live += 1; peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live -= 1
      return PASS('x')
    }
    await runReviewCi(deps({ reviewSet: async () => ({ ok: true, profiles: [CRYPTO, 'a-reviewer'], fromLabels: [], reasons: [] }), secondOpinion: hold, profileReview: hold }))
    expect(peak).toBe(3)
  })

  // The export is stripped of agent configuration and symlinks ONCE, and
  // that must complete before ANY reviewer reads the tree. `secondOpinion`
  // strips it too, but a strip racing a concurrent reader is a reader that
  // may see `.claude/` or a symlink out of the export.
  it('strips the export exactly once, before any reviewer starts reading it', async () => {
    const order: string[] = []
    const d = deps({
      reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }),
      stripExport: vi.fn(async () => { order.push('strip') }),
      secondOpinion: async () => { order.push('general'); return PASS('general') },
      profileReview: async () => { order.push('profile'); return PASS(CRYPTO) },
    })
    await runReviewCi(d)
    expect(d.stripExport).toHaveBeenCalledTimes(1)
    expect(d.stripExport).toHaveBeenCalledWith('/tmp/head')
    expect(order[0]).toBe('strip')
  })

  it('fails the check, reviewing nothing, when the export cannot be stripped', async () => {
    const d = deps({
      reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }),
      stripExport: async () => { throw new Error('EACCES') },
    })
    const v = await runReviewCi(d)
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('refusing to hand any reviewer an unstripped tree')
    expect(d.secondOpinion).not.toHaveBeenCalled()
    expect(d.profileReview).not.toHaveBeenCalled()
  })

  it('ANY FAIL FAILS — a profile FAIL fails the check even when the general review passed', async () => {
    const v = await runReviewCi(deps({
      reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }),
      profileReview: async () => ({ verdict: 'FAIL', text: 'raw string label\nVERDICT: FAIL — raw crypto context' }),
    }))
    expect(v.ok).toBe(false)
    expect(v.summary).toContain(`${CRYPTO}: FAIL`)
    expect(v.summary).toContain(`${GENERAL_REVIEWER}: PASS`)
  })

  it('a profile that could not be RUN fails, named as unavailable rather than as a finding', async () => {
    const v = await runReviewCi(deps({
      reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }),
      profileReview: async () => ({ verdict: 'UNREADABLE', text: 'engine died', failureKind: 'engine-unavailable' }),
    }))
    expect(v.ok).toBe(false)
    expect(v.summary).toContain(`${CRYPTO} unavailable:`)
  })

  it('a profile that THROWS fails only itself — the other verdicts survive', async () => {
    const v = await runReviewCi(deps({
      reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }),
      profileReview: async () => { throw new Error('spawn ENOENT') },
    }))
    expect(v.ok).toBe(false)
    expect(v.summary).toContain(`${CRYPTO} unavailable: spawn ENOENT`)
    expect(v.summary).toContain(`${GENERAL_REVIEWER}: PASS`)
  })

  // The fail-open an earlier revision of #1158 shipped: the gate step
  // resolved the set and handed it to this one through an env var, but on a
  // `pull_request` event the workflow file is the PR's OWN copy — so a PR
  // could empty that variable and its crypto review would silently never
  // run, leaving a reusable general-only PASS for a set nobody approved.
  it('decides the review set ITSELF, from the changed files, never from what invoked it', async () => {
    const d = deps({
      reviewSet: vi.fn(async () => ({ ok: true as const, profiles: [CRYPTO], fromLabels: [], reasons: [] })),
    })
    await runReviewCi(d)
    expect(d.reviewSet).toHaveBeenCalledWith(passing.changedFiles)
    expect(d.profileReview).toHaveBeenCalledTimes(1)
  })

  it('fails CLOSED, reviewing nothing, when it cannot decide its own review set', async () => {
    const d = deps({ reviewSet: async () => ({ ok: false, reason: 'the PR\'s labels could not be read' }) })
    const v = await runReviewCi(d)
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('review set refused')
    expect(d.secondOpinion).not.toHaveBeenCalled()
  })

  it('fails CLOSED, before any review runs, when a profile does not resolve in the BASE registry', async () => {
    const d = deps({
      reviewSet: async () => ({ ok: true, profiles: ['bogus-reviewer'], fromLabels: [], reasons: [] }),
      resolveProfile: async () => ({ ok: false, reason: 'no agent definition "bogus-reviewer.md"' }),
    })
    const v = await runReviewCi(d)
    expect(v.ok).toBe(false)
    expect(v.summary).toContain('review set refused')
    expect(d.secondOpinion).not.toHaveBeenCalled()
    expect(d.profileReview).not.toHaveBeenCalled()
  })

  // Every reviewer's FULL text must reach the PR, not just the one-line
  // verdict — two real reviews on #1117 left the PR with a red check and no
  // stated reason, their findings readable only via `gh run view --log`.
  it('reports every reviewer\'s full text for publishing, on a FAIL as well as a PASS', async () => {
    const d = deps({
      reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }),
      secondOpinion: async () => ({ verdict: 'PASS', text: 'nothing to report\nVERDICT: PASS' }),
      profileReview: async () => ({ verdict: 'FAIL', text: 'the HKDF info is a raw string\nVERDICT: FAIL — raw label' }),
    })
    await runReviewCi(d)
    expect(d.publishReport).toHaveBeenCalledTimes(1)
    const entries = (d.publishReport as unknown as { mock: { calls: [readonly { reviewer: string; verdict: string; body: string }[]][] } }).mock.calls[0]?.[0] ?? []
    expect(entries.map((e) => e.reviewer)).toEqual([GENERAL_REVIEWER, CRYPTO])
    expect(entries.map((e) => e.verdict)).toEqual(['PASS', 'FAIL'])
    expect(entries[1]?.body).toContain('the HKDF info is a raw string')
  })

  it('reports a re-published cached verdict too, so a cache hit still reads as a review', async () => {
    const d = deps({
      cacheFor: () => ({
        async lookup() { return { verdict: 'PASS' as const, text: 'VERDICT: PASS (cached)\n\nwhy it passed' } },
        async record() {},
      }),
    })
    await runReviewCi(d)
    const entries = (d.publishReport as unknown as { mock: { calls: [readonly { body: string }[]][] } }).mock.calls[0]?.[0] ?? []
    expect(entries[0]?.body).toContain('why it passed')
  })

  it('hands each profile its own resolved instructions, the diff and the export path', async () => {
    const d = deps({ reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }) })
    await runReviewCi(d)
    expect(d.profileReview).toHaveBeenCalledWith(
      { agent: CRYPTO, instructions: `be a ${CRYPTO}` },
      'diff --git a/x b/x',
      passing.changedFiles,
    )
  })

  it('a set of exactly one keeps the pre-#1158 summary shape byte for byte', async () => {
    const v = await runReviewCi(deps({ secondOpinion: async () => ({ verdict: 'PASS', text: 'looks fine\nVERDICT: PASS' }) }))
    expect(v.summary).toBe('VERDICT: PASS\n\nlooks fine\nVERDICT: PASS')
  })

  // The fail-open this replaces: without namespacing, a PASS recorded by the
  // general reviewer alone would be found by a later run whose set also
  // includes a profile that never ran, and re-published as if it had.
  it('looks the cache up under the EXACT review set\'s namespace', async () => {
    const seen: (string | undefined)[] = []
    const cache = memCache()
    const spy = (scope: string | undefined): ReviewCache => { seen.push(scope); return cache }
    await runReviewCi(deps({ reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }), cacheFor: spy }))
    expect(seen[0]).toBeUndefined()
    seen.length = 0
    await runReviewCi(deps({ reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }), cacheFor: spy }))
    expect(seen[0]).toBe(reviewSetTag([CRYPTO]))
    expect(cacheArtifactName('42', diffHash('d'), undefined))
      .not.toBe(cacheArtifactName('42', diffHash('d'), reviewSetTag([CRYPTO])))
  })

  // The label-clearing step makes the review set SHRINK between runs, so a
  // full-set PASS must also satisfy the smaller set it leaves behind —
  // otherwise the next review request (aimed at anyone) turns an
  // already-green, fully-reviewed PR red on `not-requested`.
  it('records a PASS under the exact set AND the general-only namespace, so a later smaller set still hits', async () => {
    const recorded: (string | undefined)[] = []
    const caches = new Map<string, ReviewCache>()
    const cacheFor = (scope: string | undefined): ReviewCache => {
      const key = scope ?? '(general)'
      if (!caches.has(key)) {
        const store = new Map<string, CachedVerdict>()
        caches.set(key, {
          async lookup(k) { return store.get(`${k.pr}:${k.diffHash}`) },
          async record(k, v) { recorded.push(scope); store.set(`${k.pr}:${k.diffHash}`, v) },
        })
      }
      return caches.get(key) as ReviewCache
    }
    await runReviewCi(deps({ reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [CRYPTO], reasons: [] }), cacheFor }))
    expect(recorded).toEqual([reviewSetTag([CRYPTO]), undefined])

    // Now the label is gone, so the set is general-only — and it hits.
    const secondOpinion = vi.fn(async () => PASS('general'))
    const v = await runReviewCi(deps({
      reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }), cacheFor, secondOpinion,
    }))
    expect(v.ok).toBe(true)
    expect(secondOpinion, 'the smaller set must reuse the full set\'s PASS').not.toHaveBeenCalled()
  })

  // The other direction, and it is fail-CLOSED on purpose: a reviewer found
  // a defect in this diff, and removing its label does not un-find it.
  it('records a FAIL under both namespaces too, so delabelling cannot orphan it into a green', async () => {
    const recorded: (string | undefined)[] = []
    const caches = new Map<string, ReviewCache>()
    const cacheFor = (scope: string | undefined): ReviewCache => {
      const key = scope ?? '(general)'
      if (!caches.has(key)) {
        const store = new Map<string, CachedVerdict>()
        caches.set(key, {
          async lookup(k) { return store.get(`${k.pr}:${k.diffHash}`) },
          async record(k, v) { recorded.push(scope); store.set(`${k.pr}:${k.diffHash}`, v) },
        })
      }
      return caches.get(key) as ReviewCache
    }
    await runReviewCi(deps({
      reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [CRYPTO], reasons: [] }),
      cacheFor,
      profileReview: async () => ({ verdict: 'FAIL', text: 'VERDICT: FAIL — raw crypto context' }),
    }))
    expect(recorded).toEqual([reviewSetTag([CRYPTO]), undefined])

    const secondOpinion = vi.fn(async () => PASS('general'))
    const v = await runReviewCi(deps({
      reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }), cacheFor, secondOpinion,
    }))
    expect(v.ok, 'removing the label must not turn a failed diff green').toBe(false)
    expect(secondOpinion).not.toHaveBeenCalled()
  })

  it('records the set\'s composed FAIL, never a PASS, when one member failed', async () => {
    const recorded: CachedVerdict[] = []
    const cache: ReviewCache = { async lookup() { return undefined }, async record(_k, v) { recorded.push(v) } }
    await runReviewCi(deps({
      reviewSet: async () => ({ ok: true, profiles: [CRYPTO], fromLabels: [], reasons: [] }), cacheFor: () => cache,
      profileReview: async () => ({ verdict: 'FAIL', text: 'VERDICT: FAIL — no' }),
    }))
    expect(new Set(recorded.map((r) => r.verdict))).toEqual(new Set(['FAIL']))
    expect(recorded[0]?.text).toContain('VERDICT: FAIL — no')
  })
})

describe('decideReviewGate: the review set is decided first, and fails closed', () => {
  const diff = 'diff --git a/x b/x\n+hello\n'
  const cache: ReviewCache = { async lookup() { return { verdict: 'PASS', text: 'VERDICT: PASS (cached)' } }, async record() {} }
  const gate = (reviewSet: () => Promise<ReviewSetDecision>, requested = true) => decideReviewGate({
    ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['x'],
    cacheFor: () => cache, requested, reviewSet, log: () => {},
  })

  it('fails closed ahead of a cached PASS when the review set cannot be resolved', async () => {
    const o = await gate(async () => ({ ok: false, reason: 'the PR\'s labels could not be read' }))
    expect(o.kind).toBe('review-set-unresolved')
    expect(o.kind === 'review-set-unresolved' && o.reason).toContain('labels could not be read')
  })

  it('fails closed ahead of a cached PASS even when this event did not request a review', async () => {
    const o = await gate(async () => ({ ok: false, reason: 'unknown profile' }), false)
    expect(o.kind).toBe('review-set-unresolved')
  })

  // An explicit label outranks the tier heuristic: someone decided this
  // particular diff needs this particular pair of eyes, and "it looked like
  // docs to me" is not an answer to that.
  it('does NOT take the low-tier shortcut when a reviewer label explicitly asked for a review', async () => {
    const o = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['README.md'],
      cacheFor: () => ({ async lookup() { return undefined }, async record() {} }),
      requested: true,
      reviewSet: async () => ({ ok: true, profiles: ['crypto-security-reviewer'], fromLabels: ['crypto-security-reviewer'], reasons: [] }),
      log: () => {},
    })
    expect(o.kind).toBe('run-engine')
  })

  it('does NOT take the low-tier shortcut when the PR\'s own CONTENT put a profile in the set either', async () => {
    const o = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['README.md'],
      cacheFor: () => ({ async lookup() { return undefined }, async record() {} }),
      requested: true,
      reviewSet: async () => ({ ok: true, profiles: ['crypto-security-reviewer'], fromLabels: [], reasons: [] }),
      log: () => {},
    })
    expect(o.kind).toBe('run-engine')
  })

  it('still takes the low-tier shortcut for a docs-only diff nobody labelled', async () => {
    const o = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['README.md'],
      cacheFor: () => ({ async lookup() { return undefined }, async record() {} }),
      requested: true,
      reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
      log: () => {},
    })
    expect(o.kind).toBe('low-tier')
  })

  it('carries the resolved set and the labels to clear into run-engine', async () => {
    const o = await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['x'],
      cacheFor: () => ({ async lookup() { return undefined }, async record() {} }),
      requested: true,
      reviewSet: async () => ({ ok: true, profiles: ['crypto-security-reviewer'], fromLabels: ['crypto-security-reviewer'], reasons: [] }),
      log: () => {},
    })
    expect(o.kind).toBe('run-engine')
    expect(o.kind === 'run-engine' && o.profiles).toEqual(['crypto-security-reviewer'])
    expect(o.kind === 'run-engine' && o.clearLabels).toEqual(['crypto-security-reviewer'])
  })

  // #1158: a cached SUBSTANTIVE FAIL short-circuits exactly like a cached
  // PASS — no model call — but concludes the check RED, with the original
  // verdict carried through so the reader sees why.
  it('concludes cache-hit with a FAIL verdict, spending no review, and carries the original text', async () => {
    const o = await decideReviewGate({
      ctx: ctx(), prDiff: async () => 'd', changedFiles: async () => ['x'],
      cacheFor: () => ({
        async lookup() { return { verdict: 'FAIL' as const, text: 'VERDICT: FAIL (cached)\n\n---\n\nleaks a key' } },
        async record() {},
      }),
      requested: true,
      reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
      log: () => {},
    })
    expect(o.kind).toBe('cache-hit')
    expect(o.kind === 'cache-hit' && o.verdict.verdict).toBe('FAIL')
    expect(o.kind === 'cache-hit' && o.verdict.text).toContain('leaks a key')
  })

  it('looks the cache up in the review set\'s own namespace, never the general reviewer\'s', async () => {
    const seen: (string | undefined)[] = []
    await decideReviewGate({
      ctx: ctx(), prDiff: async () => diff, changedFiles: async () => ['x'],
      cacheFor: (scope) => { seen.push(scope); return { async lookup() { return undefined }, async record() {} } },
      requested: true,
      reviewSet: async () => ({ ok: true, profiles: ['crypto-security-reviewer'], fromLabels: [], reasons: [] }),
      log: () => {},
    })
    expect(seen).toEqual([reviewSetTag(['crypto-security-reviewer'])])
  })
})
