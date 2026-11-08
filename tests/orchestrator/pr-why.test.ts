import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  diagnosePrWhy, exitCodeFor, renderPrWhy, renderPrWhyPorcelain, gatherPrWhyFacts, prStateFrom, reviewRunsFrom,
  latestReviewRun, runPrWhy, VERDICT_NAMES, liveQueueRunsFrom, queueRunsNaming, LIVE_RUN_STATUSES,
  type PrState, type PrWhyFacts, type ReviewRun, type VerdictName, type PrWhyDeps, type LiveQueueRun,
} from '../../orchestrator/src/pr-why.js'
import { diagnoseHead, defaultMissingChecksDeps, type HeadCheckRun, type HeadWorkflowRun, type MissingChecksDeps } from '../../orchestrator/src/missing-checks.js'
import type { BranchRuleset, CodeOwnerRule } from '../../orchestrator/src/board.js'
import { REVIEW_OUTCOME_ANNOTATION, reviewOutcomeFromAnnotations, type CheckRunAnnotation } from '../../orchestrator/src/ci.js'

/**
 * #2469. Every verdict has a fixture that yields it BY NAME, and a mutation
 * of that fixture that must flip it — a suite that only confirms the
 * expected verdict on the expected input cannot tell the logic is
 * load-bearing (the #2461 failure). The two #2450 incidents are pinned from
 * the PR's real captured GraphQL payload (`fixtures/pr-why/pr-2450.json`).
 *
 * The check diagnosis is never hand-written: every fixture's required-check
 * state goes through `missing-checks`'s real `diagnoseHead`, so this suite
 * exercises the composition, not a stand-in for it.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pr-why')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

/** The slice of `review-runs-*.json` (a raw REVIEW_RUNS_QUERY response) the
 *  annotation tests reach into. */
interface Review2467 { data: { repository: { object: { checkSuites: { nodes: { checkRuns: { nodes: {
  databaseId: number
  annotations: { pageInfo: { hasNextPage: boolean }; nodes: CheckRunAnnotation[] }
}[] } }[] } } } } }
const runNodes = (raw: Review2467) => raw.data.repository.object.checkSuites.nodes.flatMap((s) => s.checkRuns.nodes)

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const OWNER = 'rhonda-rodododo'

const RULES: BranchRuleset = {
  branch: 'main',
  requiredContexts: ['ci-status', 'fleet/review'],
  requireCodeOwnerReview: true,
  requiredApprovingReviewCount: 0,
  requireExtraApprovalForUnattributedChanges: false,
}
const OWNERS: CodeOwnerRule[] = [{ pattern: 'packages/crypto/', owners: [OWNER] }]
const OWNED_FILE = 'packages/crypto/src/hpke.rs'

