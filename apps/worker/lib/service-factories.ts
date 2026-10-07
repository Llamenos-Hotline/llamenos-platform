import type { Env } from '../types'
import type { TelephonyAdapter } from '../telephony/adapter'
import type { MessagingAdapter } from '../messaging/adapter'
// NostrPublisher removed — replaced by ConnectionManager in ws-manager.ts
import type { TelephonyProviderConfig, MessagingChannelType, MessagingConfig } from '@shared/types'
import { TwilioAdapter } from '../telephony/twilio'
import { SignalWireAdapter } from '../telephony/signalwire'
import { VonageAdapter } from '../telephony/vonage'
import { PlivoAdapter } from '../telephony/plivo'
import { AsteriskAdapter } from '../telephony/asterisk'
import { TelnyxAdapter } from '../telephony/telnyx'
import { BandwidthAdapter } from '../telephony/bandwidth'
import { FreeSwitchAdapter } from '../telephony/freeswitch'
import { MockTelephonyAdapter, MockTelephonyRefusedError, isMockProviderConfig } from '../telephony/mock'
import { createSMSAdapter } from '../messaging/sms/factory'
import { createWhatsAppAdapter } from '../messaging/whatsapp/factory'
import { createSignalAdapter } from '../messaging/signal/factory'
import { createRCSAdapter } from '../messaging/rcs/factory'
import { createTelegramAdapter } from '../messaging/telegram/factory'
import { createLogger } from './logger'

const logger = createLogger('service-factories')

/**
 * Create a TelephonyAdapter from SettingsService (service-based version).
 * Reads config via direct service call; falls back to env vars for Twilio.
 */
export async function getTelephonyFromService(
  env: Env,
  settingsService: {
    getTelephonyProvider(hmacSecret?: string): Promise<TelephonyProviderConfig | null>
  },
): Promise<TelephonyAdapter | null> {
  const webhookBaseUrl = env.WEBHOOK_BASE_URL ?? ''
  try {
    // Without the secret the stored credentials are never decrypted, so the
    // adapter is built from ciphertext and every provider call fails. The
    // structural type used to omit this parameter entirely, which made the
    // omission unrepresentable at the call site rather than merely missed.
    const config = await settingsService.getTelephonyProvider(env.HMAC_SECRET)
    if (config) return createAdapterFromConfig(config, webhookBaseUrl, env)
  } catch (e) {
    if (e instanceof MockTelephonyRefusedError) {
      // A mock config in an environment that forbids it must never silently
      // degrade to a real provider — no adapter at all is the safe answer.
      logger.error('Mock telephony provider refused', { reason: e.reason })
      return null
    }
    logger.warn('getTelephonyProvider failed, falling back to env vars', { error: e })
  }

  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER) {
    return new TwilioAdapter(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_PHONE_NUMBER, webhookBaseUrl)
  }

  return null
}

/** The settings reads a hub's telephony configuration is resolved from. */
interface TelephonySettingsReader {
  getHubTelephonyProvider(hubId: string, hmacSecret?: string): Promise<TelephonyProviderConfig | null>
  getTelephonyProvider(hmacSecret?: string): Promise<TelephonyProviderConfig | null>
}

/**
 * The telephony provider configuration a call for this hub is served by: the
 * hub's own if it has one, else the instance-wide one.
 *
 * Exported for callers that need the configuration ITSELF rather than an
 * adapter built from it — `services/ringing.ts` asks it whether this hub's
 * calls go through the PBX we run, because only then does a volunteer have an
 * in-app endpoint to be sent an INVITE. Resolving that separately is how the
 * in-app path first failed: a hub with no per-hub row made the hub-scoped read
 * null, so it concluded "not our PBX" while `getHubTelephonyFromService` was
 * happily placing calls through the instance-wide Asterisk. The agreement is
 * pinned by a test (service-factories.test.ts).
 *
 * Returns null when nothing is configured or the configuration cannot be read.
 * A mock provider in an environment that forbids one is also null: never
 * degrade to a different provider than the one the call will use.
 */
export async function resolveHubTelephonyConfig(
  env: Env,
  settingsService: TelephonySettingsReader,
  hubId: string,
): Promise<TelephonyProviderConfig | null> {
  if (hubId !== '') {
    try {
      const config = await settingsService.getHubTelephonyProvider(hubId, env.HMAC_SECRET)
      if (config) return config
    } catch (e) {
      if (e instanceof MockTelephonyRefusedError) {
        logger.error('Mock telephony provider refused', { hubId, reason: e.reason })
        return null
      }
      logger.warn('getHubTelephonyProvider failed for hub, falling back to global', { error: e })
    }
  }
  try {
    return await settingsService.getTelephonyProvider(env.HMAC_SECRET)
  } catch (e) {
    if (e instanceof MockTelephonyRefusedError) {
      logger.error('Mock telephony provider refused', { reason: e.reason })
    } else {
      logger.warn('getTelephonyProvider failed', { error: e })
    }
    return null
  }
}

/**
 * Get TelephonyAdapter for a specific hub (service-based version).
 * Falls back to global telephony config, then env vars.
 */
