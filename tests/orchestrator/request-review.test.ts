import { describe, it, expect } from 'vitest'
import {
  executeRequestReview, describeRequestReview, requestReviewExitCode,
  reviewerFor, reviewerIsAuthor, runRequestReview,
  REVIEW_LABEL, REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN,
  type RequestReviewDeps, type RequestReviewTarget,
} from '../../orchestrator/src/request-review.js'
import { KNOPE_RELEASE_BRANCH } from '../../orchestrator/src/roles/release.js'

interface Recorder {
  deps: RequestReviewDeps
  calls: string[]
  logs: string[]
}

/** Every call recorded in order. `fail` names the calls that should throw,
 *  keyed by the same string the recorder logs, so a test says "the POST that
 *  requests the reviewer fails" without stubbing the other three. */
function recorder(fail: Record<string, string> = {}): Recorder {
  const calls: string[] = []
  const logs: string[] = []
  const record = async (name: string): Promise<void> => {
    calls.push(name)
    const why = fail[name]
    if (why !== undefined) throw Object.assign(new Error(why), { code: 1, stderr: why })
  }
  return {
    calls,
    logs,
    deps: {
      addLabel: (pr, label) => record(`addLabel:${pr}:${label}`),
      removeLabel: (pr, label) => record(`removeLabel:${pr}:${label}`),
      requestReviewer: (pr, login) => record(`requestReviewer:${pr}:${login}`),
      removeRequestedReviewer: (pr, login) => record(`removeRequestedReviewer:${pr}:${login}`),
      log: (m) => { logs.push(m) },
    },
  }
}

const target = (o: Partial<RequestReviewTarget> = {}): RequestReviewTarget => ({
  number: 42, authorLogin: 'rhonda-rodododo', headRefName: 'fleet/backend/7', ...o,
})

describe('reviewerFor — who a review is requested from', () => {
  it('is llamenos-auto on an ordinary branch', () => {
    expect(reviewerFor('fleet/backend/7')).toBe(REVIEW_REQUEST_LOGIN)
    expect(reviewerFor('fix/1158-whatever')).toBe(REVIEW_REQUEST_LOGIN)
  })

  // The release PR is OPENED by llamenos-auto, so llamenos-auto cannot also
  // review it — the operator is who actually reads a release PR.
  it('is the operator, not llamenos-auto, on the knope release branch', () => {
    expect(reviewerFor(KNOPE_RELEASE_BRANCH)).toBe(RELEASE_REVIEW_REQUEST_LOGIN)
    expect(RELEASE_REVIEW_REQUEST_LOGIN).not.toBe(REVIEW_REQUEST_LOGIN)
  })
})

describe('reviewerIsAuthor — the case GitHub refuses outright', () => {
  it('the routine release PR is NOT a self-review: the reviewer is switched away from its author', () => {
    expect(reviewerIsAuthor(KNOPE_RELEASE_BRANCH, REVIEW_REQUEST_LOGIN)).toBe(false)
  })

  it('a llamenos-auto-authored PR on any OTHER branch is a self-review', () => {
    expect(reviewerIsAuthor('fleet/backend/7', REVIEW_REQUEST_LOGIN)).toBe(true)
  })

  it('an operator-authored release PR is a self-review too', () => {
    expect(reviewerIsAuthor(KNOPE_RELEASE_BRANCH, RELEASE_REVIEW_REQUEST_LOGIN)).toBe(true)
  })

  it('is case-insensitive — GitHub logins compare case-insensitively', () => {
    expect(reviewerIsAuthor('fleet/backend/7', 'Llamenos-Auto')).toBe(true)
  })
})

