import type { VerifyReport } from './verify.js'
import type { SecondOpinionResult } from './review.js'
import { SECRET_REASON_PREFIX, TRUST_ANCHOR_REASON_PREFIX } from './write-gate.js'

export type ReviewVerdict = SecondOpinionResult['verdict']

export interface GateTraceInput {
  /** `undefined` when `verifyMechanical` never ran at all for this item —
   *  distinct from a report that ran and failed. */
  report?: VerifyReport
  /** `undefined` when no review was ever requested (mechanical verification
   *  did not pass, or nothing was dispatched). */
  reviewVerdict?: ReviewVerdict
  /** The reviewer's own text — surfaced only for UNREADABLE, so the trace
   *  says WHY a review could not be trusted, not just that it wasn't PASS. */
  reviewText?: string
}

/**
 * `verifyMechanical` (verify.ts) folds scope and test failures into one
 * `reasons` array with no separate boolean for "scope specifically failed" —
 * these are the exact, stable prefixes it uses for the three write-gate
 * refusals: a secret, a trust anchor with no human sign-off (write-gate.ts
 * owns both prefixes), and a file outside the lane. Matched by text
 * rather than adding a new field to `VerifyReport`, so this stays a read-only
 * view over the existing report shape; pinned by a direct unit test in
 * trace.test.ts so a wording change in verify.ts is caught here too.
 */
const SCOPE_REASON_PREFIXES = [SECRET_REASON_PREFIX, TRUST_ANCHOR_REASON_PREFIX, 'touched files outside lane'] as const

function scopeSummary(report: VerifyReport): string {
  const scopeReasons = report.reasons.filter((r) => SCOPE_REASON_PREFIXES.some((p) => r.startsWith(p)))
  if (scopeReasons.length > 0) return `fail(${scopeReasons.join('; ')})`
  // No changed files AND a non-empty reasons array only happens on the two
  // earliest possible failures in verifyMechanical — `git rev-parse HEAD` or
  // `git diff --name-only` itself failing — before scope was ever checked.
  if (report.changedFiles.length === 0 && report.reasons.length > 0) return `unknown(${report.reasons[0] ?? ''})`
  return 'pass'
}

function impactSummary(report: VerifyReport): string {
  return report.impact === 'high' ? `high(${report.impactReasons[0] ?? 'unspecified'})` : 'low'
}

function testsSummary(report: VerifyReport): string {
  if (report.testsRun === undefined || report.testsRun.length === 0) return 'none'
  const targets = report.testsRun.join(',')
  if (report.testsPassed === true) return `${targets}:pass`
  if (report.testsPassed === false) return `${targets}:fail`
  return `${targets}:unproven`
}

const REVIEW_TEXT_SNIPPET_CHARS = 80

function reviewSummary(verdict: ReviewVerdict | undefined, text: string | undefined): string {
  if (verdict === undefined) return 'not-run'
  if (verdict !== 'UNREADABLE') return verdict
  const reason = (text ?? 'no reason given').trim().slice(0, REVIEW_TEXT_SNIPPET_CHARS)
  return `UNREADABLE(${reason})`
}

/**
 * A compact, one-line, machine-parseable summary of every gate a dispatched
 * item passed through — scope, impact, tests, review, and the exact SHA
 * `verifyMechanical` examined — meant to live in the ledger's terminal
 * `note` (tick.ts). This is G2's fix: before this, the ledger could not tell
 * "the gate refused" from "the gate never ran" for a given item, which is the
 * exact ambiguity that produced most of this project's bugs (issue #660/PR
 * #662: a bare pass-through `SUCCESS` with the worker's own note was
 * indistinguishable from a fully verified merge). There is no `merge=` field
 * any more: whether a PR merged is a fact about GitHub, derived live by
 * `llamenos-fleet status <issue>`, never a claim this trace could cache.
 *
 * Every stage renders EXPLICITLY — `not-run` / `none` / `unknown`, never an
 * absent key — so a stage that never happened can never be misread as one
 * that happened and passed.
 */
export function buildGateTrace(input: GateTraceInput): string {
  const report = input.report
  const parts = [
    `scope=${report ? scopeSummary(report) : 'not-run'}`,
    `impact=${report ? impactSummary(report) : 'not-run'}`,
    `tests=${report ? testsSummary(report) : 'not-run'}`,
    `review=${reviewSummary(input.reviewVerdict, input.reviewText)}`,
    `sha=${report?.verifiedCommit ?? 'none'}`,
  ]
  return parts.join(' ')
}
