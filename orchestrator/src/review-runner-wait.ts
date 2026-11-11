/**
 * How long `fleet/review` really waits for the review box (#2648).
 *
 * THE TRAP THIS EXISTS FOR. `gh run list --json createdAt,startedAt` reports a
 * wait of 0m for every run, because a workflow run's `startedAt` is stamped at
 * ~creation and says nothing about when a JOB acquired a runner. Measured on
 * 2026-11-10: 21 of 21 runs read 0m at run level, while the `fleet/review`
 * jobs on the same runs had waited 6-31 minutes (48 for #2613). The box
 * (`llamenos-review-box`) is ONE machine; every dashboard built on run-level
 * timestamps reported a healthy queue over a 39-minute backlog.
 *
 * The honest number is `job.started_at - run.created_at`, from the jobs API.
 * A job that has not started has no `started_at` yet and is STILL WAITING: its
 * wait so far is `now - created_at`, reported as such — never as 0 and never
 * dropped, because the longest waits are exactly the jobs that have not
 * started.
 *
 * Pure: no I/O. `scripts/fleet-review-wait.ts` does the reads.
 */

export interface RunJobSample {
  runId: number
  /** `pull_request` | `merge_group` | `workflow_dispatch` … */
  event: string
  branch: string
  /** The RUN's `created_at` — when the job became runnable. */
  runCreatedAt: string
  /** The `fleet/review` JOB's `started_at`; null while it is still queued. */
  jobStartedAt: string | null
  /** The job's own status: queued | in_progress | completed | waiting. */
  jobStatus: string
  /** The job's `runner_name`; empty/null when no runner ever took it. */
  runnerName: string | null
}

export interface RunnerWait {
  runId: number
  event: string
  branch: string
  /** Minutes the job waited for a runner (so far, if it has not started). */
  waitMinutes: number
  /** true: the job has not started — `waitMinutes` is a floor, not a final. */
  stillWaiting: boolean
  /** Hosted runners start at once; only the self-hosted box queues. */
  onReviewBox: boolean
}

const MS_PER_MINUTE = 60_000

/** A job that ran on a GitHub-hosted runner carries a `GitHub Actions N` name. */
function isReviewBox(runnerName: string | null): boolean {
  return runnerName === null || runnerName === '' || !/^GitHub Actions \d+$/.test(runnerName)
}

export function runnerWait(s: RunJobSample, now: Date): RunnerWait | undefined {
  const created = Date.parse(s.runCreatedAt)
  if (Number.isNaN(created)) return undefined
  const stillWaiting = s.jobStartedAt === null
  const end = stillWaiting ? now.getTime() : Date.parse(s.jobStartedAt as string)
  if (Number.isNaN(end)) return undefined
  return {
    runId: s.runId,
    event: s.event,
    branch: s.branch,
    waitMinutes: Math.max(0, Math.round((end - created) / MS_PER_MINUTE)),
    stillWaiting,
    onReviewBox: isReviewBox(s.runnerName),
  }
}

export interface WaitSummary {
  runs: number
  stillWaiting: number
  maxMinutes: number
  p50Minutes: number
  p90Minutes: number
  /** Per event: the same three numbers, so a merge_group wait cannot hide
   *  inside a pull_request average — the inversion #2648 is about. */
  byEvent: Record<string, { runs: number; maxMinutes: number; p50Minutes: number }>
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number
}

export function summarizeWaits(waits: RunnerWait[]): WaitSummary {
  const mins = waits.map((w) => w.waitMinutes).sort((a, b) => a - b)
  const byEvent: WaitSummary['byEvent'] = {}
  for (const event of new Set(waits.map((w) => w.event))) {
    const m = waits.filter((w) => w.event === event).map((w) => w.waitMinutes).sort((a, b) => a - b)
    byEvent[event] = { runs: m.length, maxMinutes: m[m.length - 1] ?? 0, p50Minutes: percentile(m, 50) }
  }
  return {
    runs: waits.length,
    stillWaiting: waits.filter((w) => w.stillWaiting).length,
    maxMinutes: mins[mins.length - 1] ?? 0,
    p50Minutes: percentile(mins, 50),
    p90Minutes: percentile(mins, 90),
    byEvent,
  }
}

/** A run that is still `queued`/`waiting` after this long is not queueing, it
 *  is stuck (the 2026-10-07 zombie sat for 34 days). */
export const ZOMBIE_AFTER_HOURS = 24

export function isZombie(runCreatedAt: string, status: string, now: Date): boolean {
  if (status !== 'queued' && status !== 'waiting' && status !== 'pending') return false
  const created = Date.parse(runCreatedAt)
  return !Number.isNaN(created) && now.getTime() - created > ZOMBIE_AFTER_HOURS * 60 * MS_PER_MINUTE
}
