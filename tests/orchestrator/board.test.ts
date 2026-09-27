import { describe, it, expect, vi } from 'vitest'
import {
  buildBoard, classifyPr, classifyReviewFailure, isBotAuthor,
  normalizeCheckRunState, normalizeStatusContextState, renderBoard, renderBoardPorcelain,
  fetchBoardFactsWith, deriveBranchRuleset, parseCodeOwners, codeOwnersOf,
  type BoardFacts, type PrFact, type PrCheckContext, type FleetStateFact, type BoardFetchDeps,
  type BranchGate, type BranchRuleset, type CheckState,
} from '../../orchestrator/src/board.js'
import { VERIFY_JOB, REVIEW_JOB } from '../../orchestrator/src/ci.js'
import { REVIEW_REQUEST_LOGIN } from '../../orchestrator/src/request-review.js'

const HEAD = 'head-sha-111'
const OTHER_SHA = 'stale-sha-999'
const OWNER = 'rhonda-rodododo'

const FLEET_OK: FleetStateFact = { halted: false, isQuotaHalt: false }

/** `main`'s live ruleset, verbatim from `gh api repos/:owner/:repo/rules/
 *  branches/main` on 2026-09-25 (the #961 incident): five required contexts,
 *  code-owner review required, zero approving reviews otherwise. */
const MAIN_RULES: BranchRuleset = {
  branch: 'main',
  requiredContexts: ['ci-status', 'gitleaks', 'CodeQL', VERIFY_JOB, REVIEW_JOB],
  requireCodeOwnerReview: true,
  requiredApprovingReviewCount: 0,
  requireExtraApprovalForUnattributedChanges: true,
}

const GATE: BranchGate = {
  ruleset: { ok: true, rules: MAIN_RULES },
  codeOwners: {
    ok: true,
    rules: [
      { pattern: 'packages/crypto/', owners: [OWNER] },
      { pattern: 'apps/worker/lib/auth.ts', owners: [OWNER, 'second-owner'] },
    ],
  },
}

/** Every required context OTHER than fleet/review PASSing on the current
 *  head — the baseline every classification test starts from and overrides
 *  away from. Derived from the ruleset fixture, exactly as the board derives
 *  its own required set from the live ruleset. */
function cheapPassChecks(sha = HEAD): PrCheckContext[] {
  return MAIN_RULES.requiredContexts.filter((n) => n !== REVIEW_JOB).map((name) => ({ name, kind: 'CheckRun', sha, state: 'PASS' }))
}

function ctx(name: string, state: CheckState, sha = HEAD): PrCheckContext {
  return { name, kind: 'CheckRun', sha, state }
}

function pr(overrides: Partial<PrFact> = {}): PrFact {
  return {
    number: 1,
    authorLogin: 'someone',
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    headRefOid: HEAD,
    headRefName: 'fleet/backend/1',
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    labels: [],
    reviews: [],
    files: ['docs/notes.md'],
    changedFiles: 1,
    checks: cheapPassChecks(),
    ...overrides,
  }
}

function reviewCheck(overrides: Partial<PrCheckContext> = {}): PrCheckContext {
  return { name: REVIEW_JOB, kind: 'CheckRun', sha: HEAD, state: 'PASS', ...overrides }
}

const classify = (p: PrFact, gate: BranchGate = GATE) => classifyPr(p, gate)

const facts = (prs: PrFact[], fleet: FleetStateFact = FLEET_OK): BoardFacts => ({ fleet, prs, gates: { main: GATE } })

/** `gh api repos/:owner/:repo/rules/branches/main` on 2026-09-25, verbatim
 *  (the #961 incident) — the raw body `fetchBranchRules` returns. */
const LIVE_MAIN_RULES = [
  { type: 'deletion', ruleset_id: 15885614 },
  { type: 'non_fast_forward', ruleset_id: 15885614 },
  {
    type: 'pull_request', ruleset_id: 15885614,
    parameters: {
      required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, required_reviewers: [],
      require_code_owner_review: true, require_last_push_approval: false, required_review_thread_resolution: false,
      require_extra_approval_for_unattributed_changes: true, allowed_merge_methods: ['squash'],
    },
  },
  {
    type: 'required_status_checks', ruleset_id: 15885614,
    parameters: {
      strict_required_status_checks_policy: false, do_not_enforce_on_create: true,
      required_status_checks: [
        { context: 'ci-status' }, { context: 'gitleaks' }, { context: 'CodeQL' }, { context: VERIFY_JOB }, { context: REVIEW_JOB },
      ],
    },
  },
]

type GqlPrNodeFixture = Awaited<ReturnType<BoardFetchDeps['queryOpenPrs']>> extends infer R
  ? R extends { data?: { repository?: { pullRequests?: { nodes: (infer N)[] } } | null } | null } ? N : never
  : never
type GqlContextFixture = GqlPrNodeFixture['commits']['nodes'][number]['commit'] extends infer C
  ? C extends { statusCheckRollup: { contexts: { nodes: (infer X)[] } } | null } ? X : never
  : never

/** One open-PR node exactly as `PR_QUERY` returns it. */
function gqlPr(number: number, contexts: GqlContextFixture[] = []): GqlPrNodeFixture {
  return {
    number,
    author: { login: 'a-human' },
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    headRefOid: HEAD,
    headRefName: `fleet/backend/${number}`,
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    labels: { nodes: [] },
    changedFiles: 1,
    files: { nodes: [{ path: 'docs/notes.md' }] },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { contexts: { nodes: contexts } } } }] },
  }
}

