/**
 * incident-closer (B-INCIDENTS, #2341) — closes incidents that have gone quiet
 * for their category's quiet period, and sends the trailing `updated` for an
 * incident whose last signals arrived inside a rate window, so the final
 * counts of a burst reach the banner without waiting for another signal.
 *
 * The close is what tells the people who were woken that it is over; an
 * incident that is never closed would leave a banner up forever and train
 * everyone to ignore it.
 */
import type { IncidentService } from '../services/incidents'
import { createLogger } from './logger'
import { trackWorkerTick, WORKER_TICK_INTERVAL_MS } from '../metrics/worker-liveness'

const logger = createLogger('lib.incident-closer')

/** Every minute — the shortest category window (10 min) and quiet period (15 min) are both well above it. */
const CHECK_INTERVAL_MS = WORKER_TICK_INTERVAL_MS['incident-closer']

let intervalId: ReturnType<typeof setInterval> | null = null

export function startIncidentCloserWorker(incidents: Pick<IncidentService, 'closeQuiet'>): void {
  if (intervalId) return

  logger.info('Started incident closer worker')

  const tick = () =>
    trackWorkerTick('incident-closer', async () => {
      const { closed, updated } = await incidents.closeQuiet()
      if (closed > 0 || updated > 0) logger.info('Incidents swept', { closed, updated })
    }).catch((err) => {
      logger.error('Incident closer tick failed', { error: err })
    })

  tick()

  intervalId = setInterval(tick, CHECK_INTERVAL_MS)
}

export function stopIncidentCloserWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped incident closer worker')
  }
}
