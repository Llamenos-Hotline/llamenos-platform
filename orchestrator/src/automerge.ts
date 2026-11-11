import { isKnopeReleasePr } from './roles/release.js'
import { laneIdFromBranch, QUEUE_CLEARED_LABEL } from './ci.js'

/**
 * Standard auto-merge: GitHub's own auto-merge (squash, delete branch),
 * requested the moment a PR the fleet dispatched exists — not held back
 * until this fleet's own mechanical verification and non-author review have
 * both passed (that's a SEPARATE, ALREADY-EXISTING arm site — see
 * `tick.ts`'s `enableAutoMerge` call — which stays exactly as it is: it is
 * what re-arms a PR whose branch was pushed to again after this module's
 * open-time request, since a push invalidates the per-SHA required checks
 * and GitHub does not re-request auto-merge on its own).
 *
 * This is NOT a bypass and must never become one. GitHub still withholds
 * the actual merge until every required context on the ruleset is green on
 * that exact head SHA — `ci-status`, `gitleaks`, `CodeQL`, `fleet/verify`,
 * `fleet/review` — and until any code-owner approval CODEOWNERS demands is
 * present. Requesting auto-merge only changes WHEN GitHub notices the PR is
 * ready to land; it never changes WHETHER GitHub will let it.
 */

/**
 * Whether the knope release PR (branch `release` — see
 * `roles/release.ts`'s `KNOPE_RELEASE_BRANCH`) is excluded from standard
 * auto-merge.
 *
 * DEFAULT: `false` — release PRs DO get standard auto-merge today.
 *
 * This is deliberate and TEMPORARY, not an oversight. Merging the knope
 * release PR is not an ordinary version bump: `.github/workflows/release.yml`
 * fires on `pull_request: [closed]` against `main` when the merged PR's head
 * ref was `release`, and it then tags, builds, publishes a GitHub Release,
 * and moves the `docker-stable` image tags — outward-facing and hard to
 * reverse on a public repo. That would normally make it a human's call,
 * always.
 *
 * Right now it is not, on purpose: the release pipeline has never produced
 * an artifact successfully, and that is the standing blocker on Internal
 * Availability. Until it is proven end to end, every merge attempt IS the
 * test, and gating it behind a human reviewer who has to notice and click
 * merge only slows down finding out whether it works. So the release PR is
 * left in scope for standard auto-merge, same as any other fleet PR — it
 * still cannot merge until every required check (`ci-status`, `gitleaks`,
 * `CodeQL`, `fleet/verify`, `fleet/review`) is green and any required
 * code-owner review exists, exactly like every other PR.
 *
 * Flip this to `true` the moment the release pipeline has produced a clean
 * artifact end to end — that one line is the entire re-derivation this
 * switch exists to avoid; nothing else in this file needs to change.
 */
export const EXCLUDE_RELEASE_PR_FROM_STANDARD_AUTO_MERGE = false

/**
 * A branch this automation is entitled to touch at all: one of this fleet's
 * own dispatched branches (`fleet/<lane>/<item>` — `laneIdFromBranch`,
 * ci.ts) or the knope release branch. Everything else — a human's own
 * feature branch, an ad hoc worker branch dispatched outside this
 * orchestrator entirely — is out of scope for this module, full stop,
 * regardless of the release switch above. The release switch decides
 * whether the ONE named exception inside fleet-owned branches is excluded;
 * it was never meant to, and must never, widen scope to branches this
 * module has no business enabling auto-merge on.
 */
export function isFleetOwnedBranch(headRefName: string): boolean {
  return laneIdFromBranch(headRefName) !== undefined || isKnopeReleasePr({ headRefName })
}

/**
 * The one decision point this file exists for. `excludeRelease` defaults to
 * the module-level switch but takes an explicit parameter so the mutation
 * rail (tests/orchestrator/automerge.test.ts) can drive both positions
 * without touching the exported constant — see that file's "MUTATION GUARD"
 * test, which flips this input directly and asserts the outcome flips too.
 */
