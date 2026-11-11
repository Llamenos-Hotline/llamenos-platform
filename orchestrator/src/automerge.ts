import { isKnopeReleasePr } from './roles/release.js'
import { laneIdFromBranch } from './ci.js'

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
