/**
 * Provider recording sweep — retries voicemail deletions the provider has not
 * yet confirmed (#2297).
 *
 * A voicemail is deleted at the provider as soon as it has been fetched
 * (services/voicemail.ts). When the provider refuses or cannot be reached, the
 * recording stays tracked in `provider_recordings`, with its error; this
 * worker asks again until the provider confirms. Opted-in CALL recordings are
 * not swept: they are kept for playback until their call record's retention
 * purge or a hub shred deletes them.
 */
import type { ProviderMediaEraser } from '../services/provider-recordings'
import { createLogger } from './logger'

const logger = createLogger('lib.provider-recording-sweep')

/** Check interval: every 15 minutes. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000

/**
 * Leave a voicemail this young to its own webhook's processing: it may still be
 * transcribing, and deleting under it would race the fetch.
 */
export const VOICEMAIL_SWEEP_GRACE_MS = 15 * 60 * 1000

let intervalId: ReturnType<typeof setInterval> | null = null

export function startProviderRecordingSweepWorker(providerMedia: ProviderMediaEraser): void {
  if (intervalId) return

  logger.info('Started provider recording sweep worker')

  const check = async () => {
    try {
      const result = await providerMedia.retryPendingVoicemails(VOICEMAIL_SWEEP_GRACE_MS)
      if (result.deleted > 0) logger.info('Deleted voicemail recording(s) at the provider', { count: result.deleted })
      if (result.failed.length > 0) {
        logger.error('Voicemail recording(s) still held at the provider after retry', { count: result.failed.length })
      }
    } catch (err) {
      logger.error('Provider recording sweep failed', { error: err })
    }
  }

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
