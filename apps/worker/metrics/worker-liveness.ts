/**
 * Scheduler-worker liveness, published for an OUT-OF-PROCESS observer.
 *
 * A check that runs inside the worker it checks cannot report that worker
 * being down: if `erasure-expiry` is simply not running, nothing in this
 * process will ever notice a caller-erasure deadline passing (#2323). So this
 * module does not decide anything. It publishes two instance-level gauges per
 * worker, and Prometheus — a different process — decides:
 *
 *   llamenos_worker_tick_interval_seconds{worker}           how often it SHOULD tick
 *   llamenos_worker_last_success_timestamp_seconds{worker}  when a tick last COMPLETED
 *
 * The `WorkerStalled` rule in deploy/ansible/roles/llamenos-prometheus/
 * templates/alert-rules.yml.j2 fires when the second is older than three
 * intervals, AND when the second was never published at all while the first
 * was. The interval gauge is published for every worker from process start,
 * independent of whether that worker ever runs — that is what makes a worker
 * that never ticked visible as a missing series instead of a quiet one.
 *
 * What "success" means here is LIVENESS, not correctness: the tick's body ran
 * to completion without throwing out of `trackWorkerTick`. A tick that catches
 * and logs its own per-item failures still reports alive; counting those is
 * the in-process worker-failure layer's job, not this one.
 *
 * The honest limit: this reaches whoever OPERATES the deployment (through
 * Alertmanager), never hub members. When the process or its scheduler is
 * down, the app cannot tell anyone anything.
 *
 * Both gauges carry only a worker name and numbers — no hub, user or caller
 * data — so they are safe to expose to the scraper.
 */
import type { SchedulerWorkerName } from '../services/scheduler'

const MINUTE_MS = 60_000

/**
 * Tick interval of every scheduler worker — the single source of truth. Each
 * worker reads its own `setInterval` period from here, so the period Prometheus
 * measures staleness against can never drift from the one the worker runs on.
 * Why each worker ticks at its rate is documented next to its constant in its
 * own module.
 *
 * `satisfies Record<SchedulerWorkerName, number>` makes a worker added to
 * SCHEDULER_WORKER_NAMES without an entry here a compile error.
 */
export const WORKER_TICK_INTERVAL_MS = {
  'blast-delivery': 10_000,
  'scheduled-blast-poller': MINUTE_MS,
  'retention-purge': 30 * MINUTE_MS,
  'audit-chain-verify': 60 * MINUTE_MS,
  'erasure-expiry': 5 * MINUTE_MS,
  're-encryption': MINUTE_MS,
  'periodic-cleanup': 5 * MINUTE_MS,
  'signal-queue-drain': 30_000,
  'stale-call-reaper': 2 * MINUTE_MS,
  'provider-recording-sweep': 15 * MINUTE_MS,
} as const satisfies Record<SchedulerWorkerName, number>

export const WORKER_LAST_SUCCESS_METRIC = 'llamenos_worker_last_success_timestamp_seconds'
export const WORKER_TICK_INTERVAL_METRIC = 'llamenos_worker_tick_interval_seconds'

/** Unix seconds of each worker's last completed tick. Process-local by design. */
const lastSuccessSeconds = new Map<SchedulerWorkerName, number>()

/**
 * Run one worker tick and, only if it completes, record it as the worker's
 * last success. A throw propagates unchanged and records nothing, so the
 * caller's existing error handling still runs and the gauge goes stale.
 */
export async function trackWorkerTick<T>(worker: SchedulerWorkerName, tick: () => Promise<T>): Promise<T> {
  const result = await tick()
  lastSuccessSeconds.set(worker, Date.now() / 1000)
  return result
}

/** Last completed tick (Unix seconds) for `worker`, or undefined if it never completed one. */
export function getWorkerLastSuccessSeconds(worker: SchedulerWorkerName): number | undefined {
  return lastSuccessSeconds.get(worker)
}

/**
 * Prometheus text-exposition lines for both gauges.
 *
 * The interval gauge is emitted for EVERY registered worker; the last-success
 * gauge only for workers that have completed a tick. A missing last-success
 * series is therefore a real signal (never ticked), not a default of 0 — a 0
 * would read as "succeeded in 1970" and could never be told apart.
 */
export function renderWorkerLivenessMetrics(): string[] {
  const lines: string[] = [
    `# HELP ${WORKER_TICK_INTERVAL_METRIC} Configured tick interval of each scheduler worker`,
    `# TYPE ${WORKER_TICK_INTERVAL_METRIC} gauge`,
  ]
  for (const [worker, intervalMs] of Object.entries(WORKER_TICK_INTERVAL_MS)) {
    lines.push(`${WORKER_TICK_INTERVAL_METRIC}{worker="${worker}"} ${intervalMs / 1000}`)
  }

  lines.push(
    `# HELP ${WORKER_LAST_SUCCESS_METRIC} Unix time of each scheduler worker's last completed tick (absent until its first)`,
    `# TYPE ${WORKER_LAST_SUCCESS_METRIC} gauge`,
  )
  for (const [worker, seconds] of lastSuccessSeconds) {
    lines.push(`${WORKER_LAST_SUCCESS_METRIC}{worker="${worker}"} ${seconds.toFixed(3)}`)
  }
  return lines
}
