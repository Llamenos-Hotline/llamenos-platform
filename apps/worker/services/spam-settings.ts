import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings } from '../db/schema'
import type { SpamSettings } from '../types'
import { SINGLETON_ID, getSettings } from './system-settings-row'
import type { HubSettingsService } from './hub-settings'

/** Built-in defaults, used when neither the hub nor the platform has a value. */
export const DEFAULT_SPAM_SETTINGS: SpamSettings = {
  voiceCaptchaEnabled: false,
  rateLimitEnabled: true,
  maxCallsPerMinute: 3,
  blockDurationMinutes: 30,
  // Operator ruling Q4 (c): a short unrecorded message, then the call ends.
  overLimitAction: 'message',
}

/**
 * Spam-mitigation settings: the platform values and each hub's overrides layered over them.
 */
export class SpamSettingsService {
  constructor(
    protected db: Database,
    private readonly hubSettings: HubSettingsService,
  ) {}

  /**
   * Effective spam settings. With a hubId: hub_settings.spamSettings (that hub's
   * own overrides) layered over the platform values in system_settings, layered
   * over the built-in defaults. Without a hubId: the platform values only.
   */
  async getSpamSettings(hubId?: string): Promise<SpamSettings> {
    const row = await getSettings(this.db)
    const platform: SpamSettings = {
      ...DEFAULT_SPAM_SETTINGS,
      ...((row.spamSettings as Partial<SpamSettings> | null) ?? {}),
    }
    if (!hubId) return platform
    const hubOverrides = (await this.hubSettings.getHubSettings(hubId)).spamSettings as
      | Partial<SpamSettings>
      | undefined
    return { ...platform, ...(hubOverrides ?? {}) }
  }

  /**
   * Update spam settings. With a hubId this writes ONLY that hub's overrides in
   * hub_settings — it never touches the platform values other hubs inherit.
   * Without a hubId it writes the platform values (platform admins only; the
   * route enforces that by requiring the global permission).
   */
  async updateSpamSettings(
    data: Partial<SpamSettings>,
    hubId?: string,
  ): Promise<SpamSettings> {
    if (hubId) {
      const existing =
        ((await this.hubSettings.getHubSettings(hubId)).spamSettings as Partial<SpamSettings> | undefined) ?? {}
      await this.hubSettings.updateHubSettings(hubId, { spamSettings: { ...existing, ...data } })
      return this.getSpamSettings(hubId)
    }
    const current = await this.getSpamSettings()
    const updated = { ...current, ...data }
    await this.db
      .update(systemSettings)
      .set({ spamSettings: updated })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return updated
  }
}
