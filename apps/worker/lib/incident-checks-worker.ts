/**
 * incident-checks — the L1 detector runner (B-INCIDENTS, #2341; spec §5.6).
 *
 * Evaluates every check registered with `IncidentService.registerCheck`, for
 * every hub, on its own schedule. It exists as a SEPARATE worker on purpose: a
 * check that ran inside the worker whose backlog it measures (e.g. the
 * erasure-deadline check inside `erasure-expiry`) could never report that
 * worker being stopped or wedged — the defect #2323 exists for. Here, the
 * erasure check keeps running whatever state `erasure-expiry` is in.
 *
 * A check that throws is counted by `runWorkerTick` per (check, hub); three in
 * a row raise `worker_failing` for the check's category, so a failing check
 * can never read as a zero count. Whether THIS worker is running at all is the
 * out-of-process liveness gauge's job (metrics/worker-liveness.ts).
 */
import type { IncidentService } from '../services/incidents'
import { createLogger } from './logger'
import { trackWorkerTick, WORKER_TICK_INTERVAL_MS } from '../metrics/worker-liveness'

const logger = createLogger('lib.incident-checks')

/**
 * Every 5 minutes. Level-check categories close after a quiet period that is a
 * multiple of this (services/incidents-categories.ts), so a standing backlog
 * re-observed every tick keeps its incident open.
 */
const CHECK_INTERVAL_MS = WORKER_TICK_INTERVAL_MS['incident-checks']

let intervalId: ReturnType<typeof setInterval> | null = null

export function startIncidentChecksWorker(incidents: Pick<IncidentService, 'runChecks'>): void {
  if (intervalId) return

  logger.info('Started incident checks worker')

  const tick = () =>
    trackWorkerTick('incident-checks', async () => {
      const { evaluated, failed } = await incidents.runChecks()
      if (failed > 0) logger.warn('Incident checks failed', { evaluated, failed })
    }).catch((err) => {
      logger.error('Incident checks tick failed', { error: err })
    })

  tick()

  intervalId = setInterval(tick, CHECK_INTERVAL_MS)
}

export function stopIncidentChecksWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped incident checks worker')
  }
}
