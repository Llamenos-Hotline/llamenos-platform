import { REPO, gh, ghJson, describeGhFailure } from './gh.js'
import { reviewTriggerLogins, REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN } from './ci.js'
import { isFleetOwnedBranch } from './automerge.js'

/**
 * Requesting the review the `fleet/review` gate waits on — at PR open, from
 * the orchestrator, where it is version-controlled and testable (#1760).
 *
 * `fleet/review` fires ONLY on a `review_requested` event (plus the
 * republish-only `synchronize`, which can never START a review — see ci.ts's
 * `REVIEW_REPUBLISH_ACTION`). A push is not a request. Before this module
 * existed, nothing in the PR-open path ever made the request, so every PR
 * the fleet opened was born with `requested_reviewers` empty and a
 * `fleet/review` that could only ever republish `NO-VERDICT:unreviewed` —
 * permanently BLOCKED, because nothing a worker does next can start the
 * gate. Seven PRs sat dead in exactly that state on 2026-10-09, and #1749
 * then merged with no code changes at all once a review was requested by
 * hand: the work had been mergeable the whole time, waiting on a POST
 * nobody made.
 *
 * The three rules this module exists to honour, all measured live:
 *
 * 1. CONFIRM BY EVENT COUNT, NEVER BY THE POST RESPONSE. A POST naming a
 *    reviewer who is ALREADY PENDING returns success and emits no
 *    `review_requested` event (ci.ts's `reviewNotRequestedAdvice` documents
 *    this dead end in full, from #1471). So the success signal is the
 *    `issues/<n>/events` `review_requested` count advancing, and when it
 *    does not advance the recovery is DELETE the reviewer, then POST again.
 *
 * 2. AN ALREADY-PENDING TRIGGER REVIEWER AT PR OPEN IS SUCCESS, NOT A
 *    RETRY. CODEOWNERS auto-requests `rhonda-rodododo` the moment a PR over
 *    an owned path opens, and THAT request emits the event and fires the
 *    gate. Re-firing buys nothing — and for a CODEOWNER it cannot even be
 *    done: GitHub re-adds a CODEOWNER's request the instant it is removed,
 *    so DELETE answers 200 while changing nothing and the follow-up POST
 *    no-ops. Detecting the pending request up front is what keeps this
 *    module out of the loop #1471 measured as unable to terminate.
 *
 * 3. NEVER ASK THE AUTHOR. GitHub refuses with HTTP 422 `Review cannot be
 *    requested from pull request author`. Whom to ask is
 *    `reviewTriggerLogins`'s decision (ci.ts) over the PR's LIVE author —
 *    `llamenos-auto` on any PR it did not write, the operator as stand-in
 *    on one it did (#1232). When the author cannot be read, the primary is
 *    tried first and the stand-in is the fallback for the 422, because an
 *    author collision with an unknown author means the author IS
 *    `llamenos-auto`.
 *
 * Scope: fleet-owned branches only (`isFleetOwnedBranch` — this fleet's
 * dispatched branches and the knope release branch), same fence
 * `armStandardAutoMergeAtOpen` already applies to its own at-open write.
 * Best-effort by design: a PR born without a requested review is exactly
 * the dead state `board`'s REQUEST_REVIEW row names, and a dispatch that
 * throws because GitHub was briefly unreachable is strictly worse. Nothing
 * in this module throws out of `requestReviewAtOpen`.
 */

export interface ReviewRequestPrFacts {
  /** The PR's live author login — decides whom the gate may be asked from
   *  (`reviewTriggerLogins`). `undefined` when the read carried none. */
  author: string | undefined
  /** The PR's live `requested_reviewers` logins. */
  requestedReviewers: string[]
}

export interface ReviewRequestAtOpenDeps {
  /** The PR's author and pending reviewer list — `undefined` when the PR
   *  could not be read at all, which is NOT the same as empty: guessing a
   *  reviewer on a failed read can aim the request at the PR's own author. */
  readPr(pr: string): Promise<ReviewRequestPrFacts | undefined>
  /** The PR's `review_requested` ISSUE-event count — the ONLY confirmation a
   *  request really fired (#1760 rule 1). `undefined` when the events could
   *   not be read: "could not look" must never read as "nothing fired". */
  countReviewRequestedEvents(pr: string): Promise<number | undefined>
  /** `POST /pulls/<n>/requested_reviewers` for one login. THROWS on
   *  failure — including the HTTP 422 author collision, which the caller
   *  recognises by message (`isAuthorCollision`). */
  postRequestedReviewer(pr: string, login: string): Promise<void>
  /** `DELETE /pulls/<n>/requested_reviewers` for one login — the first half
   *  of the count-stalled recovery. THROWS on failure; a throw here is
   *  logged and the re-read below still runs (the request may be pending
   *  anyway — the CODEOWNERS race this recovery exists for). */
  deleteRequestedReviewer(pr: string, login: string): Promise<void>
  log(msg: string): void
}

