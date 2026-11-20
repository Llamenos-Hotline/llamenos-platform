import { describeGhFailure } from './gh.js'
import { REVIEW_JOB } from './ci.js'
import { defaultMissingChecksDeps, type HeadCheckRun } from './missing-checks.js'

/**
 * The other home of a `fleet/review` verdict (#2884).
 *
 * A verdict reaches the required context by two routes, and until this file
 * only one of them was readable by the gate:
 *
 *  - the Actions route: a `fleet-review.yml` run records a PASS/FAIL ARTIFACT
 *    (`review-cache.ts`), and the head's `pull_request` carrier republishes it;
 *  - the operator route: `llamenos-fleet review-and-merge` runs the same
 *    review set on the operator's machine and POSTS the verdict as a
 *    `fleet/review` CHECK RUN, authored by the `llamenos-fleet-review` GitHub
 *    App (`review-and-merge.ts`, `github-app.ts`).
 *
 * `review-and-merge` is documented as the escape hatch for a PR whose review
 * cannot be re-requested (#1637, #1471) — and it is a local CLI, so it cannot
 * write the artifact. The carrier is republish-only and read ONLY the
 * artifact, so on #2871 the App's recorded PASS and the carrier's
 * `NO-VERDICT:unreviewed` were two carriers of one required name on one head,
 * and the required context's verdict is the WORST of them: a genuine PASS was
 * outvoted by a FAIL that means "I could not find a verdict".
 *
 * The reader here is the half that makes the escape hatch true: when the
 * carrier finds no cached verdict for this tree, it also accepts the PASS the
 * App recorded against this exact head SHA (`app-recorded`, ci.ts). The other
 * half — getting the carrier to run again after the App posts, so nobody has
 * to dispatch a second review by hand — is `review-carrier-refresh.ts`.
 *
 * WHAT IS TRUSTED, AND WHY IT IS NOT FORGEABLE. A check run's NAME is not a
 * capability: any app, and any workflow, can post one called `fleet/review`.
 * The identity that is not claimed in the payload is `app.slug` — GitHub
 * stamps it from the credential that created the check run, and an App slug
 * is globally unique, so only the `llamenos-fleet-review` App can produce a
 * check run carrying it. An Actions job's own `fleet/review` is `github-actions`
 * and is never believed here (it is the carrier itself).
 *
 * WHAT THE VERDICT IS BOUND TO. A check run is keyed on the head SHA, so the
 * PASS judges exactly that commit's tree. It must also be bound to what ELSE
 * the cache's key binds a verdict to — the review SET and the PR's title and
 * description (`claimDigest`, #2336) — or a profile label added, or a
 * description edited, after the review would ride a PASS that never judged
 * it. So `review-and-merge` writes both into the check run's `external_id`
 * (`reviewBinding`, review-cache.ts), and the gate believes a run only when that tag equals
 * the binding it computes NOW from the live PR. A run with no binding (one
 * posted before this existed) or another one is not believed, and
 * `review-and-merge` does not reuse it either — it reviews again and posts a
 * bound one. A head whose artifact verdict exists (a cached FAIL for this
 * tree and description) is consulted FIRST and wins.
 */

/** The GitHub App that records `review-and-merge`'s verdict. Public by
 *  necessity (it is the App's URL slug); trusted because only that App can
 *  author a check run with it. */
export const REVIEW_RECORDER_APP_SLUG = 'llamenos-fleet-review'

export type AppRecordedVerdict =
  /** The App's latest completed `fleet/review` on this head is a success. */
  | { kind: 'pass'; checkRunId: number; url: string }
  /** The App recorded nothing usable on this head — no check run, or its
   *  latest is not a success. Never a pass. */
  | { kind: 'none'; reason: string }
  /** The check runs could not be read. Distinct from `none` so the log says
   *  "could not look", but it is handled identically: no verdict. */
  | { kind: 'unreadable'; reason: string }

/**
 * Pure. The App's verdict on `headSha`, from the check runs `missing-checks.ts`
 * reads off that commit (the one module the check-run rail admits as a
 * reader — `forgery-rails.ts` — so this file never names the endpoint).
 *
 * The LATEST completed App run decides, never "any of them passed": a
 * `review-and-merge --fresh` that found a problem after an earlier PASS must
 * not be outvoted by the run it supersedes (the queue arm in
 * `fleet-review.yml` reads its own verdict the same way). A run still in
 * flight is not a verdict and is ignored, and so is every check run whose
 * name or author is not exactly the one this trusts.
 */
export function appRecordedVerdictFrom(runs: readonly HeadCheckRun[], headSha: string, binding: string): AppRecordedVerdict {
  const mine = runs.filter((r) =>
    r.name === REVIEW_JOB && r.appSlug === REVIEW_RECORDER_APP_SLUG && r.status === 'completed')
  if (mine.length === 0) {
    return { kind: 'none', reason: `no completed ${REVIEW_JOB} check run by the ${REVIEW_RECORDER_APP_SLUG} App on ${headSha}` }
  }
  const latest = [...mine].sort((a, b) =>
    a.startedAt === b.startedAt ? b.id - a.id : a.startedAt < b.startedAt ? 1 : -1)[0] as HeadCheckRun
  if (latest.conclusion !== 'success') {
    return {
      kind: 'none',
      reason: `the ${REVIEW_RECORDER_APP_SLUG} App's latest ${REVIEW_JOB} on ${headSha} concluded ` +
        `${latest.conclusion ?? '(none)'}, which is not a pass`,
    }
  }
  // Bound to what it judged, or not believed: see "WHAT THE VERDICT IS BOUND TO".
  if (latest.externalId !== binding) {
    return {
      kind: 'none',
      reason: `the ${REVIEW_RECORDER_APP_SLUG} App's PASS on ${headSha} is bound to [${latest.externalId ?? ''}], not to ` +
        `this PR's review set and description [${binding}] — it judged something else, or was recorded before bindings existed`,
    }
  }
  return { kind: 'pass', checkRunId: latest.id, url: `check run ${latest.id} on ${headSha}` }
}

/** Live wiring: the read-only head read `missing-checks` already owns, covered
 *  by the `checks: read` the review job already holds. */
export async function readAppRecordedVerdict(
  headSha: string, binding: string, log: (msg: string) => void,
  fetchCheckRuns: (sha: string) => Promise<HeadCheckRun[]> = defaultMissingChecksDeps().fetchCheckRuns,
): Promise<AppRecordedVerdict> {
  try {
    return appRecordedVerdictFrom(await fetchCheckRuns(headSha), headSha, binding)
  } catch (e) {
    const reason = `could not read the ${REVIEW_JOB} check runs on ${headSha}: ${describeGhFailure(e)}`
    log(reason)
    return { kind: 'unreadable', reason }
  }
}
