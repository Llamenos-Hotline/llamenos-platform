/**
 * SignalMessageQueue — PostgreSQL-backed retry queue for Signal messages.
 *
 * When sending a Signal message fails transiently (bridge down, rate limited,
 * network error), the message is enqueued for retry with exponential backoff.
 *
 * The queue is processed by a periodic drain loop (called from the scheduler
 * or a setInterval in dev mode). Messages that exceed maxRetries are marked
 * as dead-letter for admin review.
 *
 * Rate limiting: enforces per-number send rate limits to avoid Signal's
 * anti-spam protections (max N messages per minute per recipient).
 */

import { eq, and, lte, sql, desc } from 'drizzle-orm'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_CONTACT_ID, LABEL_MESSAGE } from '@shared/crypto-labels'
import type { Database } from '../../db'
import { signalMessageQueue } from '../../db/schema'
import { serverDecrypt, serverEncrypt } from '../../lib/crypto'
import { createLogger } from '../../lib/logger'

const logger = createLogger('signal-queue')

export type QueuedMessageStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'dead'

export interface EnqueueParams {
  hubId: string
  conversationId: string
  recipientIdentifier: string
  body: string
  mediaUrl?: string
  mediaType?: string
  idempotencyKey?: string
}

export interface QueueStats {
  pending: number
  processing: number
  failed: number
  dead: number
  sent: number
}

/** Default: max 5 retries with exponential backoff */
const DEFAULT_MAX_RETRIES = 5

/** Default: 3 messages per minute per recipient */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 3

/** Base delay for exponential backoff: 30 seconds */
const BACKOFF_BASE_MS = 30_000

/** Default retention for completed and dead-letter queue rows. */
export const DEFAULT_SIGNAL_QUEUE_RETENTION_DAYS = 30

/** Purge at least daily; queue delivery itself is drained more frequently. */
export const SIGNAL_QUEUE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

const MAX_SIGNAL_QUEUE_RETENTION_DAYS = 3650

export function parseSignalQueueRetentionDays(value?: string): number {
  if (value === undefined || value.trim() === '') return DEFAULT_SIGNAL_QUEUE_RETENTION_DAYS

  const days = Number(value)
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_SIGNAL_QUEUE_RETENTION_DAYS) {
    throw new Error(
      `SIGNAL_QUEUE_RETENTION_DAYS must be an integer from 1 to ${MAX_SIGNAL_QUEUE_RETENTION_DAYS}`,
    )
  }
  return days
}

/** HMAC-SHA-256 keyed by the server secret and domain-separated for contact identifiers. */
export function hashSignalQueueRecipientIdentifier(recipientIdentifier: string, hmacSecret: string): string {
  const key = hexToBytes(hmacSecret)
  return bytesToHex(hmac(sha256, key, utf8ToBytes(`${LABEL_CONTACT_ID}${recipientIdentifier}`)))
}

function encryptQueueValue(value: string, label: string, hmacSecret: string): string {
  return bytesToHex(serverEncrypt(utf8ToBytes(value), label, hexToBytes(hmacSecret)))
}

function decryptQueueValue(value: string, label: string, hmacSecret: string): string {
  return new TextDecoder().decode(serverDecrypt(hexToBytes(value), label, hexToBytes(hmacSecret)))
}

export class SignalMessageQueue {
  constructor(
    private readonly db: Database,
    private readonly hmacSecret: string,
    private readonly maxRetries: number = DEFAULT_MAX_RETRIES,
    private readonly rateLimitPerMinute: number = DEFAULT_RATE_LIMIT_PER_MINUTE,
  ) {}

