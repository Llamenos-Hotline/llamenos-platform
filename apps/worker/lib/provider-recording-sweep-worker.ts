/**
 * Provider recording sweep — retries provider deletions the provider has not
 * yet confirmed (#2297, #2309).
 *
 * A voicemail is deleted at the provider as soon as it has been fetched
 * (services/voicemail.ts); an opted-in call recording as soon as the server
 * holds its own sealed copy (services/call-recordings.ts). When the provider
 * refuses or cannot be reached — or, for a call recording, our copy could not
 * be made — the recording stays tracked in `provider_recordings` with its
 * error, and this worker tries again (copy first, then delete) until the
 * provider confirms.
 */
import type { ProviderMediaEraser } from '../services/provider-recordings'
import { createLogger } from './logger'
import { trackWorkerTick, WORKER_TICK_INTERVAL_MS } from '../metrics/worker-liveness'

const logger = createLogger('lib.provider-recording-sweep')

/** Check interval: every 15 minutes. */
const CHECK_INTERVAL_MS = WORKER_TICK_INTERVAL_MS['provider-recording-sweep']

/**
 * Leave a recording this young to its own webhook's processing: it may still be
 * fetching or transcribing, and deleting under it would race the fetch.
 */
export const RECORDING_SWEEP_GRACE_MS = 15 * 60 * 1000

let intervalId: ReturnType<typeof setInterval> | null = null

export function startProviderRecordingSweepWorker(providerMedia: ProviderMediaEraser): void {
  if (intervalId) return

  logger.info('Started provider recording sweep worker')

  const check = () =>
    trackWorkerTick('provider-recording-sweep', async () => {
      const result = await providerMedia.retryPending(RECORDING_SWEEP_GRACE_MS)
      if (result.deleted > 0) logger.info('Deleted recording(s) at the provider', { count: result.deleted })
      if (result.failed.length > 0) {
        logger.error('Recording(s) still held at the provider after retry', { count: result.failed.length })
      }
    }).catch((err) => {
      logger.error('Provider recording sweep failed', { error: err })
    })

  check()

  intervalId = setInterval(check, CHECK_INTERVAL_MS)
}

export function stopProviderRecordingSweepWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped provider recording sweep worker')
  }
}