export async function getHubTelephonyFromService(
  env: Env,
  settingsService: {
    getHubTelephonyProvider(hubId: string, hmacSecret?: string): Promise<TelephonyProviderConfig | null>
    getTelephonyProvider(hmacSecret?: string): Promise<TelephonyProviderConfig | null>
  },
  hubId: string,
): Promise<TelephonyAdapter | null> {
  const webhookBaseUrl = env.WEBHOOK_BASE_URL ?? ''
  try {
    // This is the path real call handling uses (services/ringing.ts:172),
    // so a per-hub provider that resolves but never decrypts is the same
    // silent fallback as not resolving at all.
    const config = await settingsService.getHubTelephonyProvider(hubId, env.HMAC_SECRET)
    if (config) return createAdapterFromConfig(config, webhookBaseUrl, env)
  } catch (e) {
    if (e instanceof MockTelephonyRefusedError) {
      logger.error('Mock telephony provider refused', { hubId, reason: e.reason })
      return null
    }
    logger.warn('getHubTelephonyProvider failed for hub, falling back to global', { error: e })
  }
  return getTelephonyFromService(env, settingsService)
}

/**
 * Get a MessagingAdapter for the specified channel (service-based version).
 * Uses SettingsService instead of DO stubs.
 */
export async function getMessagingAdapterFromService(
  channel: MessagingChannelType,
  settingsService: {
    getMessagingConfig(): Promise<MessagingConfig>
    getTelephonyProvider(): Promise<TelephonyProviderConfig | null>
  },
  hmacSecret: string,
  webhookBaseUrl = '',
): Promise<MessagingAdapter> {
  const config = await settingsService.getMessagingConfig()
  if (!config || !config.enabledChannels.includes(channel)) {
    throw new Error(`${channel} channel is not enabled`)
  }

  switch (channel) {
    case 'sms': {
      if (!config.sms?.enabled) throw new Error('SMS is not enabled')
      const telConfig = await settingsService.getTelephonyProvider()
      if (!telConfig) throw new Error('SMS requires a configured telephony provider')
      return createSMSAdapter(telConfig, config.sms, hmacSecret, webhookBaseUrl)
    }
    case 'whatsapp': {
      if (!config.whatsapp) throw new Error('WhatsApp is not configured')
      return createWhatsAppAdapter(config.whatsapp, hmacSecret, undefined, webhookBaseUrl)
    }
    case 'signal': {
      if (!config.signal) throw new Error('Signal is not configured')
      return createSignalAdapter(config.signal, hmacSecret)
    }
    case 'rcs': {
      if (!config.rcs) throw new Error('RCS is not configured')
      return createRCSAdapter(config.rcs, hmacSecret)
    }
    case 'telegram': {
      if (!config.telegram) throw new Error('Telegram is not configured')
      return createTelegramAdapter(config.telegram, hmacSecret)
    }
    default:
      throw new Error(`Unknown channel: ${channel}`)
  }
}

/**
 * Create adapter from saved config.
 * Supports Twilio, SignalWire, Vonage, Plivo, Asterisk, Telnyx, Bandwidth, and FreeSWITCH,
 * plus the test-only MockTelephonyAdapter (type `mock`, which throws
 * MockTelephonyRefusedError unless this host may serve the dev surface — see
 * lib/dev-surfaces.ts).
 */
function createAdapterFromConfig(config: TelephonyProviderConfig, webhookBaseUrl: string, env: Env): TelephonyAdapter {
  // `mock` is a worker-side test type, deliberately not part of the wire-level
  // TelephonyProviderType enum — compare on the raw string.
  if (isMockProviderConfig(config)) {
    return new MockTelephonyAdapter(env, config.phoneNumber)
  }
  switch (config.type) {
    case 'twilio':
      return new TwilioAdapter(config.accountSid!, config.authToken!, config.phoneNumber, webhookBaseUrl)
    case 'signalwire':
      return new SignalWireAdapter(config.accountSid!, config.authToken!, config.phoneNumber, config.signalwireSpace!, webhookBaseUrl)
    case 'vonage':
      return new VonageAdapter(config.apiKey!, config.apiSecret!, config.applicationId!, config.phoneNumber, config.privateKey)
    case 'plivo':
      return new PlivoAdapter(config.authId!, config.authToken!, config.phoneNumber, webhookBaseUrl)
    case 'asterisk':
      return new AsteriskAdapter(
        config.ariUrl!,
        config.ariUsername!,
        config.ariPassword!,
        config.phoneNumber,
        config.bridgeCallbackUrl!,
        config.bridgeSecret!,
      )
    case 'telnyx':
      return new TelnyxAdapter(config.apiKey!, config.connectionId!, config.phoneNumber)
    case 'bandwidth':
      return new BandwidthAdapter(
        config.authId!, // accountId
        config.authToken!, // apiToken
        config.authToken!, // apiSecret (reused)
        config.bandwidthAppId!,
        config.phoneNumber,
      )
    case 'freeswitch':
      return new FreeSwitchAdapter(
        config.phoneNumber,
        config.freeswitchBridgeUrl!,
        config.freeswitchBridgeSecret!,
        config.freeswitchBridgeUrl!.replace(/\/?$/, ''), // callback base URL without trailing slash
      )
    default:
      return new TwilioAdapter(config.accountSid!, config.authToken!, config.phoneNumber)
  }
}