describe('executeRequestReview — BOTH triggers are emitted, always', () => {
  // The whole point of #1158's migration step: whichever fleet-review.yml is
  // deployed (labeled, or review_requested), the fleet emits the event it
  // listens for. Dropping either half reopens the window in which nothing
  // can start a review.
  it('applies the review label AND requests the reviewer on one happy invocation', async () => {
    const r = recorder()
    const result = await executeRequestReview(target(), r.deps)

    expect(result.label).toEqual({ kind: 'ok' })
    expect(result.request).toEqual({ kind: 'ok' })
    expect(r.calls).toContain(`addLabel:42:${REVIEW_LABEL}`)
    expect(r.calls).toContain(`requestReviewer:42:${REVIEW_REQUEST_LOGIN}`)
    expect(requestReviewExitCode(result)).toBe(0)
  })

  // Re-applying a label a PR already carries emits no `labeled` event, and
  // re-requesting a reviewer already on the list emits no `review_requested`
  // event — so each half must clear before it re-applies, or a PR pushed to
  // since its last request never re-triggers.
  it('removes before adding, for BOTH halves, so each emits a fresh event', async () => {
    const r = recorder()
    await executeRequestReview(target(), r.deps)

    expect(r.calls).toEqual([
      `removeLabel:42:${REVIEW_LABEL}`,
      `addLabel:42:${REVIEW_LABEL}`,
      `removeRequestedReviewer:42:${REVIEW_REQUEST_LOGIN}`,
      `requestReviewer:42:${REVIEW_REQUEST_LOGIN}`,
    ])
  })

  it('a failing clear is best-effort — the label is not applied and the reviewer is not requested on a first pass', async () => {
    const r = recorder({
      [`removeLabel:42:${REVIEW_LABEL}`]: 'label not found',
      [`removeRequestedReviewer:42:${REVIEW_REQUEST_LOGIN}`]: 'reviewer not requested',
    })
    const result = await executeRequestReview(target(), r.deps)

    expect(result.label).toEqual({ kind: 'ok' })
    expect(result.request).toEqual({ kind: 'ok' })
    expect(requestReviewExitCode(result)).toBe(0)
  })

  it('requests the operator, not llamenos-auto, on the release branch', async () => {
    const r = recorder()
    const result = await executeRequestReview(
      target({ number: 1161, authorLogin: REVIEW_REQUEST_LOGIN, headRefName: KNOPE_RELEASE_BRANCH }), r.deps)

    expect(result.reviewer).toBe(RELEASE_REVIEW_REQUEST_LOGIN)
    expect(result.request).toEqual({ kind: 'ok' })
    expect(r.calls).toContain(`requestReviewer:1161:${RELEASE_REVIEW_REQUEST_LOGIN}`)
  })
})

describe('executeRequestReview — one half failing never costs the other', () => {
  // A permissions problem on labels must not cost the review request that
  // #1164's workflow needs, and a refused review request must not cost the
  // label that the currently-deployed workflow needs.
  it('a failed label still leaves the review request issued', async () => {
    const r = recorder({ [`addLabel:42:${REVIEW_LABEL}`]: 'HTTP 403: Resource not accessible' })
    const result = await executeRequestReview(target(), r.deps)

    expect(result.label.kind).toBe('failed')
    expect(result.request).toEqual({ kind: 'ok' })
    expect(r.calls).toContain(`requestReviewer:42:${REVIEW_REQUEST_LOGIN}`)
  })

  it('a failed review request still leaves the label applied', async () => {
    const r = recorder({ [`requestReviewer:42:${REVIEW_REQUEST_LOGIN}`]: 'HTTP 422: Reviews may only be requested from collaborators' })
    const result = await executeRequestReview(target(), r.deps)

    expect(result.request.kind).toBe('failed')
    expect(result.label).toEqual({ kind: 'ok' })
    expect(r.calls).toContain(`addLabel:42:${REVIEW_LABEL}`)
  })

  it('never throws, even when every call fails', async () => {
    const r = recorder({
      [`addLabel:42:${REVIEW_LABEL}`]: 'boom',
      [`removeLabel:42:${REVIEW_LABEL}`]: 'boom',
      [`requestReviewer:42:${REVIEW_REQUEST_LOGIN}`]: 'boom',
      [`removeRequestedReviewer:42:${REVIEW_REQUEST_LOGIN}`]: 'boom',
    })
    const result = await executeRequestReview(target(), r.deps)
    expect(result.label.kind).toBe('failed')
    expect(result.request.kind).toBe('failed')
  })
})