export type ReviewRequestOutcome =
  /** Nothing to do and nothing attempted — no PR, a mismatched branch, or
   *  a branch this fleet does not own. */
  | { kind: 'skipped'; reason: string }
  /** A trigger reviewer was ALREADY pending when the PR was read: the
   *  request exists, its `review_requested` event already fired (at open,
   *  via CODEOWNERS or the worker's own request), and the gate is already
   *  running. No POST was made — one would be a guaranteed no-op (#1471). */
  | { kind: 'already-pending'; reviewer: string }
  /** The event count advanced after this module's POST — the review was
   *  requested and the gate fired. `reRequested: true` means the plain
   *  POST did not advance the count and the DELETE+POST recovery did. */
  | { kind: 'requested'; reviewer: string; reRequested: boolean }
  /** The POST was accepted but the event count could not be READ, so
   *  whether the request fired is unknown — never reported as success
   *  (rule 1: the POST response proves nothing), never as failure either:
   *  the request probably exists. `board` is the backstop that names the
   *  PR if it truly did not fire. */
  | { kind: 'unverified'; reviewer: string; reason: string }
  /** No trigger reviewer could be asked and confirmed — the PR is in the
   *  born-dead state #1760 names, and the log line says why. */
  | { kind: 'failed'; reason: string }

/** GitHub's exact refusal when the POST names the PR's own author (HTTP
 *  422). Matched case-insensitively against gh's stderr/message — a 422
 *  for any OTHER reason (validation, permissions) is NOT this, and must
 *  not route to the stand-in. */
export function isAuthorCollision(e: unknown): boolean {
  const err = e as { stderr?: unknown; message?: unknown }
  const text = `${typeof err.stderr === 'string' ? err.stderr : ''} ${typeof err.message === 'string' ? err.message : String(e)}`
  return text.toLowerCase().includes('cannot be requested from pull request author')
}

/** Case-insensitive login membership — GitHub logins compare case-folded
 *  everywhere else in this codebase (`loginOf`, ci.ts). */
function hasLogin(logins: readonly string[], login: string): boolean {
  const needle = login.trim().toLowerCase()
  return logins.some((l) => l.trim().toLowerCase() === needle)
}

/**
 * The reads go through these wrappers so the "best-effort, never throws"
 * contract holds even when a DEP violates its own "undefined on failure"
 * half of it: a throw collapses to the same `undefined` the contract
 * already defines for "could not look", and the log names what happened —
 * a dispatch must never die because an events read hit a network blip.
 */
async function readPrSafe(pr: string, deps: ReviewRequestAtOpenDeps): Promise<ReviewRequestPrFacts | undefined> {
  try {
    return await deps.readPr(pr)
  } catch (e) {
    deps.log(`review-request: reading PR ${pr} threw (${describeGhFailure(e)}) — treated as unreadable`)
    return undefined
  }
}

async function countSafe(pr: string, deps: ReviewRequestAtOpenDeps): Promise<number | undefined> {
  try {
    return await deps.countReviewRequestedEvents(pr)
  } catch (e) {
    deps.log(`review-request: counting PR ${pr}'s events threw (${describeGhFailure(e)}) — treated as unreadable`)
    return undefined
  }
}

/**
 * The logins to try, in order: `reviewTriggerLogins` over the live author
 * and branch, plus the operator stand-in appended when the author is
 * UNKNOWN. With a known author the trigger list already never contains the
 * author; with an unknown one it defaults to `REVIEW_REQUEST_LOGIN`, which
 * collides (422) precisely when the unreadable author is `llamenos-auto`
 * itself — so the stand-in must be reachable from this path (#1232's route,
 * kept open under a failed read).
 */
export function reviewRequestCandidates(prAuthor: string | undefined, branch: string): string[] {
  const candidates = [...reviewTriggerLogins({ prAuthor, branch })]
  if (prAuthor === undefined && !hasLogin(candidates, RELEASE_REVIEW_REQUEST_LOGIN)) {
    candidates.push(RELEASE_REVIEW_REQUEST_LOGIN)
  }
  return candidates
}

