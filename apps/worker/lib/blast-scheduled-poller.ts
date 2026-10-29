/**
 * Scheduled blast poller — checks for due scheduled blasts and
 * triggers their sending + expansion pipeline.
 *
 * Runs on a 60s interval. When a scheduled blast's scheduledAt <= now,
 * transitions it to 'sending' and expands it into delivery rows.
 *
 * Follows the same pattern as blast-delivery-worker.ts.
 */

import type { BlastsService } from '../services/blasts'
import { createLogger } from './logger'
import { trackWorkerTick, WORKER_TICK_INTERVAL_MS } from '../metrics/worker-liveness'

const logger = createLogger('blast-scheduler')

/** How often to check for due blasts (ms) */
const POLL_INTERVAL_MS = WORKER_TICK_INTERVAL_MS['scheduled-blast-poller']

let pollTimer: ReturnType<typeof setInterval> | null = null
let serviceInstance: BlastsService | null = null

/**
 * Start the scheduled blast poller.
 */
export function startScheduledBlastPoller(blastsService: BlastsService): void {
  if (pollTimer) return
  serviceInstance = blastsService

  // Initial check after 15s
  setTimeout(() => checkScheduledBlasts(), 15_000)
  pollTimer = setInterval(() => checkScheduledBlasts(), POLL_INTERVAL_MS)

  logger.info(`Started (poll: ${POLL_INTERVAL_MS / 1000}s)`)
}

/**
 * Stop the scheduled blast poller.
 */
export function stopScheduledBlastPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  serviceInstance = null
  logger.info('Stopped')
}

/**
 * Check for scheduled blasts that are due and trigger them.
 */
async function checkScheduledBlasts(): Promise<void> {
  const service = serviceInstance
  if (!service) return

  try {
    await trackWorkerTick('scheduled-blast-poller', async () => {
      const dueBlasts = await service.getDueScheduledBlasts()
      if (dueBlasts.length === 0) return

      logger.info(`Found ${dueBlasts.length} due scheduled blast(s)`)

      for (const blast of dueBlasts) {
        try {
          // Transition to 'sending'
          await service.send(blast.id, blast.hubId ?? undefined)

          // Expand into delivery rows
          const deliveryCount = await service.expandBlast(blast.id)
          logger.info(`Expanded blast ${blast.id} into ${deliveryCount} deliveries`)
        } catch (err) {
          logger.error(`Failed to trigger scheduled blast ${blast.id}`, { error: String(err) })
        }
      }
    })
  } catch (err) {
    logger.error('Poll error', { error: String(err) })
  }
}