describe('classifyReviewFailure', () => {
  it('is substantive when the step literally named "Review" failed', () => {
    expect(classifyReviewFailure([
      { name: 'Setup Bun', conclusion: 'success' },
      { name: 'Review', conclusion: 'failure' },
    ])).toBe('substantive')
  })

  it('is infrastructure when a setup step failed and Review never ran', () => {
    expect(classifyReviewFailure([
      { name: 'Install the non-author review engine', conclusion: 'failure' },
      { name: 'Review', conclusion: null },
    ])).toBe('infrastructure')
  })

  it('is infrastructure when there is no "Review" step in the list at all', () => {
    expect(classifyReviewFailure([{ name: 'Checkout the PR BASE (trusted)', conclusion: 'failure' }])).toBe('infrastructure')
  })

  // Mutation rail (mandatory, per the brief): treating every review failure
  // as infrastructure must be distinguishable from the real function — this
  // pins the one input where they disagree.
  it('disagrees with an always-infrastructure classifier on a Review-step failure', () => {
    const alwaysInfra = (): 'infrastructure' => 'infrastructure'
    const steps = [{ name: 'Review', conclusion: 'failure' }]
    expect(classifyReviewFailure(steps)).not.toBe(alwaysInfra())
  })
})

describe('isBotAuthor', () => {
  it.each(['app/dependabot', 'app/github-actions', 'dependabot[bot]', 'github-actions[bot]', 'some-app[bot]', 'app/whatever'])(
    'treats %s as a bot', (login) => { expect(isBotAuthor(login)).toBe(true) })
  it.each(['rhonda-rodododo', 'a-human'])('does not treat %s as a bot', (login) => { expect(isBotAuthor(login)).toBe(false) })
})

describe('normalizeCheckRunState', () => {
  it('is PENDING while not completed', () => { expect(normalizeCheckRunState('IN_PROGRESS', null)).toBe('PENDING') })
  it.each(['SUCCESS', 'SKIPPED', 'NEUTRAL'])('is PASS for a completed %s', (c) => {
    expect(normalizeCheckRunState('COMPLETED', c)).toBe('PASS')
  })
  it.each(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])(
    'is FAIL for a completed %s', (c) => { expect(normalizeCheckRunState('COMPLETED', c)).toBe('FAIL') })
})

describe('normalizeStatusContextState', () => {
  it('is PASS for SUCCESS', () => { expect(normalizeStatusContextState('SUCCESS')).toBe('PASS') })
  it.each(['PENDING', 'EXPECTED'])('is PENDING for %s', (s) => { expect(normalizeStatusContextState(s)).toBe('PENDING') })
  it.each(['ERROR', 'FAILURE'])('is FAIL for %s', (s) => { expect(normalizeStatusContextState(s)).toBe('FAIL') })
})

describe('classifyPr — OPERATOR', () => {
  it('a draft is OPERATOR regardless of everything else', () => {
    expect(classify(pr({ isDraft: true, checks: [] })).action).toBe('OPERATOR')
  })

  it('the knope release PR (branch "release", bot author) is OPERATOR', () => {
    expect(classify(pr({ headRefName: 'release', authorLogin: 'app/github-actions' })).action).toBe('OPERATOR')
  })

  it('a human PR on a branch literally named "release" is NOT auto-classified OPERATOR by branch alone', () => {
    expect(classify(pr({ headRefName: 'release', authorLogin: 'a-human', checks: [...cheapPassChecks(), reviewCheck()] })).action)
      .toBe('MERGE')
  })
})

describe('classifyPr — cheap required contexts', () => {
  it('NEEDS_FIX when a cheap context failed, and names it', () => {
    const result = classify(pr({ checks: [{ name: VERIFY_JOB, kind: 'CheckRun', sha: HEAD, state: 'FAIL' }, { name: 'ci-status', kind: 'CheckRun', sha: HEAD, state: 'PASS' }] }))
    expect(result.action).toBe('NEEDS_FIX')
    expect(result.failingContexts).toContain(VERIFY_JOB)
  })

  it('WAITING when a cheap context is still pending', () => {
    const result = classify(pr({ checks: [{ name: VERIFY_JOB, kind: 'CheckRun', sha: HEAD, state: 'PENDING' }, { name: 'ci-status', kind: 'CheckRun', sha: HEAD, state: 'PASS' }] }))
    expect(result.action).toBe('WAITING')
  })

  it('WAITING when a cheap context has not posted on this head at all', () => {
    const result = classify(pr({ checks: [{ name: 'ci-status', kind: 'CheckRun', sha: HEAD, state: 'PASS' }] }))
    expect(result.action).toBe('WAITING')
  })
})

describe('classifyPr — fleet/review tree', () => {
  it('MERGE when review PASSes and author is not a bot', () => {
    expect(classify(pr({ authorLogin: 'a-human', checks: [...cheapPassChecks(), reviewCheck()] })).action).toBe('MERGE')
  })

  it('APPROVE_THEN_MERGE for a bot author with no code-owner approval yet', () => {
    expect(classify(pr({ authorLogin: 'app/dependabot', checks: [...cheapPassChecks(), reviewCheck()] })).action)
      .toBe('APPROVE_THEN_MERGE')
  })

  it('MERGE for a bot author that already carries a code-owner approval', () => {
    expect(classify(pr({
      authorLogin: 'app/dependabot', reviews: [{ login: OWNER, state: 'APPROVED' }], checks: [...cheapPassChecks(), reviewCheck()],
    })).action).toBe('MERGE')
  })

  it('WAITING while fleet/review is in flight', () => {
    expect(classify(pr({ checks: [...cheapPassChecks(), reviewCheck({ state: 'PENDING' })] })).action).toBe('WAITING')
  })

  it('STALE_LABEL when the "review" label is present but there is no verdict on this head', () => {
    const result = classify(pr({ labels: ['review'], checks: cheapPassChecks() }))
    expect(result.action).toBe('STALE_LABEL')
  })

  it('RERUN_REVIEW for an infrastructure failure not yet retried', () => {
    const result = classify(pr({
      checks: [...cheapPassChecks(), reviewCheck({ state: 'FAIL', reviewFailureKind: 'infrastructure', runAttempt: 1 })],
    }))
    expect(result.action).toBe('RERUN_REVIEW')
  })

  it('NEEDS_FIX for an infrastructure failure already retried once', () => {
    const result = classify(pr({
      checks: [...cheapPassChecks(), reviewCheck({ state: 'FAIL', reviewFailureKind: 'infrastructure', runAttempt: 2 })],
    }))
    expect(result.action).toBe('NEEDS_FIX')
  })

  // Mandatory rail #2 (brief): a substantive review FAIL must never become
  // RERUN_REVIEW, regardless of run_attempt — auto-retrying a real verdict
  // would silently re-roll it instead of surfacing it to a human.
  it('NEEDS_FIX for a substantive review failure, never RERUN_REVIEW, even on the first attempt', () => {
    const result = classify(pr({
      checks: [...cheapPassChecks(), reviewCheck({ state: 'FAIL', reviewFailureKind: 'substantive', runAttempt: 1 })],
    }))
    expect(result.action).toBe('NEEDS_FIX')
    expect(result.action).not.toBe('RERUN_REVIEW')
    expect(result.failingContexts).toContain(REVIEW_JOB)
  })
})

