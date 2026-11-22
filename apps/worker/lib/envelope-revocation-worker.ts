/**
 * Envelope revocation worker — processes queued envelope revocation jobs.
 *
 * Each job removes a departed user's HPKE-wrapped key entries from
 * note/reply/message envelope arrays. Nothing is re-sealed or rewrapped: this
 * revokes future access through the server and cannot invalidate a wrap the
 * user already copied.
 */
import type { ErasureService } from '../services/erasure'
import { createLogger } from './logger'
import { trackWorkerTick, WORKER_TICK_INTERVAL_MS } from '../metrics/worker-liveness'

const logger = createLogger('lib.envelope-revocation')

/** Check interval: every 60 seconds */
const CHECK_INTERVAL_MS = WORKER_TICK_INTERVAL_MS['envelope-revocation']

let intervalId: ReturnType<typeof setInterval> | null = null

interface EnvelopeRevocationWorkerOpts {
  erasureService: ErasureService
}

export function startEnvelopeRevocationWorker(opts: EnvelopeRevocationWorkerOpts): void {
  if (intervalId) return

  logger.info('Started envelope revocation worker')

  const check = () =>
    trackWorkerTick('envelope-revocation', async () => {
      const jobs = await opts.erasureService.getQueuedEnvelopeRevocationJobs()
      if (jobs.length === 0) return

      logger.info('Processing envelope revocation jobs', { count: jobs.length })

      for (const job of jobs) {
        try {
          await opts.erasureService.processEnvelopeRevocationJob(job.id)
          logger.info('Envelope revocation job complete', {
            jobId: job.id,
            userId: job.userId,
            hubId: job.hubId,
          })
        } catch (err) {
          logger.error('Envelope revocation job failed', {
            jobId: job.id,
            error: err,
          })
        }
      }
    }).catch((err) => {
      logger.error('Envelope revocation worker check failed', { error: err })
    })

  check()

  intervalId = setInterval(check, CHECK_INTERVAL_MS)
}

export function stopEnvelopeRevocationWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped envelope revocation worker')
  }
}