/**
 * The one entry point — called from `realDispatch` (cli.ts) the moment a
 * dispatched item's PR is known to exist on the branch it was dispatched
 * for, beside `ensureIssueLinkWith` and `armStandardAutoMergeAtOpen`.
 * Never throws: every dep call is wrapped, and the worst outcome is a
 * `failed` log line plus the dead state `board` already names.
 */
export async function requestReviewAtOpen(
  input: { pr: string | undefined; headRefName: string; branchMismatch: string | undefined },
  deps: ReviewRequestAtOpenDeps,
): Promise<ReviewRequestOutcome> {
  const { pr, headRefName, branchMismatch } = input
  if (pr === undefined) return { kind: 'skipped', reason: 'no PR was opened' }
  if (branchMismatch !== undefined) {
    return { kind: 'skipped', reason: `branch-mismatch:${branchMismatch} — the PR is not on the branch this item was dispatched for` }
  }
  if (!isFleetOwnedBranch(headRefName)) {
    return { kind: 'skipped', reason: `${headRefName} is not a fleet-owned branch` }
  }

  const facts = await readPrSafe(pr, deps)
  if (facts === undefined) {
    const reason = `could not read PR ${pr}'s author/requested reviewers — not guessing whom to ask`
    deps.log(`review-request: pr ${pr} FAILED — ${reason}`)
    return { kind: 'failed', reason }
  }

  const candidates = reviewRequestCandidates(facts.author, headRefName)
  for (const candidate of candidates) {
    // Rule 2: a pending trigger reviewer at PR open is the goal state
    // already — its event fired when the request was made (seconds ago, by
    // CODEOWNERS or the worker). Checking FIRST is also what keeps the
    // DELETE+POST recovery below from ever running against a CODEOWNER,
    // where it provably cannot advance the count (#1471).
    if (hasLogin(facts.requestedReviewers, candidate)) {
      deps.log(
        `review-request: pr ${pr} ${candidate} is already a requested reviewer — ` +
        'the request already fired the gate; not re-requesting',
      )
      return { kind: 'already-pending', reviewer: candidate }
    }

    const before = await countSafe(pr, deps)

    try {
      await deps.postRequestedReviewer(pr, candidate)
    } catch (e) {
      if (isAuthorCollision(e)) {
        // Rule 3: the author can never be asked. The live-author read said
        // this login was safe, so a collision here means the read lied or
        // raced — try the next candidate rather than giving up on the PR.
        deps.log(
          `review-request: pr ${pr} GitHub refused ${candidate} — it authored the PR ` +
          `(422, despite the live read naming author ${facts.author ?? '(unknown)'}); trying the next candidate`,
        )
        continue
      }
      const reason = `POST requested_reviewers for ${candidate} failed: ${describeGhFailure(e)}`
      deps.log(`review-request: pr ${pr} FAILED — ${reason}`)
      return { kind: 'failed', reason }
    }

    // Rule 1: the POST's success is not the signal — the event count is.
    const after = await countSafe(pr, deps)
    if (before === undefined || after === undefined) {
      const reason = 'the review_requested event count could not be read, so whether the request fired is unknown'
      deps.log(`review-request: pr ${pr} POSTed ${candidate} but ${reason}`)
      return { kind: 'unverified', reviewer: candidate, reason }
    }
    if (after > before) {
      deps.log(`review-request: pr ${pr} requested a review from ${candidate} (events ${before} -> ${after})`)
      return { kind: 'requested', reviewer: candidate, reRequested: false }
    }

    // The count did not advance: the plain POST silently no-op'd. The
    // measured recovery (#1760 rule 1) is DELETE then POST again. Either
    // half throwing is logged and falls through to the pending re-check —
    // a DELETE that "fails" can still have raced a CODEOWNERS re-add, and
    // what matters is whether the request EXISTS, not which call landed.
    deps.log(
      `review-request: pr ${pr} POST for ${candidate} returned success but the event count did not advance ` +
      `(${before} -> ${after}) — deleting the reviewer and posting again`,
    )
    try { await deps.deleteRequestedReviewer(pr, candidate) } catch (e) {
      deps.log(`review-request: pr ${pr} DELETE ${candidate} failed (${describeGhFailure(e)}) — continuing to the re-POST`)
    }
    try { await deps.postRequestedReviewer(pr, candidate) } catch (e) {
      deps.log(`review-request: pr ${pr} re-POST ${candidate} failed (${describeGhFailure(e)}) — falling through to the pending re-check`)
    }
    const afterRetry = await countSafe(pr, deps)
    if (afterRetry !== undefined && afterRetry > before) {
      deps.log(`review-request: pr ${pr} requested a review from ${candidate} after the DELETE+POST recovery (events ${before} -> ${afterRetry})`)
      return { kind: 'requested', reviewer: candidate, reRequested: true }
    }

    // Ground truth over the count: if the request now EXISTS, an event
    // fired for it at some point in this sequence (a request that was never
    // added cannot be pending) — the CODEOWNERS race, where the auto-request
    // landed between our first read and our POST and every call after was a
    // no-op. That is the gate already firing, not a failure.
    const reread = await readPrSafe(pr, deps)
    if (reread !== undefined && hasLogin(reread.requestedReviewers, candidate)) {
      deps.log(
        `review-request: pr ${pr} ${candidate} is pending after the DELETE+POST recovery without the count ` +
        'advancing — the request exists (a CODEOWNERS auto-request landed mid-sequence, or the event ' +
        'stream lagged), so the gate has its trigger; not treating this as a failure',
      )
      return { kind: 'requested', reviewer: candidate, reRequested: true }
    }

    // Truly stuck: no event, and the request does not even exist. ci.ts's
    // `reviewNotRequestedAdvice` documents the shape this can still take
    // (a CODEOWNER's request GitHub re-adds the instant it is removed);
    // the remedy there needs the REQUESTED reviewer's identity, which this
    // process is not — so name it, loudly, and let `board`'s REQUEST_REVIEW
    // row surface the PR to a human.
    const reason =
      `the review request for ${candidate} did not fire: the POST returned success, the DELETE+POST recovery ` +
      'ran, and no `review_requested` event was ever emitted — the shape ci.ts documents for a CODEOWNER ' +
      'whose request GitHub re-adds instantly (#1471). This PR will sit at NO-VERDICT:unreviewed until a ' +
      'review is requested by hand.'
    deps.log(`review-request: pr ${pr} FAILED — ${reason}`)
    return { kind: 'failed', reason }
  }

  const reason = `no trigger login could be asked — every candidate (${candidates.join(', ')}) collided with the PR's author`
  deps.log(`review-request: pr ${pr} FAILED — ${reason}`)
  return { kind: 'failed', reason }
}