describe('a partial success is LOUD — never a silently dropped review', () => {
  it('exits non-zero when only the label fired', async () => {
    const r = recorder({ [`requestReviewer:42:${REVIEW_REQUEST_LOGIN}`]: 'HTTP 422' })
    const result = await executeRequestReview(target(), r.deps)
    expect(requestReviewExitCode(result)).toBe(1)
  })

  it('exits non-zero when only the request fired', async () => {
    const r = recorder({ [`addLabel:42:${REVIEW_LABEL}`]: 'HTTP 403' })
    const result = await executeRequestReview(target(), r.deps)
    expect(requestReviewExitCode(result)).toBe(1)
  })

  it('names BOTH halves in the rendered output, and says INCOMPLETE when one failed', async () => {
    const r = recorder({ [`requestReviewer:42:${REVIEW_REQUEST_LOGIN}`]: 'HTTP 422: nope' })
    const text = describeRequestReview(await executeRequestReview(target(), r.deps))

    expect(text).toContain('INCOMPLETE')
    expect(text).toContain(`apply the "${REVIEW_LABEL}" label`)
    expect(text).toContain(`request a review from ${REVIEW_REQUEST_LOGIN}`)
    expect(text).toContain('FAIL')
    expect(text).toContain('HTTP 422')
  })

  it('logs the failure too — the board/journal sees it, not just the return value', async () => {
    const r = recorder({ [`requestReviewer:42:${REVIEW_REQUEST_LOGIN}`]: 'HTTP 422: nope' })
    await executeRequestReview(target(), r.deps)
    expect(r.logs.some((l) => l.includes('REVIEW REQUEST FAILED'))).toBe(true)
  })

  it('says "review started" and exits 0 only when both fired', async () => {
    const r = recorder()
    const result = await executeRequestReview(target(), r.deps)
    expect(describeRequestReview(result)).toContain('review started')
    expect(requestReviewExitCode(result)).toBe(0)
  })
})

describe('the PR whose author is its own reviewer', () => {
  // GitHub returns 422 for a review request naming the PR's author. The
  // fleet refuses by name rather than quietly picking someone else: a
  // request at an account fleet-review.yml does not recognise looks sent
  // and starts nothing, which is exactly the silent failure #1158 removes.
  it('does not attempt the impossible request, and reports it as SKIP, not ok', async () => {
    const r = recorder()
    const result = await executeRequestReview(target({ authorLogin: REVIEW_REQUEST_LOGIN }), r.deps)

    expect(result.request.kind).toBe('skipped')
    expect(r.calls.some((c) => c.startsWith('requestReviewer:'))).toBe(false)
    expect(r.calls.some((c) => c.startsWith('removeRequestedReviewer:'))).toBe(false)
  })

  it('still applies the label — the currently-deployed workflow can still start this review', async () => {
    const r = recorder()
    const result = await executeRequestReview(target({ authorLogin: REVIEW_REQUEST_LOGIN }), r.deps)
    expect(result.label).toEqual({ kind: 'ok' })
    expect(r.calls).toContain(`addLabel:42:${REVIEW_LABEL}`)
  })

  it('exits non-zero and names the author — an unstartable review is never reported as done', async () => {
    const r = recorder()
    const result = await executeRequestReview(target({ authorLogin: REVIEW_REQUEST_LOGIN }), r.deps)
    const text = describeRequestReview(result)

    expect(requestReviewExitCode(result)).toBe(1)
    expect(text).toContain('INCOMPLETE')
    expect(text).toContain(REVIEW_REQUEST_LOGIN)
    expect(text).toContain("own author")
  })
})

describe('runRequestReview — the CLI wrapper', () => {
  const read = async (n: string) => ({ number: Number(n), author: { login: 'rhonda-rodododo' }, headRefName: 'fleet/backend/7' })

  it('refuses a missing or non-numeric argument with usage and exit 2', async () => {
    const r = recorder()
    const out: string[] = []
    expect(await runRequestReview(undefined, read, r.deps, (t) => out.push(t))).toBe(2)
    expect(await runRequestReview('not-a-number', read, r.deps, (t) => out.push(t))).toBe(2)
    expect(out.every((t) => t.includes('usage:'))).toBe(true)
    expect(r.calls).toEqual([])
  })

  it('exits 0 and writes the report on a happy path', async () => {
    const r = recorder()
    const out: string[] = []
    expect(await runRequestReview('42', read, r.deps, (t) => out.push(t))).toBe(0)
    expect(out.join('')).toContain('review started')
  })

  it('surfaces a failure to read the PR instead of acting on a guess', async () => {
    const r = recorder()
    const out: string[] = []
    const boom = async (): Promise<never> => { throw new Error('gh exploded') }
    expect(await runRequestReview('42', boom, r.deps, (t) => out.push(t))).toBe(1)
    expect(out.join('')).toContain('could not read the PR')
    expect(r.calls).toEqual([])
  })

  it('refuses when the PR has no readable author — the self-review check cannot be made', async () => {
    const r = recorder()
    const out: string[] = []
    const noAuthor = async (n: string) => ({ number: Number(n), author: null, headRefName: 'fleet/backend/7' })
    expect(await runRequestReview('42', noAuthor, r.deps, (t) => out.push(t))).toBe(1)
    expect(out.join('')).toContain('no readable author')
    expect(r.calls).toEqual([])
  })
})