describe('classifyPr — the head-binding rule (mandatory rail #1, per the brief)', () => {
  // #862's own shape: a fleet/review SUCCESS was recorded, but against a SHA
  // that is not the PR's current head. It must never be treated as a live
  // MERGE-worthy verdict — it must read as if fleet/review were simply
  // ABSENT on this head, which (with no "review" label present) makes the
  // sole open PR a REQUEST_REVIEW candidate, not a merge.
  it('a fleet/review PASS on a stale SHA is treated as ABSENT, not as a live PASS', () => {
    const staleReview = reviewCheck({ sha: OTHER_SHA, state: 'PASS' })
    const result = classify(pr({ checks: [...cheapPassChecks(), staleReview] }))
    expect(result.action).not.toBe('MERGE')
    expect(result.action).not.toBe('APPROVE_THEN_MERGE')
    expect(result.action).toBe('REQUEST_REVIEW_CANDIDATE')
  })

  it('the same PR, surfaced through buildBoard as the sole open PR, becomes REQUEST_REVIEW — never MERGE', () => {
    const staleReview = reviewCheck({ sha: OTHER_SHA, state: 'PASS' })
    const view = buildBoard(facts([pr({ number: 862, checks: [...cheapPassChecks(), staleReview] })]))
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]?.action).toBe('REQUEST_REVIEW')
  })

  it('a cheap context (ci-status) on a stale SHA is treated as missing, not as a live PASS', () => {
    const staleCiStatus: PrCheckContext = { name: 'ci-status', kind: 'CheckRun', sha: OTHER_SHA, state: 'PASS' }
    const verifyOnHead: PrCheckContext = { name: VERIFY_JOB, kind: 'CheckRun', sha: HEAD, state: 'PASS' }
    const result = classify(pr({ checks: [staleCiStatus, verifyOnHead] }))
    expect(result.action).toBe('WAITING')
  })
})

describe('classifyPr — a PR whose author is also its would-be reviewer (#1158)', () => {
  // `REQUEST_REVIEW` is now an instruction to REQUEST a review from a
  // specific login, and GitHub refuses a request naming the PR's own
  // author. Emitting REQUEST_REVIEW for such a PR would put a row on the
  // board that every tick retries and nothing can ever satisfy.
  it('is OPERATOR, never REQUEST_REVIEW — and says why in the reason', () => {
    const result = classify(pr({ authorLogin: REVIEW_REQUEST_LOGIN, checks: cheapPassChecks() }))
    expect(result.action).toBe('OPERATOR')
    expect(result.action).not.toBe('REQUEST_REVIEW_CANDIDATE')
    expect(result.reason).toContain(REVIEW_REQUEST_LOGIN)
    expect(result.reason).toContain("own author")
  })

  it('does not divert the ordinary case — another author is still a candidate', () => {
    expect(classify(pr({ authorLogin: 'rhonda-rodododo', checks: cheapPassChecks() })).action)
      .toBe('REQUEST_REVIEW_CANDIDATE')
  })

  // The release PR is the one llamenos-auto routinely authors (#1161). The
  // reviewer switches to the operator there (`reviewerFor`), so it is NOT a
  // self-review and stays actionable — this is the case #1164's workflow
  // calls out, and the release PR's review must not be diverted to OPERATOR
  // by the self-review guard.
  it('the llamenos-auto-authored RELEASE PR is still a candidate — its reviewer is the operator', () => {
    const result = classify(pr({ authorLogin: REVIEW_REQUEST_LOGIN, headRefName: 'release', checks: cheapPassChecks() }))
    expect(result.action).toBe('REQUEST_REVIEW_CANDIDATE')
  })

  // The older release guard is keyed on `isBotAuthor`, which llamenos-auto
  // is not; a knope-authored release PR must still be OPERATOR for its own,
  // older reason (cutting a release is a human decision).
  it('a bot-authored release PR stays OPERATOR for the release reason, not the self-review one', () => {
    const result = classify(pr({ authorLogin: 'github-actions', headRefName: 'release', checks: cheapPassChecks() }))
    expect(result.action).toBe('OPERATOR')
    expect(result.reason).toContain('knope release PR')
  })
})

