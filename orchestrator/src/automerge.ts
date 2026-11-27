import { isKnopeReleasePr } from './roles/release.js'
import { laneIdFromBranch, QUEUE_CLEARED_LABEL } from './ci.js'
import { decideHold, recordHold, MergeHeldError, type QueueHistory } from './merge-hold.js'
import { normalizePrReference } from './gh.js'

/**
 * Where this fleet does NOT arm auto-merge, and why (#2732).
 *
 * There used to be a third arming path in this file, called from
 * `realDispatch` (cli.ts) the moment a dispatched PR existed. It is gone,
 * and nothing replaces it, because both arming paths that remain already
 * cover every PR it covered:
 *
 *  - `tick.ts`'s `enableAutoMerge` arms a PR the fleet dispatched once its
 *    mechanical verification AND non-author review have both passed. That
 *    site's own comment records the hazard arming at open brought back: the
 *    ruleset is what stops an armed PR landing on ordinary CI alone, and an
 *    item the fleet REJECTED kept an armed auto-merge nothing disarmed.
 *  - `queue-feed` arms any CLEAN PR whose `fleet/review` coverage is verified
 *    (fleet-dispatched or not), and re-arms one the queue dropped. It is the
 *    only arming path bounded by queue depth: a queue already holding
 *    `min_entries_to_merge` entries is given no new ones.
 *
 * Arming at open had no depth notion at all — it armed every fleet PR the
 * instant it opened, before any verdict existed, so it was both earlier than
 * the tick's arm and unbounded where queue-feed is bounded. Its stated reason
 * to exist (re-arm a PR pushed to after open, since a push invalidates the
 * per-SHA checks) was backwards: the tick arms AFTER the last revise push, and
 * queue-feed re-arms whatever lost its request. A PR born unarmed is still a
 * normal PR a human can merge by hand; it is armed later by whichever of the
 * two paths reaches it first (tests/orchestrator/automerge.test.ts pins both).
 */

/**
 * A branch this automation is entitled to touch at all: one of this fleet's
 * own dispatched branches (`fleet/<lane>/<item>` — `laneIdFromBranch`,
 * ci.ts) or the knope release branch. Everything else — a human's own
 * feature branch, an ad hoc worker branch dispatched outside this
 * orchestrator entirely — is out of scope for fleet-initiated writes at PR
 * open (`requestReviewAtOpen`, review-request.ts).
 */
export function isFleetOwnedBranch(headRefName: string): boolean {
  return laneIdFromBranch(headRefName) !== undefined || isKnopeReleasePr({ headRefName })
}

export interface ArmAutoMergeDeps {
  /** The PR's head branch and current labels, read fresh from GitHub. */
  readPr(pr: string): Promise<{ headRefName: string; labels: readonly string[] }>
  /** The PR's merge-queue history (merge-hold.ts). `undefined` = unreadable. */
  readQueueHistory(pr: number): Promise<QueueHistory | undefined>
  /** Applies the `merge-hold` label. THROWS on failure. */
  addHoldLabel(pr: number): Promise<void>
  /** Posts a PR comment. THROWS on failure. */
  postPrComment(pr: number, body: string): Promise<void>
  /** Applies the supervisor's `queue-cleared` admission label. THROWS on failure. */
  addQueueClearedLabel(pr: string): Promise<void>
  /** Hands the label back. Best-effort: must not throw. */
  removeQueueClearedLabel(pr: string): Promise<void>
  /** The one literal `gh pr merge <pr> --auto --squash` (guards.test.ts pins that there is exactly one). */
  requestAutoMerge(pr: string): Promise<void>
  log(msg: string): void
}

/**
 * THE single point where the fleet arms auto-merge — every arm site (tick.ts's
 * post-review arm, queue-feed's arm/re-arm) reaches GitHub only through this,
 * so no path can arm a `fleet/<lane>/<n>` PR without first clearing it for the
 * queue (#2689).
 *
 * Why: the merge-queue guard (fleet-verify.yml, #1894) reads the PR INSIDE the
 * merge group, after GitHub has consumed the auto-merge request, so the armed
 * request is not visible there; `queue-cleared` is the only admission signal
 * that survives. Arming without it is silent for 30-45 minutes and then the
 * entry is ejected at the head of the queue (`queue-entry-unsignalled`).
 * #2660 labelled only queue-feed's re-arm path and left the other arm paths
 * (the tick's post-review arm, and the since-removed arm-at-open) unlabelled —
 * which is why this wraps the arm itself rather than one caller.
 *
 * HELD FIRST (#2814): before anything is written, the PR's hold is decided
 * (`decideHold`, merge-hold.ts) — the `merge-hold` label, or a dequeue by
 * anyone but the merge queue itself that no one has released. A held PR is
 * NOT armed: a dequeue hold is written onto the PR (label + one comment) and
 * `MergeHeldError` is thrown; an unreadable queue history throws too, since
 * "could not ask" is not "nobody dequeued it". Because every arm path goes
 * through here, no path can undo a hold — the defect was a feeder re-arming
 * #2788 three minutes after a supervisor dequeued it.
 *
 * Fail-closed: if the label cannot be applied the PR is NOT armed (it would
 * only be ejected later); the error propagates so each caller reports it the
 * way it already reports a failed arm. If the arm fails after this call added
 * the label, the label is handed back so a clearance never outlives the act it
 * cleared. A label that was already there is never touched.
 */
export async function armAutoMergeWithQueueClearance(pr: string, deps: ArmAutoMergeDeps): Promise<void> {
  const { headRefName, labels } = await deps.readPr(pr)
  // `pr` may be the bare number or a pull URL — the worker's status template
  // allows both, and a URL form reached this GraphQL Int! parameter as
  // Number(URL)=NaN on 2026-11-26 (item 3065 / PR #3066), failing the history
  // read and leaving a verified, reviewed PR unarmed. An unrecognised form
  // still maps to NaN, which fails CLOSED exactly as before.
  const prNumber = Number(normalizePrReference(pr))
  const history = await deps.readQueueHistory(prNumber)
  if (history === undefined) {
    throw new Error(`PR ${pr}'s merge-queue history could not be read — whether a person dequeued it (a hold) is unknown, so it is not armed`)
  }
  const hold = decideHold(labels, history)
  if (hold.held) {
    await recordHold(prNumber, hold, history, deps)
    throw new MergeHeldError(pr, hold)
  }
  const needsLabel = laneIdFromBranch(headRefName) !== undefined && !labels.includes(QUEUE_CLEARED_LABEL)
  if (needsLabel) await deps.addQueueClearedLabel(pr)
  try {
    await deps.requestAutoMerge(pr)
  } catch (e) {
    if (needsLabel) await deps.removeQueueClearedLabel(pr)
    throw e
  }
}
