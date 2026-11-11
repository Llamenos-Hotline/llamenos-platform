import type { SendMessageParams, SendResult, MessagingAdapter } from './adapter'
import type { MessagingChannelType } from '@shared/types'
import { getMessagingAdapterFromService } from '../lib/service-factories'
import type { SettingsService } from '../services/settings'
import { createLogger } from '../lib/logger'
import type { OutboundSuppression } from './suppression-guard'
import { safeFetch } from '../lib/safe-fetch'
import { devSurfacesEnabled, type DevSurfacesEnv } from '../lib/dev-surfaces'
import { SimulatedMessagingAdapter } from './simulated-adapter'
import { guardOutbound } from './suppression-guard'

const logger = createLogger('delivery-router')

const NOTIFICATION_ONLY_MESSAGE = 'You have a new secure message. Open Llamenos to view it.'

export interface DeliveryRouterDeps {
  settingsService: SettingsService
  /** The opt-out record every adapter checks before it sends. */
  suppression: OutboundSuppression
  notifierUrl?: string
  notifierApiKey?: string
  /**
   * Process environment, read by the simulated-provider fallback: when the
   * channel is not configured AND this host may serve the dev surface, the
   * send goes to a SimulatedMessagingAdapter that genuinely accepts and
   * records it. Absent (or refused by the gate), an unconfigured channel
   * throws and the caller stores the message as `failed` — `sent` means a
   * provider accepted it (#2551).
   */
  env?: DevSurfacesEnv
}

/**
 * The errors `createMessagingAdapter` throws when a channel has no working
 * configuration behind it — never a transient provider failure, which must
 * not fall back to the simulator.
 */
function isUnconfiguredChannelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('not configured') || msg.includes('not enabled')
}

async function resolveChannelAdapter(
  deps: DeliveryRouterDeps,
  channel: MessagingChannelType,
): Promise<MessagingAdapter> {
  try {
    return await getMessagingAdapterFromService(channel, deps.settingsService, deps.suppression)
  } catch (err) {
    if (deps.env && isUnconfiguredChannelError(err) && devSurfacesEnabled(deps.env)) {
      logger.warn(`${channel} not configured — simulated provider accepting the send (dev-surface host)`)
      return guardOutbound(new SimulatedMessagingAdapter(channel, deps.env), deps.suppression)
    }
    throw err
  }
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
          deps.suppression,
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

  const adapter = await resolveChannelAdapter(deps, params.channelType)

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
