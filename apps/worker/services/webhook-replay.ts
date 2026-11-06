import { createHash } from 'crypto'
import { webhookNonces } from '../db/schema/webhook-nonces'
import { eq, lt } from 'drizzle-orm'
import { createLogger } from '../lib/logger'
import { isDuplicateKeyError } from '../lib/db-errors'
import type { Database } from '../db'

const logger = createLogger('webhook-replay')

const DEFAULT_WINDOW_S = 300

/**
 * Check if a webhook has already been processed.
 * Returns true if this is the first delivery (proceed with processing).
 * Returns false if this is a replay (skip processing, return idempotent 200).
 */
export async function checkWebhookReplay(
  db: Database,
  provider: string,
  bodyText: string,
  windowSeconds: number = DEFAULT_WINDOW_S,
): Promise<boolean> {
  const hash = nonceHash(provider, bodyText)

  const expiresAt = new Date(Date.now() + windowSeconds * 1000)

  try {
    await db.insert(webhookNonces).values({
      nonceHash: hash,
      provider,
      expiresAt,
    })
    return true
  } catch (e: unknown) {
    if (isDuplicateKeyError(e)) {
      logger.info('Webhook replay detected', { provider })
      return false
    }
    throw e
  }
}

function nonceHash(provider: string, bodyText: string): string {
  return createHash('sha256').update(`${provider}:${bodyText}`).digest('hex')
}

/**
 * Give back the slot `checkWebhookReplay` claimed for this delivery, so the
 * provider's redelivery is processed instead of answered as a duplicate.
 *
 * For a delivery the server REFUSED after claiming it (an inbound message no
 * hub admin could read, #1034). Without this, the refusal's 503 prompts a retry
 * that the replay guard answers with an idempotent 200 — and the provider
 * stops retrying a message that was never stored.
 */
export async function releaseWebhookReplay(
  db: Database,
  provider: string,
  bodyText: string,
): Promise<void> {
  await db.delete(webhookNonces).where(eq(webhookNonces.nonceHash, nonceHash(provider, bodyText)))
}

/**
 * Cleanup expired nonce records. Call periodically.
 */
export async function cleanupExpiredNonces(db: Database): Promise<void> {
  await db.delete(webhookNonces).where(
    lt(webhookNonces.expiresAt, new Date())
  )
}
