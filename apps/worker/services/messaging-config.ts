import { eq, isNull } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings, providerConfigs } from '../db/schema'
import type {
  MessagingConfig,
  MessagingChannelType,
  SetupState,
  EnabledChannels,
} from '@shared/types'
import { DEFAULT_MESSAGING_CONFIG } from '@shared/types'
import type { HubChannelType } from '@protocol/schemas/provider-setup'
import { webhookSecretProblem } from '../messaging/webhook-secret'
import { ServiceError } from './service-error'
import { SINGLETON_ID, getSettings } from './system-settings-row'
import type { HubSettingsService } from './hub-settings'
import {
  carryOverSecrets,
  hasPlaintextSecrets,
  openMessagingConfig,
  sealMessagingConfig,
} from './messaging-secrets'

/**
 * Messaging channel configuration and which channels are enabled.
 */
export class MessagingConfigService {
  constructor(
    protected db: Database,
    private readonly hubSettings: HubSettingsService,
    /** SERVER_KEK: seals the channel credentials at rest (#3031). */
    private readonly serverKek?: string,
  ) {}

  /**
   * The messaging config with its credentials in the clear, for the adapters
   * that send with them. Never return this from an API: go through
   * `redactMessagingConfig`.
   */
  async getMessagingConfig(): Promise<MessagingConfig> {
    const row = await getSettings(this.db)
    const stored = row.messagingConfig as Record<string, unknown> | null
    return stored && Object.keys(stored).length > 0
      ? (openMessagingConfig(stored, this.serverKek) as unknown as MessagingConfig)
      : DEFAULT_MESSAGING_CONFIG
  }

  /**
   * Seal any credential still stored in the clear. Run at boot: a row written
   * before #3031 holds them as plain jsonb, and a SQL migration cannot seal
   * them because the key lives in the application's environment. Idempotent;
   * returns whether a row was rewritten.
   */
  async sealStoredSecrets(): Promise<boolean> {
    const row = await getSettings(this.db)
    const stored = row.messagingConfig as Record<string, unknown> | null
    if (!stored || !hasPlaintextSecrets(stored)) return false
    const sealed = sealMessagingConfig(openMessagingConfig(stored, this.serverKek), this.serverKek)
    await this.db
      .update(systemSettings)
      .set({ messagingConfig: sealed })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return true
  }

  async updateMessagingConfig(
    data: Partial<MessagingConfig>,
  ): Promise<MessagingConfig> {
    // Judge only what this request writes: a stored config that predates the
    // requirement must not block an unrelated edit, and it stays fail-closed
    // anyway (its adapter refuses to build and its webhook is rejected).
    const current = await this.getMessagingConfig()
    // A client that read the redacted config never held the secrets, so a
    // channel it sends back keeps the stored ones it leaves out.
    const incoming = carryOverSecrets(data, current)

    const secretProblem = webhookSecretProblem(incoming)
    if (secretProblem) throw new ServiceError(400, secretProblem)

    const updated = { ...current, ...incoming }

    // Derive enabledChannels from individual channel configs unless caller set it explicitly
    if (!('enabledChannels' in data)) {
      const derived: MessagingChannelType[] = []
      if (updated.sms?.enabled) derived.push('sms')
      if (updated.whatsapp) derived.push('whatsapp')
      if (updated.signal) derived.push('signal')
      if (updated.rcs) derived.push('rcs')
      if (updated.telegram?.enabled) derived.push('telegram')
      updated.enabledChannels = derived
    }

    if (updated.inactivityTimeout < 5 || updated.inactivityTimeout > 1440) {
      throw new ServiceError(
        400,
        'Inactivity timeout must be between 5 and 1440 minutes',
      )
    }
    if (
      updated.maxConcurrentPerUser < 1 ||
      updated.maxConcurrentPerUser > 20
    ) {
      throw new ServiceError(
        400,
        'Max concurrent must be between 1 and 20',
      )
    }

    await this.db
      .update(systemSettings)
      .set({ messagingConfig: sealMessagingConfig(updated, this.serverKek) })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return updated
  }

  /**
   * Has this hub switched `channel` on? The switches are `hub_settings.channels`
   * (written by `PUT /hubs/:hubId/onboard/channels`).
   *
   * A hub that has never recorded any — one not set up through hub onboarding —
   * has no per-hub restriction, so the deployment-wide answer stands and this
   * is true. Once recorded the object is the whole truth for the hub: a channel
   * it does not name is off, exactly as `enableChannel` seeds every channel false.
   */
  async isHubChannelEnabled(hubId: string, channel: HubChannelType): Promise<boolean> {
    const { channels } = await this.hubSettings.getHubSettings(hubId)
    if (!channels || typeof channels !== 'object' || Object.keys(channels).length === 0) return true
    return (channels as Partial<Record<HubChannelType, boolean>>)[channel] === true
  }

  async getEnabledChannels(env: {
    TWILIO_ACCOUNT_SID?: string
    TWILIO_AUTH_TOKEN?: string
    TWILIO_PHONE_NUMBER?: string
  }): Promise<EnabledChannels> {
    const row = await getSettings(this.db)
    const [providerConfig] = await this.db
      .select()
      .from(providerConfigs)
      .where(isNull(providerConfigs.hubId))
      .limit(1)
    // These two columns hold partially-written JSON. `getSettings()` upserts the
    // singleton row with `setup_state = '{}'`, so on every fresh install
    // `row.setupState` is present but empty — casting it `as SetupState | null`
    // claimed `selectedChannels` was always an array, and `setupState?.…` guarded
    // only the null case. `{}` therefore threw a TypeError, `GET /api/config`
    // caught it and reported every channel disabled, and the desktop — which
    // gates its whole Conversations page on those flags — showed "No messaging
    // channels enabled" on a deployment that had channels configured.
    // `Partial<>` is what the data actually is, and makes the guards mandatory.
    const messagingConfig = row.messagingConfig as Partial<MessagingConfig> | null
    const setupState = row.setupState as Partial<SetupState> | null

    const voiceEnabled =
      !!providerConfig ||
      !!(
        env.TWILIO_ACCOUNT_SID &&
        env.TWILIO_AUTH_TOKEN &&
        env.TWILIO_PHONE_NUMBER
      )

    return {
      voice: voiceEnabled,
      sms: messagingConfig?.enabledChannels?.includes('sms') ?? false,
      whatsapp: messagingConfig?.enabledChannels?.includes('whatsapp') ?? false,
      signal: messagingConfig?.enabledChannels?.includes('signal') ?? false,
      rcs: messagingConfig?.enabledChannels?.includes('rcs') ?? false,
      telegram: messagingConfig?.enabledChannels?.includes('telegram') ?? false,
      reports: setupState?.selectedChannels?.includes('reports') ?? false,
    }
  }
}
