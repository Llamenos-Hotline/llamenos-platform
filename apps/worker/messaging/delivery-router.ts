import type { SendMessageParams, SendResult } from './adapter'
import type { MessagingChannelType } from '@shared/types'
import { getMessagingAdapterFromService } from '../lib/service-factories'
import type { SettingsService } from '../services/settings'
import { createLogger } from '../lib/logger'
import { safeFetch } from '../lib/safe-fetch'

const logger = createLogger('delivery-router')

const NOTIFICATION_ONLY_MESSAGE = 'You have a new secure message. Open Llamenos to view it.'

export interface DeliveryRouterDeps {
  settingsService: SettingsService
  notifierUrl?: string
  notifierApiKey?: string
}

async function checkSignalAvailability(
  notifierUrl: string,
  notifierApiKey: string,
  identifierHash: string
): Promise<boolean> {
  try {
    const res = await safeFetch(
      `${notifierUrl.replace(/\/+$/, '')}/api/check/${encodeURIComponent(identifierHash)}`,
      {
        headers: { authorization: `Bearer ${notifierApiKey}` },
        timeoutMs: 10_000,
        ssrfGuard: false,
      }
    )
    if (!res.ok) return false
    const data = (await res.json()) as { registered?: boolean }
    return data.registered === true
  } catch {
    return false
  }
}

function sanitizeSmsBody(body: string, mode: 'full' | 'notification-only'): string {
  if (mode === 'notification-only') {
    return NOTIFICATION_ONLY_MESSAGE
  }
  return body
}

export interface RoutedSendParams {
  channelType: MessagingChannelType
  recipientIdentifier: string
  identifierHash: string
  body: string
  conversationId: string
  mediaUrl?: string
  mediaType?: string
}

/**
 * Send an outbound message with Signal-first routing and SMS notification-only mode.
 *
 * 1. If preferSignalDelivery is enabled and the recipient's hash is registered
 *    with the signal-notifier sidecar, route via Signal regardless of the
 *    original channel.
 * 2. If sending via SMS and smsContentMode is 'notification-only', replace the
 *    body with a generic notification.
 * 3. Otherwise, send via the original channel adapter.
 */
export async function routeOutboundMessage(
  deps: DeliveryRouterDeps,
  params: RoutedSendParams
): Promise<{ result: SendResult; actualChannel: MessagingChannelType }> {
  const config = await deps.settingsService.getMessagingConfig()
  const preferSignal = config.preferSignalDelivery ?? true
  const smsMode = config.smsContentMode ?? 'notification-only'

  const signalEnabled = config.enabledChannels.includes('signal') && config.signal !== null

  if (
    preferSignal &&
    signalEnabled &&
    deps.notifierUrl &&
    deps.notifierApiKey
  ) {
    const hasSignal = await checkSignalAvailability(
      deps.notifierUrl,
      deps.notifierApiKey,
      params.identifierHash
    )
    if (hasSignal) {
      try {
        const signalAdapter = await getMessagingAdapterFromService(
          'signal',
          deps.settingsService,
        )
        const sendParams: SendMessageParams = {
          recipientIdentifier: params.recipientIdentifier,
          body: params.body,
          conversationId: params.conversationId,
        }
        const result = params.mediaUrl
          ? await signalAdapter.sendMediaMessage({ ...sendParams, mediaUrl: params.mediaUrl, mediaType: params.mediaType ?? 'image/jpeg' })
          : await signalAdapter.sendMessage(sendParams)
        return { result, actualChannel: 'signal' }
      } catch (err) {
        logger.warn('Signal-first routing failed, falling back', { error: err instanceof Error ? err.message : String(err), conversationId: params.conversationId })
      }
    }
  }

  const adapter = await getMessagingAdapterFromService(
    params.channelType,
    deps.settingsService,
  )

  let body = params.body
  if (params.channelType === 'sms') {
    body = sanitizeSmsBody(body, smsMode)
  }

  const sendParams: SendMessageParams = {
    recipientIdentifier: params.recipientIdentifier,
    body,
    conversationId: params.conversationId,
  }

  const result = params.mediaUrl
    ? await adapter.sendMediaMessage({ ...sendParams, mediaUrl: params.mediaUrl, mediaType: params.mediaType ?? 'image/jpeg' })
    : await adapter.sendMessage(sendParams)

  return { result, actualChannel: params.channelType }
}
