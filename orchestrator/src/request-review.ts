import { REPO, gh, ghJson, describeGhFailure } from './gh.js'
import { reviewTriggerLogins, reviewNotRequestedAdvice, REVIEW_REQUEST_LOGIN } from './ci.js'

/**
 * Requesting the non-author review that `fleet/review` is the check for —
 * the one act that can START one (#1158).
 *
 * ## Why this module exists at all
 *
 * `fleet-review.yml` triggers on `pull_request: types: [review_requested,
 * synchronize]`, and its own header states the split: `review_requested` is
 * the ONLY event that can start a review; `synchronize` may only REPUBLISH a
 * verdict the PR already earned (`isRepublishOnlyEvent`, ci.ts). `fleet/review`
 * is also a REQUIRED context. Put those two facts together and a PR nobody
 * requests a review on is not "unreviewed" — it is unmergeable, permanently,
 * with no path forward but a human requesting one by hand.
 *
 * Nothing in the fleet did that. Measured on #1722 (`fleet/android/1149`), the
 * first PR the lanes opened after their modes were corrected: `review_requested
 * events: 0`, `fleet/review` ABSENT on the head, blocked with no route out.
 * Requesting one by hand took the count 0 -> 1 and started a run immediately —
 * so the mechanism worked and nothing invoked it. This module is the invocation.
 *
 * ## What it does NOT do, and why
 *
 * It does not apply the `review` LABEL. That was this module's other half for
 * the length of the #1158 -> #1164 migration, when the deployed workflow still
 * triggered on `labeled`. #1164 has merged: the live workflow subscribes to
 * `review_requested` only, and `.github/labels.yml` has since deleted the
 * `review` label outright ("The retired `review` label is deliberately absent:
 * nothing fires on it"). Applying it would be an API call that reports success
 * and starts nothing — precisely the silent failure #1158 exists to remove. So
 * the label half is gone rather than kept "just in case" (#1169).
 *
 * It does not REMOVE-then-re-add the reviewer either, which was the other half
 * of that design. Two measured facts killed that idiom:
 *
 *  - re-requesting a login already on the request list emits NO
 *    `review_requested` event (#1471), so the POST half is a silent no-op; and
 *  - when the login is a CODEOWNER of a path the PR touches, GitHub PINS the
 *    request: the `DELETE` answers 200 with the login still listed and emits no
 *    `review_request_removed` (#1611). The DELETE half is a silent no-op too.
 *
 * Every command in that sequence reports success while nothing happens, which
 * is how eight PRs once sat red being told to run the one loop that cannot
 * terminate. So this module reads the LIVE request list first and only POSTs a
 * login that is genuinely absent — where GitHub's semantics make the POST a
 * true add that does emit the event. When every candidate is already pending it
 * says so and names the recovery that does work (`reviewNotRequestedAdvice`,
 * ci.ts, which is the single statement of it) instead of looping.
 *
 * ## Why the outcome is checked against the EVENT, not the API response
 *
 * A 201 from `POST .../requested_reviewers` is not evidence a review started:
 * the no-op above returns 201 as well. So `executeRequestReview` counts this
 * PR's `review_requested` timeline events before and after, and reports
 * `requested` only when that count went UP. A request that cannot be confirmed
 * that way is reported as unconfirmed and exits non-zero — never as done.
 */

/** How many times the event count is re-read before giving up on confirming
 *  the request. The timeline API is eventually consistent; one read that has
 *  not caught up yet is not evidence nothing fired. */
export const EVENT_CONFIRM_ATTEMPTS = 4

/** Gap between those re-reads. */
export const EVENT_CONFIRM_DELAY_MS = 2_000

/** Everything about a PR the decision needs. Both fields decide WHO may be
 *  asked (`reviewTriggerLogins`), so neither is re-derived here. */
export interface RequestReviewTarget {
  number: number
  authorLogin: string
  headRefName: string
}

/**
 * `requested` is the only outcome that means a review started, and it is only
 * ever returned on a CONFIRMED event-count increase.
 *
 * `already-pending` is the #1471/#1611 dead end: every login that could start
 * this PR's review is already on its request list, so no POST can emit an
 * event. Not a failure of this command, but not a success either — it is a PR
 * that needs the comment-review recovery, and `advice` carries it.
 *
 * `unconfirmed` is a POST that succeeded while the event count did not move or
 * could not be read. Deliberately NOT folded into `requested`: the whole point
 * of this module is that the API response is not the evidence.
 */
