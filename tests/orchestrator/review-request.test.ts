import { describe, it, expect } from 'vitest'
import {
  requestReviewAtOpen,
  reviewRequestCandidates,
  isAuthorCollision,
  type ReviewRequestAtOpenDeps,
  type ReviewRequestPrFacts,
} from '../../orchestrator/src/review-request.js'
import { REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN } from '../../orchestrator/src/ci.js'
import { KNOPE_RELEASE_BRANCH } from '../../orchestrator/src/roles/release.js'

const PR = '1761'
const BRANCH = 'fleet/shared/1760'

interface Call {
  fn: 'readPr' | 'count' | 'post' | 'delete'
  login?: string
}

/**
 * Deps whose every call is recorded in order, with scripted behaviours —
 * the only way to assert the SEQUENCE matters here (POST before the first
 * count, DELETE before the second POST, no POST at all when the reviewer is
 * already pending).
 */
function fakeDeps(overrides: {
  facts?: ReviewRequestPrFacts | undefined
  /** Event counts returned in call order; the last one repeats when the
   *  script runs out. */
  counts?: (number | undefined)[]
  /** Logins the POST throws the author-collision 422 for. */
  postCollides?: string[]
  /** Logins the POST throws a generic failure for. */
  postFails?: string[]
  /** Facts returned by the SECOND and later readPr calls (the post-retry
   *  re-read) — defaults to `facts`. */
  rereadFacts?: ReviewRequestPrFacts | undefined
  deleteFails?: boolean
}): { deps: ReviewRequestAtOpenDeps; calls: Call[]; logs: string[] } {
  const calls: Call[] = []
  const logs: string[] = []
  let countIdx = 0
  let readIdx = 0
  const counts = overrides.counts ?? [0, 1]
  return {
    calls,
    logs,
    deps: {
      readPr: async () => {
        calls.push({ fn: 'readPr' })
        readIdx += 1
        return readIdx === 1 ? overrides.facts : (overrides.rereadFacts ?? overrides.facts)
      },
      countReviewRequestedEvents: async () => {
        calls.push({ fn: 'count' })
        const c = counts[Math.min(countIdx, counts.length - 1)]
        countIdx += 1
        return c
      },
      postRequestedReviewer: async (_pr, login) => {
        calls.push({ fn: 'post', login })
        if (overrides.postCollides?.includes(login)) {
          const e = new Error('exit 1: gh: Review cannot be requested from pull request author (HTTP 422)') as Error & { stderr: string }
          e.stderr = 'gh: Review cannot be requested from pull request author (HTTP 422)'
          throw e
        }
        if (overrides.postFails?.includes(login)) {
          throw new Error('exit 1: gh: Validation Failed (HTTP 422)')
        }
      },
      deleteRequestedReviewer: async (_pr, login) => {
        calls.push({ fn: 'delete', login })
        if (overrides.deleteFails === true) throw new Error('exit 1: gh: Not Found (HTTP 404)')
      },
      log: (msg) => logs.push(msg),
    },
  }
}

const input = { pr: PR, headRefName: BRANCH, branchMismatch: undefined }

describe('requestReviewAtOpen — skip fences', () => {
  it('does nothing when no PR was opened', async () => {
    const { deps, calls } = fakeDeps({})
    const out = await requestReviewAtOpen({ ...input, pr: undefined }, deps)
    expect(out.kind).toBe('skipped')
    expect(calls).toEqual([])
  })

  it('does nothing on a branch mismatch — the PR is not the one this item was dispatched for', async () => {
    const { deps, calls } = fakeDeps({})
    const out = await requestReviewAtOpen({ ...input, branchMismatch: 'someone-elses-branch' }, deps)
    expect(out.kind).toBe('skipped')
    expect(calls).toEqual([])
  })

  it('refuses a branch this fleet does not own', async () => {
    const { deps, calls } = fakeDeps({})
    const out = await requestReviewAtOpen({ ...input, headRefName: 'my-personal-feature' }, deps)
    expect(out.kind).toBe('skipped')
    expect(calls).toEqual([])
  })
})

