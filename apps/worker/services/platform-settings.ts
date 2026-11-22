import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings } from '../db/schema'
import { SINGLETON_ID, getSettings, isCrossHubSharingEnabled } from './system-settings-row'

/**
 * Platform-wide settings on the `system_settings` singleton: the platform settings document,
 * geocoding configuration and the cross-hub sharing switch.
 */
export class PlatformSettingsService {
  constructor(protected db: Database) {}

  async getCrossHubSharingEnabled(): Promise<{ enabled: boolean }> {
    return { enabled: await isCrossHubSharingEnabled(this.db) }
  }

  async setCrossHubSharingEnabled(data: {
    enabled: boolean
  }): Promise<{ enabled: boolean }> {
    const enabled = !!data.enabled
    await getSettings(this.db) // ensure singleton row exists before UPDATE
    await this.db
      .update(systemSettings)
      .set({ crossHubSharingEnabled: enabled })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { enabled }
  }

  async getGeocodingConfig(): Promise<import('@protocol/schemas/geocoding').GeocodingConfig> {
    const settings = await getSettings(this.db)
    const config = settings.geocodingConfig as Record<string, unknown> | null
    if (!config || typeof config !== 'object' || !('provider' in config)) {
      return { provider: null, countries: [], enabled: false }
    }
    const rawProvider = config.provider as string | null
    const validProviders = ['opencage', 'geoapify', 'llamenos-central'] as const
    const provider = validProviders.includes(rawProvider as typeof validProviders[number])
      ? rawProvider as typeof validProviders[number]
      : null
    return {
      provider,
      countries: Array.isArray(config.countries) ? config.countries as string[] : [],
      enabled: Boolean(config.enabled),
    }
  }

  async getGeocodingConfigAdmin(): Promise<import('@protocol/schemas/geocoding').GeocodingConfigAdmin> {
    const settings = await getSettings(this.db)
    const config = settings.geocodingConfig as Record<string, unknown> | null
    if (!config || typeof config !== 'object') {
      return { provider: null, apiKey: '', countries: [], enabled: false }
    }
    const rawProvider = config.provider as string | null
    const validProviders = ['opencage', 'geoapify', 'llamenos-central'] as const
    const provider = validProviders.includes(rawProvider as typeof validProviders[number])
      ? rawProvider as typeof validProviders[number]
      : null
    return {
      provider,
      apiKey: (config.apiKey as string) ?? '',
      countries: Array.isArray(config.countries) ? config.countries as string[] : [],
      enabled: Boolean(config.enabled),
    }
  }

  async updateGeocodingConfig(data: import('@protocol/schemas/geocoding').GeocodingConfigAdmin): Promise<void> {
    await this.db.update(systemSettings).set({ geocodingConfig: data }).where(eq(systemSettings.id, SINGLETON_ID))
  }

  async getPlatformSettings(): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .select({
        platformSettings: systemSettings.platformSettings,
        crossHubSharingEnabled: systemSettings.crossHubSharingEnabled,
      })
      .from(systemSettings)
      .where(eq(systemSettings.id, SINGLETON_ID))
      .limit(1)

    if (!row) {
      return {
        featureFlags: {
          mlsEnabled: false,
          transcriptionEnabled: true,
          caseManagementEnabled: false,
          crossHubSharingEnabled: false,
        },
        branding: {
          instanceName: 'Llamenos',
          supportEmail: '',
          privacyPolicyUrl: '',
        },
        sessionPolicy: {
          maxSessionDurationHours: 720,
          maxInactiveHours: 168,
        },
        erasurePlatformFloor: {
          minDelayHours: 24,
        },
        retentionPurge: {
          cronHourUtc: 3,
          enabled: true,
        },
      }
    }

    // `featureFlags.crossHubSharingEnabled` is a VIEW of the one stored switch
    // (`system_settings.cross_hub_sharing_enabled`, what `CasesService.list`
    // enforces), never a stored copy: a second copy is a toggle that reads
    // "off" while the behaviour it names stays on (#2605).
    const stored = (row.platformSettings ?? {}) as Record<string, unknown>
    return {
      ...stored,
      featureFlags: {
        ...((stored.featureFlags as Record<string, unknown> | undefined) ?? {}),
        crossHubSharingEnabled: row.crossHubSharingEnabled ?? false,
      },
    }
  }

  async updatePlatformSettings(
    updates: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const current = await this.getPlatformSettings()

    const merged: Record<string, unknown> = { ...current }
    for (const [section, value] of Object.entries(updates)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        current[section] &&
        typeof current[section] === 'object'
      ) {
        merged[section] = {
          ...(current[section] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        }
      } else if (value !== undefined) {
        merged[section] = value
      }
    }

    // The cross-hub flag is routed to its one stored home and never persisted
    // in the platform-settings document (see `getPlatformSettings`).
    const { crossHubSharingEnabled, ...storedFlags } = (merged.featureFlags ?? {}) as Record<string, unknown>
    const incomingFlags = updates.featureFlags as Record<string, unknown> | undefined
    // ONE statement writes the column and the document, so a failure cannot leave the
    // switch flipped while the rest of the update is lost (or the reverse).
    const crossHubUpdate = incomingFlags?.crossHubSharingEnabled !== undefined
      ? { crossHubSharingEnabled: incomingFlags.crossHubSharingEnabled === true }
      : {}
    if (crossHubUpdate.crossHubSharingEnabled !== undefined) {
      await getSettings(this.db) // ensure the singleton row exists before UPDATE
    }
    await this.db
      .update(systemSettings)
      .set({ platformSettings: { ...merged, featureFlags: storedFlags }, ...crossHubUpdate })
      .where(eq(systemSettings.id, SINGLETON_ID))

    return { ...merged, featureFlags: { ...storedFlags, crossHubSharingEnabled } }
  }
}