describe('buildBoard — REQUEST_REVIEW is capped to one per invocation', () => {
  it('picks exactly one, the OLDEST eligible by PR number, and defers the rest to WAITING', () => {
    const candidate = (n: number): PrFact => pr({ number: n, checks: cheapPassChecks() })
    const view = buildBoard(facts([candidate(50), candidate(12), candidate(99)]))

    const labelled = view.rows.filter((r) => r.action === 'REQUEST_REVIEW')
    expect(labelled).toHaveLength(1)
    expect(labelled[0]?.number).toBe(12)

    const deferred = view.rows.filter((r) => r.number !== 12)
    expect(deferred.every((r) => r.action === 'WAITING')).toBe(true)
  })

  it('says a review is REQUESTED, not labelled, when it defers the rest', () => {
    const candidate = (n: number): PrFact => pr({ number: n, checks: cheapPassChecks() })
    const view = buildBoard(facts([candidate(12), candidate(99)]))
    const deferred = view.rows.find((r) => r.number === 99)
    expect(deferred?.reason).toContain('only one PR gets a review requested per invocation')
    expect(deferred?.reason).not.toContain('labelled')
  })

  it('is a no-op cap when only one PR is eligible', () => {
    const view = buildBoard(facts([pr({ number: 7, checks: cheapPassChecks() })]))
    expect(view.rows.map((r) => r.action)).toEqual(['REQUEST_REVIEW'])
  })
})

describe('buildBoard — totality', () => {
  it('every PR lands in exactly one row, and every action is one of the eight public actions', () => {
    const view = buildBoard(facts([
      pr({ number: 1, isDraft: true }),
      pr({ number: 2, checks: cheapPassChecks() }),
      pr({ number: 3, authorLogin: 'a-human', checks: [...cheapPassChecks(), reviewCheck()] }),
    ]))
    expect(view.rows).toHaveLength(3)
    const publicActions = new Set(['MERGE', 'APPROVE_THEN_MERGE', 'REQUEST_REVIEW', 'RERUN_REVIEW', 'NEEDS_FIX', 'WAITING', 'STALE_LABEL', 'OPERATOR'])
    for (const row of view.rows) expect(publicActions.has(row.action)).toBe(true)
  })

  it('carries the fleet state through unchanged', () => {
    const halted: FleetStateFact = { halted: true, haltReason: 'engine quota exhausted (claude) — retry after 2026-01-01T00:00:00.000Z', isQuotaHalt: true }
    const view = buildBoard(facts([], halted))
    expect(view.fleet).toEqual(halted)
  })
})

describe('renderBoard', () => {
  it('groups by action and includes the fleet line', () => {
    const view = buildBoard(facts([pr({ number: 5, authorLogin: 'a-human', checks: [...cheapPassChecks(), reviewCheck()] })]))
    const out = renderBoard(view)
    expect(out).toContain('fleet: not halted')
    expect(out).toContain('## MERGE')
    expect(out).toContain('#5 @a-human')
  })

  it('says so when there are no open PRs', () => {
    expect(renderBoard(buildBoard(facts([])))).toContain('no open pull requests')
  })
})

describe('renderBoardPorcelain', () => {
  it('emits one unpadded pipe-delimited fleet line first, then one row per PR', () => {
    const view = buildBoard(facts([pr({ number: 9, authorLogin: 'a-human', checks: [...cheapPassChecks(), reviewCheck()] })]))
    const lines = renderBoardPorcelain(view).split('\n')
    expect(lines[0]?.startsWith('fleet|no|')).toBe(true)
    expect(lines).toHaveLength(2)
    const fields = lines[1]?.split('|') ?? []
    expect(fields[0]).toBe('9')
    expect(fields[1]).toBe('MERGE')
    expect(fields[2]).toBe('a-human')
  })

  it('never contains a padded/aligned column — porcelain rows are the raw join, no column(1) formatting', () => {
    const view = buildBoard(facts([pr({ number: 1, checks: cheapPassChecks() })]))
    const out = renderBoardPorcelain(view)
    expect(out).not.toMatch(/ {2,}/)
  })
})

