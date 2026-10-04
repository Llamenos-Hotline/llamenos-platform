/**
 * Signal retry queue drain worker.
 *
 * SignalMessageQueue.claimBatch() (apps/worker/messaging/signal/queue.ts)
 * claims a batch of pending messages for delivery, but nothing ever called
 * it — a repo-wide grep returned only the definition. Messages enqueued
 * after a transient send failure sat at status='pending' forever: never
 * retried, never dead-lettered, never surfaced in the admin dead-letter UI
 * (which only shows rows already transitioned to 'dead'). See issue #1127.
 *
 * This worker drains the queue on an interval: claim a batch, resolve the
 * Signal adapter, attempt delivery, and record the outcome via the queue's
 * own markSent/markFailed — markFailed already implements the exponential
 * backoff + dead-letter transition after maxRetries, this worker only has
 * to call it.
 */
import type { Database } from '../db'
import type { MessagingAdapter } from '../messaging/adapter'
import { SignalMessageQueue } from '../messaging/signal/queue'
import { createLogger } from './logger'

const logger = createLogger('lib.signal-queue-drain')

/** Drain every 30 seconds — matches the queue's base retry backoff. */
export const DRAIN_INTERVAL_MS = 30 * 1000

const BATCH_SIZE = 10

/** Resolves the currently configured Signal adapter, or null if unconfigured. */
export type SignalAdapterResolver = () => Promise<MessagingAdapter | null>

export interface SignalQueueDrainWorkerOpts {
  queue: SignalMessageQueue
  resolveSignalAdapter: SignalAdapterResolver
}

/** Convenience for the scheduler — builds the queue from a Database handle. */
export function createSignalQueueDrainOpts(
  db: Database,
  resolveSignalAdapter: SignalAdapterResolver,
): SignalQueueDrainWorkerOpts {
  return { queue: new SignalMessageQueue(db), resolveSignalAdapter }
}

let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Drain one batch. Returns the number of messages claimed. Exported for
 * tests; the scheduler calls it through the worker below.
 */
export async function drainSignalQueue(opts: SignalQueueDrainWorkerOpts): Promise<number> {
  const batch = await opts.queue.claimBatch(BATCH_SIZE)
  if (batch.length === 0) return 0

  const adapter = await opts.resolveSignalAdapter()
  if (!adapter) {
    // No Signal provider configured right now — put every claimed message
    // back on the retry clock rather than burning a retry attempt against a
    // send that was never going to happen.
    logger.warn('Signal queue has pending messages but no adapter is configured', {
      count: batch.length,
    })
    for (const message of batch) {
      await opts.queue.markFailed(message.id, 'Signal adapter not configured', message.retryCount)
    }
    return batch.length
  }

  for (const message of batch) {
    try {
      if (await opts.queue.isRateLimited(message.recipientIdentifier)) {
        await opts.queue.markFailed(message.id, 'Rate limited', message.retryCount)
        continue
      }

      const result = message.mediaUrl
        ? await adapter.sendMediaMessage({
            recipientIdentifier: message.recipientIdentifier,
            body: message.body,
            conversationId: message.conversationId,
            mediaUrl: message.mediaUrl,
            mediaType: message.mediaType ?? 'application/octet-stream',
          })
        : await adapter.sendMessage({
            recipientIdentifier: message.recipientIdentifier,
            body: message.body,
            conversationId: message.conversationId,
          })

      if (result.success) {
        await opts.queue.markSent(message.id, result.externalId)
      } else {
        await opts.queue.markFailed(message.id, result.error ?? 'Send failed', message.retryCount)
      }
    } catch (err) {
      await opts.queue.markFailed(
        message.id,
        err instanceof Error ? err.message : String(err),
        message.retryCount,
      )
    }
  }

  return batch.length
}

export function startSignalQueueDrainWorker(opts: SignalQueueDrainWorkerOpts): void {
  if (intervalId) return

  logger.info('Started Signal queue drain worker')

  const run = () => {
    drainSignalQueue(opts).catch((err) => {
      logger.error('Signal queue drain run failed', { error: err })
    })
  }

  run()
  intervalId = setInterval(run, DRAIN_INTERVAL_MS)
}

export function stopSignalQueueDrainWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped Signal queue drain worker')
  }
}
