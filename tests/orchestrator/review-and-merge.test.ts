import { describe, it, expect, vi } from 'vitest'
import {
  hasSuccessfulReview, checkRunConclusion, evaluateMergeReadiness, describeOutcome,
  runReviewAndMerge, postReviewCheckRun, REVIEW_AND_MERGE_MODEL,
  type CheckRunInfo, type RequiredCheck, type ReviewAndMergeDeps, type PrSnapshotFacts,
} from '../../orchestrator/src/review-and-merge.js'
import { REVIEW_JOB } from '../../orchestrator/src/ci.js'
import { REPO } from '../../orchestrator/src/gh.js'
import {
  GITHUB_API, VerdictRecorderError,
  type AppHttp, type AppHttpRequest,
} from '../../orchestrator/src/github-app.js'
import type { SecondOpinionResult } from '../../orchestrator/src/review.js'

const facts = (over: Partial<PrSnapshotFacts> = {}): PrSnapshotFacts => ({
  headSha: 'head111',
  baseSha: 'base000',
  changedFiles: ['orchestrator/src/foo.ts'],
  addedLines: 10,
  authorLogin: 'rhonda-rodododo',
  authorIsBot: false,
  headBranch: 'fleet/infra/9',
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
    recorderReady: vi.fn(async () => ({ ok: true as const })),
    postCheckRun: vi.fn(async () => {}),
    currentHeadSha: vi.fn(async () => 'head111'),
    requiredChecks: vi.fn(async () => requiredChecks()),
    reviewSet: vi.fn(async () => ({ ok: true as const, profiles: [], fromLabels: [], reasons: [] })),
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

// #1158 — this command is an INDEPENDENT producer of the required
// `fleet/review` check and runs exactly ONE reviewer. The per-specialist
// contexts that used to hold it back are gone, so nothing else would stop
// it posting a GREEN `fleet/review` on a crypto PR after a general-only
// review. It refuses instead.
describe('runReviewAndMerge refuses a PR whose review set it does not actually run', () => {
  it('posts nothing and merges nothing when the set needs a reviewer profile', async () => {
    const deps = baseDeps({
      reviewSet: vi.fn(async () => ({
        ok: true as const, profiles: ['crypto-security-reviewer'], fromLabels: [], reasons: [],
      })),
    })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(outcome.kind === 'not-mergeable' && outcome.reason).toContain('crypto-security-reviewer')
    expect(outcome.kind === 'not-mergeable' && outcome.reason).toContain('llamenos-auto')
    expect(deps.invokeReviewer).not.toHaveBeenCalled()
    expect(deps.postCheckRun, 'it must not post a fleet/review it did not earn').not.toHaveBeenCalled()
    expect(deps.merge).not.toHaveBeenCalled()
  })

  // #1232's defect, in this command's own advice: GitHub refuses to request
  // a PR's author, so telling the author of a `llamenos-auto` PR to request
  // `llamenos-auto` names a request that cannot be made.
  it('on a PR llamenos-auto wrote, names the operator — the request GitHub will accept', async () => {
    const deps = baseDeps({
      readPr: vi.fn(async () => facts({ authorLogin: 'llamenos-auto', headBranch: 'fleet/desktop/1130' })),
      reviewSet: vi.fn(async () => ({
        ok: true as const, profiles: ['crypto-security-reviewer'], fromLabels: [], reasons: [],
      })),
    })
    const outcome = await runReviewAndMerge('1184', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(outcome.kind === 'not-mergeable' && outcome.reason).toContain('Request a review from rhonda-rodododo')
    expect(outcome.kind === 'not-mergeable' && outcome.reason).not.toContain('Request a review from llamenos-auto')
  })

  it('refuses when the review set cannot be worked out at all', async () => {
    const deps = baseDeps({
      reviewSet: vi.fn(async () => ({ ok: false as const, reason: 'the PR\'s labels could not be read' })),
    })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(deps.postCheckRun).not.toHaveBeenCalled()
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('still reviews and merges a PR whose set is the general reviewer alone', async () => {
    const deps = baseDeps()
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('merged')
    expect(deps.invokeReviewer).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// #1483 — the verdict is recorded with a GitHub App installation token, or
// it is not recorded at all. The Checks API refuses a PAT outright, so these
// assertions are about WHICH credential reaches WHICH endpoint, and about
// every way this command must refuse rather than lose a verdict.
// ---------------------------------------------------------------------------

const INSTALL_TOKEN = 'ghs_installationTokenForTheCheckCall000'
const APP_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NTY3In0.ZmFrZXNpZ25hdHVyZQ'
const OPERATOR_PAT = 'ghp_theOperatorsOwnPersonalAccessToken0'

interface RecordedPost { requests: AppHttpRequest[]; http: AppHttp }

function recordingCheckHttp(status = 201, body = '{"id":42}'): RecordedPost {
  const requests: AppHttpRequest[] = []
  return {
    requests,
    http: async (req) => {
      requests.push(req)
      return { status, body }
    },
  }
}

describe('postReviewCheckRun authenticates as the GitHub App (#1483)', () => {
  it('POSTs the verdict to this repo\'s check-runs endpoint with the INSTALLATION token', async () => {
    const { requests, http } = recordingCheckHttp()
    await postReviewCheckRun('abc123', 'PASS', 'VERDICT: PASS', {
      mintToken: async () => INSTALL_TOKEN,
      http,
    })

    expect(requests).toHaveLength(1)
    const req = requests[0]
    expect(req?.method).toBe('POST')
    expect(req?.url).toBe(`${GITHUB_API}/repos/${REPO}/check-runs`)

    // The whole point: the installation token, not the App JWT, and not the
    // operator's PAT. `Bearer <jwt>` goes to the token-exchange endpoints
    // (asserted in github-app.test.ts); this call carries `token <ghs_…>`.
    expect(req?.authorization).toBe(`token ${INSTALL_TOKEN}`)
    expect(req?.authorization).not.toContain(APP_JWT)
    expect(req?.authorization).not.toContain(OPERATOR_PAT)
    expect(req?.authorization).not.toMatch(/^Bearer /)
  })

  it('sends the real check-run payload — name, head SHA, conclusion and the reviewer\'s own text', async () => {
    const { requests, http } = recordingCheckHttp()
    await postReviewCheckRun('abc123', 'FAIL', 'VERDICT: FAIL — leaks a key', {
      mintToken: async () => INSTALL_TOKEN,
      http,
    })
    const body = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>
    expect(body['name']).toBe(REVIEW_JOB)
    expect(body['head_sha']).toBe('abc123')
    expect(body['status']).toBe('completed')
    expect(body['conclusion']).toBe('failure')
    expect((body['output'] as { summary?: string }).summary).toContain('leaks a key')
  })

  it('truncates an over-long summary rather than letting GitHub reject the whole post', async () => {
    const { requests, http } = recordingCheckHttp()
    await postReviewCheckRun('abc123', 'PASS', 'x'.repeat(70_000), { mintToken: async () => INSTALL_TOKEN, http })
    const summary = (JSON.parse(requests[0]?.body ?? '{}') as { output: { summary: string } }).output.summary
    expect(summary.length).toBeLessThan(70_000)
    expect(summary).toContain('(truncated)')
  })

  it('throws when GitHub refuses the post — never returns as if it had been recorded', async () => {
    const { http } = recordingCheckHttp(403, JSON.stringify({ message: 'You must authenticate via a GitHub App.' }))
    await expect(postReviewCheckRun('abc123', 'PASS', 'VERDICT: PASS', { mintToken: async () => INSTALL_TOKEN, http }))
      .rejects.toThrow(/HTTP 403/)
  })

  it('throws when no token can be minted, and never reaches the endpoint', async () => {
    const { requests, http } = recordingCheckHttp()
    await expect(postReviewCheckRun('abc123', 'PASS', 'VERDICT: PASS', {
      mintToken: async () => { throw new VerdictRecorderError('FLEET_REVIEW_APP_ID is not set') },
      http,
    })).rejects.toThrow(/FLEET_REVIEW_APP_ID/)
    expect(requests, 'it must not post a verdict it could not authenticate').toEqual([])
  })

  it('keeps the installation token out of its own error message, even when GitHub echoes it', async () => {
    const { http } = recordingCheckHttp(401, JSON.stringify({ message: `bad credential ${INSTALL_TOKEN}`, token: INSTALL_TOKEN }))
    const e = await postReviewCheckRun('abc123', 'PASS', 'VERDICT: PASS', { mintToken: async () => INSTALL_TOKEN, http })
      .catch((err: unknown) => err)
    expect(e).toBeInstanceOf(VerdictRecorderError)
    expect((e as Error).message).not.toContain(INSTALL_TOKEN)
    expect((e as Error).message).toContain('HTTP 401')
  })
})

describe('runReviewAndMerge fails CLOSED when a verdict cannot be recorded (#1483)', () => {
  it('refuses BEFORE the reviewer runs when the App credentials are absent', async () => {
    const deps = baseDeps({
      recorderReady: vi.fn(async () => ({ ok: false as const, reason: 'FLEET_REVIEW_APP_ID is not set (see issue #1483)' })),
    })
    const outcome = await runReviewAndMerge('9', deps)

    expect(outcome.kind).toBe('cannot-record')
    expect(outcome.kind === 'cannot-record' && outcome.reason).toContain('FLEET_REVIEW_APP_ID')
    // Nothing spent, nothing posted, nothing merged.
    expect(deps.invokeReviewer, 'an opus review must not be spent on a verdict that cannot be recorded').not.toHaveBeenCalled()
    expect(deps.exportHead).not.toHaveBeenCalled()
    expect(deps.postCheckRun).not.toHaveBeenCalled()
    expect(deps.merge).not.toHaveBeenCalled()
  })

  it('says plainly that nothing was posted, and names the issue, in the operator-facing line', () => {
    const line = describeOutcome({ kind: 'cannot-record', pr: '9', reason: 'the key is missing at /x/review-app.pem' })
    expect(line).toContain('NOT reviewed')
    expect(line).toContain('Nothing was posted')
    expect(line).toContain('#1483')
    expect(line, 'a refusal must never read as a success').not.toMatch(/\bposted fleet\/review\b/)
  })

  it('reports a LOST verdict when the review ran but the post failed, and never merges', async () => {
    const deps = baseDeps({
      postCheckRun: vi.fn(async () => { throw new VerdictRecorderError('HTTP 401 — A JSON web token could not be decoded') }),
    })
    const outcome = await runReviewAndMerge('9', deps)

    expect(outcome.kind).toBe('review-unrecorded')
    expect(outcome.kind === 'review-unrecorded' && outcome.verdict).toBe('PASS')
    expect(outcome.kind === 'review-unrecorded' && outcome.headSha).toBe('head111')
    expect(outcome.kind === 'review-unrecorded' && outcome.reason).toContain('HTTP 401')
    expect(deps.invokeReviewer).toHaveBeenCalledTimes(1)
    expect(deps.merge, 'a verdict that was never recorded cannot gate a merge').not.toHaveBeenCalled()
  })

  // The precise shape the brief forbids: a "posted the verdict" line when
  // nothing was posted.
  it('never logs "posted" when the post failed', async () => {
    const deps = baseDeps({
      postCheckRun: vi.fn(async () => { throw new VerdictRecorderError('HTTP 403') }),
    })
    await runReviewAndMerge('9', deps)
    const logged = (deps.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).not.toContain('posted')
  })

  it('renders the lost verdict as a loss, not a pass', () => {
    const line = describeOutcome({
      kind: 'review-unrecorded', pr: '9', headSha: 'head111', verdict: 'PASS', reason: 'HTTP 403',
    })
    expect(line).toContain('LOST')
    expect(line).toContain('nothing was posted')
    expect(line).toContain('#1483')
  })

  it('the freshness-hit path needs no App credentials at all — it posts nothing', async () => {
    const deps = baseDeps({
      fetchReviewCheckRuns: vi.fn(async () => [{ id: 1, status: 'completed', conclusion: 'success' }]),
      recorderReady: vi.fn(async () => ({ ok: false as const, reason: 'FLEET_REVIEW_APP_ID is not set' })),
    })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome).toEqual({ kind: 'merged', pr: '9', headSha: 'head111' })
    expect(deps.recorderReady).not.toHaveBeenCalled()
    expect(deps.postCheckRun).not.toHaveBeenCalled()
  })

  it('still refuses a specialist-needing PR without even consulting the recorder', async () => {
    const deps = baseDeps({
      reviewSet: vi.fn(async () => ({
        ok: true as const, profiles: ['crypto-security-reviewer'], fromLabels: [], reasons: [],
      })),
    })
    const outcome = await runReviewAndMerge('9', deps)
    expect(outcome.kind).toBe('not-mergeable')
    expect(outcome.kind === 'not-mergeable' && outcome.reason).toContain('will not post a fleet/review that claims otherwise')
    expect(deps.recorderReady).not.toHaveBeenCalled()
    expect(deps.postCheckRun).not.toHaveBeenCalled()
  })
})