const run = (over: Partial<HeadCheckRun> & { name: string; id: number }): HeadCheckRun => ({
  status: 'completed', conclusion: 'success', appSlug: 'github-actions', startedAt: '2026-11-05T10:00:00Z', ...over,
})
const REVIEW_ID = 900
const greenRuns = (): HeadCheckRun[] => [run({ name: 'ci-status', id: 100 }), run({ name: 'fleet/review', id: REVIEW_ID })]
const settledRuns: HeadWorkflowRun[] = [{ id: 1, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', runAttempt: 1 }]

function head(checkRuns: HeadCheckRun[], runs: HeadWorkflowRun[] = settledRuns) {
  return diagnoseHead({ sha: SHA, baseRef: 'main', requiredContexts: RULES.requiredContexts, checkRuns, statuses: [], runs, jobsByRun: new Map() })
}

const reviewRun = (over: Partial<ReviewRun> = {}): ReviewRun => ({
  id: REVIEW_ID, status: 'completed', conclusion: 'success', startedAt: '2026-11-05T10:00:00Z',
  outcome: { read: true, message: 'PASS:reviewed — every reviewer read this diff and passed it' }, ...over,
})

function prState(over: Partial<PrState> = {}): PrState {
  return {
    number: 4242, state: 'OPEN', isDraft: false, headRefOid: SHA, headRefName: 'feat/x', baseRefName: 'main',
    mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE', authorLogin: 'llamenos-auto', labels: [],
    autoMergeRequest: null, mergeQueueEntry: null, isInMergeQueue: false,
    reviews: [], reviewRequests: [], changedFiles: 1, ...over,
  }
}

const ARMED = { enabledAt: '2026-11-04T12:00:00Z', mergeMethod: 'SQUASH', enabledBy: 'llamenos-auto' }
const QUEUED = { state: 'QUEUED', position: 2, enqueuedAt: '2026-11-05T11:00:00Z' }

function facts(over: Partial<Omit<PrWhyFacts, 'state'>> & { state?: Partial<PrState> } = {}): PrWhyFacts {
  const { state, ...rest } = over
  const s = prState(state)
  return {
    pr: 4242,
    state: { ok: true, value: s },
    ruleset: { ok: true, value: RULES },
    codeOwners: { ok: true, value: OWNERS },
    files: { ok: true, value: [OWNED_FILE] },
    checks: { ok: true, value: head(greenRuns()) },
    reviewRuns: { ok: true, value: [reviewRun()] },
    queueRuns: { ok: true, value: [] },
    headAfter: { ok: true, value: s.headRefOid },
    ...rest,
  }
}

const approvedByOwner = { reviews: [{ login: OWNER, state: 'APPROVED', submittedAt: '2026-11-05T09:00:00Z' }] }
const names = (f: PrWhyFacts): VerdictName[] => diagnosePrWhy(f).verdicts.map((v) => v.name)

// ---------------------------------------------------------------------------
// The two #2450 incidents, from the PR's real payload
// ---------------------------------------------------------------------------

/** #2450 changed 8 files; the list handed in must be complete or the
 *  code-owner answer is (correctly) unknown. One of them is owned. */
const FILES_2450 = [OWNED_FILE, ...Array.from({ length: 7 }, (_, i) => `knope/file-${i}.md`)]
const facts2450 = (state: PrState): PrWhyFacts => facts({ state, files: { ok: true, value: FILES_2450 } })

/** pr-2450.json as captured, re-shaped into the state each incident was in. */
function pr2450(edit: (p: Record<string, unknown>) => void): PrState {
  const raw = structuredClone(fixture('pr-2450.json')) as { data: { repository: { pullRequest: Record<string, unknown> } } }
  edit(raw.data.repository.pullRequest)
  return prStateFrom(raw, 2450)
}

describe('#2450 incident 1 — an approved PR whose reviewDecision is "" is not codeowner-approval-missing', () => {
  // The captured payload carries rhonda-rodododo's APPROVED review. Put the
  // PR back into the BLOCKED, un-queued state it was diagnosed in, with the
  // `reviewDecision: ""` GitHub reports under a zero-count ruleset added to
  // the raw body — the field that was misread.
  const blocked = (p: Record<string, unknown>) => {
    p['mergeStateStatus'] = 'BLOCKED'
    p['isInMergeQueue'] = false
    p['mergeQueueEntry'] = null
    p['reviewDecision'] = ''
  }

  it('the payload really is approved by the code owner, and reviewDecision really is ""', () => {
    const raw = structuredClone(fixture('pr-2450.json')) as { data: { repository: { pullRequest: Record<string, unknown> } } }
    blocked(raw.data.repository.pullRequest)
    expect(raw.data.repository.pullRequest['reviewDecision']).toBe('')
    expect(prStateFrom(raw, 2450).reviews).toEqual([{ login: OWNER, state: 'APPROVED', submittedAt: '2026-11-05T14:48:50Z' }])
  })

  it('does NOT yield codeowner-approval-missing', () => {
    const f = facts2450(pr2450(blocked))
    expect(names(f)).not.toContain('codeowner-approval-missing')
  })

  it('flips: the same PR with the owner\'s approval removed DOES yield it', () => {
    const f = facts2450(pr2450((p) => { blocked(p); p['latestOpinionatedReviews'] = { nodes: [] } }))
    expect(names(f)).toContain('codeowner-approval-missing')
  })

  it('flips: an approval from someone who does not own the path does not count', () => {
    const f = facts2450(pr2450((p) => {
      blocked(p)
      p['latestOpinionatedReviews'] = { nodes: [{ author: { login: 'someone-else' }, state: 'APPROVED', submittedAt: '2026-11-05T14:48:50Z' }] }
    }))
    expect(names(f)).toContain('codeowner-approval-missing')
  })

  it('reviewDecision cannot change the verdict in either direction — it is not part of PrState at all', () => {
    for (const rd of ['', 'APPROVED', 'REVIEW_REQUIRED', null]) {
      const approved = facts2450(pr2450((p) => { blocked(p); p['reviewDecision'] = rd }))
      const unapproved = facts2450(pr2450((p) => { blocked(p); p['reviewDecision'] = rd; p['latestOpinionatedReviews'] = { nodes: [] } }))
      expect(names(approved), String(rd)).not.toContain('codeowner-approval-missing')
      expect(names(unapproved), String(rd)).toContain('codeowner-approval-missing')
    }
    expect(Object.keys(pr2450(blocked))).not.toContain('reviewDecision')
  })
})

describe('#2450 incident 2 — CLEAN + armed auto-merge + not queued is automerge-stale', () => {
  const stale = (p: Record<string, unknown>) => {
    p['mergeStateStatus'] = 'CLEAN'
    p['isInMergeQueue'] = false
    p['mergeQueueEntry'] = null
    p['autoMergeRequest'] = { enabledAt: '2026-11-04T15:00:00Z', mergeMethod: 'SQUASH', enabledBy: { login: 'llamenos-auto' } }
  }

  it('yields automerge-stale, with the disable → confirm → re-arm remedy', () => {
    const r = diagnosePrWhy(facts2450(pr2450(stale)))
    expect(r.verdicts[0]?.name).toBe('automerge-stale')
    expect(r.verdicts[0]?.remedy).toContain('--disable-auto')
    expect(r.verdicts[0]?.remedy).toContain('autoMergeRequest')
    expect(exitCodeFor(r)).toBe(1)
  })

  it('flips: once the PR is actually in the queue it is queued-ok, however autoMergeRequest reads', () => {
    for (const amr of [null, { enabledAt: 'x', mergeMethod: 'SQUASH', enabledBy: { login: 'y' } }]) {
      const f = facts2450(pr2450((p) => { stale(p); p['autoMergeRequest'] = amr; p['isInMergeQueue'] = true; p['mergeQueueEntry'] = QUEUED }))
      expect(names(f)).toEqual(['queued-ok'])
    }
  })

  it('flips: with no request armed the same CLEAN PR is not-queued, never automerge-stale', () => {
    const f = facts2450(pr2450((p) => { stale(p); p['autoMergeRequest'] = null }))
    expect(names(f)).toEqual(['not-queued'])
  })

  it('flips: an armed request on a BLOCKED PR is not stale — it is waiting for the block to clear', () => {
    const f = facts2450(pr2450((p) => { stale(p); p['mergeStateStatus'] = 'BLOCKED' }))
    expect(names(f)).not.toContain('automerge-stale')
  })
})

// ---------------------------------------------------------------------------
// One fixture per verdict, and the mutation that flips it
// ---------------------------------------------------------------------------

/** Every verdict this file produces by name, collected so the last test can
 *  prove there is no verdict without a fixture. */
const produced = new Set<VerdictName>()
function expectVerdict(f: PrWhyFacts, name: VerdictName): ReturnType<typeof diagnosePrWhy> {
  const r = diagnosePrWhy(f)
  expect(r.verdicts.map((v) => v.name)).toContain(name)
  produced.add(name)
  return r
}

describe('codeowner-approval-missing', () => {
  it('BLOCKED, every required check green, an owned path with no owner approval', () => {
    const r = expectVerdict(facts(), 'codeowner-approval-missing')
    expect(r.verdicts.map((v) => v.name)).toEqual(['codeowner-approval-missing'])
    expect(exitCodeFor(r)).toBe(1)
  })
  it('flips: the owner approves → gone (and a BLOCKED PR with nothing found is blocked-unexplained, never clean)', () => {
    expect(names(facts({ state: approvedByOwner }))).toEqual(['blocked-unexplained'])
  })
  it('flips: the owner is the author — self-approval never counts', () => {
    expect(names(facts({ state: { ...approvedByOwner, authorLogin: OWNER } }))).toContain('codeowner-approval-missing')
  })
  it('flips: the path is not owned → gone', () => {
    expect(names(facts({ files: { ok: true, value: ['README.md'] } }))).not.toContain('codeowner-approval-missing')
  })
  it('flips: the ruleset stops requiring code-owner review → gone', () => {
    expect(names(facts({ ruleset: { ok: true, value: { ...RULES, requireCodeOwnerReview: false } } }))).not.toContain('codeowner-approval-missing')
  })
  it('a team owner is never assumed approved', () => {
    const f = facts({ codeOwners: { ok: true, value: [{ pattern: 'packages/crypto/', owners: ['org/crypto'] }] }, state: approvedByOwner })
    expect(names(f)).toContain('codeowner-approval-missing')
  })
  it('a truncated file list is unknown, never "no owned path"', () => {
    const r = expectVerdict(facts({ files: { ok: true, value: ['README.md'] }, state: { changedFiles: 2 } }), 'unknown')
    expect(exitCodeFor(r)).toBe(2)
  })
  it('unreadable CODEOWNERS is unknown', () => {
    expect(exitCodeFor(expectVerdict(facts({ codeOwners: { ok: false, reason: 'HTTP 502' } }), 'unknown'))).toBe(2)
  })
})

describe('automerge-stale / not-queued', () => {
  it('automerge-stale: CLEAN + armed + absent from the queue', () => {
    expectVerdict(facts({ state: { mergeStateStatus: 'CLEAN', autoMergeRequest: ARMED } }), 'automerge-stale')
  })
  it('UNSTABLE and HAS_HOOKS are mergeable states too', () => {
    for (const m of ['UNSTABLE', 'HAS_HOOKS']) {
      expect(names(facts({ state: { mergeStateStatus: m, autoMergeRequest: ARMED } })), m).toEqual(['automerge-stale'])
    }
  })
  it('not-queued: CLEAN, nothing armed, absent from the queue', () => {
    const r = expectVerdict(facts({ state: { mergeStateStatus: 'CLEAN' } }), 'not-queued')
    expect(r.verdicts[0]?.remedy).toContain('--auto')
  })
  it('flips: arming it turns not-queued into automerge-stale', () => {
    expect(names(facts({ state: { mergeStateStatus: 'CLEAN', autoMergeRequest: ARMED } }))).not.toContain('not-queued')
  })
})

describe('queued-ok / queued-unmergeable', () => {
  it('queued-ok: in the queue (auto-merge consumed) — exit 0', () => {
    const r = expectVerdict(facts({ state: { mergeStateStatus: 'BLOCKED', mergeQueueEntry: QUEUED, isInMergeQueue: true } }), 'queued-ok')
    expect(exitCodeFor(r)).toBe(0)
  })
  it('membership beats every other signal: a queued PR with a BLOCKED merge state and a red check is still queued-ok', () => {
    const f = facts({ state: { mergeQueueEntry: QUEUED, isInMergeQueue: true }, checks: { ok: true, value: head([run({ name: 'ci-status', id: 100, conclusion: 'failure' })]) } })
    expect(names(f)).toEqual(['queued-ok'])
  })
  it('flips: the entry goes UNMERGEABLE → queued-unmergeable', () => {
    const r = expectVerdict(facts({ state: { mergeQueueEntry: { ...QUEUED, state: 'UNMERGEABLE' }, isInMergeQueue: true } }), 'queued-unmergeable')
    expect(r.verdicts.map((v) => v.name)).not.toContain('queued-ok')
    expect(exitCodeFor(r)).toBe(1)
  })
  it('flips: the entry disappears → not queued-ok', () => {
    expect(names(facts({ state: { mergeStateStatus: 'CLEAN' } }))).not.toContain('queued-ok')
  })
  it('the two membership fields disagreeing is unknown, never a guess either way', () => {
    expect(exitCodeFor(expectVerdict(facts({ state: { mergeQueueEntry: QUEUED, isInMergeQueue: false } }), 'unknown'))).toBe(2)
    expect(names(facts({ state: { mergeQueueEntry: null, isInMergeQueue: true } }))).toEqual(['unknown'])
  })
})

describe('required-context-absent — delegated to missing-checks', () => {
  const noCi = () => head([run({ name: 'fleet/review', id: REVIEW_ID })])
  it('a required context with no carrier, every run settled', () => {
    const r = expectVerdict(facts({ state: approvedByOwner, checks: { ok: true, value: noCi() } }), 'required-context-absent')
    expect(r.verdicts[0]?.evidence.join(' ')).toContain('ci-status')
    expect(r.verdicts[0]?.remedy).toContain('missing-checks --pr 4242')
  })
  it('flips: a run still in flight makes it required-check-pending instead', () => {
    const inFlight: HeadWorkflowRun[] = [{ id: 1, name: 'CI', event: 'pull_request', status: 'in_progress', conclusion: null, runAttempt: 1 }]
    const f = facts({ state: approvedByOwner, checks: { ok: true, value: head([run({ name: 'fleet/review', id: REVIEW_ID })], inFlight) } })
    expect(names(f)).toEqual(['required-check-pending'])
    produced.add('required-check-pending')
  })
  it('flips: the context posts → gone', () => {
    expect(names(facts({ state: approvedByOwner }))).not.toContain('required-context-absent')
  })
  it('a dropped-job run is the same verdict', () => {
    const d = diagnoseHead({
      sha: SHA, baseRef: 'main', requiredContexts: RULES.requiredContexts, checkRuns: greenRuns(), statuses: [],
      runs: [{ id: 7, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'failure', runAttempt: 1 }],
      jobsByRun: new Map([[7, [{ name: 'lint', conclusion: 'success' }]]]),
    })
    expect(names(facts({ state: approvedByOwner, checks: { ok: true, value: d } }))).toEqual(['required-context-absent'])
  })
})

describe('fleet/review verdicts — read from the outcome annotation, not output.title', () => {
  const redReview = (outcome: string | undefined, over: Partial<ReviewRun> = {}): Pick<PrWhyFacts, 'checks' | 'reviewRuns'> => ({
    checks: { ok: true, value: head([run({ name: 'ci-status', id: 100 }), run({ name: 'fleet/review', id: REVIEW_ID, conclusion: 'failure' })]) },
    reviewRuns: { ok: true, value: [reviewRun({ conclusion: 'failure', outcome: { read: true, message: outcome }, ...over })] },
  })
  it('review-verdict-stale-by-tree: NO-VERDICT:tree-changed', () => {
    const r = expectVerdict(facts({ state: approvedByOwner, ...redReview('NO-VERDICT:tree-changed — the last PASS judged another tree') }), 'review-verdict-stale-by-tree')
    expect(r.verdicts[0]?.remedy).toContain('REQUEST')
    expect(r.verdicts[0]?.remedy).toContain('gh run rerun only re-executes the cache lookup')
  })
  it('flips: a REJECTED outcome is required-check-failing, not stale-by-tree', () => {
    const f = facts({ state: approvedByOwner, ...redReview('REJECTED:reviewed — a reviewer rejected it') })
    expect(names(f)).toEqual(['required-check-failing'])
    produced.add('required-check-failing')
  })
  // #2559: a held trust-anchor change names the sign-off remedy, never
  // "act on the cause" — and is still a blocker.
  it('review-awaits-trust-approval: NO-VERDICT:sign-off-pending', () => {
    const r = expectVerdict(facts({ state: approvedByOwner, ...redReview('NO-VERDICT:sign-off-pending — the diff changes a shipped client\'s TLS trust anchors') }), 'review-awaits-trust-approval')
    expect(r.verdicts[0]?.severity).toBe('blocker')
    expect(r.verdicts[0]?.remedy).toContain('signs off on head')
    expect(r.verdicts[0]?.remedy).not.toContain('a NO-VERDICT is not a rejection')
  })
  it('flips: NO-VERDICT:scope stays required-check-failing, not review-awaits-trust-approval', () => {
    expect(names(facts({ state: approvedByOwner, ...redReview('NO-VERDICT:scope — outside the lane') }))).toEqual(['required-check-failing'])
  })
  it('review-never-requested: NO-VERDICT:unreviewed with nobody requested', () => {
    expectVerdict(facts({ state: approvedByOwner, ...redReview('NO-VERDICT:unreviewed — no review has ever been earned') }), 'review-never-requested')
  })
  it('review-never-requested: fleet/review absent on a settled head with nobody requested', () => {
    const noReview = head([run({ name: 'ci-status', id: 100 })])
    expect(names(facts({ state: approvedByOwner, checks: { ok: true, value: noReview } }))).toEqual(['review-never-requested'])
    // flips: once somebody is requested the absence is a plain absent context
    expect(names(facts({ state: { ...approvedByOwner, reviewRequests: ['llamenos-auto'] }, checks: { ok: true, value: noReview } }))).toEqual(['required-context-absent'])
  })
  it('flips: a reviewer is already requested → not review-never-requested', () => {
    const f = facts({ state: { ...approvedByOwner, reviewRequests: ['llamenos-auto'] }, ...redReview('NO-VERDICT:unreviewed — x') })
    expect(names(f)).toEqual(['required-check-failing'])
  })
  it('the annotation read naming a different newest run than the check read is unknown (the head is moving)', () => {
    const f = facts({ state: approvedByOwner, ...redReview('NO-VERDICT:tree-changed — x', { id: REVIEW_ID + 1 }) })
    expect(names(f)).toEqual(['unknown'])
  })
  it('an unreadable annotation read is unknown when the review is red', () => {
    const f = facts({ state: approvedByOwner, ...redReview('x'), reviewRuns: { ok: false, reason: 'HTTP 502' } })
    expect(exitCodeFor(diagnosePrWhy(f))).toBe(2)
  })
  it('an outcome the reader could not decide (read: false) is unknown; a read that found none is an unnamed failure', () => {
    const undecided = facts({ state: approvedByOwner, ...redReview(undefined, { outcome: { read: false, detail: 'cut off' } }) })
    expect(names(undecided)).toEqual(['unknown'])
    expect(exitCodeFor(diagnosePrWhy(undecided))).toBe(2)
    expect(names(facts({ state: approvedByOwner, ...redReview(undefined) }))).toEqual(['required-check-failing'])
  })
  it('latestReviewRun orders by startedAt, id breaking ties — never list order', () => {
    const a = reviewRun({ id: 1, startedAt: '2026-11-05T10:00:02Z' })
    const b = reviewRun({ id: 2, startedAt: '2026-11-05T10:00:01Z' })
    const c = reviewRun({ id: 3, startedAt: '2026-11-05T10:00:02Z' })
    expect(latestReviewRun([a, b, c])?.id).toBe(3)
    expect(latestReviewRun([c, b, a])?.id).toBe(3)
  })
})

describe('required-check-failing / required-check-pending', () => {
  it('a red required context other than fleet/review', () => {
    const f = facts({ state: approvedByOwner, checks: { ok: true, value: head([run({ name: 'ci-status', id: 100, conclusion: 'failure' }), run({ name: 'fleet/review', id: REVIEW_ID })]) } })
    const r = expectVerdict(f, 'required-check-failing')
    expect(r.verdicts[0]?.evidence.join(' ')).toContain('ci-status')
  })
  it('flips: a later same-app success supersedes the red run → gone', () => {
    const f = facts({ state: approvedByOwner, checks: { ok: true, value: head([
      run({ name: 'ci-status', id: 100, conclusion: 'failure', startedAt: '2026-11-05T09:00:00Z' }),
      run({ name: 'ci-status', id: 101 }),
      run({ name: 'fleet/review', id: REVIEW_ID }),
    ]) } })
    expect(names(f)).not.toContain('required-check-failing')
  })
  it('pending: a required check in flight', () => {
    const f = facts({ state: approvedByOwner, checks: { ok: true, value: head([run({ name: 'ci-status', id: 100, status: 'in_progress', conclusion: null }), run({ name: 'fleet/review', id: REVIEW_ID })]) } })
    expectVerdict(f, 'required-check-pending')
  })
})

describe('fleet-queue-guard-unsatisfied', () => {
  const fleet = { headRefName: 'fleet/backend/2469', mergeStateStatus: 'CLEAN', autoMergeRequest: ARMED }
  it('a fleet/* head without queue-cleared', () => {
    expectVerdict(facts({ state: fleet }), 'fleet-queue-guard-unsatisfied')
  })
  it('also on a queued fleet PR — the guard runs on the merge_group entry', () => {
    expect(names(facts({ state: { ...fleet, autoMergeRequest: null, mergeQueueEntry: QUEUED, isInMergeQueue: true } }))).toEqual(['queued-ok', 'fleet-queue-guard-unsatisfied'])
  })
  it('flips: the label is present → gone', () => {
    expect(names(facts({ state: { ...fleet, labels: ['queue-cleared'] } }))).not.toContain('fleet-queue-guard-unsatisfied')
  })
  it('flips: a label merely containing the string is not it', () => {
    expect(names(facts({ state: { ...fleet, labels: ['queue-clearedx'] } }))).toContain('fleet-queue-guard-unsatisfied')
  })
  it('flips: a non-fleet head → gone', () => {
    expect(names(facts({ state: { ...fleet, headRefName: 'fleet-backend-2469' } }))).not.toContain('fleet-queue-guard-unsatisfied')
  })
})

describe('check-carrier-ambiguous', () => {
  const twoReviews = () => head([
    run({ name: 'ci-status', id: 100 }),
    run({ name: 'fleet/review', id: REVIEW_ID - 1, conclusion: 'failure', startedAt: '2026-11-05T09:00:00Z' }),
    run({ name: 'fleet/review', id: REVIEW_ID }),
  ])
  it('two runs share a name on one head: names both and the latest by started_at', () => {
    const r = expectVerdict(facts({ state: { mergeStateStatus: 'CLEAN' }, checks: { ok: true, value: twoReviews() } }), 'check-carrier-ambiguous')
    const v = r.verdicts.find((x) => x.name === 'check-carrier-ambiguous')
    expect(v?.severity).toBe('note')
    expect(v?.evidence[0]).toContain(`#${REVIEW_ID - 1} (superseded)`)
    expect(v?.evidence[0]).toContain(`#${REVIEW_ID} (counted)`)
    expect(v?.evidence[1]).toContain(`latest by started_at: github-actions=success@2026-11-05T10:00:00Z#${REVIEW_ID}`)
  })
  it('a note never changes the exit code on its own', () => {
    expect(exitCodeFor(diagnosePrWhy(facts({ state: { mergeQueueEntry: QUEUED, isInMergeQueue: true }, checks: { ok: true, value: twoReviews() } })))).toBe(0)
  })
  it('flips: one carrier → gone', () => {
    expect(names(facts({ state: { mergeStateStatus: 'CLEAN' } }))).not.toContain('check-carrier-ambiguous')
  })
})

describe('head-moved', () => {
  it('the head re-read last differs from the head diagnosed — exit 2', () => {
    const r = expectVerdict(facts({ headAfter: { ok: true, value: OTHER_SHA } }), 'head-moved')
    expect(r.verdicts[0]?.name).toBe('head-moved')
    expect(exitCodeFor(r)).toBe(2)
  })
  it('flips: same head → gone', () => {
    expect(names(facts())).not.toContain('head-moved')
  })
  it('an unreadable re-read is unknown, not "unmoved"', () => {
    expect(names(facts({ headAfter: { ok: false, reason: 'HTTP 502' } }))).toContain('unknown')
  })
})

describe('the remaining states each have a name', () => {
  it('merged (exit 0) / closed (exit 1)', () => {
    expect(exitCodeFor(expectVerdict(facts({ state: { state: 'MERGED' } }), 'merged'))).toBe(0)
    expect(exitCodeFor(expectVerdict(facts({ state: { state: 'CLOSED' } }), 'closed'))).toBe(1)
  })
  it('conflicted: DIRTY or CONFLICTING — and nothing derived from frozen checks', () => {
    expect(names(facts({ state: { mergeStateStatus: 'DIRTY' } }))).toEqual(['conflicted'])
    expectVerdict(facts({ state: { mergeable: 'CONFLICTING' } }), 'conflicted')
    expect(names(facts({ state: { mergeable: 'MERGEABLE' } }))).not.toContain('conflicted')
  })
  it('draft', () => {
    expectVerdict(facts({ state: { isDraft: true } }), 'draft')
    expect(names(facts({ state: { isDraft: false } }))).not.toContain('draft')
  })
  it('behind', () => {
    expectVerdict(facts({ state: { ...approvedByOwner, mergeStateStatus: 'BEHIND' } }), 'behind')
  })
  it('changes-requested — and it is not hidden by an owner\'s earlier approval elsewhere', () => {
    const f = facts({ state: { reviews: [{ login: OWNER, state: 'APPROVED', submittedAt: 'x' }, { login: 'other', state: 'CHANGES_REQUESTED', submittedAt: 'y' }] } })
    expect(expectVerdict(f, 'changes-requested').verdicts.map((v) => v.name)).toEqual(['changes-requested'])
  })
  it('approvals-missing: a non-zero required count', () => {
    const f = facts({ state: approvedByOwner, ruleset: { ok: true, value: { ...RULES, requiredApprovingReviewCount: 2 } } })
    expect(expectVerdict(f, 'approvals-missing').verdicts[0]?.evidence[0]).toContain('1 of 2')
    expect(names(facts({ state: approvedByOwner, ruleset: { ok: true, value: { ...RULES, requiredApprovingReviewCount: 1 } } }))).not.toContain('approvals-missing')
  })
  it('blocked-unexplained: BLOCKED with nothing modelled owed is exit 2, never clean', () => {
    const r = expectVerdict(facts({ state: approvedByOwner }), 'blocked-unexplained')
    expect(exitCodeFor(r)).toBe(2)
  })
  it('mergeStateStatus UNKNOWN is unknown', () => {
    expect(exitCodeFor(expectVerdict(facts({ state: { ...approvedByOwner, mergeStateStatus: 'UNKNOWN' } }), 'unknown'))).toBe(2)
  })
  it('an unreadable PR is a single unknown verdict naming it', () => {
    const r = diagnosePrWhy({ ...facts(), state: { ok: false, reason: 'HTTP 502: Bad Gateway' } })
    expect(r.verdicts).toHaveLength(1)
    expect(r.verdicts[0]?.evidence[0]).toContain('HTTP 502')
    expect(exitCodeFor(r)).toBe(2)
  })
  it('every verdict name has a fixture in this file', () => {
    expect([...produced].sort()).toEqual([...VERDICT_NAMES].sort())
  })
})

// ---------------------------------------------------------------------------
// Two verdicts at once, rendered
// ---------------------------------------------------------------------------

describe('rendering', () => {
  it('a PR with two simultaneous blockers lists both, ranked, with evidence and remedy', () => {
    const r = diagnosePrWhy(facts({ state: { headRefName: 'fleet/backend/2469', mergeStateStatus: 'CLEAN', autoMergeRequest: ARMED } }))
    const text = renderPrWhy(r)
    expect(text.indexOf('1. automerge-stale  [BLOCKER]')).toBeGreaterThan(0)
    expect(text.indexOf('2. fleet-queue-guard-unsatisfied  [BLOCKER]')).toBeGreaterThan(text.indexOf('1. automerge-stale'))
    expect(text).toContain('result: BLOCKED — 2 blocker(s) (exit 1)')
    expect(renderPrWhyPorcelain(r)).toBe('4242|automerge-stale|blocker\n4242|fleet-queue-guard-unsatisfied|blocker')
  })
  it('an unknown outranks everything and the result line says what could not be observed', () => {
    const text = renderPrWhy(diagnosePrWhy(facts({ codeOwners: { ok: false, reason: 'HTTP 502' } })))
    expect(text).toContain('1. unknown  [UNKNOWN]')
    expect(text).toContain('could not observe CODEOWNERS on main: HTTP 502')
    expect(text).toContain('result: UNKNOWN')
  })
})

// ---------------------------------------------------------------------------
// #2480: a building group is absent from the entry fields
// ---------------------------------------------------------------------------

/** The live shape observed 2026-11-05 ~17:20Z: #2472's group building, its
 *  PR OPEN/CLEAN, auto-merge consumed, and NO entry on GitHub's queue fields. */
const BASE_SHA = 'c7a6f2b0161d54b8d14080263c6c71daaf233955'
const groupRun = (pr: number, over: Partial<LiveQueueRun> = {}): LiveQueueRun => ({
  id: 42073399205, name: 'CI', status: 'in_progress', headBranch: `gh-readonly-queue/main/pr-${pr}-${BASE_SHA}`, ...over,
})
const buildingNoEntry = { mergeStateStatus: 'CLEAN', autoMergeRequest: null, mergeQueueEntry: null, isInMergeQueue: false }

describe('queue membership is the union of the entry and a live group run (#2480)', () => {
  it('no entry + a live gh-readonly-queue/main/pr-<N>-<sha> run → queued-ok, exit 0', () => {
    const r = expectVerdict(facts({ state: buildingNoEntry, queueRuns: { ok: true, value: [groupRun(4242)] } }), 'queued-ok')
    expect(r.verdicts.map((v) => v.name)).toEqual(['queued-ok'])
    expect(r.verdicts[0]?.evidence.join('\n')).toContain(`run 42073399205 (CI) in_progress on gh-readonly-queue/main/pr-4242-${BASE_SHA}`)
    expect(r.verdicts[0]?.remedy).toContain('do NOT re-queue')
    expect(r.summary?.queue).toContain('building')
    expect(exitCodeFor(r)).toBe(0)
  })
  it('flips: remove the run → not-queued', () => {
    expect(names(facts({ state: buildingNoEntry, queueRuns: { ok: true, value: [] } }))).toEqual(['not-queued'])
  })
  it('flips: an armed request with neither probe positive → automerge-stale; with a live run it is still queued-ok', () => {
    expect(names(facts({ state: { ...buildingNoEntry, autoMergeRequest: ARMED } }))).toEqual(['automerge-stale'])
    expect(names(facts({ state: { ...buildingNoEntry, autoMergeRequest: ARMED }, queueRuns: { ok: true, value: [groupRun(4242)] } }))).toEqual(['queued-ok'])
  })
  it('a queued-not-yet-built entry (no run) is still queued-ok on the entry alone', () => {
    expect(names(facts({ state: { mergeStateStatus: 'CLEAN', mergeQueueEntry: QUEUED, isInMergeQueue: true }, queueRuns: { ok: true, value: [] } }))).toEqual(['queued-ok'])
  })
  it('a live group run beats a BLOCKED merge state and a red head check, exactly as an entry does', () => {
    const f = facts({
      state: { mergeQueueEntry: null, isInMergeQueue: false },
      queueRuns: { ok: true, value: [groupRun(4242)] },
      checks: { ok: true, value: head([run({ name: 'ci-status', id: 100, conclusion: 'failure' })]) },
    })
    expect(names(f)).toEqual(['queued-ok'])
  })
  it('a live run settles the two entry fields disagreeing', () => {
    expect(names(facts({ state: { mergeQueueEntry: null, isInMergeQueue: true }, queueRuns: { ok: true, value: [groupRun(4242)] } }))).toEqual(['queued-ok'])
  })
  it('a failed run probe with no entry is unknown — NEVER not-queued or automerge-stale', () => {
    for (const autoMergeRequest of [null, ARMED]) {
      const r = expectVerdict(facts({ state: { ...buildingNoEntry, autoMergeRequest }, queueRuns: { ok: false, reason: 'HTTP 502: Bad Gateway' } }), 'unknown')
      expect(r.verdicts.map((v) => v.name)).toEqual(['unknown'])
      expect(r.verdicts[0]?.evidence[0]).toContain('HTTP 502')
      expect(exitCodeFor(r)).toBe(2)
    }
  })
  it('a failed run probe is irrelevant when the entry is present — membership is already proven', () => {
    expect(names(facts({ state: { mergeQueueEntry: QUEUED, isInMergeQueue: true }, queueRuns: { ok: false, reason: 'HTTP 502' } }))).toEqual(['queued-ok'])
  })
  it('a failed run probe on a BLOCKED PR is unknown, and the head\'s own blockers are still reported', () => {
    const r = diagnosePrWhy(facts({ queueRuns: { ok: false, reason: 'HTTP 502' } }))
    expect(r.verdicts.map((v) => v.name)).toEqual(['unknown', 'codeowner-approval-missing'])
    expect(exitCodeFor(r)).toBe(2)
  })
  it('the header names an unreadable probe only on an open PR — a merged PR\'s probe is skipped, not failed', () => {
    expect(diagnosePrWhy(facts({ state: buildingNoEntry, queueRuns: { ok: false, reason: 'HTTP 502' } })).summary?.queue).toContain('unreadable')
    expect(diagnosePrWhy(facts({ state: { state: 'MERGED' }, queueRuns: { ok: false, reason: 'not read' } })).summary?.queue).toBe('absent')
  })
  it('the entry fields disagreeing with a failed run probe is unknown', () => {
    expect(names(facts({ state: { mergeQueueEntry: null, isInMergeQueue: true }, queueRuns: { ok: false, reason: 'HTTP 502' } }))).toEqual(['unknown'])
  })
})

describe('queueRunsNaming', () => {
  const runs = [
    groupRun(2472),
    groupRun(2467, { id: 42073545442, status: 'queued' }),
    groupRun(24720, { id: 3 }),
    groupRun(247, { id: 4 }),
    { id: 5, name: 'CI', status: 'in_progress', headBranch: `gh-readonly-queue/release/pr-2472-${BASE_SHA}` },
    { id: 6, name: 'CI', status: 'in_progress', headBranch: `gh-readonly-queue/main/${BASE_SHA}` },
    { id: 7, name: 'CI', status: 'in_progress', headBranch: 'feat/pr-2472' },
  ]
  it('picks only the runs whose queue branch names this PR on this base', () => {
    expect(queueRunsNaming(runs, 'main', 2472).map((r) => r.id)).toEqual([42073399205])
    expect(queueRunsNaming(runs, 'main', 2467).map((r) => r.id)).toEqual([42073545442])
    expect(queueRunsNaming(runs, 'release', 2472).map((r) => r.id)).toEqual([5])
    expect(queueRunsNaming(runs, 'main', 9999)).toEqual([])
  })
})

describe('liveQueueRunsFrom', () => {
  const page = (total: number, n: number) => ({
    total_count: total,
    workflow_runs: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: 'CI', status: 'in_progress', head_branch: `gh-readonly-queue/main/pr-${i + 1}-${BASE_SHA}` })),
  })
  it('parses a complete page', () => {
    expect(liveQueueRunsFrom(page(2, 2), 'in_progress').map((r) => r.headBranch)).toEqual([
      `gh-readonly-queue/main/pr-1-${BASE_SHA}`, `gh-readonly-queue/main/pr-2-${BASE_SHA}`,
    ])
  })
  it('throws on a truncated page — a live run on an unread page is not "no run"', () => {
    expect(() => liveQueueRunsFrom(page(101, 100), 'queued')).toThrow('may be unread')
  })
  it('throws on a body that is not a run page, or a run missing its branch', () => {
    expect(() => liveQueueRunsFrom({ message: 'Server Error' }, 'queued')).toThrow('did not return a run page')
    expect(() => liveQueueRunsFrom({ total_count: 1, workflow_runs: [{ id: 1, status: 'queued' }] }, 'queued')).toThrow('without id/head_branch/status')
  })
  it('covers every non-terminal status GitHub reports, in lifecycle order', () => {
    expect(LIVE_RUN_STATUSES).toEqual(['requested', 'waiting', 'pending', 'queued', 'in_progress'])
  })
})

