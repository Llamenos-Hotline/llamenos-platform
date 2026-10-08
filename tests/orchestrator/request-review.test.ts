import { describe, it, expect } from 'vitest'
import {
  executeRequestReview, describeRequestReview, requestReviewExitCode,
  requestReviewAtOpen, runRequestReview,
  type RequestReviewDeps, type RequestReviewResult, type RequestReviewTarget,
} from '../../orchestrator/src/request-review.js'
import { REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN } from '../../orchestrator/src/ci.js'
import { KNOPE_RELEASE_BRANCH } from '../../orchestrator/src/roles/release.js'

/**
 * A fake GitHub that reproduces the two measured behaviours a naive
 * implementation of this module cannot survive. Both of them make the HAPPY
 * path of a "request a review" API call indistinguishable from a no-op, which
 * is why every assertion below is on `reviewRequestedEvents` — the count
 * `fleet-review.yml` actually triggers off — and never on "we called the API".
 *
 * TRAP 1 (#1471): requesting a reviewer who is ALREADY on the request list
 * succeeds and emits NO `review_requested` event. So a test that asserts the
 * POST happened passes for an implementation that starts no review at all.
 *
 * TRAP 2 (#1611): when the login is a CODEOWNER of a path the PR touches,
 * GitHub PINS the request — `DELETE .../requested_reviewers` answers 200 with
 * the login STILL listed and emits no `review_request_removed`. So the
 * remove-then-re-add idiom (`clear`+`request`) cannot terminate: the clear
 * does nothing, and the re-request is then trap 1.
 *
 * `clear` is exposed deliberately even though production no longer calls it —
 * see the "a remove-then-re-add implementation" test, which drives this fake
 * the way the pre-#1611 design did and shows the event count never moves.
 */
class FakeGitHub {
  requestedReviewers: string[]
  /** Logins GitHub re-pins the instant they are removed. */
  readonly pinnedCodeOwners: Set<string>
  reviewRequestedEvents = 0
  reviewRequestRemovedEvents = 0
  /** Set to make the live request-list read fail, as `ghJson` does. */
  listUnreadable = false
  /** Set to make the event-count read fail. */
  eventsUnreadable = false
  /** Set to make the POST throw, as a permissions failure does. */
  postError: string | undefined
  readonly logs: string[] = []
  readonly calls: string[] = []

  constructor(init: { requested?: string[]; pinned?: string[] } = {}) {
    this.requestedReviewers = [...(init.requested ?? [])]
    this.pinnedCodeOwners = new Set((init.pinned ?? []).map((l) => l.toLowerCase()))
  }

  private has(login: string): boolean {
    return this.requestedReviewers.some((l) => l.toLowerCase() === login.toLowerCase())
  }

  /** GitHub's real semantics: a true add emits the event, a re-add does not. */
  request(login: string): void {
    this.calls.push(`POST ${login}`)
    if (this.postError !== undefined) throw new Error(this.postError)
    if (this.has(login)) return
    this.requestedReviewers.push(login)
    this.reviewRequestedEvents += 1
  }

  /** GitHub's real semantics: a pinned CODEOWNER survives the DELETE, 200 and
   *  all, and no removal event is emitted. */
  clear(login: string): void {
    this.calls.push(`DELETE ${login}`)
    if (this.pinnedCodeOwners.has(login.toLowerCase())) return
    if (!this.has(login)) return
    this.requestedReviewers = this.requestedReviewers.filter((l) => l.toLowerCase() !== login.toLowerCase())
    this.reviewRequestRemovedEvents += 1
  }

  deps(): RequestReviewDeps {
    return {
      readRequestedReviewers: async (_pr) => (this.listUnreadable ? undefined : [...this.requestedReviewers]),
      requestReviewer: async (_pr, login) => { this.request(login) },
      countReviewRequestEvents: async (_pr) => (this.eventsUnreadable ? undefined : this.reviewRequestedEvents),
      sleep: async () => {},
      log: (msg) => { this.logs.push(msg) },
    }
  }
}

const FLEET_PR: RequestReviewTarget = { number: 1722, authorLogin: 'rhonda-rodododo', headRefName: 'fleet/android/1149' }