describe('fetchBoardFactsWith', () => {
  const deps = (over: Partial<BoardFetchDeps> = {}): BoardFetchDeps => ({
    queryOpenPrs: vi.fn(async () => ({ data: { repository: { pullRequests: { nodes: [] } } } })),
    fetchRunJobs: vi.fn(async () => undefined),
    checkFleetHalt: vi.fn(async () => ({ halted: false })),
    fetchBranchRules: vi.fn(async () => LIVE_MAIN_RULES),
    fetchCodeOwners: vi.fn(async () => null),
    ...over,
  })
  const onePr = (node: GqlPrNodeFixture) => async () => ({ data: { repository: { pullRequests: { nodes: [node] } } } })

  it('reads the fleet halt state through checkFleetHalt, not a re-implemented file read', async () => {
    const result = await fetchBoardFactsWith(deps({ checkFleetHalt: async () => ({ halted: true, reason: 'halted by hand' }) }))
    expect(result.fleet).toEqual({ halted: true, haltReason: 'halted by hand', isQuotaHalt: false })
  })

  it('classifies a QUOTA halt reason correctly', async () => {
    const reason = 'engine quota exhausted (claude) — retry after 2026-01-01T00:00:00.000Z'
    const result = await fetchBoardFactsWith(deps({ checkFleetHalt: async () => ({ halted: true, reason }) }))
    expect(result.fleet.isQuotaHalt).toBe(true)
  })

  it('maps a GraphQL PR node into a PrFact, with both CheckRun and StatusContext contexts normalized', async () => {
    const node = gqlPr(41, [
      { __typename: 'CheckRun', name: 'ci-status', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: VERIFY_JOB, state: 'SUCCESS' },
    ])
    node.labels = { nodes: [{ name: 'agent-dispatchable' }] }
    node.latestOpinionatedReviews = { nodes: [{ author: { login: OWNER }, state: 'APPROVED' }] }
    const result = await fetchBoardFactsWith(deps({ queryOpenPrs: onePr(node) }))
    expect(result.prs).toHaveLength(1)
    const [pr0] = result.prs
    expect(pr0?.labels).toEqual(['agent-dispatchable'])
    expect(pr0?.baseRefName).toBe('main')
    expect(pr0?.files).toEqual(['docs/notes.md'])
    expect(pr0?.changedFiles).toBe(1)
    expect(pr0?.reviews).toEqual([{ login: OWNER, state: 'APPROVED' }])
    expect(pr0?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ci-status', kind: 'CheckRun', state: 'PASS' }),
      expect.objectContaining({ name: VERIFY_JOB, kind: 'StatusContext', state: 'PASS' }),
    ]))
  })

  it('only calls fetchRunJobs for a FAILed fleet/review CheckRun, never for a passing or unrelated one', async () => {
    const fetchRunJobs = vi.fn(async () => ({ steps: [{ name: 'Review', conclusion: 'failure' as const }], runAttempt: 1 }))
    const node = gqlPr(1, [
      { __typename: 'CheckRun', name: 'ci-status', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: REVIEW_JOB, status: 'COMPLETED', conclusion: 'FAILURE', checkSuite: { workflowRun: { databaseId: 555 } } },
    ])
    const result = await fetchBoardFactsWith(deps({ fetchRunJobs, queryOpenPrs: onePr(node) }))
    expect(fetchRunJobs).toHaveBeenCalledTimes(1)
    expect(fetchRunJobs).toHaveBeenCalledWith(555)
    const review = result.prs[0]?.checks.find((c) => c.name === REVIEW_JOB)
    expect(review?.reviewFailureKind).toBe('substantive')
    expect(review?.runAttempt).toBe(1)
  })

  it('an unreadable run is treated as an infrastructure failure, fail-safe toward "worth a retry"', async () => {
    const node = gqlPr(2, [
      { __typename: 'CheckRun', name: REVIEW_JOB, status: 'COMPLETED', conclusion: 'FAILURE', checkSuite: { workflowRun: { databaseId: 777 } } },
    ])
    const result = await fetchBoardFactsWith(deps({ fetchRunJobs: async () => undefined, queryOpenPrs: onePr(node) }))
    const review = result.prs[0]?.checks.find((c) => c.name === REVIEW_JOB)
    expect(review?.reviewFailureKind).toBe('infrastructure')
  })
})

// ---------------------------------------------------------------------------
// The #961 incident: the board said MERGE on a PR GitHub refused, because it
// gated on a hardcoded ['ci-status', 'fleet/verify'] and never saw the
// ruleset's `gitleaks`. Every test below is built from the ruleset, and each
// one fails against the hardcoded list.
// ---------------------------------------------------------------------------

/** PR #961's own rollup, verbatim: every context green except `gitleaks`. */
const SHAPE_961 = (): PrCheckContext[] => [
  ctx('ci-status', 'PASS'), ctx('CodeQL', 'PASS'), ctx(VERIFY_JOB, 'PASS'), ctx(REVIEW_JOB, 'PASS'), ctx('gitleaks', 'FAIL'),
]

describe('the #961 incident — the required set is derived from the ruleset', () => {
  it('ci-status/CodeQL/fleet/verify/fleet/review pass but gitleaks fails → NEEDS_FIX naming gitleaks, never MERGE', () => {
    const result = classify(pr({ number: 961, authorLogin: OWNER, checks: SHAPE_961() }))
    expect(result.action).not.toBe('MERGE')
    expect(result.action).toBe('NEEDS_FIX')
    expect(result.failingContexts).toEqual(['gitleaks'])
  })

  it('the same PR through buildBoard never lands in the MERGE bucket', () => {
    const view = buildBoard(facts([pr({ number: 961, authorLogin: OWNER, checks: SHAPE_961() })]))
    expect(view.rows.map((r) => r.action)).toEqual(['NEEDS_FIX'])
    expect(renderBoard(view)).not.toContain('## MERGE')
  })

  it('a ruleset-required context that never posted on the head is WAITING, never MERGE', () => {
    const withoutCodeQl = [ctx('ci-status', 'PASS'), ctx('gitleaks', 'PASS'), ctx(VERIFY_JOB, 'PASS'), reviewCheck()]
    const result = classify(pr({ authorLogin: OWNER, checks: withoutCodeQl }))
    expect(result.action).toBe('WAITING')
    expect(result.reason).toContain('CodeQL')
  })

  it('a context the operator adds to the ruleset later is enforced with no code change', () => {
    const rules: BranchRuleset = { ...MAIN_RULES, requiredContexts: [...MAIN_RULES.requiredContexts, 'sbom'] }
    const gate: BranchGate = { ...GATE, ruleset: { ok: true, rules } }
    const allFiveGreen = [...cheapPassChecks(), reviewCheck()]
    expect(classify(pr({ authorLogin: OWNER, checks: allFiveGreen }), gate).action).toBe('WAITING')
    expect(classify(pr({ authorLogin: OWNER, checks: [...allFiveGreen, ctx('sbom', 'FAIL')] }), gate).action).toBe('NEEDS_FIX')
    expect(classify(pr({ authorLogin: OWNER, checks: [...allFiveGreen, ctx('sbom', 'PASS')] }), gate).action).toBe('MERGE')
  })

  it('a failing context the ruleset does NOT require does not block', () => {
    const result = classify(pr({ authorLogin: OWNER, checks: [...cheapPassChecks(), reviewCheck(), ctx('lint-advisory', 'FAIL')] }))
    expect(result.action).toBe('MERGE')
  })

  it('a same-named context that failed alongside a passing one is not read as a pass', () => {
    const result = classify(pr({ authorLogin: OWNER, checks: [...cheapPassChecks(), ctx('gitleaks', 'FAIL'), reviewCheck()] }))
    expect(result.action).toBe('NEEDS_FIX')
    expect(result.failingContexts).toEqual(['gitleaks'])
  })
})