// ---------------------------------------------------------------------------
// Gathering: a failed read is unknown, never a verdict about nothing
// ---------------------------------------------------------------------------

function fakeDeps(over: Partial<PrWhyDeps> = {}, checks: Partial<MissingChecksDeps> = {}): PrWhyDeps {
  const rulesBody = [
    { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: true } },
    { type: 'required_status_checks', parameters: { required_status_checks: RULES.requiredContexts.map((context) => ({ context })) } },
  ]
  return {
    readPr: async () => prState(approvedByOwner),
    readHead: async () => SHA,
    readFiles: async () => [OWNED_FILE],
    readReviewRuns: async () => [reviewRun()],
    readCodeOwners: async () => `packages/crypto/ @${OWNER}\n`,
    readLiveQueueRuns: async () => [],
    sleep: async () => {},
    checks: {
      listPrs: async () => { throw new Error('pr-why never lists PRs') },
      fetchBranchRules: async () => rulesBody,
      fetchCheckRuns: async () => greenRuns(),
      fetchCommitStatuses: async () => [],
      fetchWorkflowRuns: async () => settledRuns,
      fetchRunJobs: async () => [],
      ...checks,
    },
    ...over,
  }
}

describe('gatherPrWhyFacts', () => {
  it('composes the real reads into the expected verdict', async () => {
    expect(names(await gatherPrWhyFacts(fakeDeps(), 4242))).toEqual(['blocked-unexplained'])
    expect(names(await gatherPrWhyFacts(fakeDeps({ readPr: async () => prState() }), 4242))).toEqual(['codeowner-approval-missing'])
  })

  it('a 502 on the check read is unknown — NOT required-context-absent', async () => {
    const f = await gatherPrWhyFacts(fakeDeps({}, { fetchCheckRuns: async () => { throw Object.assign(new Error('x'), { code: 1, stderr: 'HTTP 502: Bad Gateway' }) } }), 4242)
    expect(names(f)).toEqual(['unknown'])
    expect(diagnosePrWhy(f).verdicts[0]?.evidence[0]).toContain('HTTP 502')
    expect(exitCodeFor(diagnosePrWhy(f))).toBe(2)
  })

  it('a 502 on the PR read is unknown and nothing else is read', async () => {
    let otherReads = 0
    const f = await gatherPrWhyFacts(fakeDeps({ readPr: async () => { throw new Error('HTTP 502') }, readFiles: async () => { otherReads++; return [] } }), 4242)
    expect(names(f)).toEqual(['unknown'])
    expect(otherReads).toBe(0)
  })

  it('an unreadable ruleset is unknown', async () => {
    expect(names(await gatherPrWhyFacts(fakeDeps({}, { fetchBranchRules: async () => { throw new Error('HTTP 502') } }), 4242))).toContain('unknown')
  })

  it('re-polls an UNKNOWN merge state, and stops polling once it resolves', async () => {
    let reads = 0
    const states = ['UNKNOWN', 'UNKNOWN', 'CLEAN']
    const f = await gatherPrWhyFacts(fakeDeps({ readPr: async () => prState({ mergeStateStatus: states[Math.min(reads++, 2)] ?? 'CLEAN' }) }), 4242)
    expect(reads).toBe(3)
    expect(names(f)).toEqual(['not-queued'])
  })

  it('never waits on the merge state of a queued PR', async () => {
    let reads = 0
    await gatherPrWhyFacts(fakeDeps({ readPr: async () => { reads++; return prState({ mergeStateStatus: 'UNKNOWN', mergeQueueEntry: QUEUED, isInMergeQueue: true }) } }), 4242)
    expect(reads).toBe(1)
  })

  it('#2480 end to end: no entry + a live group run naming the PR → queued-ok; no run → not-queued', async () => {
    const clean = { readPr: async () => prState({ ...approvedByOwner, mergeStateStatus: 'CLEAN' }) }
    const live = [groupRun(4242), groupRun(4243, { id: 2 })]
    expect(names(await gatherPrWhyFacts(fakeDeps({ ...clean, readLiveQueueRuns: async () => live }), 4242))).toEqual(['queued-ok'])
    expect(names(await gatherPrWhyFacts(fakeDeps({ ...clean, readLiveQueueRuns: async () => [groupRun(4243, { id: 2 })] }), 4242))).toEqual(['not-queued'])
  })

  it('a 502 on the live-run probe is unknown — NOT not-queued', async () => {
    const f = await gatherPrWhyFacts(fakeDeps({
      readPr: async () => prState({ ...approvedByOwner, mergeStateStatus: 'CLEAN' }),
      readLiveQueueRuns: async () => { throw Object.assign(new Error('x'), { code: 1, stderr: 'HTTP 502: Bad Gateway' }) },
    }), 4242)
    expect(names(f)).toEqual(['unknown'])
    expect(diagnosePrWhy(f).verdicts[0]?.evidence[0]).toContain('HTTP 502')
  })

  it('a head that moves during the reads is head-moved', async () => {
    expect(names(await gatherPrWhyFacts(fakeDeps({ readHead: async () => OTHER_SHA }), 4242))[0]).toBe('head-moved')
  })
})