export function shouldStandardAutoMerge(
  headRefName: string,
  excludeRelease: boolean = EXCLUDE_RELEASE_PR_FROM_STANDARD_AUTO_MERGE,
): boolean {
  if (!isFleetOwnedBranch(headRefName)) return false
  if (excludeRelease && isKnopeReleasePr({ headRefName })) return false
  return true
}

export interface AutoMergeAtOpenDeps {
  enableAutoMerge(pr: string): Promise<void>
  log(msg: string): void
}

/**
 * Called from exactly one place in production — `realDispatch` (cli.ts),
 * immediately after the fleet learns a dispatched item's PR exists and
 * confirms it is on the branch that item was dispatched for. Best-effort by
 * design: a PR born without auto-merge armed is still a normal PR a human
 * can merge by hand; a dispatch that throws because GitHub was briefly
 * unreachable is strictly worse.
 */
export async function armStandardAutoMergeAtOpen(
  input: { pr: string | undefined; headRefName: string; branchMismatch: string | undefined },
  deps: AutoMergeAtOpenDeps,
): Promise<void> {
  const { pr, headRefName, branchMismatch } = input
  if (pr === undefined || branchMismatch !== undefined) return

  if (!shouldStandardAutoMerge(headRefName)) {
    deps.log(`auto-merge: pr ${pr} (${headRefName}) not requested at open — excluded from standard auto-merge`)
    return
  }

  try {
    await deps.enableAutoMerge(pr)
    deps.log(`auto-merge: requested standard auto-merge at PR open on pr ${pr} (${headRefName})`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    deps.log(`auto-merge: could not request standard auto-merge at open on pr ${pr}: ${msg}`)
  }
}

export interface ArmAutoMergeDeps {
  /** The PR's head branch and current labels, read fresh from GitHub. */
  readPr(pr: string): Promise<{ headRefName: string; labels: readonly string[] }>
  /** Applies the supervisor's `queue-cleared` admission label. THROWS on failure. */
  addQueueClearedLabel(pr: string): Promise<void>
  /** Hands the label back. Best-effort: must not throw. */
  removeQueueClearedLabel(pr: string): Promise<void>
  /** The one literal `gh pr merge <pr> --auto --squash` (guards.test.ts pins that there is exactly one). */
  requestAutoMerge(pr: string): Promise<void>
}

/**
 * THE single point where the fleet arms auto-merge — every arm site (PR open
 * in `armStandardAutoMergeAtOpen`, tick.ts's post-review re-arm, queue-feed's
 * arm/re-arm) reaches GitHub only through this, so no path can arm a
 * `fleet/<lane>/<n>` PR without first clearing it for the queue (#2689).
 *
 * Why: the merge-queue guard (fleet-verify.yml, #1894) reads the PR INSIDE the
 * merge group, after GitHub has consumed the auto-merge request, so the armed
 * request is not visible there; `queue-cleared` is the only admission signal
 * that survives. Arming without it is silent for 30-45 minutes and then the
 * entry is ejected at the head of the queue (`queue-entry-unsignalled`).
 * #2660 labelled only queue-feed's re-arm path and left the arm-at-open path
 * unlabelled — which is why this wraps the arm itself rather than one caller.
 *
 * Fail-closed: if the label cannot be applied the PR is NOT armed (it would
 * only be ejected later); the error propagates so each caller reports it the
 * way it already reports a failed arm. If the arm fails after this call added
 * the label, the label is handed back so a clearance never outlives the act it
 * cleared. A label that was already there is never touched.
 */
export async function armAutoMergeWithQueueClearance(pr: string, deps: ArmAutoMergeDeps): Promise<void> {
  const { headRefName, labels } = await deps.readPr(pr)
  const needsLabel = laneIdFromBranch(headRefName) !== undefined && !labels.includes(QUEUE_CLEARED_LABEL)
  if (needsLabel) await deps.addQueueClearedLabel(pr)
  try {
    await deps.requestAutoMerge(pr)
  } catch (e) {
    if (needsLabel) await deps.removeQueueClearedLabel(pr)
    throw e
  }
}
