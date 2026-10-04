/**
 * Blast delivery worker — drains pending deliveries and sends them
 * through the messaging adapter, respecting rate limits and handling
 * retries with exponential backoff.
 *
 * Follows the same background poller pattern as blast-delivery-worker.ts.
 *
 * Lifecycle:
 *   1. TaskScheduler calls `startBlastWorker()` at server startup
 *   2. Every POLL_INTERVAL_MS, the worker checks for active blasts
 *   3. For each active blast, drains a batch of pending deliveries
 *   4. Sends each delivery through the appropriate messaging adapter
 *   5. Checks subscriber status before each send (mid-flight opt-out)
 *   6. Updates delivery status (sent/failed/opted_out)
 *   7. Syncs blast stats after each batch
 *   8. When all deliveries are terminal, blast transitions to 'sent'
 */

import type { BlastsService } from '../services/blasts'
import type { SettingsService } from '../services/settings'
import type { MessagingAdapter, SendResult } from '../messaging/adapter'
import type { MessagingChannelType, BlastContent, MultiBlastContent, BlastSettings } from '@shared/types'
import { DEFAULT_BLAST_SETTINGS, resolveBlastContent } from '@shared/types'
import { TokenBucketRateLimiter } from './rate-limiter'
import { createLogger } from './logger'

const logger = createLogger('blast-worker')

/** How often to poll for work (ms) */
const POLL_INTERVAL_MS = 10_000

/** Max deliveries to process per batch per blast */
const BATCH_SIZE = 50

/** Callback for real-time progress events */
export type BlastProgressCallback = (blastId: string, hubId: string, stats: {
  totalRecipients: number
  sent: number
  delivered: number
  failed: number
  optedOut: number
}) => void

/** Callback for blast status changes */
export type BlastStatusCallback = (blastId: string, hubId: string, status: string) => void

/** Function to resolve a messaging adapter for a given channel */
export type AdapterResolver = (channel: MessagingChannelType, hubId?: string) => Promise<MessagingAdapter | null>

export interface BlastDeliveryWorkerDeps {
  blastsService: BlastsService
  settingsService: SettingsService
  resolveAdapter: AdapterResolver
  /** Resolve subscriber identifier from encryptedIdentifier — needed to actually send messages */
  resolveIdentifier: (subscriberId: string) => Promise<string | null>
  onProgress?: BlastProgressCallback
  onStatusChange?: BlastStatusCallback
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let deps: BlastDeliveryWorkerDeps | null = null
let processing = false

// Per-hub-per-channel rate limiters (keyed by hubId:channel)
const rateLimiters = new Map<string, TokenBucketRateLimiter>()

const MAX_RATE_LIMITERS = 1000

function getRateLimiter(hubId: string, channel: MessagingChannelType, settings: BlastSettings): TokenBucketRateLimiter {
  const key = `${hubId || 'global'}:${channel}`
  let limiter = rateLimiters.get(key)
  if (!limiter) {
    const rate = settings.rateLimits?.[channel] ?? settings.rateLimitPerSecond
    limiter = TokenBucketRateLimiter.create(rate)
    rateLimiters.set(key, limiter)

    if (rateLimiters.size > MAX_RATE_LIMITERS) {
      const firstKey = rateLimiters.keys().next().value
      if (firstKey) rateLimiters.delete(firstKey)
    }
  }
  return limiter
}

/**
 * Start the blast delivery worker.
 */
export function startBlastWorker(workerDeps: BlastDeliveryWorkerDeps): void {
  if (pollTimer) return
  deps = workerDeps

  // Initial poll after 5s to let the app stabilize
  setTimeout(() => pollForWork(), 5_000)
  pollTimer = setInterval(() => pollForWork(), POLL_INTERVAL_MS)

  logger.info(`Started (poll: ${POLL_INTERVAL_MS / 1000}s, batch: ${BATCH_SIZE})`)
}

/**
 * Stop the blast delivery worker.
 */
export function stopBlastWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  deps = null
  rateLimiters.clear()
  logger.info('Stopped')
}

/**
 * Main poll loop — find active blasts and process their deliveries.
 */
async function pollForWork(): Promise<void> {
  if (!deps || processing) return
  processing = true

  try {
    const sendingBlasts = await deps.blastsService.getSendingBlasts()
    if (sendingBlasts.length === 0) return

    for (const blast of sendingBlasts) {
      // Re-check blast status (may have been cancelled)
      const current = await deps.blastsService.getBlast(blast.id)
      if (current.status !== 'sending') continue

      await processBlastBatch(blast.id, blast.hubId ?? '')
    }
  } catch (err) {
    logger.error('Poll error', { error: String(err) })
  } finally {
    processing = false
  }
}

/**
 * Process one batch of deliveries for a blast.
 */
