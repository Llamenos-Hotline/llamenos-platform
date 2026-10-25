import type { MessagingAdapter } from '../adapter'
import type { TelegramConfig } from '@shared/types'
import { hasWebhookSecret, missingWebhookSecretMessage } from '../webhook-secret'
import { TelegramAdapter } from './adapter'

/**
 * Create a validated TelegramAdapter instance from a TelegramConfig.
 * Throws if any required configuration fields are missing.
 */
export function createTelegramAdapter(
  config: TelegramConfig,
  hmacSecret: string,
): MessagingAdapter {
  if (!config.botToken) {
    throw new Error('Telegram bot token is required')
  }
  if (!hasWebhookSecret(config.webhookSecret)) {
    throw new Error(missingWebhookSecretMessage('telegram'))
  }
  if (!config.enabled) {
    throw new Error('Telegram channel is not enabled')
  }
  return new TelegramAdapter(config, hmacSecret)
}