describe('missing-checks reads throw on failure instead of returning an empty list', () => {
  // Before #2469, `pagedJson` was `ghJson(...) ?? []`: a failed read became
  // "no carriers", which scored every required context ABSENT_SETTLED.
  it.each([
    ['fetchCheckRuns', (d: MissingChecksDeps) => d.fetchCheckRuns(SHA)],
    ['fetchCommitStatuses', (d: MissingChecksDeps) => d.fetchCommitStatuses(SHA)],
    ['fetchWorkflowRuns', (d: MissingChecksDeps) => d.fetchWorkflowRuns(SHA)],
    ['fetchRunJobs', (d: MissingChecksDeps) => d.fetchRunJobs(1)],
    ['fetchBranchRules', (d: MissingChecksDeps) => d.fetchBranchRules('main')],
    ['listPrs', (d: MissingChecksDeps) => d.listPrs(1)],
  ])('%s rejects when the runner fails', async (_name, call) => {
    const deps = defaultMissingChecksDeps(async () => { throw new Error('HTTP 502') })
    await expect(call(deps)).rejects.toThrow('HTTP 502')
  })

  it('fetchCheckRuns flattens every page from the injected runner', async () => {
    const deps = defaultMissingChecksDeps(async () => JSON.stringify([
      { check_runs: [{ id: 1, name: 'ci-status', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: 't' }] },
      { check_runs: [{ id: 2, name: 'gitleaks', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: 't' }] },
    ]))
    expect((await deps.fetchCheckRuns(SHA)).map((r) => r.name)).toEqual(['ci-status', 'gitleaks'])
  })
})