describe('executeRequestReview — a review is started, measured by the EVENT (#1158)', () => {
  it('requests the fleet identity on an ordinary fleet PR, and the review_requested count RISES', async () => {
    const gh = new FakeGitHub()
    expect(gh.reviewRequestedEvents).toBe(0)

    const result = await executeRequestReview(FLEET_PR, gh.deps())

    // The assertion that matters: an event fired. #1722 arrived with this at
    // 0 and was unmergeable forever.
    expect(gh.reviewRequestedEvents).toBe(1)
    expect(result.outcome).toEqual({
      kind: 'requested', reviewer: REVIEW_REQUEST_LOGIN, eventsBefore: 0, eventsAfter: 1,
    })
    expect(requestReviewExitCode(result)).toBe(0)
  })

  it('reports `requested` ONLY on a confirmed count increase, not on a successful POST', async () => {
    const gh = new FakeGitHub()
    // The POST lands on a login already pending — GitHub's own no-op. The
    // API call succeeds; no event fires. `requested` must not be claimed.
    gh.requestedReviewers = [REVIEW_REQUEST_LOGIN]
    // Make the dead-end branch unreachable so the POST is actually attempted
    // and the confirmation step is what decides the outcome.
    gh.listUnreadable = true

    const result = await executeRequestReview(FLEET_PR, gh.deps())

    expect(gh.calls).toContain(`POST ${REVIEW_REQUEST_LOGIN}`)
    expect(gh.reviewRequestedEvents).toBe(0)
    expect(result.outcome.kind).toBe('unconfirmed')
    expect(requestReviewExitCode(result)).toBe(1)
  })
})

describe('executeRequestReview — who is asked is decided by the PR AUTHOR (#1232)', () => {
  it('asks the operator on a PR the fleet identity itself authored — never the author', async () => {
    const gh = new FakeGitHub()
    const result = await executeRequestReview(
      { number: 1379, authorLogin: REVIEW_REQUEST_LOGIN, headRefName: 'fix/1158-request-review-migration' },
      gh.deps(),
    )

    expect(result.candidates).not.toContain(REVIEW_REQUEST_LOGIN)
    expect(gh.requestedReviewers).toEqual([RELEASE_REVIEW_REQUEST_LOGIN])
    expect(gh.reviewRequestedEvents).toBe(1)
    expect(result.outcome.kind === 'requested' && result.outcome.reviewer).toBe(RELEASE_REVIEW_REQUEST_LOGIN)
  })

  it('asks the operator on an operator-authored PR? no — it asks the fleet identity', async () => {
    const gh = new FakeGitHub()
    const result = await executeRequestReview(
      { number: 1718, authorLogin: RELEASE_REVIEW_REQUEST_LOGIN, headRefName: 'fix/1709-backup-format' },
      gh.deps(),
    )
    expect(result.outcome.kind === 'requested' && result.outcome.reviewer).toBe(REVIEW_REQUEST_LOGIN)
  })

  it('never names the author, whoever the author is', async () => {
    for (const author of [REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN, 'someone-else']) {
      for (const branch of ['fleet/infra/1', KNOPE_RELEASE_BRANCH]) {
        const gh = new FakeGitHub()
        const result = await executeRequestReview({ number: 1, authorLogin: author, headRefName: branch }, gh.deps())
        expect(result.candidates.map((l) => l.toLowerCase())).not.toContain(author.toLowerCase())
      }
    }
  })

  it('falls through to the SECOND candidate on the release PR when the first is already pending', async () => {
    // The release branch accepts either login. The first is pending (so a
    // request for it would fire nothing); the second must be used instead of
    // reporting a dead end.
    const gh = new FakeGitHub({ requested: [REVIEW_REQUEST_LOGIN] })
    const result = await executeRequestReview(
      { number: 1161, authorLogin: 'knope-bot', headRefName: KNOPE_RELEASE_BRANCH }, gh.deps(),
    )
    expect(result.candidates).toEqual([REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN])
    expect(gh.reviewRequestedEvents).toBe(1)
    expect(result.outcome.kind === 'requested' && result.outcome.reviewer).toBe(RELEASE_REVIEW_REQUEST_LOGIN)
  })
})