export type RequestReviewOutcome =
  | { kind: 'requested'; reviewer: string; eventsBefore: number; eventsAfter: number }
  | { kind: 'already-pending'; pending: string[]; advice: string[] }
  | { kind: 'unconfirmed'; reviewer: string; detail: string }
  | { kind: 'failed'; detail: string }

export interface RequestReviewResult {
  number: number
  /** Every login that could have started this PR's review, in the order
   *  `reviewTriggerLogins` ranks them. */
  candidates: string[]
  outcome: RequestReviewOutcome
}

export interface RequestReviewDeps {
  /** The PR's LIVE `requested_reviewers` logins. `undefined` on ANY read
   *  failure, which is NOT the same as empty: an unreadable list cannot rule
   *  out the no-op, so it must never be treated as "nobody is pending". */
  readRequestedReviewers(pr: number): Promise<string[] | undefined>
  /** `POST repos/{repo}/pulls/{n}/requested_reviewers`. */
  requestReviewer(pr: number, login: string): Promise<void>
  /** How many `review_requested` events this PR's timeline carries.
   *  `undefined` on any read failure. */
  countReviewRequestEvents(pr: number): Promise<number | undefined>
  sleep(ms: number): Promise<void>
  log(msg: string): void
}

/** GitHub logins are case-insensitive. */
function sameLogin(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Re-reads the event count until it exceeds `before`, or the attempts run out.
 * Returns the count that confirmed it, or `undefined` if none did — including
 * when the count itself could not be read, since "could not look" and "nothing
 * fired" must not collapse into the same answer for the caller.
 */
async function confirmEvent(
  pr: number,
  before: number,
  deps: RequestReviewDeps,
): Promise<number | undefined> {
  for (let attempt = 0; attempt < EVENT_CONFIRM_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.sleep(EVENT_CONFIRM_DELAY_MS)
    const after = await deps.countReviewRequestEvents(pr)
    if (after !== undefined && after > before) return after
  }
  return undefined
}

/**
 * Requests the non-author review on one PR, and reports what actually
 * happened to the `review_requested` event count rather than what the API
 * answered. Never throws: every failure lands on the returned result so a
 * caller at PR open cannot be made to abort by a GitHub blip.
 */
export async function executeRequestReview(
  target: RequestReviewTarget,
  deps: RequestReviewDeps,
): Promise<RequestReviewResult> {
  const candidates = reviewTriggerLogins({ prAuthor: target.authorLogin, branch: target.headRefName })
  const fail = (detail: string): RequestReviewResult => {
    deps.log(`request-review: #${target.number} REVIEW REQUEST FAILED — ${detail}`)
    return { number: target.number, candidates: [...candidates], outcome: { kind: 'failed', detail } }
  }

  // `undefined` is "could not look", never "nobody is pending" — the two must
  // not collapse, so an unreadable list skips the deterministic dead-end check
  // below rather than being read as an empty one. The event count still
  // decides the outcome, so a blind POST cannot be reported as a success it
  // was not.
  const pending = await deps.readRequestedReviewers(target.number)
  if (pending !== undefined && candidates.every((login) => pending.some((p) => sameLogin(p, login)))) {
    const advice = reviewNotRequestedAdvice({
      pr: String(target.number),
      branch: target.headRefName,
      ask: candidates[0],
      isAuthorStandIn: sameLogin(target.authorLogin, REVIEW_REQUEST_LOGIN),
      alreadyRequested: pending,
    })
    deps.log(
      `request-review: #${target.number} NOTHING TO REQUEST — ${candidates.join(', ')} already pending; ` +
      'a re-request emits no event (#1471) and a CODEOWNER request cannot be removed (#1611)',
    )
    return {
      number: target.number,
      candidates: [...candidates],
      outcome: { kind: 'already-pending', pending: [...pending], advice },
    }
  }
  const ask = candidates.find((login) => pending?.some((p) => sameLogin(p, login)) !== true) ?? candidates[0]

  const before = await deps.countReviewRequestEvents(target.number)
  try {
    await deps.requestReviewer(target.number, ask)
  } catch (e) {
    return fail(`requesting a review from ${ask} failed — ${describeGhFailure(e)}`)
  }

  if (before === undefined) {
    const detail = `requested a review from ${ask}, but this PR's review_requested event count could not be read ` +
      'before the request, so the request is unconfirmed — check `issues/<n>/events`'
    deps.log(`request-review: #${target.number} UNCONFIRMED — ${detail}`)
    return { number: target.number, candidates: [...candidates], outcome: { kind: 'unconfirmed', reviewer: ask, detail } }
  }

  const after = await confirmEvent(target.number, before, deps)
  if (after === undefined) {
    const detail = `the POST for ${ask} succeeded but this PR's review_requested event count did not rise above ` +
      `${before} — no review was started, whatever the API answered`
    deps.log(`request-review: #${target.number} UNCONFIRMED — ${detail}`)
    return { number: target.number, candidates: [...candidates], outcome: { kind: 'unconfirmed', reviewer: ask, detail } }
  }

  deps.log(`request-review: #${target.number} review requested from ${ask} (review_requested events ${before} -> ${after})`)
  return {
    number: target.number,
    candidates: [...candidates],
    outcome: { kind: 'requested', reviewer: ask, eventsBefore: before, eventsAfter: after },
  }
}

/** One block that always names the PR, who could have been asked, and what
 *  happened to the event count — so an outcome that started no review cannot
 *  read like one that did. */
export function describeRequestReview(result: RequestReviewResult): string {
  const { number, candidates, outcome } = result
  const head = `request-review #${number} (could ask: ${candidates.join(', ')})`
  switch (outcome.kind) {
    case 'requested':
      return `${head}\n  ok    review requested from ${outcome.reviewer} — review_requested events ` +
        `${outcome.eventsBefore} -> ${outcome.eventsAfter}`
    case 'already-pending':
      return [
        `${head}\n  BLOCKED  no review can be started by request: ${outcome.pending.join(', ')} already pending`,
        ...outcome.advice.map((line) => `  - ${line}`),
      ].join('\n')
    case 'unconfirmed':
      return `${head}\n  UNCONFIRMED  ${outcome.detail}`
    case 'failed':
      return `${head}\n  FAIL  ${outcome.detail}`
  }
}

/** Non-zero for anything but a CONFIRMED request. `already-pending` and
 *  `unconfirmed` both leave the PR with no review started, so neither may
 *  exit 0 and read as done. */
export function requestReviewExitCode(result: RequestReviewResult): number {
  return result.outcome.kind === 'requested' ? 0 : 1
}

interface TimelineEvent { event?: string | null }

export function defaultRequestReviewDeps(log: (msg: string) => void): RequestReviewDeps {
  return {
    readRequestedReviewers: async (pr) => {
      const data = await ghJson<{ requested_reviewers?: { login?: string | null }[] | null }>(
        ['api', `repos/${REPO}/pulls/${pr}`],
      )
      if (data === undefined) return undefined
      return (data.requested_reviewers ?? []).flatMap((r) => (r.login == null ? [] : [r.login]))
    },
    // `pulls/{n}/requested_reviewers` takes a `reviewers` ARRAY — a bare
    // `reviewer=<login>` field is silently ignored by the API and requests
    // nobody. `-f 'reviewers[]=<login>'` is how `gh api` spells a
    // single-element array.
    requestReviewer: async (pr, login) => {
      await gh(['api', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-X', 'POST', '-f', `reviewers[]=${login}`])
    },
    // The ISSUE timeline, not the pull one: `issues/{n}/events` is where
    // `review_requested` lands, and it is the read the gate's own advice
    // tells a reader to trust over `reviewRequests` (ci.ts).
    countReviewRequestEvents: async (pr) => {
      const events = await ghJson<TimelineEvent[]>(
        ['api', '--paginate', `repos/${REPO}/issues/${pr}/events?per_page=100`],
      )
      if (events === undefined) return undefined
      return events.filter((e) => e.event === 'review_requested').length
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  }
}

export interface RequestReviewAtOpenDeps {
  /** `undefined` on any read failure, matching `ghJson`'s own contract. */
  readPr(pr: string): Promise<{ number: number; authorLogin: string; headRefName: string } | undefined>
  execute(target: RequestReviewTarget): Promise<RequestReviewResult>
  log(msg: string): void
}

/**
 * Called from exactly one place in production — `realDispatch` (cli.ts),
 * immediately after the fleet learns a dispatched item's PR exists and
 * confirms it is on the branch that item was dispatched for. The same site,
 * and the same reasoning, as `armStandardAutoMergeAtOpen` (automerge.ts): PR
 * open is the earliest moment the PR exists, and `fleet/review` is a required
 * context that only a `review_requested` event can bring into being.
 *
 * Best-effort in the sense that it never throws into the dispatch — but NOT
 * in the sense of quiet. Anything other than a confirmed request is logged as
 * the block it is, because the consequence is a PR that cannot merge at all
 * and the fleet has already shipped one morning of exactly that.
 *
 * This deliberately does not honour the board's one-review-per-tick cap. The
 * cap exists to spread engine load across ticks for a BACKLOG of PRs that can
 * each wait; a PR opened without a review request cannot wait, it is blocked
 * forever. Dispatches per tick are already bounded by lane concurrency, so
 * one request per dispatched PR is bounded by the same thing.
 */
export async function requestReviewAtOpen(
  input: { pr: string | undefined; headRefName: string; branchMismatch: string | undefined },
  deps: RequestReviewAtOpenDeps,
): Promise<void> {
  const { pr, headRefName, branchMismatch } = input
  if (pr === undefined || branchMismatch !== undefined) return

  try {
    const view = await deps.readPr(pr)
    if (view === undefined) {
      deps.log(`request-review: could not read PR ${pr} (${headRefName}) — no review requested, so it cannot merge`)
      return
    }

    const result = await deps.execute({
      number: view.number,
      authorLogin: view.authorLogin,
      headRefName: view.headRefName,
    })
    if (result.outcome.kind !== 'requested') {
      deps.log(`request-review: PR ${pr} has NO review started and cannot merge — ${describeRequestReview(result)}`)
    }
  } catch (e) {
    // Never into the dispatch: a GitHub blip must not turn a finished PR into
    // a failed dispatch. But never quiet either — the consequence of landing
    // here is a PR that cannot merge at all.
    deps.log(
      `request-review: PR ${pr} (${headRefName}) has NO review started and cannot merge — ` +
      `requesting one threw: ${describeGhFailure(e)}`,
    )
  }
}

interface PrViewFacts {
  number: number
  author: { login: string } | null
  headRefName: string
}

/** `llamenos-fleet request-review <pr>` — the executing half of the board's
 *  `REQUEST_REVIEW` action, and the by-hand route for a PR the fleet did not
 *  open. */
export async function runRequestReview(
  pr: string | undefined,
  read: (pr: string) => Promise<PrViewFacts | undefined>,
  deps: RequestReviewDeps,
  write: (text: string) => void,
): Promise<number> {
  if (pr === undefined || !/^\d+$/.test(pr)) {
    write('usage: llamenos-fleet request-review <pr>\n')
    return 2
  }
  let facts: PrViewFacts | undefined
  try {
    facts = await read(pr)
  } catch (e) {
    write(`request-review #${pr}: could not read the PR — ${describeGhFailure(e)}\n`)
    return 1
  }
  if (facts === undefined) {
    write(`request-review #${pr}: could not read the PR\n`)
    return 1
  }
  const author = facts.author?.login
  if (author === undefined) {
    // The author decides who may be asked (`reviewTriggerLogins`). Without it
    // the request could name the PR's own author, which GitHub refuses with a
    // 422 — a failure that reads at a call site like a permissions problem.
    write(`request-review #${pr}: the PR has no readable author — refusing to guess who may be asked to review it\n`)
    return 1
  }
  const result = await executeRequestReview(
    { number: facts.number, authorLogin: author, headRefName: facts.headRefName },
    deps,
  )
  write(describeRequestReview(result) + '\n')
  return requestReviewExitCode(result)
}