describe('ruleset unavailable → CANNOT_DECIDE, never a guessed MERGE', () => {
  it('a failed ruleset read makes an otherwise all-green PR CANNOT_DECIDE', () => {
    const gate: BranchGate = { ruleset: { ok: false, reason: 'GET rules/branches/main failed: exit 1: HTTP 502' } }
    const result = classify(pr({ authorLogin: OWNER, checks: [...cheapPassChecks(), reviewCheck()] }), gate)
    expect(result.action).toBe('CANNOT_DECIDE')
    expect(result.reason).toContain('HTTP 502')
  })

  it('a PR whose base branch has no gathered gate is CANNOT_DECIDE', () => {
    const view = buildBoard(facts([pr({ baseRefName: 'release-1.x', authorLogin: OWNER, checks: [...cheapPassChecks(), reviewCheck()] })]))
    expect(view.rows.map((r) => r.action)).toEqual(['CANNOT_DECIDE'])
  })

  it('code-owner review required but CODEOWNERS unreadable → CANNOT_DECIDE', () => {
    const gate: BranchGate = { ruleset: GATE.ruleset, codeOwners: { ok: false, reason: 'graphql: timeout' } }
    const result = classify(pr({ authorLogin: OWNER, checks: [...cheapPassChecks(), reviewCheck()] }), gate)
    expect(result.action).toBe('CANNOT_DECIDE')
  })

  it('drafts and the knope release PR stay OPERATOR — those never depended on the ruleset', () => {
    const gate: BranchGate = { ruleset: { ok: false, reason: 'down' } }
    expect(classify(pr({ isDraft: true }), gate).action).toBe('OPERATOR')
  })
})

describe('deriveBranchRuleset', () => {
  it('reads the live main ruleset shape into the required set and review requirements', () => {
    const live = [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true, require_extra_approval_for_unattributed_changes: true } },
      { type: 'required_status_checks', parameters: { required_status_checks: [
        { context: 'ci-status' }, { context: 'gitleaks' }, { context: 'CodeQL' }, { context: VERIFY_JOB }, { context: REVIEW_JOB },
      ] } },
    ]
    expect(deriveBranchRuleset('main', live)).toEqual({ ok: true, rules: MAIN_RULES })
  })

  it('unions required contexts across every rule, and takes the strictest review requirement', () => {
    const result = deriveBranchRuleset('main', [
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a' }, { context: 'b' }] } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'b' }, { context: 'c', integration_id: 15368 }] } },
      { type: 'pull_request', parameters: { required_approving_review_count: 1, require_code_owner_review: false } },
      { type: 'pull_request', parameters: { required_approving_review_count: 2, require_code_owner_review: true } },
    ])
    expect(result).toEqual({
      ok: true,
      rules: {
        branch: 'main', requiredContexts: ['a', 'b', 'c'],
        requireCodeOwnerReview: true, requiredApprovingReviewCount: 2, requireExtraApprovalForUnattributedChanges: false,
      },
    })
  })

  it.each([
    ['an empty rule list', []],
    ['rules with no required status checks', [{ type: 'deletion' }, { type: 'pull_request', parameters: { require_code_owner_review: true } }]],
    ['a non-array body', { message: 'Not Found' }],
    ['a required_status_checks rule with a malformed entry', [{ type: 'required_status_checks', parameters: { required_status_checks: [{ ctx: 'x' }] } }]],
  ])('refuses %s instead of guessing a required set', (_label, raw) => {
    const result = deriveBranchRuleset('main', raw)
    expect(result.ok).toBe(false)
  })
})

describe('fetchBoardFactsWith — ruleset acquisition', () => {
  const baseDeps = (over: Partial<BoardFetchDeps> = {}): BoardFetchDeps => ({
    queryOpenPrs: async () => ({ data: { repository: { pullRequests: { nodes: [gqlPr(1), gqlPr(2), gqlPr(3)] } } } }),
    fetchRunJobs: async () => undefined,
    checkFleetHalt: async () => ({ halted: false }),
    fetchBranchRules: async () => LIVE_MAIN_RULES,
    fetchCodeOwners: async () => `packages/crypto/ @${OWNER}\n`,
    ...over,
  })

  it('fetches the ruleset and CODEOWNERS once per invocation, not once per PR', async () => {
    const fetchBranchRules = vi.fn(async () => LIVE_MAIN_RULES)
    const fetchCodeOwners = vi.fn(async () => `packages/crypto/ @${OWNER}\n`)
    const result = await fetchBoardFactsWith(baseDeps({ fetchBranchRules, fetchCodeOwners }))
    expect(fetchBranchRules).toHaveBeenCalledTimes(1)
    expect(fetchBranchRules).toHaveBeenCalledWith('main')
    expect(fetchCodeOwners).toHaveBeenCalledTimes(1)
    expect(result.gates.main?.ruleset).toEqual({ ok: true, rules: MAIN_RULES })
  })

  it('never caches across invocations — a second board run re-reads the ruleset', async () => {
    const fetchBranchRules = vi.fn(async () => LIVE_MAIN_RULES)
    await fetchBoardFactsWith(baseDeps({ fetchBranchRules }))
    await fetchBoardFactsWith(baseDeps({ fetchBranchRules }))
    expect(fetchBranchRules).toHaveBeenCalledTimes(2)
  })

  it('a thrown ruleset read becomes an explicit failure carrying the gh detail, and the board says CANNOT_DECIDE', async () => {
    const result = await fetchBoardFactsWith(baseDeps({
      fetchBranchRules: async () => { throw new Error('exit 1: HTTP 404: Not Found') },
    }))
    expect(result.gates.main?.ruleset.ok).toBe(false)
    const view = buildBoard(result)
    expect(view.rows.every((r) => r.action === 'CANNOT_DECIDE')).toBe(true)
    expect(renderBoard(view)).toContain('HTTP 404')
    expect(renderBoard(view)).not.toContain('## MERGE')
  })

  it('a repository with no CODEOWNERS file on the base branch has no owned paths', async () => {
    const result = await fetchBoardFactsWith(baseDeps({ fetchCodeOwners: async () => null }))
    expect(result.gates.main?.codeOwners).toEqual({ ok: true, rules: [] })
  })

  it('CODEOWNERS is not read at all when the ruleset does not require code-owner review', async () => {
    const fetchCodeOwners = vi.fn(async () => '')
    const noOwners = LIVE_MAIN_RULES.map((r) => r.type === 'pull_request'
      ? { ...r, parameters: { ...r.parameters, require_code_owner_review: false } } : r)
    const result = await fetchBoardFactsWith(baseDeps({ fetchBranchRules: async () => noOwners, fetchCodeOwners }))
    expect(fetchCodeOwners).not.toHaveBeenCalled()
    expect(result.gates.main?.codeOwners).toBeUndefined()
  })
})

