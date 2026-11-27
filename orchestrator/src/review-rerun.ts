/**
 * Re-fire `fleet/review` for a PR and CONFIRM A RUN STARTED (#3058).
 *
 * The defect this exists to stop: a helper that POSTs a review request, sees a
 * `review_requested` event on the timeline, and reports success. The event is
 * real and proves nothing about a RUN — #3058 read exactly that as "the
 * trigger does not exist" and rebuilt the helper around a `workflow_dispatch`,
 * whose check run never reaches the PR's rollup (`reviewNotRequestedAdvice`,
 * ci.ts). The trigger does exist: the request starts
 * `REVIEW_RERUN_WORKFLOW` (#2815), and on #3051 it started at 10:11:07Z, two
 * seconds after the 10:11:05Z event.
 *
 * So success here means ONE thing: a run of that workflow, on the PR's head
 * SHA, created after the request. An event with no run is a failure, and so is
 * a request that emitted no event at all. Everything touching GitHub is
 * injected (`RerunDeps`), so tests/orchestrator/review-rerun.test.ts can break
 * it in both directions without a network.
 */
import { REVIEW_RERUN_WORKFLOW, reviewTriggerLogins } from './ci.js'

export interface RerunRun {
  id: number
  event: string
  head_sha: string
  created_at: string
  html_url: string
}

export interface RerunPr {
  number: number
  headSha: string
  branch: string
  author: string
  /** Logins currently listed in `requested_reviewers`. */
  requestedReviewers: readonly string[]
}

export interface RerunDeps {
  readPr(pr: number): Promise<RerunPr>
  /** `created_at` of every `review_requested` event on the PR that named `login`. */
  reviewRequestEvents(pr: number, login: string): Promise<string[]>
  removeReviewer(pr: number, login: string): Promise<void>
  addReviewer(pr: number, login: string): Promise<void>
  /** Runs of `REVIEW_RERUN_WORKFLOW`, newest first, for this head SHA. */
  rerunRuns(headSha: string): Promise<RerunRun[]>
  now(): Date
  sleep(ms: number): Promise<void>
}

export type RerunResult = { ok: true; run: RerunRun } | { ok: false; reason: string }

/** GitHub's clock and ours are not the same clock. */
export const RERUN_CLOCK_SKEW_MS = 15_000
export const RERUN_POLL_MS = 3_000
export const RERUN_POLL_ATTEMPTS = 20

/** The run a request started: this head, this trigger, created after `since`. */
export function runStartedForRequest(runs: readonly RerunRun[], headSha: string, since: Date): RerunRun | undefined {
  const floor = since.getTime() - RERUN_CLOCK_SKEW_MS
  return runs.find((r) => r.event === 'pull_request' && r.head_sha === headSha && Date.parse(r.created_at) >= floor)
}

export async function rerunReview(deps: RerunDeps, prNumber: number): Promise<RerunResult> {
  const pr = await deps.readPr(prNumber)
  const [ask] = reviewTriggerLogins({ prAuthor: pr.author, branch: pr.branch })
  const since = deps.now()
  const before = (await deps.reviewRequestEvents(prNumber, ask)).length

  // A login that is already requested emits no event on a second POST (#1471),
  // so take it off first. A CODEOWNER's request is re-added by GitHub the
  // instant it is removed; the event count below is what says whether it took.
  if (pr.requestedReviewers.some((l) => l.toLowerCase() === ask.toLowerCase())) await deps.removeReviewer(prNumber, ask)
  await deps.addReviewer(prNumber, ask)

  const after = (await deps.reviewRequestEvents(prNumber, ask)).length
  if (after <= before) {
    return {
      ok: false,
      reason: `requesting \`${ask}\` emitted no review_requested event on #${prNumber} (${before} before, ${after} after), ` +
        'so nothing started — GitHub re-adds a CODEOWNER request the instant it is removed (#1471); submit a ' +
        'comment review as that login, then re-add it',
    }
  }

  for (let i = 0; i < RERUN_POLL_ATTEMPTS; i++) {
    const run = runStartedForRequest(await deps.rerunRuns(pr.headSha), pr.headSha, since)
    if (run !== undefined) return { ok: true, run }
    await deps.sleep(RERUN_POLL_MS)
  }
  return {
    ok: false,
    reason: `a review_requested event fired for \`${ask}\` on #${prNumber}, but no ${REVIEW_RERUN_WORKFLOW} run started on ` +
      `${pr.headSha} within ${(RERUN_POLL_ATTEMPTS * RERUN_POLL_MS) / 1000}s — an event is not a run; treat the review as NOT re-fired`,
  }
}