async function processBlastBatch(blastId: string, hubId: string): Promise<void> {
  if (!deps) return

  // Get blast settings for rate limit
  const settings = await deps.blastsService.getBlastSettings(hubId)

  const messagingConfig = await deps.settingsService.getMessagingConfig()
  const smsContentMode = messagingConfig.smsContentMode ?? 'notification-only'

  // Get the blast content + opt-out footer
  const blast = await deps.blastsService.getBlast(blastId)
  const rawContent = blast.content as BlastContent | MultiBlastContent
  const defaultLang = (blast as Record<string, unknown>).defaultLanguage as string | undefined ?? 'en'
  const optOutFooter = settings.optOutFooter ?? DEFAULT_BLAST_SETTINGS.optOutFooter

  // Drain a batch of pending deliveries
  const batch = await deps.blastsService.drainDeliveryBatch(blastId, BATCH_SIZE)
  if (batch.length === 0) {
    // No more pending deliveries — sync stats to check completion
    const { completed } = await deps.blastsService.syncBlastStats(blastId)
    if (completed) {
      logger.info(`Blast ${blastId} completed`)
      if (hubId) {
        deps.onStatusChange?.(blastId, hubId, 'sent')
      }
    }
    return
  }

  logger.info(`Processing ${batch.length} deliveries for blast ${blastId}`)

  for (const delivery of batch) {
    // Re-check blast status (may have been cancelled mid-batch)
    const currentBlast = await deps.blastsService.getBlast(blastId)
    if (currentBlast.status !== 'sending') {
      logger.info(`Blast ${blastId} no longer sending (status: ${currentBlast.status}), stopping`)
      return
    }

    // Mid-flight opt-out check
    const isActive = await deps.blastsService.isSubscriberActive(delivery.subscriberId)
    if (!isActive) {
      await deps.blastsService.markDeliveryOptedOut(delivery.id)
      continue
    }

    const channel = delivery.channel as MessagingChannelType
    const adapter = await deps.resolveAdapter(channel, hubId)
    if (!adapter) {
      await deps.blastsService.markDeliveryFailed(
        delivery.id,
        `No adapter available for channel: ${channel}`,
        delivery.attempts,
      )
      continue
    }

    const limiter = getRateLimiter(hubId, channel, settings)
    await limiter.waitForToken()

    // Resolve subscriber language for multi-language content
    const subscriberRow = await deps.blastsService.getSubscriberById(delivery.subscriberId)
    const subscriberLang = subscriberRow?.language ?? 'en'
    const content = resolveBlastContent(rawContent, subscriberLang, defaultLang)

    // Build message body with opt-out footer
    const messageBody = buildMessageBody(content, channel, optOutFooter, smsContentMode)

    // Resolve the subscriber's actual identifier (decrypted from encryptedIdentifier)
    const recipientIdentifier = await deps.resolveIdentifier(delivery.subscriberId)

    if (!recipientIdentifier) {
      await deps.blastsService.markDeliveryFailed(
        delivery.id,
        'Could not resolve subscriber identifier',
        delivery.attempts,
      )
      continue
    }

    try {
      const result: SendResult = content.mediaUrl
        ? await adapter.sendMediaMessage({
            recipientIdentifier,
            body: messageBody,
            conversationId: `blast:${blastId}`,
            mediaUrl: content.mediaUrl,
            mediaType: content.mediaType ?? 'image/jpeg',
          })
        : await adapter.sendMessage({
            recipientIdentifier,
            body: messageBody,
            conversationId: `blast:${blastId}`,
          })

      if (result.success) {
        await deps.blastsService.markDeliverySent(delivery.id, result.externalId)
      } else {
        await deps.blastsService.markDeliveryFailed(
          delivery.id,
          result.error ?? 'Send failed',
          delivery.attempts,
        )
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      await deps.blastsService.markDeliveryFailed(
        delivery.id,
        errorMessage,
        delivery.attempts,
      )
    }
  }

  // Sync stats after batch
  const { stats, completed } = await deps.blastsService.syncBlastStats(blastId)

  if (hubId) {
    deps.onProgress?.(blastId, hubId, stats)
  }

  if (completed) {
    logger.info(`Blast ${blastId} completed — ${stats.sent + stats.delivered} sent, ${stats.failed} failed`)
    if (hubId) {
      deps.onStatusChange?.(blastId, hubId, 'sent')
    }
  }
}

/**
 * Build the message body for a specific channel, with opt-out footer.
 */
const NOTIFICATION_ONLY_MESSAGE = 'You have a new secure message. Open Llamenos to view it.'

function buildMessageBody(
  content: BlastContent,
  channel: MessagingChannelType,
  optOutFooter: string,
  smsContentMode: 'full' | 'notification-only' = 'notification-only'
): string {
  let body: string
  switch (channel) {
    case 'sms':
      body = content.smsText ?? content.text ?? ''
      if (smsContentMode === 'notification-only') {
        body = NOTIFICATION_ONLY_MESSAGE
      }
      break
    default:
      body = content.text ?? ''
      break
  }

  return body + optOutFooter
}
