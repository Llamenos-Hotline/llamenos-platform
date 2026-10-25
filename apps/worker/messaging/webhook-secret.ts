import { createHash, timingSafeEqual } from 'node:crypto'
import type { MessagingConfig } from '@shared/types'

/**
 * An inbound messaging webhook is an unauthenticated public endpoint, so the
 * shared secret is the only thing separating a provider from anyone who can
 * reach the URL. RCS and Telegram used to accept a webhook when no secret was
 * configured (#2154); the secret is now required wherever a config is saved,
 * an adapter is built, and a request is validated.
 */

/** True when `secret` is a usable (non-blank) shared secret. */
export function hasWebhookSecret(secret: string | undefined | null): secret is string {
  return typeof secret === 'string' && secret.trim().length > 0
}

/** Operator-facing message for a channel saved or built without its secret. */
export function missingWebhookSecretMessage(channel: 'rcs' | 'telegram'): string {
  const label = channel === 'rcs' ? 'RCS' : 'Telegram'
  return `${label} webhook secret is required: without one, anyone who can reach the webhook URL could inject messages`
}

/**
 * The first config problem that would leave an RCS or Telegram webhook
 * unauthenticated, or null. Only a channel that is actually being enabled is
 * judged: RCS has no `enabled` flag, so its presence enables it.
 */
export function webhookSecretProblem(config: Pick<Partial<MessagingConfig>, 'rcs' | 'telegram'>): string | null {
  if (config.rcs && !hasWebhookSecret(config.rcs.webhookSecret)) {
    return missingWebhookSecretMessage('rcs')
  }
  if (config.telegram?.enabled && !hasWebhookSecret(config.telegram.webhookSecret)) {
    return missingWebhookSecretMessage('telegram')
  }
  return null
}

/**
 * Constant-time string comparison for webhook secrets. Both sides are hashed
 * first so the comparison runs over equal-length digests and the secret's
 * length is not observable through an early return.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest()
  const db = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(da, db)
}