describe('executeRequestReview — TRAP 1: a login already pending fires nothing (#1471)', () => {
  it('does not POST at all, and says no review can be started by request', async () => {
    const gh = new FakeGitHub({ requested: [REVIEW_REQUEST_LOGIN] })

    const result = await executeRequestReview(FLEET_PR, gh.deps())

    expect(gh.calls).toEqual([])
    expect(gh.reviewRequestedEvents).toBe(0)
    expect(result.outcome.kind).toBe('already-pending')
    expect(requestReviewExitCode(result)).toBe(1)
  })

  it('names the recovery that works — a COMMENT review clears the list — and never an approving one', async () => {
    const gh = new FakeGitHub({ requested: [REVIEW_REQUEST_LOGIN] })
    const result = await executeRequestReview(FLEET_PR, gh.deps())
    const text = describeRequestReview(result)
    expect(text).toMatch(/--comment/)
    expect(text).toMatch(/never an APPROVING review/)
  })

  it('the login compare is case-insensitive, as GitHub logins are', async () => {
    const gh = new FakeGitHub({ requested: [REVIEW_REQUEST_LOGIN.toUpperCase()] })
    const result = await executeRequestReview(FLEET_PR, gh.deps())
    expect(result.outcome.kind).toBe('already-pending')
    expect(gh.calls).toEqual([])
  })
})

describe('executeRequestReview — TRAP 2: a CODEOWNER request is PINNED (#1611)', () => {
  // This is the break-it test for the retired design. It drives the fake the
  // way remove-then-re-add did and shows the event count never moves — so an
  // implementation that "cleared then re-requested" would report success on a
  // PR that still has no review. Production no longer issues the DELETE, and
  // the test below pins that.
  it('a remove-then-re-add sequence emits NOTHING when the login is a pinned CODEOWNER', () => {
    const gh = new FakeGitHub({ requested: [RELEASE_REVIEW_REQUEST_LOGIN], pinned: [RELEASE_REVIEW_REQUEST_LOGIN] })

    gh.clear(RELEASE_REVIEW_REQUEST_LOGIN)
    gh.request(RELEASE_REVIEW_REQUEST_LOGIN)

    expect(gh.requestedReviewers).toEqual([RELEASE_REVIEW_REQUEST_LOGIN])
    expect(gh.reviewRequestRemovedEvents).toBe(0)
    expect(gh.reviewRequestedEvents).toBe(0)
  })

  it('production issues no DELETE on that PR — it reports the dead end instead of looping on it', async () => {
    const gh = new FakeGitHub({ requested: [RELEASE_REVIEW_REQUEST_LOGIN], pinned: [RELEASE_REVIEW_REQUEST_LOGIN] })

    const result = await executeRequestReview(
      { number: 1379, authorLogin: REVIEW_REQUEST_LOGIN, headRefName: 'fix/1158-request-review-migration' },
      gh.deps(),
    )

    expect(gh.calls.filter((c) => c.startsWith('DELETE'))).toEqual([])
    expect(result.outcome.kind).toBe('already-pending')
    expect(requestReviewExitCode(result)).toBe(1)
  })
})

