import { REPO, gh, describeGhFailure } from './gh.js'
import { KNOPE_RELEASE_BRANCH } from './roles/release.js'

/**
 * `llamenos-fleet request-review <pr>` — the executing half of the board's
 * `REQUEST_REVIEW` action (board.ts), and the migration step #1158/#1164
 * turns on.
 *
 * ## Why this does TWO things
 *
 * `fleet-review.yml` is triggered by a GitHub event, and #1164 changes WHICH
 * event: from `pull_request: types: [labeled]` (the `review` label) to
 * `pull_request: types: [review_requested]` (a review requested from
 * `llamenos-auto`). Only one version of that workflow can be on `main` at a
 * time, and whichever one is there listens for exactly one of the two
 * events — so a fleet that emits only one of them is a fleet that cannot
 * start a review for as long as the other version is deployed.
 *
 * This module therefore emits BOTH on every invocation, deliberately, for
 * the length of the migration:
 *
 *  1. the `review` label (what the currently-deployed workflow triggers on), and
 *  2. a review request from `llamenos-auto` (what #1164's workflow triggers on).
 *
 * Both are cheap, and they cannot double-run the engine: the live workflow
 * subscribes to one event type, so the other is simply never delivered to
 * it. Once #1164 has merged and the request half is confirmed firing, a
 * follow-up drops the label half — until then, dropping either one
 * reintroduces the gap.
 *
 * ## Why remove-then-add, twice
 *
 * Both APIs are idempotent in the way that hurts here: re-applying a label a
 * PR already carries emits no `labeled` event, and re-requesting a reviewer
 * already on the request list emits no `review_requested` event. Neither
 * would re-trigger the workflow on a PR that has been pushed to since. So
 * each half is a DELETE followed by a POST — the same re-fire idiom the
 * board already tells an operator to use by hand ("remove and re-add the
 * label to re-trigger", #862), applied to the reviewer request as well.
 *
 * The DELETE half of each pair is best-effort: a label that is not applied
 * and a reviewer who is not requested are both the normal first-time state,
 * and `gh` reports them as failures. Only the POST decides that half's
 * outcome.
 *
 * ## Why nothing here is swallowed
 *
 * The two halves run INDEPENDENTLY — a failure of one never skips the other
 * (a permissions problem on labels must not cost the review request, and a
 * refused review request must not cost the label that still works today).
 * Every failure is recorded on the result and rendered by
 * `describeRequestReview`; `requestReviewExitCode` is non-zero unless BOTH
 * halves succeeded. A partial success is a LOUD partial success, never a
 * silently dropped review.
 */

/** The label the currently-deployed `fleet-review.yml` triggers on. */
export const REVIEW_LABEL = 'review'

/**
 * Who a review is requested from. `llamenos-auto` is this fleet's second
 * write-access identity and the account `fleet-review.yml` recognises as
 * "the fleet asked for a review" (#773, #1164).
 */
export const REVIEW_REQUEST_LOGIN = 'llamenos-auto'

/**
 * Accepted INSTEAD of `REVIEW_REQUEST_LOGIN`, and only on knope's `release`
 * PR: that PR is opened by the operator's own release automation as
 * `llamenos-auto`, so `llamenos-auto` is its AUTHOR and GitHub will not let
 * it be the reviewer too. The operator (`rhonda-rodododo`) is who actually
 * reads a release PR, so they are who the request goes to there.
 */
export const RELEASE_REVIEW_REQUEST_LOGIN = 'rhonda-rodododo'

/** Pure. Which login a review is requested from for this head branch. */
export function reviewerFor(headRefName: string): string {
  return headRefName === KNOPE_RELEASE_BRANCH ? RELEASE_REVIEW_REQUEST_LOGIN : REVIEW_REQUEST_LOGIN
}

