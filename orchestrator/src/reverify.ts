import type { RunRecord } from './ledger.js'

/**
 * A failed mechanical verification is a fact about ONE commit, not about the
 * pull request (#2738).
 *
 * `runReviewLoop` ends the moment mechanical verification fails, and on that
 * round it is right not to spend the single `fleet/review` runner on a red PR.
 * But the PR then exists, so `tick` reads the item as `pr-already-open` on
 * every later pass and never looks at it again: a PR whose verification failed
 * and which nobody is working on was abandoned in place — never re-verified,
 * never reviewed, never merged, with nothing on it saying so. Only a human
 * reading `fleet.log` could notice.
 *
 * This module is the pure half of the fix: from the ledger and the PR's live
 * head, decide whether the fleet owes that PR another look.
 *
 *  - `head-moved`: the failure is on an OLDER commit than the PR's head now.
 *    A push (a human's, or a dispatched worker's) is what the failure was
 *    waiting for; re-verify the new head, and on a pass request the review the
 *    first round skipped.
 *  - `runner-crash`: the SAME head, but the failure never reached a verdict —
 *    the test runner died or wrote no report (`tests=<suite>:crash`). That is a
 *    property of the run, not of the commit, so one more run is owed. Bounded
 *    to `MAX_CRASH_RETRIES_PER_HEAD`; a red result that WAS read is never
 *    re-run to "get green".
 *  - `abandoned`: the same head, a real red result (or crashes past the
 *    bound). Nothing the fleet can do until the head moves; the PR carries a
 *    comment saying so.
 */
export const MAX_CRASH_RETRIES_PER_HEAD = 1

/** Marker in the ledger note of a row written by a re-entry pass. */
export const REENTRY_NOTE_PREFIX = 'reverify:'

export type OpenPrAssessment =
  | { kind: 'none' }
  | { kind: 'head-moved'; failedSha: string; headSha: string }
  | { kind: 'runner-crash'; failedSha: string }
  | { kind: 'abandoned'; failedSha: string; headSha: string | undefined }

const FULL_SHA = /^[0-9a-f]{40}$/

/** The newest terminal ledger row for the item, if it ended at a failed
 *  mechanical verification (structured `verification`, never parsed text). */
export function latestMechanicalRejection(rows: RunRecord[], itemId: string): { row: RunRecord; sha: string; runnerCrashed: boolean } | undefined {
  const latest = rows
    .filter((r) => r.itemId === itemId && r.outcome !== 'DISPATCHED')
    .sort((a, b) => b.ts - a.ts)[0]
  if (latest === undefined || latest.outcome !== 'REJECTED' || latest.verification === undefined) return undefined
  const { failedSha, runnerCrashed } = latest.verification
  if (!FULL_SHA.test(failedSha)) return undefined
  return { row: latest, sha: failedSha, runnerCrashed: runnerCrashed === true }
}

/**
 * Pure. `headSha` is the PR's live head, `undefined` when it could not be
 * read — which is never read as "unchanged" and never as "moved": with no head
 * to compare there is nothing to re-enter on, only the visible comment.
 */
export function assessOpenPr(rows: RunRecord[], itemId: string, headSha: string | undefined): OpenPrAssessment {
  const failure = latestMechanicalRejection(rows, itemId)
  if (failure === undefined) return { kind: 'none' }
  if (headSha === undefined) return { kind: 'abandoned', failedSha: failure.sha, headSha }
  if (headSha !== failure.sha) return { kind: 'head-moved', failedSha: failure.sha, headSha }

  if (failure.runnerCrashed) {
    const crashesOnThisHead = rows.filter((r) =>
      r.itemId === itemId && r.outcome === 'REJECTED' && r.verification?.runnerCrashed === true &&
      r.verification.failedSha === failure.sha,
    ).length
    // The first crash is the original round; retries are the extra rows.
    if (crashesOnThisHead <= MAX_CRASH_RETRIES_PER_HEAD) return { kind: 'runner-crash', failedSha: failure.sha }
  }
  return { kind: 'abandoned', failedSha: failure.sha, headSha }
}

const short = (sha: string): string => sha.slice(0, 12)

/** Posted on the PR when mechanical verification fails, so the state is
 *  discoverable from the PR itself, not only from `fleet.log`. */
export function buildVerificationFailedComment(input: {
  sha: string | undefined
  reasons: readonly string[]
  runnerCrashed: boolean
  reentry: boolean
}): string {
  const at = input.sha === undefined ? 'the head' : `\`${short(input.sha)}\``
  const what = input.runnerCrashed
    ? `the test runner crashed before producing a result on ${at} (this is not a verdict on the tests themselves)`
    : `mechanical verification failed on ${at}`
  return [
    `**Fleet: ${what}, so no review was requested.**`,
    '',
    ...input.reasons.map((r) => `- ${r}`),
    '',
    input.reentry
      ? 'This was a re-verification after the head moved. The fleet re-verifies again on the next push.'
      : 'The fleet re-verifies this PR automatically when its head moves (a push, by a person or a worker) ' +
        'and requests the review then; a runner crash is retried once on the same head. Nothing else is needed to unblock it.',
  ].join('\n')
}

/** Posted when a re-verification of a moved head passes. */
export function buildReentryPassedComment(sha: string, review: string): string {
  return `**Fleet: re-verified \`${short(sha)}\` after the head moved — mechanical verification now passes.** ${review}`
}