// ---------------------------------------------------------------------------
// Parsers, against payloads captured from the live API (2026-11-05)
// ---------------------------------------------------------------------------

describe('prStateFrom', () => {
  it('parses a queued PR: auto-merge consumed, membership on both fields', () => {
    const s = prStateFrom(fixture('pr-2450.json'), 2450)
    expect(s.autoMergeRequest).toBeNull()
    expect(s.isInMergeQueue).toBe(true)
    expect(s.mergeQueueEntry?.state).toBe('QUEUED')
    expect(names(facts({ state: s }))).toEqual(['queued-ok'])
  })
  it('parses an un-queued draft', () => {
    const s = prStateFrom(fixture('pr-2470.json'), 2470)
    expect(s.isDraft).toBe(true)
    expect(s.mergeQueueEntry).toBeNull()
    expect(s.isInMergeQueue).toBe(false)
  })
  it('throws on GraphQL errors, a missing PR, or a missing field — never a defaulted state', () => {
    expect(() => prStateFrom({ errors: [{ message: 'Could not resolve to a PullRequest' }], data: { repository: { pullRequest: null } } }, 1)).toThrow('GraphQL errors')
    expect(() => prStateFrom({ data: { repository: { pullRequest: null } } }, 1)).toThrow('no pull request')
    const raw = structuredClone(fixture('pr-2450.json')) as { data: { repository: { pullRequest: Record<string, unknown> } } }
    delete raw.data.repository.pullRequest['isInMergeQueue']
    expect(() => prStateFrom(raw, 2450)).toThrow('isInMergeQueue')
  })
})