  /**
   * Enqueue a message for delivery. If an idempotency key is provided,
   * duplicate enqueues are silently ignored.
   */
  async enqueue(params: EnqueueParams): Promise<string> {
    const id = crypto.randomUUID()
    const now = new Date()

    await this.db.insert(signalMessageQueue).values({
      id,
      hubId: params.hubId,
      conversationId: params.conversationId,
      recipientIdentifierHash: hashSignalQueueRecipientIdentifier(params.recipientIdentifier, this.hmacSecret),
      recipientIdentifierCiphertext: encryptQueueValue(
        params.recipientIdentifier,
        LABEL_CONTACT_ID,
        this.hmacSecret,
      ),
      encryptedBody: encryptQueueValue(params.body, LABEL_MESSAGE, this.hmacSecret),
      mediaUrl: params.mediaUrl ?? null,
      mediaType: params.mediaType ?? null,
      idempotencyKey: params.idempotencyKey ?? null,
      status: 'pending',
      retryCount: 0,
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing()

    logger.info('Message enqueued', { id, conversationId: params.conversationId })
    return id
  }

  /**
   * Claim and return a batch of messages ready for delivery.
   * Uses a CTE with SELECT ... FOR UPDATE SKIP LOCKED → UPDATE ... RETURNING
   * for safe concurrent processing without race conditions.
   */
  async claimBatch(batchSize: number = 10): Promise<Array<{
    id: string
    hubId: string
    conversationId: string
    recipientIdentifier: string
    body: string
    mediaUrl: string | null
    mediaType: string | null
    retryCount: number
  }>> {
    const now = new Date().toISOString()

    // Atomic CTE: SELECT with FOR UPDATE SKIP LOCKED (limited), then UPDATE only those rows
    const claimed = await this.db.execute<{
      id: string
      hub_id: string
      conversation_id: string
      recipient_identifier_ciphertext: string
      encrypted_body: string
      media_url: string | null
      media_type: string | null
      retry_count: number
    }>(sql`
      WITH batch AS (
        SELECT id
        FROM signal_message_queue
        WHERE status = 'pending'
          AND next_retry_at <= ${now}
        ORDER BY next_retry_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE signal_message_queue q
      SET status = 'processing', updated_at = ${now}
      FROM batch
      WHERE q.id = batch.id
      RETURNING q.id, q.hub_id, q.conversation_id, q.recipient_identifier_ciphertext,
                q.encrypted_body, q.media_url, q.media_type, q.retry_count
    `)

    return [...claimed].map(row => ({
      id: row.id,
      hubId: row.hub_id,
      conversationId: row.conversation_id,
      recipientIdentifier: decryptQueueValue(
        row.recipient_identifier_ciphertext,
        LABEL_CONTACT_ID,
        this.hmacSecret,
      ),
      body: decryptQueueValue(row.encrypted_body, LABEL_MESSAGE, this.hmacSecret),
      mediaUrl: row.media_url,
      mediaType: row.media_type,
      retryCount: row.retry_count,
    }))
  }

  /**
   * Mark a message as successfully sent.
   */
  async markSent(messageId: string, externalId?: string): Promise<void> {
    await this.db
      .update(signalMessageQueue)
      .set({
        status: 'sent',
        externalId: externalId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(signalMessageQueue.id, messageId))
  }

  /**
   * Mark a message as failed. If retries are exhausted, mark as dead-letter.
   */
  async markFailed(messageId: string, error: string, currentRetryCount: number): Promise<void> {
    const nextRetryCount = currentRetryCount + 1
    const isDead = nextRetryCount >= this.maxRetries

    if (isDead) {
      await this.db
        .update(signalMessageQueue)
        .set({
          status: 'dead',
          lastError: error,
          retryCount: nextRetryCount,
          updatedAt: new Date(),
        })
        .where(eq(signalMessageQueue.id, messageId))

      logger.warn('Message moved to dead-letter queue', { messageId, retries: nextRetryCount, error })
    } else {
      // Exponential backoff: 30s, 60s, 120s, 240s, 480s
      const delayMs = BACKOFF_BASE_MS * Math.pow(2, currentRetryCount)
      const jitter = Math.random() * delayMs * 0.2  // 20% jitter
      const nextRetryAt = new Date(Date.now() + delayMs + jitter)

      await this.db
        .update(signalMessageQueue)
        .set({
          status: 'pending',
          lastError: error,
          retryCount: nextRetryCount,
          nextRetryAt,
          updatedAt: new Date(),
        })
        .where(eq(signalMessageQueue.id, messageId))

      logger.info('Message scheduled for retry', { messageId, retry: nextRetryCount, nextRetryAt: nextRetryAt.toISOString() })
    }
  }

  /**
   * Check if sending to a recipient would exceed the rate limit.
   * Counts messages sent to this recipient in the last minute.
   */
  async isRateLimited(recipientIdentifier: string): Promise<boolean> {
    const oneMinuteAgo = new Date(Date.now() - 60_000)

    const result = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(signalMessageQueue)
      .where(
        and(
          eq(
            signalMessageQueue.recipientIdentifierHash,
            hashSignalQueueRecipientIdentifier(recipientIdentifier, this.hmacSecret),
          ),
          eq(signalMessageQueue.status, 'sent'),
          sql`${signalMessageQueue.updatedAt} > ${oneMinuteAgo}`,
        ),
      )

    const count = result[0]?.count ?? 0
    return count >= this.rateLimitPerMinute
  }

  /**
   * Get queue statistics for monitoring.
   */
  async getStats(hubId?: string): Promise<QueueStats> {
    const conditions = hubId ? [eq(signalMessageQueue.hubId, hubId)] : []

    const rows = await this.db
      .select({
        status: signalMessageQueue.status,
        count: sql<number>`count(*)::int`,
      })
      .from(signalMessageQueue)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(signalMessageQueue.status)

    const stats: QueueStats = { pending: 0, processing: 0, failed: 0, dead: 0, sent: 0 }
    for (const row of rows) {
      const status = row.status as keyof QueueStats
      if (status in stats) {
        stats[status] = row.count
      }
    }
    return stats
  }

  /**
   * Get dead-letter messages for admin review.
   */
  async getDeadLetters(hubId?: string, limit: number = 50): Promise<Array<{
    id: string
    conversationId: string
    recipientIdentifier: string
    body: string
    lastError: string | null
    retryCount: number
    createdAt: Date
  }>> {
    const conditions = [eq(signalMessageQueue.status, 'dead')]
    if (hubId) {
      conditions.push(eq(signalMessageQueue.hubId, hubId))
    }

    const rows = await this.db
      .select({
        id: signalMessageQueue.id,
        conversationId: signalMessageQueue.conversationId,
        recipientIdentifierCiphertext: signalMessageQueue.recipientIdentifierCiphertext,
        encryptedBody: signalMessageQueue.encryptedBody,
        lastError: signalMessageQueue.lastError,
        retryCount: signalMessageQueue.retryCount,
        createdAt: signalMessageQueue.createdAt,
      })
      .from(signalMessageQueue)
      .where(and(...conditions))
      .orderBy(desc(signalMessageQueue.createdAt))
      .limit(limit)

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      recipientIdentifier: decryptQueueValue(row.recipientIdentifierCiphertext, LABEL_CONTACT_ID, this.hmacSecret),
      body: decryptQueueValue(row.encryptedBody, LABEL_MESSAGE, this.hmacSecret),
      lastError: row.lastError,
      retryCount: row.retryCount,
      createdAt: row.createdAt,
    }))
  }

  /**
   * Retry a dead-letter message (reset it to pending).
   */
  async retryDeadLetter(messageId: string): Promise<boolean> {
    const result = await this.db
      .update(signalMessageQueue)
      .set({
        status: 'pending',
        retryCount: 0,
        nextRetryAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(signalMessageQueue.id, messageId),
          eq(signalMessageQueue.status, 'dead'),
        ),
      )
      .returning({ id: signalMessageQueue.id })

    return result.length > 0
  }

  /**
   * Clean up old sent/dead messages older than the specified age.
   */
  async cleanup(olderThanDays: number = DEFAULT_SIGNAL_QUEUE_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)

    const deleted = await this.db
      .delete(signalMessageQueue)
      .where(
        and(
          sql`${signalMessageQueue.status} IN ('sent', 'dead')`,
          lte(signalMessageQueue.createdAt, cutoff),
        ),
      )
      .returning({ id: signalMessageQueue.id })

    if (deleted.length > 0) {
      logger.info('Cleaned up old queue entries', { count: deleted.length })
    }

    return deleted.length
  }
}