describe('executeRequestReview — nothing is swallowed, and nothing is guessed', () => {
  it('a failed POST is `failed`, non-zero, logged, and named in the rendered text', async () => {
    const gh = new FakeGitHub()
    gh.postError = 'HTTP 403: Resource not accessible by integration'

    const result = await executeRequestReview(FLEET_PR, gh.deps())

    expect(result.outcome.kind).toBe('failed')
    expect(requestReviewExitCode(result)).toBe(1)
    expect(describeRequestReview(result)).toMatch(/FAIL/)
    expect(gh.logs.join('\n')).toMatch(/REVIEW REQUEST FAILED/)
    expect(gh.reviewRequestedEvents).toBe(0)
  })

  it('never throws, whatever fails', async () => {
    const gh = new FakeGitHub()
    gh.postError = 'boom'
    gh.listUnreadable = true
    gh.eventsUnreadable = true
    await expect(executeRequestReview(FLEET_PR, gh.deps())).resolves.toBeDefined()
  })

  it('an unreadable event count is `unconfirmed`, never `requested` — the POST is not the evidence', async () => {
    const gh = new FakeGitHub()
    gh.eventsUnreadable = true

    const result = await executeRequestReview(FLEET_PR, gh.deps())

    // The request DID land on the fake, so "we called the API" is satisfied.
    expect(gh.requestedReviewers).toEqual([REVIEW_REQUEST_LOGIN])
    // It still must not be reported as a started review.
    expect(result.outcome.kind).toBe('unconfirmed')
    expect(requestReviewExitCode(result)).toBe(1)
    expect(describeRequestReview(result)).toMatch(/UNCONFIRMED/)
  })

  it('an unreadable request list does not become an EMPTY one — it still asks, and still proves it', async () => {
    const gh = new FakeGitHub()
    gh.listUnreadable = true

    const result = await executeRequestReview(FLEET_PR, gh.deps())

    expect(result.outcome.kind).toBe('requested')
    expect(gh.reviewRequestedEvents).toBe(1)
  })

  it('retries the confirmation read rather than calling a lagging timeline a failure', async () => {
    const gh = new FakeGitHub()
    const deps = gh.deps()
    let reads = 0
    const lagging: RequestReviewDeps = {
      ...deps,
      // The timeline API is eventually consistent: the first read after the
      // POST has not caught up. That is not evidence nothing fired.
      countReviewRequestEvents: async (pr) => {
        reads += 1
        return reads <= 2 ? 0 : deps.countReviewRequestEvents(pr)
      },
    }

    const result = await executeRequestReview(FLEET_PR, lagging)

    expect(result.outcome.kind).toBe('requested')
  })

  it('every rendered outcome names the PR and who could have been asked', async () => {
    const cases: RequestReviewResult['outcome'][] = []
    const plain = new FakeGitHub()
    cases.push((await executeRequestReview(FLEET_PR, plain.deps())).outcome)
    const pendingGh = new FakeGitHub({ requested: [REVIEW_REQUEST_LOGIN] })
    cases.push((await executeRequestReview(FLEET_PR, pendingGh.deps())).outcome)
    const failedGh = new FakeGitHub()
    failedGh.postError = 'nope'
    cases.push((await executeRequestReview(FLEET_PR, failedGh.deps())).outcome)
    const unconfirmedGh = new FakeGitHub()
    unconfirmedGh.eventsUnreadable = true
    cases.push((await executeRequestReview(FLEET_PR, unconfirmedGh.deps())).outcome)

    expect(cases.map((o) => o.kind).sort())
      .toEqual(['already-pending', 'failed', 'requested', 'unconfirmed'])
    for (const outcome of cases) {
      const text = describeRequestReview({ number: 1722, candidates: [REVIEW_REQUEST_LOGIN], outcome })
      expect(text).toContain('#1722')
      expect(text).toContain(REVIEW_REQUEST_LOGIN)
    }
  })
})