describe('reviewRunsFrom', () => {
  it('finds both fleet/review runs on #2467\'s head and their outcome annotations', () => {
    const runs = reviewRunsFrom(fixture('review-runs-2467-77962f5.json'))
    expect(runs.map((r) => [r.id, r.conclusion, r.outcome.read ? r.outcome.message?.split(' ')[0] : 'UNREAD'])).toEqual(expect.arrayContaining([
      [127036521163, 'failure', 'NO-VERDICT:unreviewed'],
      [127036866882, 'success', 'PASS:reviewed'],
    ]))
    expect(latestReviewRun(runs)?.id).toBe(127036866882)
  })
  it('reads each run\'s outcome through ci.ts\'s one reader — the same answer board gets for the same annotations', () => {
    const raw = fixture('review-runs-2467-77962f5.json') as Review2467
    for (const r of reviewRunsFrom(raw)) {
      const node = runNodes(raw).find((n) => n.databaseId === r.id)
      expect(r.outcome).toEqual(reviewOutcomeFromAnnotations(node?.annotations.nodes ?? [], { complete: true }))
    }
  })
  it('throws on a truncated suite page rather than guessing the newest run', () => {
    const raw = structuredClone(fixture('review-runs-2467-77962f5.json')) as { data: { repository: { object: { checkSuites: { pageInfo: { hasNextPage: boolean } } } } } }
    raw.data.repository.object.checkSuites.pageInfo.hasNextPage = true
    expect(() => reviewRunsFrom(raw)).toThrow('unread page')
  })
})