describe('the ruleset pull_request requirements', () => {
  const green = (): PrCheckContext[] => [...cheapPassChecks(), reviewCheck()]

  it('a human PR touching a code-owned file with no code-owner approval is REVIEW_BLOCKED, never MERGE', () => {
    const result = classify(pr({ authorLogin: 'a-human', files: ['packages/crypto/src/lib.rs'], checks: green() }))
    expect(result.action).toBe('REVIEW_BLOCKED')
    expect(result.reason).toContain('packages/crypto/src/lib.rs')
  })

  it('a code-owned file whose ONLY owner is the author can never be approved — REVIEW_BLOCKED', () => {
    const result = classify(pr({ authorLogin: OWNER, files: ['packages/crypto/src/lib.rs'], checks: green() }))
    expect(result.action).toBe('REVIEW_BLOCKED')
  })

  it('an approval from a listed code owner satisfies the requirement', () => {
    const result = classify(pr({
      authorLogin: OWNER, files: ['apps/worker/lib/auth.ts'], reviews: [{ login: 'second-owner', state: 'APPROVED' }], checks: green(),
    }))
    expect(result.action).toBe('MERGE')
  })

  it('an approval from someone who is NOT a code owner of that file does not satisfy it', () => {
    const result = classify(pr({
      authorLogin: 'a-human', files: ['packages/crypto/src/lib.rs'], reviews: [{ login: 'second-owner', state: 'APPROVED' }], checks: green(),
    }))
    expect(result.action).toBe('REVIEW_BLOCKED')
  })

  it('a PR touching only unowned files needs no code-owner approval', () => {
    expect(classify(pr({ authorLogin: OWNER, files: ['docs/x.md'], checks: green() })).action).toBe('MERGE')
  })

  it('a PR whose file list was truncated cannot be proven free of owned files — REVIEW_BLOCKED', () => {
    const result = classify(pr({ authorLogin: OWNER, files: ['docs/x.md'], changedFiles: 250, checks: green() }))
    expect(result.action).toBe('REVIEW_BLOCKED')
  })

  it('required_approving_review_count is enforced', () => {
    const gate: BranchGate = { ...GATE, ruleset: { ok: true, rules: { ...MAIN_RULES, requiredApprovingReviewCount: 1 } } }
    expect(classify(pr({ authorLogin: OWNER, checks: green() }), gate).action).toBe('REVIEW_BLOCKED')
    expect(classify(pr({ authorLogin: OWNER, checks: green(), reviews: [{ login: 'x', state: 'APPROVED' }] }), gate).action).toBe('MERGE')
  })

  it('a self-approval never counts toward required approvals', () => {
    const gate: BranchGate = { ...GATE, ruleset: { ok: true, rules: { ...MAIN_RULES, requiredApprovingReviewCount: 1 } } }
    expect(classify(pr({ authorLogin: OWNER, checks: green(), reviews: [{ login: OWNER, state: 'APPROVED' }] }), gate).action)
      .toBe('REVIEW_BLOCKED')
  })

  it('an outstanding CHANGES_REQUESTED review is REVIEW_BLOCKED even when nothing else requires review', () => {
    const result = classify(pr({ authorLogin: OWNER, checks: green(), reviews: [{ login: 'x', state: 'CHANGES_REQUESTED' }] }))
    expect(result.action).toBe('REVIEW_BLOCKED')
  })

  it('a bot PR touching a code-owned file with no approval is APPROVE_THEN_MERGE', () => {
    expect(classify(pr({ authorLogin: 'app/dependabot', files: ['packages/crypto/Cargo.toml'], checks: green() })).action)
      .toBe('APPROVE_THEN_MERGE')
  })

  it('the bot extra-approval requirement is read from the ruleset, not assumed', () => {
    const gate: BranchGate = { ...GATE, ruleset: { ok: true, rules: { ...MAIN_RULES, requireExtraApprovalForUnattributedChanges: false } } }
    expect(classify(pr({ authorLogin: 'app/dependabot', checks: green() }), gate).action).toBe('MERGE')
  })
})