describe('requestReviewAtOpen — the fleet asks at PR open, or says the PR cannot merge', () => {
  function atOpenDeps(overrides: {
    readPr?: (pr: string) => Promise<{ number: number; authorLogin: string; headRefName: string } | undefined>
    execute?: (t: RequestReviewTarget) => Promise<RequestReviewResult>
  } = {}) {
    const executed: RequestReviewTarget[] = []
    const logs: string[] = []
    return {
      executed,
      logs,
      deps: {
        readPr: overrides.readPr ?? (async (_pr) => ({ number: 1722, authorLogin: 'rhonda-rodododo', headRefName: 'fleet/android/1149' })),
        execute: overrides.execute ?? (async (t) => {
          executed.push(t)
          return { number: t.number, candidates: [REVIEW_REQUEST_LOGIN], outcome: { kind: 'requested', reviewer: REVIEW_REQUEST_LOGIN, eventsBefore: 0, eventsAfter: 1 } }
        }),
        log: (m: string) => { logs.push(m) },
      },
    }
  }

  it('requests a review for the PR it just discovered', async () => {
    const h = atOpenDeps()
    await requestReviewAtOpen({ pr: '1722', headRefName: 'fleet/android/1149', branchMismatch: undefined }, h.deps)
    expect(h.executed).toEqual([{ number: 1722, authorLogin: 'rhonda-rodododo', headRefName: 'fleet/android/1149' }])
  })

  // Break-it, the other direction: with the request removed from the open
  // path, a freshly opened PR has NO review_requested event and no
  // `fleet/review` carrier. This is the state #1722 was measured in.
  it('without it, a freshly opened PR has review_requested events: 0', async () => {
    const gh = new FakeGitHub()
    // The at-open path not called at all — exactly what main does today.
    expect(gh.reviewRequestedEvents).toBe(0)
    // ...and called, it is 1.
    await executeRequestReview(FLEET_PR, gh.deps())
    expect(gh.reviewRequestedEvents).toBe(1)
  })

  it('does nothing when there is no PR, or the worker pushed to the wrong branch', async () => {
    const a = atOpenDeps()
    await requestReviewAtOpen({ pr: undefined, headRefName: 'fleet/x/1', branchMismatch: undefined }, a.deps)
    const b = atOpenDeps()
    await requestReviewAtOpen({ pr: '9', headRefName: 'fleet/x/1', branchMismatch: 'pushed to other/branch' }, b.deps)
    expect([...a.executed, ...b.executed]).toEqual([])
  })

  it('an unreadable PR is logged as a PR that cannot merge, and never executed on a guess', async () => {
    const h = atOpenDeps({ readPr: async () => undefined })
    await requestReviewAtOpen({ pr: '1722', headRefName: 'fleet/android/1149', branchMismatch: undefined }, h.deps)
    expect(h.executed).toEqual([])
    expect(h.logs.join('\n')).toMatch(/cannot merge/)
  })

  it('an outcome that started no review is logged as the block it is, not as best-effort silence', async () => {
    const h = atOpenDeps({
      execute: async (t) => ({
        number: t.number,
        candidates: [REVIEW_REQUEST_LOGIN],
        outcome: { kind: 'already-pending', pending: [REVIEW_REQUEST_LOGIN], advice: ['do the thing'] },
      }),
    })
    await requestReviewAtOpen({ pr: '1722', headRefName: 'fleet/android/1149', branchMismatch: undefined }, h.deps)
    expect(h.logs.join('\n')).toMatch(/NO review started and cannot merge/)
  })

  it('never throws into the dispatch, but still says the PR cannot merge', async () => {
    const h = atOpenDeps({ execute: async () => { throw new Error('github down') } })
    await expect(
      requestReviewAtOpen({ pr: '1722', headRefName: 'fleet/android/1149', branchMismatch: undefined }, h.deps),
    ).resolves.toBeUndefined()
    expect(h.logs.join('\n')).toMatch(/cannot merge/)
  })
})

describe('runRequestReview — the CLI wrapper', () => {
  const okRead = async () => ({ number: 1722, author: { login: 'rhonda-rodododo' }, headRefName: 'fleet/android/1149' })

  it('usage and exit 2 on a missing or non-numeric argument, with no calls made', async () => {
    const gh = new FakeGitHub()
    const out: string[] = []
    for (const arg of [undefined, 'not-a-number', '12a']) {
      expect(await runRequestReview(arg, okRead, gh.deps(), (t) => out.push(t))).toBe(2)
    }
    expect(gh.calls).toEqual([])
    expect(out.every((t) => t.includes('usage:'))).toBe(true)
  })

  it('exit 1 with no calls made when the PR cannot be read', async () => {
    const gh = new FakeGitHub()
    const out: string[] = []
    expect(await runRequestReview('1722', async () => undefined, gh.deps(), (t) => out.push(t))).toBe(1)
    expect(await runRequestReview('1722', async () => { throw new Error('gh exploded') }, gh.deps(), (t) => out.push(t))).toBe(1)
    expect(gh.calls).toEqual([])
  })

  it('refuses to guess who may be asked when the PR has no readable author', async () => {
    const gh = new FakeGitHub()
    const out: string[] = []
    const code = await runRequestReview(
      '1722', async () => ({ number: 1722, author: null, headRefName: 'fleet/android/1149' }), gh.deps(), (t) => out.push(t),
    )
    expect(code).toBe(1)
    expect(gh.calls).toEqual([])
    expect(out.join('')).toMatch(/no readable author/)
  })

  it('exit 0 and a rendered outcome on a confirmed request', async () => {
    const gh = new FakeGitHub()
    const out: string[] = []
    expect(await runRequestReview('1722', okRead, gh.deps(), (t) => out.push(t))).toBe(0)
    expect(gh.reviewRequestedEvents).toBe(1)
    expect(out.join('')).toMatch(/review requested from llamenos-auto/)
  })
})
