import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  unstickStalledReviews, unstickCandidatesFrom, commentReviewAs, defaultCommentReviewIo,
  MAX_EVALUATIONS_PER_HEAD, UNSTICK_GRACE_MS, PROCEDURAL_REVIEW_BODY,
  type UnstickDeps, type UnstickCandidate, type CommentReviewIo,
} from '../../orchestrator/src/review-unstick.js'
import { rerunReview, type RerunDeps, type RerunRun } from '../../orchestrator/src/review-rerun.js'
import { REVIEW_JOB, VERIFY_JOB, RELEASE_REVIEW_REQUEST_LOGIN } from '../../orchestrator/src/ci.js'
import type { BoardFacts, PrFact, BranchGate } from '../../orchestrator/src/board.js'

/**
 * Rails for #3113 — a fleet PR whose opening review request produced no verdict
 * must recover on its own, without storming, without re-reviewing a PR that
 * already has a verdict, and without ever approving anything.
 */

const HEAD = 'c'.repeat(40)
const NOW = new Date('2026-11-27T21:00:00Z')
const OLD = new Date(NOW.getTime() - UNSTICK_GRACE_MS - 60_000)
const CODEOWNER = RELEASE_REVIEW_REQUEST_LOGIN // the trigger on a PR the bot authored

const run = (over: Partial<RerunRun> = {}): RerunRun => ({
  id: 1, event: 'pull_request', head_sha: HEAD, created_at: '2026-11-27T21:00:01Z',
  html_url: 'https://github.com/o/r/actions/runs/1', status: 'completed', ...over,
})

// ---------------------------------------------------------------------------
// rerunReview's recovery — the failure constructed directly
// ---------------------------------------------------------------------------

/** A CODEOWNER-pending PR: the plain POST/DELETE are no-ops; only a submitted
 *  review empties the list, after which the POST is a true add. */
function codeownerPending(opts: { startRun?: boolean } = {}) {
  const calls: string[] = []
  const logs: string[] = []
  let pending = true
  let events = 1
  const deps: RerunDeps = {
    readPr: async () => ({ number: 3111, headSha: HEAD, branch: 'fleet/backend/2571', author: 'llamenos-auto', requestedReviewers: pending ? [CODEOWNER] : [] }),
    reviewRequestEvents: async () => Array.from({ length: events }, () => '2026-11-27T19:59:46Z'),
    removeReviewer: async (_n, l) => { calls.push(`remove:${l}`) }, // re-added instantly: pending stays true
    addReviewer: async (_n, l) => {
      calls.push(`add:${l}`)
      if (!pending) { events += 1; pending = true }
    },
    rerunRuns: async () => (opts.startRun === false || events < 2 ? [] : [run()]),
    now: () => NOW,
    sleep: async () => { calls.push('sleep') },
    commentReviewAs: async (_n, l, sha) => { calls.push(`comment:${l}:${sha}`); pending = false },
    log: (m) => logs.push(m),
  }
  return { deps, calls, logs }
}

describe('rerunReview recovers a CODEOWNER request that emits no event (#3113)', () => {
  it('submits a comment review as the reviewer, re-adds, and confirms a run — and says it did', async () => {
    const { deps, calls, logs } = codeownerPending()
    const r = await rerunReview(deps, 3111)
    expect(r).toEqual({ ok: true, run: run(), viaCommentReview: true })
    expect(calls).toEqual([`remove:${CODEOWNER}`, `add:${CODEOWNER}`, `comment:${CODEOWNER}:${HEAD}`, `add:${CODEOWNER}`])
    expect(logs.join('\n')).toContain('emitted no event')
    expect(logs.join('\n')).toContain('comment review')
  })

  it('without the recovery dep the dead end is still a loud failure naming the remedy', async () => {
    const { deps } = codeownerPending()
    delete deps.commentReviewAs
    const r = await rerunReview(deps, 3111)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('comment review')
  })

  it('does not take the recovery when the plain request already fired — no spurious review', async () => {
    const calls: string[] = []
    let events = 0
    const deps: RerunDeps = {
      readPr: async () => ({ number: 5, headSha: HEAD, branch: 'b', author: 'someone', requestedReviewers: [] }),
      reviewRequestEvents: async () => Array.from({ length: events }, () => 't'),
      removeReviewer: async () => undefined,
      addReviewer: async () => { events += 1 },
      rerunRuns: async () => [run()],
      now: () => NOW,
      sleep: async () => undefined,
      commentReviewAs: async () => { calls.push('comment') },
    }
    const r = await rerunReview(deps, 5)
    expect(r).toEqual({ ok: true, run: run() })
    expect(calls).toEqual([])
  })

  it('FAILS, naming that the comment review was submitted, when the re-add still emits nothing', async () => {
    const { deps } = codeownerPending()
    deps.addReviewer = async () => undefined
    const r = await rerunReview(deps, 3111)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('WAS submitted')
  })

  it('FAILS (never a false success) when the event fires but no run starts', async () => {
    const { deps } = codeownerPending({ startRun: false })
    const r = await rerunReview(deps, 3111)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('an event is not a run')
  })
})