/**
 * The live deps, wired the way every other orchestrator module wires them:
 * `gh` by argv (never a shell), the repo pinned by `REPO`, reads returning
 * `undefined` on failure and writes throwing.
 */
export function defaultReviewRequestAtOpenDeps(log: (msg: string) => void): ReviewRequestAtOpenDeps {
  return {
    readPr: async (pr) => {
      const data = await ghJson<{
        user?: { login?: string | null } | null
        requested_reviewers?: { login?: string | null }[] | null
      }>(
        ['api', `repos/${REPO}/pulls/${pr}`],
        30_000,
        (detail) => log(`review-request: reading PR ${pr} failed — not guessing whom to ask: ${detail}`),
      )
      if (data === undefined) return undefined
      return {
        author: data.user?.login ?? undefined,
        requestedReviewers: (data.requested_reviewers ?? []).flatMap((r) => (r.login == null ? [] : [r.login])),
      }
    },
    countReviewRequestedEvents: async (pr) => {
      // `--paginate --slurp` reads EVERY page, the same pattern
      // `fetchBranchRules` (board.ts) already uses: a count off only the
      // first page is a before/after comparison that cannot advance on any
      // PR whose event list has filled page one — a false "not fired" on
      // exactly the retry path this count exists to verify.
      const pages = await ghJson<{ event?: string }[][]>(
        ['api', '--paginate', '--slurp', `repos/${REPO}/issues/${pr}/events?per_page=100`],
        30_000,
        (detail) => log(`review-request: reading PR ${pr}'s events failed: ${detail}`),
      )
      if (pages === undefined) return undefined
      return pages.flat().filter((e) => e.event === 'review_requested').length
    },
    postRequestedReviewer: async (pr, login) => {
      await gh(['api', '-X', 'POST', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-f', `reviewers[]=${login}`], 30_000)
    },
    deleteRequestedReviewer: async (pr, login) => {
      await gh(['api', '-X', 'DELETE', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-f', `reviewers[]=${login}`], 30_000)
    },
    log,
  }
}

/** Re-exported so callers wiring advice text do not import ci.ts twice. */
export { REVIEW_REQUEST_LOGIN }