/**
 * Pure. GitHub refuses (422) a review request naming the PR's own author,
 * and there is no way around it: a PR cannot be reviewed by the person who
 * opened it. `reviewerFor` already routes the one routine case — the
 * `release` PR authored by `llamenos-auto` — to the operator instead, so
 * this returns `true` only for a case nothing has anticipated: a
 * `llamenos-auto`-authored PR on some OTHER branch (or an operator-authored
 * `release` PR).
 *
 * The fleet's answer is to refuse loudly, not to guess a third reviewer.
 * Silently picking someone else would route a review at an account that
 * `fleet-review.yml` does not recognise as the trigger, producing a request
 * that looks sent and starts nothing — the exact silent failure #1158
 * exists to remove. The board reports these as `OPERATOR` and this command
 * exits non-zero with the author named.
 */
export function reviewerIsAuthor(headRefName: string, authorLogin: string): boolean {
  return reviewerFor(headRefName).toLowerCase() === authorLogin.toLowerCase()
}

/** Everything about a PR this command needs; nothing is re-derived here. */
export interface RequestReviewTarget {
  number: number
  authorLogin: string
  headRefName: string
}

/** One half's outcome. `skipped` is a half that was not attempted BECAUSE
 *  attempting it could not succeed — never "did not get around to it"; it
 *  counts as a failure for `requestReviewExitCode`, exactly like `failed`. */
export type HalfOutcome =
  | { kind: 'ok' }
  | { kind: 'failed'; detail: string }
  | { kind: 'skipped'; detail: string }

export interface RequestReviewResult {
  number: number
  reviewer: string
  /** Applying the `review` label — the currently-deployed trigger. */
  label: HalfOutcome
  /** Requesting a review from `reviewer` — #1164's trigger. */
  request: HalfOutcome
}

/** The four real network calls, injected so the whole command is unit-tested
 *  against fakes rather than only against a live `gh`. */
export interface RequestReviewDeps {
  addLabel(pr: number, label: string): Promise<void>
  removeLabel(pr: number, label: string): Promise<void>
  requestReviewer(pr: number, login: string): Promise<void>
  removeRequestedReviewer(pr: number, login: string): Promise<void>
  log(msg: string): void
}

/** Best-effort DELETE: the "not currently applied/requested" state is both
 *  normal and indistinguishable from a real failure at this layer, and
 *  either way the POST that follows is what decides the outcome. */
async function clearFirst(what: string, deps: RequestReviewDeps, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (e) {
    deps.log(`request-review: ${what} not cleared (${describeGhFailure(e)}) — continuing to re-apply`)
  }
}

/**
 * Applies the `review` label AND requests a review from the right login,
 * each independently, and reports both. Never throws: every failure lands on
 * the returned result so the caller renders one complete picture instead of
 * aborting on the first problem and hiding the second.
 */
export async function executeRequestReview(
  target: RequestReviewTarget,
  deps: RequestReviewDeps,
): Promise<RequestReviewResult> {
  const reviewer = reviewerFor(target.headRefName)

  // Half 1 — the label. Runs first, and its outcome never gates half 2.
  let label: HalfOutcome
  await clearFirst(`label "${REVIEW_LABEL}"`, deps, () => deps.removeLabel(target.number, REVIEW_LABEL))
  try {
    await deps.addLabel(target.number, REVIEW_LABEL)
    label = { kind: 'ok' }
    deps.log(`request-review: #${target.number} labelled "${REVIEW_LABEL}"`)
  } catch (e) {
    label = { kind: 'failed', detail: describeGhFailure(e) }
    deps.log(`request-review: #${target.number} LABEL FAILED — ${label.detail}`)
  }

  // Half 2 — the review request. Reached whatever half 1 did.
  let request: HalfOutcome
  if (reviewerIsAuthor(target.headRefName, target.authorLogin)) {
    request = {
      kind: 'skipped',
      detail: `GitHub refuses a review request naming the PR's own author, and #${target.number} is authored by ` +
        `${target.authorLogin} — the very login a review would be requested from on branch ` +
        `"${target.headRefName}". No review can be started for this PR by request; it needs a human reviewer.`,
    }
    deps.log(`request-review: #${target.number} REVIEW REQUEST IMPOSSIBLE — ${request.detail}`)
  } else {
    await clearFirst(`review request for ${reviewer}`, deps, () => deps.removeRequestedReviewer(target.number, reviewer))
    try {
      await deps.requestReviewer(target.number, reviewer)
      request = { kind: 'ok' }
      deps.log(`request-review: #${target.number} review requested from ${reviewer}`)
    } catch (e) {
      request = { kind: 'failed', detail: describeGhFailure(e) }
      deps.log(`request-review: #${target.number} REVIEW REQUEST FAILED — ${request.detail}`)
    }
  }

  return { number: target.number, reviewer, label, request }
}