/** #2490. #2467's real red `fleet/review` run, whose outcome annotation sits
 *  SECOND in its list (after a Node.js deprecation notice), with that list
 *  cut off by its page after the first annotation — the outcome exists but
 *  was never read. This is the unreadable annotation: pr-why must say it
 *  cannot tell, never fall through to "the run named no outcome". */
describe('#2490 — an unreadable outcome annotation is unknown end to end, never a negative', () => {
  const RED_2467 = 127036521163
  function red2467(cut: boolean): ReviewRun {
    const raw = structuredClone(fixture('review-runs-2467-77962f5.json')) as Review2467
    const node = runNodes(raw).find((n) => n.databaseId === RED_2467)
    if (node === undefined) throw new Error('fixture lost #2467\'s red run')
    expect(node.annotations.nodes.findIndex((a) => a.title === REVIEW_OUTCOME_ANNOTATION)).toBeGreaterThan(0)
    if (cut) {
      node.annotations.nodes = node.annotations.nodes.slice(0, 1)
      node.annotations.pageInfo.hasNextPage = true
    } else {
      node.annotations.nodes = node.annotations.nodes.filter((a) => a.title !== REVIEW_OUTCOME_ANNOTATION)
    }
    const run = reviewRunsFrom(raw).find((r) => r.id === RED_2467)
    if (run === undefined) throw new Error('reviewRunsFrom dropped the red run')
    return { ...run, id: REVIEW_ID }
  }
  const redHead = { ok: true as const, value: head([run({ name: 'ci-status', id: 100 }), run({ name: 'fleet/review', id: REVIEW_ID, conclusion: 'failure' })]) }

  it('the cut-off page reads as read: false from the shared reader', () => {
    expect(red2467(true).outcome).toEqual({ read: false, detail: expect.stringContaining('cut off') })
  })
  it('pr-why reports unknown and exits 2 — not required-check-failing, not review-never-requested', () => {
    const r = diagnosePrWhy(facts({ state: approvedByOwner, checks: redHead, reviewRuns: { ok: true, value: [red2467(true)] } }))
    expect(r.verdicts.map((v) => v.name)).toEqual(['unknown'])
    expect(r.verdicts[0]?.evidence.join(' ')).toContain(`run ${REVIEW_ID}`)
    expect(exitCodeFor(r)).toBe(2)
  })
  it('flips: the same run with a WHOLE list that names no outcome is a real (unnamed) failure, exit 1', () => {
    const r = diagnosePrWhy(facts({ state: approvedByOwner, checks: redHead, reviewRuns: { ok: true, value: [red2467(false)] } }))
    expect(r.verdicts.map((v) => v.name)).toEqual(['required-check-failing'])
    expect(exitCodeFor(r)).toBe(1)
  })
})

describe('runPrWhy argv', () => {
  it.each([[[]], [['abc']], [['1', '2']], [['1', '--json']]])('refuses %j with exit 2', async (args) => {
    expect(await runPrWhy(args as string[], fakeDeps())).toBe(2)
  })
})
