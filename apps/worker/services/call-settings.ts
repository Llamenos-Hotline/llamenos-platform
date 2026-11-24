import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings, hubSettings as hubSettingsTable } from '../db/schema'
import type { CallSettings } from '../types'
import {
  callHistoryAccessSettingsSchema,
  type CallHistoryAccessSettings,
  type CallHistoryAccessSettingsPatch,
} from '@protocol/schemas/calls'
import { SINGLETON_ID, getSettings } from './system-settings-row'
import type { HubSettingsService } from './hub-settings'

export const DEFAULT_CALL_SETTINGS: CallSettings = {
  queueTimeoutSeconds: 90,
  voicemailMaxSeconds: 120,
  // Provider-side call recording is OFF unless a hub deliberately turns it on
  // (#1505). Do not flip this: every answered call would be written to a third
  // party's disk, and the caller-facing recording notice is driven off it.
  recordCalls: false,
}

/**
 * A hub's stored access window, through the schema: an absent or out-of-range
 * value reads as the default rather than as a window nobody chose.
 */
function parseCallHistoryAccess(stored: unknown): CallHistoryAccessSettings {
  const parsed = callHistoryAccessSettingsSchema.safeParse(stored ?? {})
  return parsed.success ? parsed.data : callHistoryAccessSettingsSchema.parse({})
}

/**
 * Call handling settings: call settings, the volunteer call-history access window, transcription
 * settings and a hub's fallback ring group.
 */
export class CallSettingsService {
  constructor(
    protected db: Database,
    private readonly hubSettings: HubSettingsService,
  ) {}

  async getTranscriptionSettings(): Promise<{
    globalEnabled: boolean
    allowUserOptOut: boolean
  }> {
    const row = await getSettings(this.db)
    return {
      globalEnabled: row.transcriptionEnabled ?? true,
      allowUserOptOut: row.allowUserTranscriptionOptOut ?? false,
    }
  }

  async updateTranscriptionSettings(data: {
    globalEnabled?: boolean
    allowUserOptOut?: boolean
  }): Promise<{ globalEnabled: boolean; allowUserOptOut: boolean }> {
    const updates: Record<string, unknown> = {}
    if (data.globalEnabled !== undefined)
      updates.transcriptionEnabled = data.globalEnabled
    if (data.allowUserOptOut !== undefined)
      updates.allowUserTranscriptionOptOut = data.allowUserOptOut

    if (Object.keys(updates).length > 0) {
      await this.db
        .update(systemSettings)
        .set(updates)
        .where(eq(systemSettings.id, SINGLETON_ID))
    }
    return this.getTranscriptionSettings()
  }

  /**
   * Effective call settings. With a hubId: that hub's own overrides layered over
   * the platform values, layered over the defaults. Without: platform values only.
   */
  async getCallSettings(hubId?: string): Promise<CallSettings> {
    const row = await getSettings(this.db)
    const platform: CallSettings = {
      ...DEFAULT_CALL_SETTINGS,
      ...((row.callSettings as Partial<CallSettings> | null) ?? {}),
    }
    if (!hubId) return platform
    const hubOverrides = (await this.hubSettings.getHubSettings(hubId)).callSettings as
      | Partial<CallSettings>
      | undefined
    return { ...platform, ...(hubOverrides ?? {}) }
  }

  /**
   * Update call settings. With a hubId this writes ONLY that hub's overrides;
   * without one it writes the platform values.
   */
  async updateCallSettings(
    data: Partial<CallSettings>,
    hubId?: string,
  ): Promise<CallSettings> {
    const clamp = (v: number) => Math.max(30, Math.min(300, v))
    const clamped: Partial<CallSettings> = {}
    if (data.queueTimeoutSeconds !== undefined)
      clamped.queueTimeoutSeconds = clamp(data.queueTimeoutSeconds)
    if (data.voicemailMaxSeconds !== undefined)
      clamped.voicemailMaxSeconds = clamp(data.voicemailMaxSeconds)
    if (data.recordCalls !== undefined) clamped.recordCalls = data.recordCalls

    if (hubId) {
      const existing =
        ((await this.hubSettings.getHubSettings(hubId)).callSettings as Partial<CallSettings> | undefined) ?? {}
      await this.hubSettings.updateHubSettings(hubId, { callSettings: { ...existing, ...clamped } })
      return this.getCallSettings(hubId)
    }
    const updated: CallSettings = { ...(await this.getCallSettings()), ...clamped }
    await this.db
      .update(systemSettings)
      .set({ callSettings: updated })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return updated
  }

  /**
   * The hub's volunteer call-history access window: how many days back a member
   * holding only `calls:read-own-history` may read the calls they answered.
   * The default (7 days) when the hub never set one.
   *
   * Access control only. It deletes nothing and is unrelated to the retention
   * policy (`retention.ts`, services/erasure.ts): a record past a volunteer's
   * window stays the admin system of record.
   */
  async getCallHistoryAccess(hubId: string): Promise<CallHistoryAccessSettings> {
    return parseCallHistoryAccess((await this.hubSettings.getHubSettings(hubId)).callHistoryAccess)
  }

  /**
   * Apply a PATCH to the hub's access window and return the window before and
   * after, for the audit entry. A body that names nothing changes nothing.
   *
   * Read and write share one transaction under a per-hub advisory lock, so two
   * concurrent changes are serialised and each audit entry's `before` is the
   * value that change actually replaced.
   */
  async updateCallHistoryAccess(
    hubId: string,
    patch: CallHistoryAccessSettingsPatch,
  ): Promise<{ before: CallHistoryAccessSettings; after: CallHistoryAccessSettings }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`callHistoryAccess:${hubId}`}))`)
      const [row] = await tx
        .select({ settings: hubSettingsTable.settings })
        .from(hubSettingsTable)
        .where(eq(hubSettingsTable.hubId, hubId))
      const before = parseCallHistoryAccess((row?.settings as Record<string, unknown> | undefined)?.callHistoryAccess)
      const after: CallHistoryAccessSettings = {
        ...before,
        ...(patch.volunteerAccessDays !== undefined ? { volunteerAccessDays: patch.volunteerAccessDays } : {}),
      }
      const merge = { callHistoryAccess: after }
      await tx
        .insert(hubSettingsTable)
        .values({ hubId, settings: merge })
        .onConflictDoUpdate({
          target: hubSettingsTable.hubId,
          set: {
            settings: sql`COALESCE(${hubSettingsTable.settings}, '{}'::jsonb) || ${hubSettingsTable.settings.mapToDriverValue(merge)}::jsonb`,
          },
        })
      return { before, after }
    })
  }

  /**
   * A hub's fallback group: who rings when nobody is both scheduled and
   * clocked in. Per hub only — every call belongs to a hub (#2460), so there
   * is no instance-wide group for a call that belongs to none.
   */
  async getFallbackGroup(hubId: string): Promise<{
    userPubkeys: string[]
  }> {
    const settings = await this.hubSettings.getHubSettings(hubId)
    const group = settings.fallbackGroup
    return { userPubkeys: Array.isArray(group) ? (group as string[]) : [] }
  }

  async setFallbackGroup(data: {
    userPubkeys: string[]
  }, hubId: string): Promise<{ userPubkeys: string[] }> {
    await this.hubSettings.updateHubSettings(hubId, { fallbackGroup: data.userPubkeys })
    // The group as stored — what `PUT /shifts/fallback` declares it answers.
    return this.getFallbackGroup(hubId)
  }
}