describe('GitHub\'s own mergeStateStatus is the final word on MERGE', () => {
  const green = (): PrCheckContext[] => [...cheapPassChecks(), reviewCheck()]

  it('BLOCKED with every derived requirement met is OPERATOR (an unmodelled requirement), never MERGE', () => {
    const result = classify(pr({ authorLogin: OWNER, mergeStateStatus: 'BLOCKED', checks: green() }))
    expect(result.action).toBe('OPERATOR')
    expect(result.reason).toContain('BLOCKED')
  })

  it('DIRTY is NEEDS_FIX (merge conflict)', () => {
    expect(classify(pr({ authorLogin: OWNER, mergeStateStatus: 'DIRTY', checks: green() })).action).toBe('NEEDS_FIX')
  })

  it('UNKNOWN is WAITING (GitHub has not computed mergeability yet)', () => {
    expect(classify(pr({ authorLogin: OWNER, mergeStateStatus: 'UNKNOWN', checks: green() })).action).toBe('WAITING')
  })

  it.each(['CLEAN', 'UNSTABLE', 'HAS_HOOKS'])('%s permits MERGE', (state) => {
    expect(classify(pr({ authorLogin: OWNER, mergeStateStatus: state, checks: green() })).action).toBe('MERGE')
  })
})

describe('CODEOWNERS parsing and matching', () => {
  const rules = () => parseCodeOwners([
    '# comment line',
    '',
    'apps/worker/lib/auth.ts  @a',
    'packages/crypto/          @b @org/team',
    '**/*.pem                  @c',
    'packages/crypto/README.md',
  ].join('\n'))

  it('matches with gitignore semantics — the syntax GitHub parses CODEOWNERS with', () => {
    expect(codeOwnersOf(rules(), 'apps/worker/lib/auth.ts')).toEqual(['a'])
    expect(codeOwnersOf(rules(), 'apps/worker/lib/auth.tsx')).toEqual([])
    expect(codeOwnersOf(rules(), 'packages/crypto/src/lib.rs')).toEqual(['b', 'org/team'])
    expect(codeOwnersOf(rules(), 'deploy/certs/server.pem')).toEqual(['c'])
  })

  it('the last matching line wins, including a line with no owners (which un-owns the path)', () => {
    expect(codeOwnersOf(rules(), 'packages/crypto/README.md')).toEqual([])
  })

  it('a team owner is never assumed satisfied by an individual approval the board cannot verify', () => {
    const gate: BranchGate = { ...GATE, codeOwners: { ok: true, rules: parseCodeOwners('packages/crypto/ @org/team\n') } }
    const result = classify(pr({
      authorLogin: OWNER, files: ['packages/crypto/x.rs'], reviews: [{ login: 'someone', state: 'APPROVED' }],
      checks: [...cheapPassChecks(), reviewCheck()],
    }), gate)
    expect(result.action).toBe('REVIEW_BLOCKED')
  })
})

// #1092 — label-driven specialists (`fleet/review/<agent>`) are not in the
// ruleset, so the board binds them itself, ahead of the generalist verdict.
// Every case below has every REQUIRED context green, fleet/review PASS, and a
// non-bot author touching no owned path — i.e. would be MERGE without them.
describe('classifyPr: a specialist review binds at the merge decision (any FAIL fails)', () => {
  const SPECIALIST = 'fleet/review/crypto-security-reviewer'
  const green = (extra: PrCheckContext[] = [], labels: string[] = []): PrFact =>
    pr({ labels, checks: [...cheapPassChecks(), reviewCheck(), ...extra] })

  it('baseline: with no specialist at all the PR is MERGE', () => {
    expect(classify(green()).action).toBe('MERGE')
  })

  it('a FAILED specialist is NEEDS_FIX even though fleet/review PASSED', () => {
    const c = classify(green([ctx(SPECIALIST, 'FAIL')], ['crypto-security-reviewer']))
    expect(c.action).toBe('NEEDS_FIX')
    expect(c.failingContexts).toEqual([SPECIALIST])
  })

  it('a FAILED specialist still blocks after its label is removed', () => {
    expect(classify(green([ctx(SPECIALIST, 'FAIL')])).action).toBe('NEEDS_FIX')
  })

  it('a later PASS on the same head does not hide an earlier FAIL (worst of same-named runs)', () => {
    expect(classify(green([ctx(SPECIALIST, 'FAIL'), ctx(SPECIALIST, 'PASS')], ['crypto-security-reviewer'])).action)
      .toBe('NEEDS_FIX')
  })

  it('a specialist still in flight is WAITING, never MERGE', () => {
    expect(classify(green([ctx(SPECIALIST, 'PENDING')], ['crypto-security-reviewer'])).action).toBe('WAITING')
  })

  it('a specialist requested by label with no check on this head is STALE_LABEL', () => {
    const c = classify(green([], ['crypto-security-reviewer']))
    expect(c.action).toBe('STALE_LABEL')
    expect(c.reason).toContain(SPECIALIST)
  })

  it('a specialist verdict on a STALE sha does not count for the current head', () => {
    expect(classify(green([ctx(SPECIALIST, 'PASS', OTHER_SHA)], ['crypto-security-reviewer'])).action).toBe('STALE_LABEL')
  })

  it('an unknown -reviewer label\'s failing check blocks exactly like a real specialist\'s', () => {
    expect(classify(green([ctx('fleet/review/bogus-reviewer', 'FAIL')], ['bogus-reviewer'])).action).toBe('NEEDS_FIX')
  })

  it('a passing specialist lets the PR through to MERGE', () => {
    expect(classify(green([ctx(SPECIALIST, 'PASS')], ['crypto-security-reviewer'])).action).toBe('MERGE')
  })

  // GitHub does not evaluate a SKIPPED job's `name:` expression — the check
  // carries the raw expression text (observed on run 36272104112, label
  // `lane:infra`). It must stay outside the `fleet/review/` prefix.
  it('the skipped specialist job of an unrelated label never blocks, under the name GitHub really gives it', () => {
    const skippedName = "endsWith(github.event.label.name, '-reviewer') && format('fleet/review/{0}', github.event.label.name) || 'fleet-specialist/not-requested'"
    expect(classify(green([ctx(skippedName, 'PASS'), ctx('fleet-specialist/disarm-auto-merge', 'PASS')], ['lane:infra'])).action).toBe('MERGE')
  })
})
