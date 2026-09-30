/**
 * Whether a CI run's PLATFORM jobs run on this event, or are left to the merge
 * queue. "Platform jobs" are the ones `ci.yml` and `desktop-e2e.yml` gate on a
 * `changes` flag — the iOS/Android/desktop/backend/crypto builds and E2E
 * suites, including every macOS job.
 *
 * THE ONE CASE THAT DEFERS: a `pull_request` event for the knope release PR
 * (`KNOPE_RELEASE_BRANCH`, this repository's own branch, never a fork's), whose
 * base branch has a merge queue. knope regenerates that PR on every merge to
 * `main`, so each regeneration used to buy a full platform run, including the
 * macOS jobs that share GitHub's repo-wide cap of 5 concurrent macOS jobs with
 * every other PR — for a diff that is a version bump and a changelog. On a
 * `pull_request` event that run is advisory: `merge_group` CI tests the actual
 * merge commit before it reaches `main`, and that is the gate. Deferring the
 * advisory copy changes nothing about what can land.
 *
 * WHAT DEFERRING DOES NOT TOUCH. Every job that is not platform-gated still
 * runs on the release PR (build, lint, docs-guard, audit, the no-generated-
 * files and updater-pubkey guards, crypto-guardrails). The other four required
 * contexts are separate workflows that this module does not change:
 * `gitleaks`, `CodeQL` and `fleet/verify` run on both events, and
 * `fleet/review` only republishes on `merge_group` the verdict the PR earned —
 * so it could never be deferred.
 *
 * EVERY OTHER CASE RUNS, and every doubt resolves to "run":
 *   - any event other than `pull_request` — `merge_group` above all, and also
 *     `push` and `workflow_dispatch`;
 *   - any other head branch — for an ordinary PR the early signal is the
 *     author's feedback loop, not a duplicate;
 *   - a FORK's branch named `release`, which is not the knope PR;
 *   - a base branch whose rules cannot be read, or that has no merge queue —
 *     in that case nothing downstream would test the merge before it landed.
 */
import { KNOPE_RELEASE_BRANCH } from './roles/release.js'

export type PlatformJobs = 'run' | 'defer-to-merge-queue'

export interface PrCiEvent {
  /** `github.event_name`. */
  eventName: string
  /** `github.head_ref` — empty outside `pull_request`. */
  headRef: string
  /** `github.event.pull_request.head.repo.full_name` — empty outside `pull_request`. */
  headRepo: string
  /** `github.repository`. */
  repository: string
  /** Raw body of `GET /repos/{repo}/rules/branches/{base}`; empty when it was not fetched or the fetch failed. */
  baseBranchRules: string
}

export interface PrCiScope {
  platformJobs: PlatformJobs
  reason: string
}

/** Whether a rules-for-a-branch response contains an active merge queue rule. Anything unreadable is "no". */
export function hasMergeQueue(rawRules: string): boolean {
  let rules: unknown
  try {
    rules = JSON.parse(rawRules)
  } catch {
    return false
  }
  return Array.isArray(rules) && rules.some(
    (rule: unknown) => typeof rule === 'object' && rule !== null && (rule as { type?: unknown }).type === 'merge_queue',
  )
}

export function decidePrCiScope(event: PrCiEvent): PrCiScope {
  if (event.eventName !== 'pull_request') {
    return { platformJobs: 'run', reason: `"${event.eventName}" is not a pull_request event; only a pull_request run is ever deferred` }
  }
  if (event.headRef !== KNOPE_RELEASE_BRANCH) {
    return { platformJobs: 'run', reason: `head branch "${event.headRef}" is not the knope release branch` }
  }
  if (event.headRepo !== event.repository) {
    return { platformJobs: 'run', reason: `head repository "${event.headRepo}" is not ${event.repository}; a fork's "${KNOPE_RELEASE_BRANCH}" branch is not the knope release PR` }
  }
  if (!hasMergeQueue(event.baseBranchRules)) {
    return { platformJobs: 'run', reason: 'the base branch has no merge queue, or its rules could not be read; nothing would test this merge before it lands' }
  }
  return {
    platformJobs: 'defer-to-merge-queue',
    reason: 'knope release PR against a merge-queue base: the platform jobs run on merge_group, against the commit that will actually land',
  }
}

// Workflow entry point. Reads the event from the environment, writes exactly
// one `platform_jobs=<value>` line to stdout (the caller appends it to
// $GITHUB_OUTPUT) and the reason to stderr, where it shows in the job log.
if (import.meta.main) {
  const env = (name: string): string => process.env[name] ?? ''
  const scope = decidePrCiScope({
    eventName: env('EVENT_NAME'),
    headRef: env('HEAD_REF'),
    headRepo: env('HEAD_REPO'),
    repository: env('REPOSITORY'),
    baseBranchRules: env('BASE_BRANCH_RULES'),
  })
  console.error(`platform jobs: ${scope.platformJobs} — ${scope.reason}`)
  console.log(`platform_jobs=${scope.platformJobs}`)
}