describe('requestReviewAtOpen — the happy path (#1760: the POST nobody made)', () => {
  it('POSTs the trigger login and confirms by the event count advancing', async () => {
    const { deps, calls, logs } = fakeDeps({
      facts: { author: 'a-human', requestedReviewers: [] },
      counts: [0, 1],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out).toEqual({ kind: 'requested', reviewer: REVIEW_REQUEST_LOGIN, reRequested: false })
    // The count is read BEFORE the POST — a count read only afterwards can
    // never prove the request fired.
    expect(calls).toEqual([
      { fn: 'readPr' },
      { fn: 'count' },
      { fn: 'post', login: REVIEW_REQUEST_LOGIN },
      { fn: 'count' },
    ])
    expect(logs.some((l) => l.includes('requested a review'))).toBe(true)
  })

  it('asks the operator stand-in on a PR llamenos-auto itself authored (#1232)', async () => {
    const { deps, calls } = fakeDeps({
      facts: { author: REVIEW_REQUEST_LOGIN, requestedReviewers: [] },
      counts: [0, 1],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out).toEqual({ kind: 'requested', reviewer: RELEASE_REVIEW_REQUEST_LOGIN, reRequested: false })
    expect(calls.filter((c) => c.fn === 'post')).toEqual([{ fn: 'post', login: RELEASE_REVIEW_REQUEST_LOGIN }])
  })
})

describe('requestReviewAtOpen — already pending at PR open (the CODEOWNERS case)', () => {
  it('is success, and makes NO POST — a POST naming a pending reviewer is a guaranteed no-op (#1471)', async () => {
    const { deps, calls } = fakeDeps({
      facts: { author: REVIEW_REQUEST_LOGIN, requestedReviewers: [RELEASE_REVIEW_REQUEST_LOGIN] },
      counts: [1, 1],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out).toEqual({ kind: 'already-pending', reviewer: RELEASE_REVIEW_REQUEST_LOGIN })
    expect(calls).toEqual([{ fn: 'readPr' }])
  })

  it('matches the pending reviewer case-insensitively', async () => {
    const { deps } = fakeDeps({
      facts: { author: REVIEW_REQUEST_LOGIN, requestedReviewers: [RELEASE_REVIEW_REQUEST_LOGIN.toUpperCase()] },
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out.kind).toBe('already-pending')
  })
})

describe('requestReviewAtOpen — the already-pending retry path (#1760 verify-by-breaking-it)', () => {
  it('DELETEs then POSTs again when the plain POST does not advance the count, and confirms on the retry', async () => {
    // First POST no-ops (count 0 -> 0); after the DELETE+POST the count
    // advances (0 -> 1). This is THE case a bare POST silently fails and
    // the one that would quietly reintroduce #1760.
    const { deps, calls } = fakeDeps({
      facts: { author: 'a-human', requestedReviewers: [] },
      counts: [0, 0, 1],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out).toEqual({ kind: 'requested', reviewer: REVIEW_REQUEST_LOGIN, reRequested: true })
    expect(calls).toEqual([
      { fn: 'readPr' },
      { fn: 'count' },
      { fn: 'post', login: REVIEW_REQUEST_LOGIN },
      { fn: 'count' },
      { fn: 'delete', login: REVIEW_REQUEST_LOGIN },
      { fn: 'post', login: REVIEW_REQUEST_LOGIN },
      { fn: 'count' },
    ])
  })

  it('treats the request existing after a stalled count as requested (the CODEOWNERS race, not a failure)', async () => {
    const { deps } = fakeDeps({
      facts: { author: 'a-human', requestedReviewers: [] },
      rereadFacts: { author: 'a-human', requestedReviewers: [REVIEW_REQUEST_LOGIN] },
      counts: [0, 0, 0],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out).toEqual({ kind: 'requested', reviewer: REVIEW_REQUEST_LOGIN, reRequested: true })
  })

  it('fails loudly when neither the count nor a pending request confirms the review ever fired', async () => {
    const { deps, logs } = fakeDeps({
      facts: { author: 'a-human', requestedReviewers: [] },
      counts: [0, 0, 0],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out.kind).toBe('failed')
    if (out.kind === 'failed') expect(out.reason).toContain('did not fire')
    expect(logs.some((l) => l.includes('FAILED'))).toBe(true)
  })

  it('still re-checks after the DELETE itself throws — a failed DELETE must not abort the recovery', async () => {
    const { deps, calls } = fakeDeps({
      facts: { author: 'a-human', requestedReviewers: [] },
      rereadFacts: { author: 'a-human', requestedReviewers: [REVIEW_REQUEST_LOGIN] },
      counts: [0, 0, 0],
      deleteFails: true,
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out.kind).toBe('requested')
    expect(calls.filter((c) => c.fn === 'delete')).toHaveLength(1)
  })
})

describe('requestReviewAtOpen — the author/reviewer collision (HTTP 422)', () => {
  it('falls through to the stand-in when GitHub refuses the primary as the PR author', async () => {
    // The live read FAILED to name an author (undefined), so the primary is
    // REVIEW_REQUEST_LOGIN — which then collides, proving the unreadable
    // author was llamenos-auto itself.
    const { deps, calls, logs } = fakeDeps({
      facts: { author: undefined, requestedReviewers: [] },
      // count before the colliding POST, count before the stand-in's POST,
      // count after it — a fresh `before` is measured per candidate, so the
      // advance is always against the state THIS candidate started from.
      counts: [0, 0, 1],
      postCollides: [REVIEW_REQUEST_LOGIN],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out).toEqual({ kind: 'requested', reviewer: RELEASE_REVIEW_REQUEST_LOGIN, reRequested: false })
    expect(calls.filter((c) => c.fn === 'post')).toEqual([
      { fn: 'post', login: REVIEW_REQUEST_LOGIN },
      { fn: 'post', login: RELEASE_REVIEW_REQUEST_LOGIN },
    ])
    expect(logs.some((l) => l.includes('refused'))).toBe(true)
  })

  it('fails when every candidate collides', async () => {
    const { deps } = fakeDeps({
      facts: { author: undefined, requestedReviewers: [] },
      counts: [0, 0],
      postCollides: [REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out.kind).toBe('failed')
  })

  it('a 422 that is NOT the author collision does not route to the stand-in', async () => {
    const { deps, calls } = fakeDeps({
      facts: { author: 'a-human', requestedReviewers: [] },
      postFails: [REVIEW_REQUEST_LOGIN],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out.kind).toBe('failed')
    expect(calls.filter((c) => c.fn === 'post')).toEqual([{ fn: 'post', login: REVIEW_REQUEST_LOGIN }])
    expect(calls.some((c) => c.fn === 'delete')).toBe(false)
  })
})

describe('requestReviewAtOpen — failed reads fail closed, never guess', () => {
  it('an unreadable PR means no POST at all — the reviewer cannot be chosen without the author', async () => {
    const { deps, calls } = fakeDeps({ facts: undefined })
    const out = await requestReviewAtOpen(input, deps)
    expect(out.kind).toBe('failed')
    expect(calls.filter((c) => c.fn === 'post')).toEqual([])
  })

  it('an unreadable event count after the POST is unverified, never "requested" — the POST response proves nothing', async () => {
    const { deps, calls } = fakeDeps({
      facts: { author: 'a-human', requestedReviewers: [] },
      counts: [0, undefined],
    })
    const out = await requestReviewAtOpen(input, deps)
    expect(out).toMatchObject({ kind: 'unverified', reviewer: REVIEW_REQUEST_LOGIN })
    // And no DELETE+POST storm on top of an unverifiable state.
    expect(calls.some((c) => c.fn === 'delete')).toBe(false)
  })
})

describe('reviewRequestCandidates', () => {
  it('is the primary alone on an ordinary fleet branch with a human author', () => {
    expect(reviewRequestCandidates('a-human', BRANCH)).toEqual([REVIEW_REQUEST_LOGIN])
  })

  it('is the operator stand-in on a llamenos-auto-authored PR', () => {
    expect(reviewRequestCandidates(REVIEW_REQUEST_LOGIN, BRANCH)).toEqual([RELEASE_REVIEW_REQUEST_LOGIN])
  })

  it('appends the stand-in when the author is unknown — the 422 fallback must be reachable', () => {
    expect(reviewRequestCandidates(undefined, BRANCH)).toEqual([REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN])
  })

  it('keeps both trigger logins on the release branch without duplicating the stand-in', () => {
    expect(reviewRequestCandidates(undefined, KNOPE_RELEASE_BRANCH)).toEqual([
      REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN,
    ])
  })
})

describe('isAuthorCollision', () => {
  it('recognises GitHub’s 422 author refusal by message', () => {
    const e = new Error('failed') as Error & { stderr: string }
    e.stderr = 'gh: Review cannot be requested from pull request author (HTTP 422)'
    expect(isAuthorCollision(e)).toBe(true)
  })

  it('does not recognise an unrelated 422', () => {
    expect(isAuthorCollision(new Error('gh: Validation Failed (HTTP 422)'))).toBe(false)
  })
})

describe('requestReviewAtOpen — never throws', () => {
  it('a throwing dep collapses to the contract’s own "unreadable", not a rejection', async () => {
    const logs: string[] = []
    const deps: ReviewRequestAtOpenDeps = {
      readPr: async () => { throw new Error('network partition') },
      countReviewRequestedEvents: async () => 0,
      postRequestedReviewer: async () => {},
      deleteRequestedReviewer: async () => {},
      log: (m) => logs.push(m),
    }
    const out = await requestReviewAtOpen(input, deps)
    expect(out.kind).toBe('failed')
    expect(logs.some((l) => l.includes('threw'))).toBe(true)
  })
})