function describeHalf(what: string, outcome: HalfOutcome): string {
  if (outcome.kind === 'ok') return `  ok    ${what}`
  if (outcome.kind === 'skipped') return `  SKIP  ${what} — ${outcome.detail}`
  return `  FAIL  ${what} — ${outcome.detail}`
}

/**
 * One block naming BOTH halves, always — a successful half is printed next
 * to a failed one so a partial success reads as partial at a glance rather
 * than as "the command printed something, so it worked".
 */
export function describeRequestReview(result: RequestReviewResult): string {
  const both = result.label.kind === 'ok' && result.request.kind === 'ok'
  const head = both
    ? `request-review #${result.number}: review started (label + request to ${result.reviewer})`
    : `request-review #${result.number}: INCOMPLETE — not every trigger was emitted`
  return [
    head,
    describeHalf(`apply the "${REVIEW_LABEL}" label`, result.label),
    describeHalf(`request a review from ${result.reviewer}`, result.request),
  ].join('\n')
}

/** Non-zero unless BOTH halves succeeded: whichever `fleet-review.yml` is
 *  deployed, a half that did not fire may be the ONLY half that mattered,
 *  so a partial success can never exit 0 and read as done. */
export function requestReviewExitCode(result: RequestReviewResult): number {
  return result.label.kind === 'ok' && result.request.kind === 'ok' ? 0 : 1
}

export function defaultRequestReviewDeps(log: (msg: string) => void): RequestReviewDeps {
  return {
    addLabel: async (pr, label) => { await gh(['pr', 'edit', String(pr), '--add-label', label]) },
    removeLabel: async (pr, label) => { await gh(['pr', 'edit', String(pr), '--remove-label', label]) },
    // `pulls/{n}/requested_reviewers` takes a `reviewers` ARRAY on both
    // verbs — a bare `reviewer=<login>` field is silently ignored by the
    // API and requests nobody. `-f 'reviewers[]=<login>'` is how `gh api`
    // spells a single-element array.
    requestReviewer: async (pr, login) => {
      await gh(['api', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-X', 'POST', '-f', `reviewers[]=${login}`])
    },
    removeRequestedReviewer: async (pr, login) => {
      await gh(['api', `repos/${REPO}/pulls/${pr}/requested_reviewers`, '-X', 'DELETE', '-f', `reviewers[]=${login}`])
    },
    log,
  }
}

interface PrViewFacts {
  number: number
  author: { login: string } | null
  headRefName: string
}

/** `llamenos-fleet request-review <pr>`. Reads the PR's author and head
 *  branch (both decide the reviewer), then executes both halves. */
export async function runRequestReview(
  pr: string | undefined,
  read: (pr: string) => Promise<PrViewFacts>,
  deps: RequestReviewDeps,
  write: (text: string) => void,
): Promise<number> {
  if (pr === undefined || !/^\d+$/.test(pr)) {
    write('usage: llamenos-fleet request-review <pr>\n')
    return 2
  }
  let facts: PrViewFacts
  try {
    facts = await read(pr)
  } catch (e) {
    write(`request-review #${pr}: could not read the PR — ${describeGhFailure(e)}\n`)
    return 1
  }
  const author = facts.author?.login
  if (author === undefined) {
    // Without an author the self-review check cannot be made, and making the
    // request anyway is how a 422 turns into a request nobody notices.
    write(`request-review #${pr}: the PR has no readable author — refusing to guess whether ${reviewerFor(facts.headRefName)} may be requested\n`)
    return 1
  }
  const result = await executeRequestReview(
    { number: facts.number, authorLogin: author, headRefName: facts.headRefName },
    deps,
  )
  write(describeRequestReview(result) + '\n')
  return requestReviewExitCode(result)
}