// ---------------------------------------------------------------------------
// the pass: what it acts on, and what it must leave alone
// ---------------------------------------------------------------------------

function passDeps(over: {
  candidates?: UnstickCandidate[]
  runs?: RerunRun[]
  committed?: Date | undefined
  rerun?: UnstickDeps['rerun']
} = {}) {
  const logs: string[] = []
  const reran: number[] = []
  const deps: UnstickDeps = {
    candidates: async () => over.candidates ?? [{ number: 3111, headSha: HEAD, reason: 'NO-VERDICT:unreviewed' }],
    headCommittedAt: async () => ('committed' in over ? over.committed : OLD),
    now: () => NOW,
    runsOnHead: async () => over.runs ?? [],
    rerun: over.rerun ?? (async (pr) => { reran.push(pr); return { ok: true, run: run(), viaCommentReview: true } }),
    log: (m) => logs.push(m),
  }
  return { deps, logs, reran }
}

describe('unstickStalledReviews', () => {
  it('re-requests a stalled PR and reports the recovery by name', async () => {
    const { deps, logs, reran } = passDeps()
    const out = await unstickStalledReviews(deps)
    expect(reran).toEqual([3111])
    expect(out).toEqual([{ kind: 'refired', pr: 3111, run: run(), viaCommentReview: true }])
    expect(logs.join('\n')).toMatch(/#3111 review re-fired via a comment review/)
  })

  it('leaves a head alone while an evaluation is queued or running — however long the review takes', async () => {
    for (const status of ['queued', 'in_progress']) {
      const { deps, reran, logs } = passDeps({ runs: [run({ status })] })
      expect(await unstickStalledReviews(deps)).toEqual([{ kind: 'in-flight', pr: 3111 }])
      expect(reran).toEqual([])
      expect(logs.join('\n')).toContain('still running')
    }
  })

  it('leaves a young head alone, and one whose age cannot be read (a failed read is not "old")', async () => {
    const young = passDeps({ committed: new Date(NOW.getTime() - 60_000) })
    expect(await unstickStalledReviews(young.deps)).toEqual([{ kind: 'too-young', pr: 3111 }])
    const unknown = passDeps({ committed: undefined })
    expect(await unstickStalledReviews(unknown.deps)).toEqual([{ kind: 'too-young', pr: 3111 }])
    expect(young.reran.concat(unknown.reran)).toEqual([])
  })

  it('stops asking once a head has spent its evaluations and REPORTS it — no request storm', async () => {
    const spent = Array.from({ length: MAX_EVALUATIONS_PER_HEAD }, (_, i) => run({ id: i + 1 }))
    const { deps, reran, logs } = passDeps({ runs: spent })
    expect(await unstickStalledReviews(deps)).toEqual([{ kind: 'exhausted', pr: 3111, evaluations: MAX_EVALUATIONS_PER_HEAD }])
    expect(reran).toEqual([])
    expect(logs.join('\n')).toContain('STALLED')
  })

  it('one fewer than the cap still asks', async () => {
    const { deps, reran } = passDeps({ runs: Array.from({ length: MAX_EVALUATIONS_PER_HEAD - 1 }, (_, i) => run({ id: i + 1 })) })
    await unstickStalledReviews(deps)
    expect(reran).toEqual([3111])
  })

  it('reports a failed recovery (and a throw) and carries on to the next PR', async () => {
    const { deps, logs } = passDeps({
      candidates: [
        { number: 1, headSha: HEAD, reason: 'r' }, { number: 2, headSha: HEAD, reason: 'r' }, { number: 3, headSha: HEAD, reason: 'r' },
      ],
      rerun: async (pr) => {
        if (pr === 1) return { ok: false, reason: 'no event' }
        if (pr === 2) throw new Error('gh exploded')
        return { ok: true, run: run() }
      },
    })
    const out = await unstickStalledReviews(deps)
    expect(out.map((o) => o.kind)).toEqual(['failed', 'failed', 'refired'])
    expect(logs.join('\n')).toMatch(/#1 FAILED — no event/)
    expect(logs.join('\n')).toMatch(/#2 FAILED/)
  })
})

// ---------------------------------------------------------------------------
// candidate selection comes from the board's own table
// ---------------------------------------------------------------------------

const GATE: BranchGate = {
  ruleset: { ok: true, rules: { branch: 'main', requiredContexts: ['ci-status', VERIFY_JOB, REVIEW_JOB], requireCodeOwnerReview: false, requiredApprovingReviewCount: 0, requireExtraApprovalForUnattributedChanges: false } },
  codeOwners: { ok: true, rules: [] },
}
const pr = (over: Partial<PrFact>): PrFact => ({
  number: 1, authorLogin: 'llamenos-auto', isDraft: false, createdAt: '2026-11-27T19:00:00Z', headRefOid: HEAD,
  headRefName: 'fleet/backend/1', baseRefName: 'main', mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE',
  labels: [], reviews: [], files: ['docs/a.md'], changedFiles: 1, reviewRequests: [CODEOWNER],
  checks: [
    { name: 'ci-status', kind: 'CheckRun', sha: HEAD, state: 'PASS' },
    { name: VERIFY_JOB, kind: 'CheckRun', sha: HEAD, state: 'PASS' },
    { name: REVIEW_JOB, kind: 'CheckRun', sha: HEAD, state: 'FAIL', reviewOutcome: { read: true, message: 'NO-VERDICT:unreviewed — no review has ever been earned on this PR and a push never starts one' }, reviewFailureKind: 'infrastructure', runAttempt: 1 },
  ],
  ...over,
})
const facts = (prs: PrFact[]): BoardFacts => ({ fleet: { halted: false, isQuotaHalt: false }, prs, gates: { main: GATE }, baseHeads: {} })

describe('unstickCandidatesFrom', () => {
  it('names a fleet PR whose gate holds no verdict and has nothing evaluating it', () => {
    expect(unstickCandidatesFrom(facts([pr({})])).map((c) => c.number)).toEqual([1])
  })

  it('never names a PR that already has a verdict (green or a real FAIL)', () => {
    const green = pr({ number: 2, checks: pr({}).checks.map((c) => (c.name === REVIEW_JOB ? { name: c.name, kind: 'CheckRun' as const, sha: HEAD, state: 'PASS' as const } : c)) })
    const realFail = pr({
      number: 3,
      checks: pr({}).checks.map((c) => (c.name === REVIEW_JOB
        ? { ...c, reviewOutcome: { read: true as const, message: 'FAIL:substantive — the reviewer found defects' }, reviewFailureKind: 'substantive' as const }
        : c)),
    })
    expect(unstickCandidatesFrom(facts([green, realFail]))).toEqual([])
  })

  it('never names a draft, a non-fleet branch, or the knope release branch', () => {
    expect(unstickCandidatesFrom(facts([
      pr({ number: 4, isDraft: true }), pr({ number: 5, headRefName: 'feature/x' }), pr({ number: 6, headRefName: 'release' }),
    ]))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// the credential step: comment only, right identity only, loud when absent
// ---------------------------------------------------------------------------

function io(over: Partial<CommentReviewIo> = {}) {
  const posted: Array<{ token: string; pr: number; sha: string; body: string }> = []
  const real: CommentReviewIo = {
    tokenFor: async () => 'tok-codeowner-0123456789',
    resolve: async () => ({ kind: 'login', login: CODEOWNER }),
    postReview: async (token, p, sha, body) => { posted.push({ token, pr: p, sha, body }) },
    ...over,
  }
  return { real, posted }
}

describe('commentReviewAs', () => {
  it('posts the procedural body on the head as the verified reviewer', async () => {
    const { real, posted } = io()
    await commentReviewAs(real, 3111, CODEOWNER, HEAD)
    expect(posted).toEqual([{ token: 'tok-codeowner-0123456789', pr: 3111, sha: HEAD, body: PROCEDURAL_REVIEW_BODY }])
  })

  it('refuses, naming the remedy, when this machine holds no credential for the reviewer', async () => {
    const { real, posted } = io({ tokenFor: async () => undefined })
    await expect(commentReviewAs(real, 3111, CODEOWNER, HEAD)).rejects.toThrow(/gh auth login --user rhonda-rodododo/)
    expect(posted).toEqual([])
  })

  it('refuses a credential that resolves to anyone else, and one that cannot be resolved', async () => {
    const wrong = io({ resolve: async () => ({ kind: 'login', login: 'llamenos-auto' }) })
    await expect(commentReviewAs(wrong.real, 1, CODEOWNER, HEAD)).rejects.toThrow(/wrong identity/)
    const unresolved = io({ resolve: async () => ({ kind: 'unresolved', reason: 'network' }) })
    await expect(commentReviewAs(unresolved.real, 1, CODEOWNER, HEAD)).rejects.toThrow(/could not be resolved/)
    expect(wrong.posted.concat(unresolved.posted)).toEqual([])
  })

  it('can only ever send a COMMENT review — an approval is not reachable through this module', () => {
    const src = readFileSync(join(__dirname, '../../orchestrator/src/review-unstick.ts'), 'utf8')
    const events = [...src.matchAll(/event=([A-Z_]+)/g)].map((m) => m[1])
    expect(events).toEqual(['COMMENT'])
    expect(src).not.toMatch(/APPROVE|REQUEST_CHANGES|--approve/)
    // and the live poster really does build that argv
    expect(defaultCommentReviewIo().postReview).toBeTypeOf('function')
  })
})
