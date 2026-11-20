import { ghJson, gh, REPO, describeGhFailure } from './gh.js'
import { REVIEW_JOB } from './ci.js'
import { defaultMissingChecksDeps, type HeadCheckRun } from './missing-checks.js'

/**
 * Making the head's `fleet/review` carrier read what `review-and-merge`
 * just recorded (#2884).
 *
 * The required context's verdict is the worst of the head's counted
 * carriers, one per app. After `review-and-merge` posts a PASS as the
 * `llamenos-fleet-review` App, the Actions carrier that already concluded
 * `NO-VERDICT:unreviewed` on the same head is still red, and nothing re-runs
 * it. The gate can now read the App's PASS (`review-app-verdict.ts`), but only
 * a run that starts AFTER the PASS exists will: so this re-runs the carrier,
 * in place, the same way the `refresh-carrier` job in `fleet-review.yml`
 * does after a review request (#2813) — a re-run is a new attempt inside the
 * SAME check suite, so the head keeps exactly one Actions `fleet/review`.
 *
 * It never makes anything green by itself: the re-run re-judges the head on
 * the gate's own terms, and a carrier that is already green, still running,
 * or not the `pull_request` carrier of `fleet-review.yml` is left alone.
 */

/** The workflow whose `pull_request` run is the head's carrier. */
export const CARRIER_WORKFLOW_PATH = '.github/workflows/fleet-review.yml'

const ACTIONS_APP_SLUG = 'github-actions'

export interface CarrierRefreshDeps {
  /** The head's check runs — `missing-checks.ts`'s read, the one the check-run
   *  rail admits. THROWS on failure, so "could not look" is never "no carrier". */
  fetchCheckRuns(sha: string): Promise<HeadCheckRun[]>
  /** A read-only `gh api` GET; `undefined` on any failure. */
  api<T>(path: string): Promise<T | undefined>
  /** `POST .../actions/runs/<id>/rerun`; throws when GitHub refuses. */
  rerun(runId: number): Promise<void>
  log(msg: string): void
}

export type CarrierRefreshResult =
  | { kind: 'refreshed'; runs: number[] }
  /** Nothing was red, or nothing is a carrier — no action needed. */
  | { kind: 'nothing-to-refresh'; why: string }
  /** The carriers could not be listed or re-run. The verdict stays recorded;
   *  only the re-run is unfinished, and `why` says how to finish it. */
  | { kind: 'not-refreshed'; why: string }

interface RunInfo { path?: string; event?: string; status?: string }

export async function refreshFailedCarriers(headSha: string, deps: CarrierRefreshDeps): Promise<CarrierRefreshResult> {
  let listed: HeadCheckRun[]
  try {
    listed = await deps.fetchCheckRuns(headSha)
  } catch (e) {
    return { kind: 'not-refreshed', why: `could not list the ${REVIEW_JOB} check runs on ${headSha}: ${describeGhFailure(e)}` }
  }
  // Only a COMPLETED, FAILED Actions check run: a green carrier needs nothing,
  // and a running one will read the App's PASS on its own if it started after.
  const red = listed.filter((c) =>
    c.name === REVIEW_JOB && c.appSlug === ACTIONS_APP_SLUG && c.status === 'completed' && c.conclusion === 'failure')
  if (red.length === 0) {
    return { kind: 'nothing-to-refresh', why: `no failed Actions ${REVIEW_JOB} carrier on ${headSha}` }
  }
  const runs: number[] = []
  for (const check of red) {
    const job = await deps.api<{ run_id?: number }>(`repos/${REPO}/actions/jobs/${check.id}`)
    if (job?.run_id === undefined) {
      return { kind: 'not-refreshed', why: `could not resolve check run ${check.id} to its workflow run` }
    }
    const run = await deps.api<RunInfo>(`repos/${REPO}/actions/runs/${job.run_id}`)
    if (run === undefined) return { kind: 'not-refreshed', why: `could not read workflow run ${job.run_id}` }
    // A dispatch run is not the carrier: only the `pull_request` run attaches
    // to the PR's rollup, and re-running anything else changes nothing there.
    const path = run.path ?? ''
    if ((path !== CARRIER_WORKFLOW_PATH && !path.startsWith(`${CARRIER_WORKFLOW_PATH}@`)) || run.event !== 'pull_request') {
      deps.log(`not a carrier: check run ${check.id} belongs to run ${job.run_id} (${path || 'no path'}, ${run.event ?? 'no event'})`)
      continue
    }
    if (!runs.includes(job.run_id)) runs.push(job.run_id)
  }
  if (runs.length === 0) return { kind: 'nothing-to-refresh', why: `no failed ${REVIEW_JOB} check run on ${headSha} is the pull_request carrier` }
  for (const id of runs) {
    try {
      await deps.rerun(id)
    } catch (e) {
      return { kind: 'not-refreshed', why: `GitHub refused to re-run carrier run ${id}: ${describeGhFailure(e)}` }
    }
    deps.log(`re-ran the ${REVIEW_JOB} carrier (run ${id}) on ${headSha} in place`)
  }
  return { kind: 'refreshed', runs }
}

/** Live wiring over the operator's own `gh` credentials (`actions: write`). */
export function liveCarrierRefreshDeps(log: (msg: string) => void): CarrierRefreshDeps {
  return {
    fetchCheckRuns: defaultMissingChecksDeps().fetchCheckRuns,
    api: <T>(path: string) => ghJson<T>(['api', path], 30_000, (detail) => log(`gh api ${path} failed: ${detail}`)),
    rerun: async (runId) => { await gh(['api', '-X', 'POST', `repos/${REPO}/actions/runs/${runId}/rerun`], 30_000) },
    log,
  }
}

export function describeCarrierRefresh(r: CarrierRefreshResult, headSha: string): string {
  switch (r.kind) {
    case 'refreshed':
      return `re-ran the ${REVIEW_JOB} carrier (run ${r.runs.join(', ')}) on ${headSha} so the required context reads the recorded PASS`
    case 'nothing-to-refresh':
      return `no carrier re-run needed: ${r.why}`
    case 'not-refreshed':
      return `the verdict is recorded, but the carrier was NOT re-run (${r.why}); re-run the head's ` +
        `Fleet Review \`pull_request\` run by hand to have the required context read it`
  }
}
