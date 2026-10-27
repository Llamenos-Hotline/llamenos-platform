import type { MessagingAdapter } from '../adapter'
import type { SignalConfig } from '@shared/types'
import { SignalAdapter } from './adapter'

/**
 * Create a validated SignalAdapter instance from a SignalConfig.
 * Throws if any required configuration fields are missing.
 */
export function createSignalAdapter(config: SignalConfig): MessagingAdapter {
  if (!config.bridgeUrl || !config.bridgeApiKey || !config.webhookSecret || !config.registeredNumber) {
    throw new Error('Signal bridge configuration is incomplete')
  }
  return new SignalAdapter(config)
}
