/**
 * Re-encryption worker — processes queued re-encryption jobs.
 *
 * Each job removes a departed user's HPKE-wrapped key copies
 * from note/reply/message envelopes.
 */
import type { ErasureService } from '../services/erasure'
import { createLogger } from './logger'
import { trackWorkerTick, WORKER_TICK_INTERVAL_MS } from '../metrics/worker-liveness'

const logger = createLogger('lib.re-encryption')

/** Check interval: every 60 seconds */
const CHECK_INTERVAL_MS = WORKER_TICK_INTERVAL_MS['re-encryption']

let intervalId: ReturnType<typeof setInterval> | null = null

interface ReEncryptionWorkerOpts {
  erasureService: ErasureService
}

export function startReEncryptionWorker(opts: ReEncryptionWorkerOpts): void {
  if (intervalId) return

  logger.info('Started re-encryption worker')

  const check = () =>
    trackWorkerTick('re-encryption', async () => {
      const jobs = await opts.erasureService.getQueuedReEncryptionJobs()
      if (jobs.length === 0) return

      logger.info('Processing re-encryption jobs', { count: jobs.length })

      for (const job of jobs) {
        try {
          await opts.erasureService.processReEncryptionJob(job.id)
          logger.info('Re-encryption job complete', {
            jobId: job.id,
            userId: job.userId,
            hubId: job.hubId,
          })
        } catch (err) {
          logger.error('Re-encryption job failed', {
            jobId: job.id,
            error: err,
          })
        }
      }
    }).catch((err) => {
      logger.error('Re-encryption worker check failed', { error: err })
    })

  check()

  intervalId = setInterval(check, CHECK_INTERVAL_MS)
}

export function stopReEncryptionWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped re-encryption worker')
  }
}
