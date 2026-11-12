import { lstat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunRecord } from './ledger.js'
import { REVERIFY_DIR } from './paths.js'
import { acquireInFlight, nestedInVerification, recordAttempt } from './review-and-merge-guards.js'

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

/**
 * Makes the trusted dependency install available to an extracted head export —
 * the step `fleet-verify.yml` performs on its own export ("Make base
 * dependencies available to the head export") before `runVerifyCi` runs, and
 * which `verifyOpenPrHead` must repeat, because `git archive` leaves out the
 * gitignored `node_modules` and `prepareTestRoot` refuses any test root whose
 * `node_modules` is not, by realpath, the trusted install. Without it every
 * routed suite of every re-verification fails as an "untrusted test root",
 * which reads as a red verdict on the PR's code.
 *
 * Refuses an export that already has a `node_modules` of any kind (directory,
 * file or symlink): the commit under judgement may not supply the runner that
 * judges it. `symlink` itself fails with EEXIST on an existing entry rather
 * than nesting the link inside a directory, so the check and the link cannot
 * disagree.
 */
export async function linkTrustedModules(headDir: string, trustedModules: string): Promise<void> {
  const target = join(headDir, 'node_modules')
  if (await lstat(target).then(() => true, () => false)) {
    throw new Error(
      'the commit under judgement contains node_modules — refusing to judge it with a runner it could supply',
    )
  }
  await symlink(trustedModules, target)
}

/**
 * How many times ONE head may be re-verified. Re-entry normally verifies a
 * head once (the verdict is recorded and the next pass sees head == failed
 * head), plus the single runner-crash retry — so 2 is the working maximum.
 * The third is slack for a pass that verified but could not record, and the
 * ceiling is what bounds the case the ledger cannot: a verification that
 * keeps starting without ever finishing recording.
 */
export const MAX_REENTRIES_PER_SHA = 3

export type ReentryClaim = { ok: true; release(): void } | { ok: false; reason: string }

/**
 * The bound on re-verification (#2738), reusing the three guards #2742 put
 * round `review-and-merge` after the 2026-11-11 runaway — a worker verifying
 * the first version of this path reached 44,158 processes:
 *
 *   1. **Never from inside a verification.** A re-entry started by a process
 *      that is itself running under a verification (`FLEET_IN_VERIFICATION`,
 *      which every test run the gate starts carries) is the recursion edge.
 *   2. **Never two at once for one PR** (a pidfile per PR, reaped only when its
 *      holder is dead).
 *   3. **Never more than `MAX_REENTRIES_PER_SHA` for one head.** A new commit is
 *      a new head with a fresh allowance; the same bytes are not retried
 *      forever.
 *
 * Fails CLOSED like the guards it composes: a lock or ledger that cannot be
 * used refuses the re-entry, which costs one pass's delay and nothing else.
 * The caller `release()`s the claim when the re-entry ends, however it ends.
 */
export function claimReentry(
  pr: string,
  sha: string,
  opts: { dir?: string; env?: NodeJS.ProcessEnv; ceiling?: number; pid?: number } = {},
): ReentryClaim {
  const nested = nestedInVerification(opts.env ?? process.env)
  if (nested !== undefined) return { ok: false, reason: nested }
  const dir = opts.dir ?? REVERIFY_DIR
  const lock = acquireInFlight(pr.replace(/^.*\//, ''), { dir, ...(opts.pid === undefined ? {} : { pid: opts.pid }) })
  if (!lock.ok) return { ok: false, reason: lock.reason }
  const attempt = recordAttempt(sha, { dir, ceiling: opts.ceiling ?? MAX_REENTRIES_PER_SHA })
  if (!attempt.ok) {
    lock.release()
    return { ok: false, reason: attempt.reason }
  }
  return { ok: true, release: lock.release }
}
