/**
 * SettingsService — replaces SettingsDO.
 *
 * Manages system configuration, hubs, roles, entity type definitions,
 * IVR audio, rate limits, captchas, and case number sequences.
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, sql, lt, inArray, or, isNull, desc } from 'drizzle-orm'
import type { Database } from '../db'
import {
  systemSettings,
  hubs as hubsTable,
  hubSettings as hubSettingsTable,
  hubKeys,
  hubStorageSettings,
  hubStorageCredentials,
  roles as rolesTable,
  platformRoleEnvelopes,
  customFieldDefinitions,
  entityTypeDefinitions,
  relationshipTypeDefinitions,
  reportTypeDefinitions,
  ivrAudio,
  rateLimits,
  apiRateLimits,
  captchas,
  caseNumberSequences,
  // Hub deletion — all tables with hub-scoped data
  notes,
  noteReplies,
  bans,
  contactMetadata,
  auditLog,
  shifts,
  activeCalls,
  callRecords,
  conversations,
  contacts,
  contactRelationships,
  affinityGroups,
  groupMembers,
  blasts,
  subscribers,
  blastSettings,
  caseRecords,
  caseContacts,
  caseEvents,
  caseInteractions,
  evidence,
  custodyEntries,
  reportEvents,
  reportCases,
  events as hubCaseEvents,
  providerConfigs,
  users,
} from '../db/schema'
import type { SpamSettings, CallSettings } from '../types'
import type {
  CustomFieldDefinition,
  TelephonyProviderConfig,
  MessagingConfig,
  MessagingChannelType,
  SetupState,
  EnabledChannels,
  Hub,
  ReportType,
} from '@shared/types'
import {
  MAX_CUSTOM_FIELDS,
  MAX_SELECT_OPTIONS,
  MAX_FIELD_NAME_LENGTH,
  MAX_FIELD_LABEL_LENGTH,
  MAX_OPTION_LENGTH,
  FIELD_NAME_REGEX,
  PROVIDER_REQUIRED_FIELDS,
  DEFAULT_MESSAGING_CONFIG,
  DEFAULT_SETUP_STATE,
  MAX_REPORT_TYPES,
  MAX_REPORT_TYPE_NAME_LENGTH,
  MAX_REPORT_TYPE_DESCRIPTION_LENGTH,
  DEFAULT_REPORT_TYPES,
  MAX_ENTITY_TYPES,
  MAX_RELATIONSHIP_TYPES,
} from '@shared/types'
import type {
  EntityTypeDefinition,
  EntityFieldDefinition,
  RelationshipTypeDefinition,
} from '@protocol/schemas/entity-schema'
import type {
  ReportTypeDefinition,
  ReportFieldDefinition,
} from '@protocol/schemas/report-types'
import { IVR_LANGUAGES, LANGUAGE_CODES } from '@shared/languages'
import type { IvrVoiceCatalog } from '../telephony/ivr-menu'
import { getIvrVoiceCatalogForProvider } from '../telephony/ivr-voice-catalogs'
import { speechLanguageFor } from './ivr-speech/voices'
import { MOCK_PROVIDER_TYPE } from '../telephony/mock'
import type { Role } from '@shared/permissions'
import { DEFAULT_ROLES } from '@shared/permissions'
import {
  validateTTLOverrides,
  type TTLOverrides,
  type CleanupMetrics,
  emptyCleanupMetrics,
  resolveTTL,
} from '../lib/ttl'
import { createLogger } from '../lib/logger'
import { withRetry, isRetryableDbError } from '../lib/retry'
import { getCircuitBreaker } from '../lib/circuit-breaker'

const log = createLogger('services.settings')

// ---------------------------------------------------------------------------
// Result types — services return typed data, not Response objects
// ---------------------------------------------------------------------------

/** Thrown by service methods for known error conditions */
/**
 * Outcome of resolving the IVR voice catalog for a hub. Three distinct states:
 * nothing configured yet (no constraint can be applied), a catalog resolved
 * (constraint applies), or a provider configured whose catalog we do not hold
 * (speakability unknown — must be refused, never silently permitted).
 */
type IvrCatalogResolution =
  | { state: 'unconfigured' }
  | { state: 'resolved'; catalog: IvrVoiceCatalog<unknown> }
  | { state: 'unsupported'; providerType: string }

export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SINGLETON_ID = 1

/** Built-in defaults, used when neither the hub nor the platform has a value. */
const DEFAULT_SPAM_SETTINGS: SpamSettings = {
  voiceCaptchaEnabled: false,
  rateLimitEnabled: true,
  maxCallsPerMinute: 3,
  blockDurationMinutes: 30,
}

const DEFAULT_CALL_SETTINGS: CallSettings = {
  queueTimeoutSeconds: 90,
  voicemailMaxSeconds: 120,
}

/**
 * On a self-hosted PBX every prompt nobody uploaded is generated speech
 * (IvrSpeechService), so a language with no offline voice is not just absent
 * from the menu: its callers are spoken to in another language. Say which, and
 * how to fix it, where the operator hits the limit.
 */
function generatedSpeechGap(provider: string, unspeakable: string[]): string {
  if (provider !== 'asterisk' && provider !== 'freeswitch') return ''
  const heard = unspeakable.map((code) => `${code} → ${speechLanguageFor(code)}`).join(', ')
  return `. No offline voice exists for them: callers in these languages hear prompts in another language (${heard}) unless you upload recordings in their language.`
}

const VALID_PROMPT_TYPES = [
  'greeting',
  'pleaseHold',
  'waitMessage',
  'rateLimited',
  'captchaPrompt',
] as const

const MAX_AUDIO_SIZE = 1_048_576 // 1 MB

const ALLOWED_HUB_SETTINGS = new Set([
  'hubName',
  'timezone',
  'language',
  'welcomeMessage',
  'emergencyMessage',
  'maxConcurrentCalls',

  'callSettings',
  'spamSettings',
  'transcriptionEnabled',
  'autoAssignment',
  'fallbackGroup',
  'caseManagementEnabled',
  'providerSetupComplete',
  'channels',
  'quotas',
  'usage',
  'subAccountEnabled',
  'subAccountConfigId',
  'heartbeatTimeout',
  'ivrLanguages',
])

const VALID_PROVIDER_TYPES = [
  'twilio',
  'signalwire',
  'vonage',
  'plivo',
  'asterisk',
  'telnyx',
  'bandwidth',
  'freeswitch',
] as const

const CAPTCHA_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ---------------------------------------------------------------------------
// Helper to get or upsert the system_settings singleton row
// ---------------------------------------------------------------------------

async function getSettings(db: Database) {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, SINGLETON_ID))
  if (rows.length > 0) return rows[0]

  // Upsert the singleton
  const [row] = await db
    .insert(systemSettings)
    .values({ id: SINGLETON_ID })
    .onConflictDoNothing()
    .returning()
  // If onConflictDoNothing didn't insert (race), re-read
  if (!row) {
    const [existing] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.id, SINGLETON_ID))
    return existing
  }
  return row
}

// ---------------------------------------------------------------------------
// Module-level TTL cache for roles (30s TTL — roles change rarely, auth runs every request)
// ---------------------------------------------------------------------------

let _rolesCache: { roles: Role[]; expiresAt: number } | null = null
const ROLES_CACHE_TTL_MS = 30_000

export function invalidateRolesCache(): void {
  _rolesCache = null
}

// ---------------------------------------------------------------------------
// SettingsService
// ---------------------------------------------------------------------------

/**
 * What an `ensureInit` call seeds: the defaults every deployment needs, plus —
 * in demo or development mode — a completed setup state and enabled messaging.
 */
type InitMode = 'default' | 'development' | 'demo'

export class SettingsService {
  /**
   * Modes already initialised by this process (cleared by `reset`). Tracked per
   * mode, not as one flag: the server initialises defaults at boot, and a later
   * demo/development call must still apply its mode-specific seeding rather than
   * being swallowed as a repeat.
   */
  private initializedModes = new Set<InitMode>()

  constructor(protected db: Database) {}

  // =========================================================================
  // Initialization — seeds defaults for empty tables
  // =========================================================================

  /**
   * Seed defaults into empty settings fields and an empty roles table. Only
   * ever fills what is empty, so it is safe on every server boot: values an
   * operator has set, and roles that exist, are never overwritten.
   */
  async ensureInit(env?: {
    DEMO_MODE?: string
    ENVIRONMENT?: string
  }): Promise<void> {
    const mode: InitMode =
      env?.DEMO_MODE === 'true' ? 'demo' : env?.ENVIRONMENT === 'development' ? 'development' : 'default'
    if (this.initializedModes.has(mode)) return
    this.initializedModes.add(mode)

    const row = await getSettings(this.db)
    const spamSettings = row.spamSettings as SpamSettings | null

    // Seed spam settings if empty
    if (!spamSettings || Object.keys(spamSettings).length === 0) {
      await this.db
        .update(systemSettings)
        .set({
          spamSettings: { ...DEFAULT_SPAM_SETTINGS },
        })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }

    // Seed call settings
    const callSettings = row.callSettings as CallSettings | null
    if (!callSettings || Object.keys(callSettings).length === 0) {
      await this.db
        .update(systemSettings)
        .set({
          callSettings: { ...DEFAULT_CALL_SETTINGS },
        })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }

    // Seed IVR languages
    if (!row.ivrLanguages || row.ivrLanguages.length === 0) {
      await this.db
        .update(systemSettings)
        .set({ ivrLanguages: [...IVR_LANGUAGES] })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }

    // Seed default roles if none exist. ON CONFLICT DO NOTHING: replicas booting
    // together against a fresh database can both see an empty table.
    const existingRoles = await this.db.select().from(rolesTable)
    if (existingRoles.length === 0) {
      const now = new Date()
      for (const r of DEFAULT_ROLES) {
        await this.db.insert(rolesTable).values({
          id: r.id,
          name: r.name,
          slug: r.slug,
          permissions: r.permissions,
          isDefault: r.isDefault,
          isSystem: r.isSystem,
          description: r.description,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoNothing()
      }
    }

    // Demo/development mode: mark setup complete, enable messaging
    if (mode !== 'default') {
      const isDemoMode = mode === 'demo'
      const setupState = row.setupState as SetupState | null
      if (!setupState || !setupState.setupCompleted) {
        await this.db
          .update(systemSettings)
          .set({
            setupState: {
              setupCompleted: true,
              completedSteps: ['welcome', 'telephony', 'channels'],
              pendingChannels: [],
              selectedChannels: ['voice', 'sms', 'signal', 'reports'],
              demoMode: isDemoMode,
            },
          })
          .where(eq(systemSettings.id, SINGLETON_ID))
      }
      const msgConfig = row.messagingConfig as MessagingConfig | null
      if (!msgConfig || Object.keys(msgConfig).length === 0) {
        await this.db
          .update(systemSettings)
          .set({
            messagingConfig: {
              ...DEFAULT_MESSAGING_CONFIG,
              enabledChannels: ['sms', 'signal'],
            },
          })
          .where(eq(systemSettings.id, SINGLETON_ID))
      }
    }
  }

  // =========================================================================
  // Spam Settings
  // =========================================================================

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
    const hubOverrides = (await this.getHubSettings(hubId)).spamSettings as
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
        ((await this.getHubSettings(hubId)).spamSettings as Partial<SpamSettings> | undefined) ?? {}
      await this.updateHubSettings(hubId, { spamSettings: { ...existing, ...data } })
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

  // =========================================================================
  // Transcription Settings
  // =========================================================================

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

  // =========================================================================
  // Call Settings
  // =========================================================================

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
    const hubOverrides = (await this.getHubSettings(hubId)).callSettings as
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

    if (hubId) {
      const existing =
        ((await this.getHubSettings(hubId)).callSettings as Partial<CallSettings> | undefined) ?? {}
      await this.updateHubSettings(hubId, { callSettings: { ...existing, ...clamped } })
      return this.getCallSettings(hubId)
    }
    const updated: CallSettings = { ...(await this.getCallSettings()), ...clamped }
    await this.db
      .update(systemSettings)
      .set({ callSettings: updated })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return updated
  }

  // =========================================================================
  // IVR Languages
  // =========================================================================

  async getIvrLanguages(hubId?: string): Promise<{ enabledLanguages: string[] }> {
    if (hubId) {
      const languages = await this.getHubIvrLanguages(hubId)
      return { enabledLanguages: languages }
    }
    const row = await getSettings(this.db)
    return {
      enabledLanguages: row.ivrLanguages ?? [...IVR_LANGUAGES],
    }
  }

  /**
   * Get the ordered IVR language list for a hub, with cascade fallback:
   * hub_settings.ivrLanguages → system_settings.ivr_languages → IVR_LANGUAGES constant
   */
  async getHubIvrLanguages(hubId: string): Promise<string[]> {
    const hubSettings = await this.getHubSettings(hubId)
    const hubLangs = hubSettings.ivrLanguages
    if (Array.isArray(hubLangs) && hubLangs.length > 0) {
      return hubLangs as string[]
    }
    const row = await getSettings(this.db)
    return row.ivrLanguages ?? [...IVR_LANGUAGES]
  }

  /**
   * Resolve the IVR voice catalog for whichever provider will actually answer
   * this hub's calls — hub-specific config first, then the global fallback
   * (mirrors `getHubTelephonyFromService`'s resolution order in
   * lib/service-factories.ts).
   *
   * The three outcomes are kept distinct on purpose. The previous version
   * returned a bare `IvrVoiceCatalog | undefined` behind a blanket
   * `catch { return undefined }`, which collapsed "no provider configured yet"
   * (legitimately permissive) together with "a provider IS configured but we
   * could not read it" and "the lookup threw" (both of which must never be
   * permissive). That conflation is what silently disabled a security-relevant
   * constraint. There is deliberately no try/catch here: a failed read is a
   * real failure and must surface, not be downgraded into "unconstrained".
   */
  private async resolveIvrVoiceCatalog(hubId?: string): Promise<IvrCatalogResolution> {
    const hubConfig = hubId ? await this.getHubTelephonyProvider(hubId) : null
    const config = hubConfig ?? (await this.getTelephonyProvider())
    const providerType = config?.type
    if (!providerType) return { state: 'unconfigured' }
    const catalog = getIvrVoiceCatalogForProvider(providerType)
    if (!catalog) return { state: 'unsupported', providerType }
    return { state: 'resolved', catalog }
  }

  async updateIvrLanguages(data: {
    enabledLanguages: string[]
  }, hubId?: string): Promise<{ enabledLanguages: string[] }> {
    if (
      !Array.isArray(data.enabledLanguages) ||
      data.enabledLanguages.length === 0
    ) {
      throw new ServiceError(
        400,
        'At least one language must be enabled',
      )
    }
    const valid = data.enabledLanguages.filter((code) =>
      LANGUAGE_CODES.includes(code),
    )
    if (valid.length === 0) {
      throw new ServiceError(400, 'No valid IVR language codes provided')
    }
    // Constrain to what the active provider can actually speak (#732) —
    // reuses the catalog resolution built for #679 / PR #673 rather than
    // duplicating "which locales does this provider have a voice for".
    const resolution = await this.resolveIvrVoiceCatalog(hubId)
    if (resolution.state === 'unsupported') {
      // A provider is configured but we hold no voice catalog for it, so
      // speakability is unknown. Refuse rather than fall through to the
      // permissive branch reserved for "nothing configured yet".
      throw new ServiceError(
        400,
        `No IVR voice catalog for the configured telephony provider (${resolution.providerType}) — cannot verify that it can speak the requested languages`,
      )
    }
    if (resolution.state === 'resolved') {
      const unspeakable = valid.filter((code) => !resolution.catalog.speaks(code))
      if (unspeakable.length > 0) {
        throw new ServiceError(
          400,
          `The active telephony provider (${resolution.catalog.provider}) cannot speak: ${unspeakable.join(', ')}` +
            generatedSpeechGap(resolution.catalog.provider, unspeakable),
        )
      }
    }
    if (hubId) {
      await this.updateHubSettings(hubId, { ivrLanguages: valid })
      return { enabledLanguages: valid }
    }
    await this.db
      .update(systemSettings)
      .set({ ivrLanguages: valid })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { enabledLanguages: valid }
  }

  // =========================================================================
  // Fallback Group
  // =========================================================================

  async getFallbackGroup(hubId?: string): Promise<{
    userPubkeys: string[]
  }> {
    if (hubId) {
      const settings = await this.getHubSettings(hubId)
      const group = settings.fallbackGroup
      return { userPubkeys: Array.isArray(group) ? (group as string[]) : [] }
    }
    const row = await getSettings(this.db)
    const group = row.fallbackGroup ?? []
    return { userPubkeys: group }
  }

  async setFallbackGroup(data: {
    userPubkeys: string[]
  }, hubId?: string): Promise<{ ok: true }> {
    if (hubId) {
      await this.updateHubSettings(hubId, { fallbackGroup: data.userPubkeys })
      return { ok: true }
    }
    await this.db
      .update(systemSettings)
      .set({ fallbackGroup: data.userPubkeys })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { ok: true }
  }

  // =========================================================================
  // Rate Limiting
  // =========================================================================

  async checkRateLimit(data: {
    key: string
    maxPerMinute: number
  }): Promise<{ limited: boolean }> {
    if (!data.key || !/^[a-zA-Z0-9:_-]{1,256}$/.test(data.key)) {
      throw new ServiceError(400, 'Invalid rate limit key')
    }
    if (
      !Number.isInteger(data.maxPerMinute) ||
      data.maxPerMinute < 1 ||
      data.maxPerMinute > 1000
    ) {
      throw new ServiceError(
        400,
        'maxPerMinute must be an integer between 1 and 1000',
      )
    }

    const windowMs = 60_000

    // Single atomic statement (#1492). The previous implementation was a
    // read-modify-write: SELECT the array, filter and append in JS, then upsert
    // the whole array back. Concurrent requests on the same key all read the
    // same array and the last write won, so N simultaneous requests were
    // recorded as one — the limiter undercounted precisely under the parallel
    // traffic it exists to stop (invite enumeration, credential grinding).
    //
    // INSERT ... ON CONFLICT DO UPDATE takes a row lock and re-evaluates the
    // SET expression against the *committed* row, so concurrent callers are
    // serialised by PostgreSQL and each one observes every predecessor.
    //
    // The window is evaluated from the database's own clock (`now()`, the
    // transaction timestamp — stable for the whole statement) rather than from
    // Date.now(), so the stored timestamps and the expiry cutoff share one
    // clock and a skewed application server cannot widen or narrow the window.
    //
    // Retention is capped at maxPerMinute in-window entries before appending,
    // which bounds the row under a flood without changing any verdict: entries
    // dropped by the cap are strictly older than the ones kept, so whenever a
    // dropped entry would still be in-window the retained set already holds
    // maxPerMinute entries and the request is limited either way.
    const nowMs = sql`(EXTRACT(EPOCH FROM now()) * 1000)::bigint`
    const result = await this.db.execute<{ count: number }>(sql`
      INSERT INTO rate_limits (key, timestamps)
      VALUES (${data.key}, jsonb_build_array(${nowMs}))
      ON CONFLICT (key) DO UPDATE SET timestamps =
        COALESCE((
          SELECT jsonb_agg(recent.t)
          FROM (
            SELECT a.t
            FROM jsonb_array_elements(rate_limits.timestamps) AS a(t)
            WHERE (a.t)::numeric > ${nowMs} - ${windowMs}
            ORDER BY (a.t)::numeric DESC
            LIMIT ${data.maxPerMinute}
          ) AS recent
        ), '[]'::jsonb) || jsonb_build_array(${nowMs})
      RETURNING jsonb_array_length(timestamps) AS count
    `)

    const count = Number(result[0]?.count ?? 0)
    return { limited: count > data.maxPerMinute }
  }

  // =========================================================================
  // API Rate Limiting — fixed-window counters (Epic A / C03)
  // =========================================================================

  /**
   * Atomic fixed-window rate limit check. Returns whether the request is limited
   * and the Retry-After value in seconds.
   */
  async checkApiRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
  ): Promise<{ limited: boolean; retryAfterSeconds: number }> {
    const windowInterval = `${windowMs / 1000} seconds`

    const result = await this.db.execute<{ count: number; window_start: Date }>(sql`
      INSERT INTO api_rate_limits (key, count, window_start)
      VALUES (${key}, 1, NOW())
      ON CONFLICT (key) DO UPDATE
      SET count = CASE
        WHEN api_rate_limits.window_start < NOW() - ${windowInterval}::interval
        THEN 1
        ELSE api_rate_limits.count + 1
      END,
      window_start = CASE
        WHEN api_rate_limits.window_start < NOW() - ${windowInterval}::interval
        THEN NOW()
        ELSE api_rate_limits.window_start
      END
      RETURNING count, window_start
    `)

    const row = result[0]
    const count = Number(row?.count ?? 0)
    const windowStart = row?.window_start

    if (count > maxRequests) {
      const windowStartMs = windowStart instanceof Date
        ? windowStart.getTime()
        : new Date(String(windowStart)).getTime()
      const windowEndMs = windowStartMs + windowMs
      const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - Date.now()) / 1000))
      return { limited: true, retryAfterSeconds }
    }

    return { limited: false, retryAfterSeconds: 0 }
  }

  /** Clear API rate limit counters (new fixed-window table). */
  async clearApiRateLimits(prefix?: string): Promise<void> {
    if (prefix) {
      await this.db.delete(apiRateLimits).where(sql`${apiRateLimits.key} LIKE ${prefix + '%'}`)
    } else {
      await this.db.delete(apiRateLimits)
    }
  }

  /** Clear expired API rate limit windows (older than 10 minutes). */
  async clearExpiredApiRateLimits(): Promise<void> {
    await this.db.delete(apiRateLimits)
      .where(sql`${apiRateLimits.windowStart} < NOW() - INTERVAL '10 minutes'`)
  }

  // =========================================================================
  // Custom Fields
  // =========================================================================

  async getCustomFields(
    role: string = 'admin',
  ): Promise<{ fields: CustomFieldDefinition[] }> {
    let rows = await this.db
      .select()
      .from(customFieldDefinitions)
      .orderBy(customFieldDefinitions.sortOrder)

    if (role !== 'admin') {
      rows = rows.filter((r) => r.visibleToUsers)
    }

    // Map DB rows to CustomFieldDefinition shape
    const fields: CustomFieldDefinition[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      type: r.fieldType as CustomFieldDefinition['type'],
      required: r.required ?? false,
      options: r.options ?? undefined,
      validation: r.validation as CustomFieldDefinition['validation'],
      visibleToUsers: r.visibleToUsers ?? true,
      editableByUsers: r.editableByUsers ?? true,
      context: r.context as CustomFieldDefinition['context'],
      maxFileSize: r.maxFileSize ?? undefined,
      allowedMimeTypes: r.allowedMimeTypes ?? undefined,
      maxFiles: r.maxFiles ?? 1,
      order: r.sortOrder ?? 0,
      createdAt: r.createdAt.toISOString(),
    }))

    return { fields }
  }

  async updateCustomFields(data: {
    fields: CustomFieldDefinition[]
  }): Promise<{ fields: CustomFieldDefinition[] }> {
    if (!data || !Array.isArray(data.fields)) {
      throw new ServiceError(
        400,
        'Invalid request: fields array required',
      )
    }

    const { fields } = data

    if (fields.length > MAX_CUSTOM_FIELDS) {
      throw new ServiceError(
        400,
        `Maximum ${MAX_CUSTOM_FIELDS} custom fields`,
      )
    }

    // Validate each field
    const names = new Set<string>()
    for (const field of fields) {
      if (!field.name || !field.label || !field.type) {
        throw new ServiceError(
          400,
          'Each field must have name, label, and type',
        )
      }
      if (!FIELD_NAME_REGEX.test(field.name)) {
        throw new ServiceError(
          400,
          `Invalid field name: ${field.name}. Use alphanumeric and underscores only.`,
        )
      }
      if (field.name.length > MAX_FIELD_NAME_LENGTH) {
        throw new ServiceError(
          400,
          `Field name too long: ${field.name}`,
        )
      }
      if (field.label.length > MAX_FIELD_LABEL_LENGTH) {
        throw new ServiceError(
          400,
          `Field label too long (max ${MAX_FIELD_LABEL_LENGTH} chars)`,
        )
      }
      if (names.has(field.name)) {
        throw new ServiceError(
          400,
          `Duplicate field name: ${field.name}`,
        )
      }
      names.add(field.name)
      if (
        !['text', 'number', 'select', 'checkbox', 'textarea', 'file'].includes(
          field.type,
        )
      ) {
        throw new ServiceError(
          400,
          `Invalid field type: ${field.type}`,
        )
      }
      if (field.type === 'select') {
        if (!field.options || field.options.length === 0) {
          throw new ServiceError(
            400,
            `Select field "${field.name}" must have options`,
          )
        }
        if (field.options.length > MAX_SELECT_OPTIONS) {
          throw new ServiceError(
            400,
            `Too many options for "${field.name}" (max ${MAX_SELECT_OPTIONS})`,
          )
        }
        for (const opt of field.options) {
          if (typeof opt !== 'string' || opt.length > MAX_OPTION_LENGTH) {
            throw new ServiceError(
              400,
              `Option too long in "${field.name}" (max ${MAX_OPTION_LENGTH} chars)`,
            )
          }
        }
      }
    }

    const validContexts = ['call-notes', 'conversation-notes', 'reports', 'all']
    const normalized = fields.map((f, i) => ({
      ...f,
      order: i,
      context:
        (f.context as string) === 'both'
          ? 'all'
          : validContexts.includes(f.context)
            ? f.context
            : 'all',
    }))

    // Replace all custom fields in a transaction, serialized across writers.
    // DELETE-all + INSERT under READ COMMITTED is not safe on its own: a
    // concurrent writer's DELETE blocks on our row locks, then skips the rows
    // we deleted and cannot see the rows we inserted, so both inserts survive
    // and the table ends up holding the union of both lists (duplicate names)
    // (#686). The transaction-scoped advisory lock makes each replacement see
    // the previous one's committed state: last writer wins, never a union.
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('custom_field_definitions:replace'))`,
      )
      await tx.delete(customFieldDefinitions)
      for (const [i, f] of normalized.entries()) {
        await tx.insert(customFieldDefinitions).values({
          id: f.id || crypto.randomUUID(),
          name: f.name,
          label: f.label,
          fieldType: f.type,
          required: f.required ?? false,
          options: f.options,
          validation: f.validation,
          visibleToUsers: f.visibleToUsers ?? true,
          editableByUsers: f.editableByUsers ?? true,
          context: f.context ?? 'all',
          maxFileSize: f.maxFileSize,
          allowedMimeTypes: f.allowedMimeTypes,
          maxFiles: f.maxFiles ?? 1,
          sortOrder: i,
        })
      }
    })

    return { fields: normalized as CustomFieldDefinition[] }
  }

  // =========================================================================
  // Messaging Config
  // =========================================================================

  async getMessagingConfig(): Promise<MessagingConfig> {
    const row = await getSettings(this.db)
    const config = row.messagingConfig as MessagingConfig | null
    return config && Object.keys(config).length > 0
      ? config
      : DEFAULT_MESSAGING_CONFIG
  }

  async updateMessagingConfig(
    data: Partial<MessagingConfig>,
  ): Promise<MessagingConfig> {
    const current = await this.getMessagingConfig()
    const updated = { ...current, ...data }

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
      .set({ messagingConfig: updated })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return updated
  }

  // =========================================================================
  // Setup State
  // =========================================================================

  async getSetupState(): Promise<SetupState> {
    const row = await getSettings(this.db)
    const state = row.setupState as SetupState | null
    return state && Object.keys(state).length > 0
      ? state
      : DEFAULT_SETUP_STATE
  }

  async updateSetupState(data: Partial<SetupState>): Promise<SetupState> {
    const current = await this.getSetupState()
    const updated = { ...current, ...data }
    await this.db
      .update(systemSettings)
      .set({ setupState: updated })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return updated
  }

  // =========================================================================
  // Enabled Channels
  // =========================================================================

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

  // =========================================================================
  // Report Categories (deprecated — use report types)
  // =========================================================================

  async getReportCategories(): Promise<{ categories: string[] }> {
    const row = await getSettings(this.db)
    return {
      categories: row.reportCategories ?? [
        'Incident Report',
        'Field Observation',
        'Evidence',
        'Other',
      ],
    }
  }

  async updateReportCategories(data: {
    categories: string[]
  }): Promise<{ categories: string[] }> {
    if (!Array.isArray(data.categories)) {
      throw new ServiceError(400, 'categories must be an array')
    }
    const categories = data.categories.slice(0, 50)
    await this.db
      .update(systemSettings)
      .set({ reportCategories: categories })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { categories }
  }

  // =========================================================================
  // Report Types CRUD
  // =========================================================================

  async getReportTypes(): Promise<{ reportTypes: ReportType[] }> {
    const row = await getSettings(this.db)
    let reportTypes = row.reportTypes as ReportType[] | null
    if (!reportTypes || reportTypes.length === 0) {
      const now = new Date().toISOString()
      reportTypes = DEFAULT_REPORT_TYPES.map((d) => ({
        ...d,
        id: crypto.randomUUID(),
        fields: [],
        isArchived: false,
        createdAt: now,
        updatedAt: now,
      }))
      await this.db
        .update(systemSettings)
        .set({ reportTypes })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }
    return { reportTypes }
  }

  async createReportType(data: Partial<ReportType>): Promise<ReportType> {
    if (!data || typeof data !== 'object') {
      throw new ServiceError(400, 'Invalid request body')
    }

    const { name, description, icon, fields, isDefault } = data

    if (!name || !name.trim()) {
      throw new ServiceError(400, 'Name is required')
    }
    if (name.length > MAX_REPORT_TYPE_NAME_LENGTH) {
      throw new ServiceError(
        400,
        `Name too long (max ${MAX_REPORT_TYPE_NAME_LENGTH} chars)`,
      )
    }
    if (description && description.length > MAX_REPORT_TYPE_DESCRIPTION_LENGTH) {
      throw new ServiceError(
        400,
        `Description too long (max ${MAX_REPORT_TYPE_DESCRIPTION_LENGTH} chars)`,
      )
    }

    const row = await getSettings(this.db)
    const reportTypes = (row.reportTypes as ReportType[]) ?? []

    if (reportTypes.filter((rt) => !rt.isArchived).length >= MAX_REPORT_TYPES) {
      throw new ServiceError(
        400,
        `Maximum ${MAX_REPORT_TYPES} active report types`,
      )
    }

    if (fields && fields.length > MAX_CUSTOM_FIELDS) {
      throw new ServiceError(
        400,
        `Maximum ${MAX_CUSTOM_FIELDS} fields per report type`,
      )
    }

    const now = new Date().toISOString()

    if (isDefault) {
      for (const rt of reportTypes) {
        rt.isDefault = false
      }
    }

    const reportType: ReportType = {
      id: crypto.randomUUID(),
      name: name.trim(),
      description: (description || '').trim(),
      icon: icon || undefined,
      fields: fields || [],
      isDefault: isDefault || false,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    }

    reportTypes.push(reportType)
    await this.db
      .update(systemSettings)
      .set({ reportTypes })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return reportType
  }

  async updateReportType(
    id: string,
    data: Partial<ReportType>,
  ): Promise<ReportType> {
    if (!data || typeof data !== 'object') {
      throw new ServiceError(400, 'Invalid request body')
    }

    const row = await getSettings(this.db)
    const reportTypes = (row.reportTypes as ReportType[]) ?? []
    const idx = reportTypes.findIndex((rt) => rt.id === id)
    if (idx === -1) {
      throw new ServiceError(404, 'Report type not found')
    }

    const rt = reportTypes[idx]

    if (data.name !== undefined) {
      if (!data.name.trim()) {
        throw new ServiceError(400, 'Name cannot be empty')
      }
      if (data.name.length > MAX_REPORT_TYPE_NAME_LENGTH) {
        throw new ServiceError(
          400,
          `Name too long (max ${MAX_REPORT_TYPE_NAME_LENGTH} chars)`,
        )
      }
      rt.name = data.name.trim()
    }

    if (data.description !== undefined) {
      if (data.description.length > MAX_REPORT_TYPE_DESCRIPTION_LENGTH) {
        throw new ServiceError(
          400,
          `Description too long (max ${MAX_REPORT_TYPE_DESCRIPTION_LENGTH} chars)`,
        )
      }
      rt.description = data.description.trim()
    }

    if (data.icon !== undefined) rt.icon = data.icon || undefined
    if (data.fields !== undefined) {
      if (data.fields.length > MAX_CUSTOM_FIELDS) {
        throw new ServiceError(
          400,
          `Maximum ${MAX_CUSTOM_FIELDS} fields per report type`,
        )
      }
      rt.fields = data.fields
    }

    if (data.isDefault !== undefined) {
      if (data.isDefault) {
        for (const other of reportTypes) {
          other.isDefault = false
        }
      }
      rt.isDefault = data.isDefault
    }

    rt.updatedAt = new Date().toISOString()
    reportTypes[idx] = rt
    await this.db
      .update(systemSettings)
      .set({ reportTypes })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return rt
  }

  async archiveReportType(id: string): Promise<{ ok: true }> {
    const row = await getSettings(this.db)
    const reportTypes = (row.reportTypes as ReportType[]) ?? []
    const idx = reportTypes.findIndex((rt) => rt.id === id)
    if (idx === -1) {
      throw new ServiceError(404, 'Report type not found')
    }

    const activeCount = reportTypes.filter((rt) => !rt.isArchived).length
    if (activeCount <= 1 && !reportTypes[idx].isArchived) {
      throw new ServiceError(
        400,
        'Cannot archive the last active report type',
      )
    }

    reportTypes[idx].isArchived = true
    reportTypes[idx].isDefault = false
    reportTypes[idx].updatedAt = new Date().toISOString()

    if (!reportTypes.some((rt) => rt.isDefault && !rt.isArchived)) {
      const firstActive = reportTypes.find((rt) => !rt.isArchived)
      if (firstActive) firstActive.isDefault = true
    }

    await this.db
      .update(systemSettings)
      .set({ reportTypes })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { ok: true }
  }

  // =========================================================================
  // Telephony Provider
  // =========================================================================

  async getProviderConfig(
    providerType: string,
    hubId?: string,
  ): Promise<typeof providerConfigs.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(providerConfigs)
      .where(
        and(
          eq(providerConfigs.providerType, providerType),
          hubId
            ? eq(providerConfigs.hubId, hubId)
            : isNull(providerConfigs.hubId),
        ),
      )
    return row ?? null
  }

  async upsertProviderConfig(
    config: Partial<typeof providerConfigs.$inferInsert>,
  ): Promise<typeof providerConfigs.$inferSelect> {
    const now = new Date()
    const hubId = config.hubId !== undefined ? config.hubId : null

    // Find existing config for this hub (or global if hubId is null)
    const whereClause = hubId !== null
      ? eq(providerConfigs.hubId, hubId)
      : isNull(providerConfigs.hubId)

    const [existing] = await this.db
      .select({ id: providerConfigs.id })
      .from(providerConfigs)
      .where(whereClause)
      .limit(1)

    const id = existing?.id ?? config.id ?? crypto.randomUUID()

    if (existing) {
      await this.db
        .update(providerConfigs)
        .set({
          providerType: config.providerType,
          credentials: config.credentials,
          status: config.status,
          capabilities: config.capabilities,
          phoneNumbers: config.phoneNumbers,
          error: config.error,
          lastCheckedAt: config.lastCheckedAt,
          updatedAt: now,
        })
        .where(eq(providerConfigs.id, id))
    } else {
      await this.db
        .insert(providerConfigs)
        .values({
          id,
          hubId,
          providerType: config.providerType ?? '',
          credentials: config.credentials ?? null,
          status: config.status ?? 'disconnected',
          capabilities: config.capabilities ?? [],
          phoneNumbers: config.phoneNumbers ?? [],
          error: config.error ?? null,
          lastCheckedAt: config.lastCheckedAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
    }

    const [row] = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, id))
    return row
  }

  async deleteProviderConfig(id: string): Promise<{ ok: true }> {
    await this.db
      .delete(providerConfigs)
      .where(eq(providerConfigs.id, id))
    return { ok: true }
  }

  async getTelephonyProvider(hmacSecret?: string, hubId?: string): Promise<TelephonyProviderConfig | null> {
    // When a hubId is provided, read the hub-scoped config instead of the global one.
    const hubCondition = hubId
      ? eq(providerConfigs.hubId, hubId)
      : isNull(providerConfigs.hubId)
    const [row] = await this.db
      .select()
      .from(providerConfigs)
      .where(hubCondition)
      .orderBy(desc(providerConfigs.updatedAt))
      .limit(1)
    if (!row) return null

    // Build base config from provider_configs metadata
    const config: Record<string, unknown> = {
      type: row.providerType,
      phoneNumber: (row.phoneNumbers as string[])?.[0] ?? '',
    }

    // Decrypt credentials if hmacSecret is provided and credentials exist
    if (row.credentials && hmacSecret) {
      try {
        const { decryptCredentials } = await import('./provider-setup/crypto')
        const creds = decryptCredentials(row.credentials, hmacSecret)
        Object.assign(config, creds)
      } catch {
        // Credentials may be plain JSON (legacy) — try parsing directly
        try {
          Object.assign(config, JSON.parse(row.credentials))
        } catch { /* ignore */ }
      }
    } else if (row.credentials) {
      // No hmacSecret — try plain JSON parse (legacy path)
      try {
        Object.assign(config, JSON.parse(row.credentials))
      } catch { /* encrypted, can't decrypt without secret */ }
    }

    return config as unknown as TelephonyProviderConfig
  }

  /**
   * @deprecated Use ProviderSetupService.configure() instead — it encrypts credentials at rest.
   * This legacy method stores credentials in plaintext and will be removed in a future release.
   */
  async updateTelephonyProvider(
    _config: TelephonyProviderConfig,
  ): Promise<never> {
    throw new ServiceError(
      400,
      'updateTelephonyProvider is deprecated — use POST /provider-setup/configure which encrypts credentials at rest',
    )
  }

  // =========================================================================
  // IVR Audio
  // =========================================================================

  async getIvrAudioList(): Promise<{
    recordings: Array<{
      promptType: string
      language: string
      size: number
      uploadedAt: string
    }>
  }> {
    const rows = await this.db.select().from(ivrAudio)
    return {
      recordings: rows.map((r) => ({
        promptType: r.promptType,
        language: r.language,
        size: r.size,
        uploadedAt: r.uploadedAt.toISOString(),
      })),
    }
  }

  async uploadIvrAudio(
    promptType: string,
    language: string,
    audioBase64: string,
    size: number,
  ): Promise<{
    ok: true
    promptType: string
    language: string
    size: number
    uploadedAt: string
  }> {
    if (!(VALID_PROMPT_TYPES as readonly string[]).includes(promptType)) {
      throw new ServiceError(400, 'Invalid prompt type')
    }
    if (size > MAX_AUDIO_SIZE) {
      throw new ServiceError(400, 'File too large (max 1MB)')
    }
    if (size === 0) {
      throw new ServiceError(400, 'Empty file')
    }

    const now = new Date()

    await this.db
      .insert(ivrAudio)
      .values({
        promptType,
        language,
        audio: audioBase64,
        size,
        uploadedAt: now,
      })
      .onConflictDoUpdate({
        target: [ivrAudio.promptType, ivrAudio.language],
        set: {
          audio: audioBase64,
          size,
          uploadedAt: now,
        },
      })

    return {
      ok: true,
      promptType,
      language,
      size,
      uploadedAt: now.toISOString(),
    }
  }

  async getIvrAudio(
    promptType: string,
    language: string,
  ): Promise<{ audio: string; size: number } | null> {
    const [row] = await this.db
      .select()
      .from(ivrAudio)
      .where(
        and(
          eq(ivrAudio.promptType, promptType),
          eq(ivrAudio.language, language),
        ),
      )
    if (!row) return null
    return { audio: row.audio, size: row.size }
  }

  async deleteIvrAudio(
    promptType: string,
    language: string,
  ): Promise<{ ok: true }> {
    await this.db
      .delete(ivrAudio)
      .where(
        and(
          eq(ivrAudio.promptType, promptType),
          eq(ivrAudio.language, language),
        ),
      )
    return { ok: true }
  }

  // =========================================================================
  // Roles CRUD
  // =========================================================================

  async getRoles(): Promise<{ roles: Role[] }> {
    const now = Date.now()
    if (_rolesCache && _rolesCache.expiresAt > now) {
      return { roles: _rolesCache.roles }
    }
    const rows = await this.db.select().from(rolesTable)
    const envelopesRows = await this.db.select().from(platformRoleEnvelopes)
    const envelopesByRole = new Map<string, typeof envelopesRows>()
    for (const e of envelopesRows) {
      const list = envelopesByRole.get(e.roleId) ?? []
      list.push(e)
      envelopesByRole.set(e.roleId, list)
    }
    const userCounts = await this.db
      .select({ roleId: sql<string>`unnest(${users.roles})`, count: sql<number>`count(*)` })
      .from(users)
      .groupBy(sql`unnest(${users.roles})`)
    const countByRole = new Map<string, number>()
    for (const uc of userCounts) {
      countByRole.set(uc.roleId, Number(uc.count))
    }
    const rolesList: Role[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      permissions: r.permissions,
      isDefault: r.isDefault ?? false,
      isSystem: r.isSystem ?? false,
      description: r.description,
      encryptedName: r.encryptedName ?? null,
      encryptedDescription: r.encryptedDescription ?? null,
      envelopes: (envelopesByRole.get(r.id) ?? []).map((e) => ({
        adminPubkey: e.adminPubkey,
        encryptedName: e.encryptedName,
        encryptedDescription: e.encryptedDescription,
      })),
      assignedUserCount: countByRole.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    // Don't cache empty results — they indicate a race with reset/ensureInit
    if (rolesList.length > 0) {
      _rolesCache = { roles: rolesList, expiresAt: now + ROLES_CACHE_TTL_MS }
    }
    return { roles: rolesList }
  }

  async createRole(data: Partial<Role> & { encryptedName?: string; encryptedDescription?: string; envelopes?: Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }> }): Promise<Role> {
    if (!data || typeof data !== 'object') {
      throw new ServiceError(400, 'Invalid request')
    }
    const { slug, permissions, description, encryptedName, encryptedDescription, envelopes } = data
    if (!slug || !permissions) {
      throw new ServiceError(
        400,
        'slug and permissions are required',
      )
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new ServiceError(
        400,
        'slug must be lowercase alphanumeric with hyphens',
      )
    }

    // Check slug uniqueness
    const [existing] = await this.db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.slug, slug))
    if (existing) {
      throw new ServiceError(
        409,
        `Role slug "${slug}" already exists`,
      )
    }

    const now = new Date()
    const id = data.id ?? `role-${crypto.randomUUID()}`

    const roleDescription = description ?? ''

    await this.db.insert(rolesTable).values({
      id,
      name: data.name ?? null,
      slug,
      permissions: permissions as string[],
      isDefault: false,
      isSystem: false,
      description: roleDescription,
      encryptedName: encryptedName ?? null,
      encryptedDescription: encryptedDescription ?? null,
      createdAt: now,
      updatedAt: now,
    })

    if (envelopes && envelopes.length > 0) {
      for (const env of envelopes) {
        await this.db.insert(platformRoleEnvelopes).values({
          roleId: id,
          adminPubkey: env.adminPubkey,
          encryptedName: env.encryptedName,
          encryptedDescription: env.encryptedDescription,
          createdAt: now,
          updatedAt: now,
        })
      }
    }

    return {
      id,
      name: data.name ?? null,
      slug,
      permissions: permissions as string[],
      isDefault: false,
      isSystem: false,
      description: roleDescription,
      encryptedName: encryptedName ?? null,
      encryptedDescription: encryptedDescription ?? null,
      envelopes: envelopes ?? [],
      assignedUserCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
  }

  async updateRole(id: string, data: Partial<Role>): Promise<Role> {
    const [existing] = await this.db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Role not found')
    }
    if (existing.isSystem) {
      throw new ServiceError(403, 'Cannot modify system roles')
    }

    const now = new Date()
    // Never store plaintext name for non-system roles — name column stays null
    const updates: Record<string, unknown> = { updatedAt: now }
    if (data.description) updates.description = data.description
    if (data.permissions) updates.permissions = data.permissions as string[]

    await this.db
      .update(rolesTable)
      .set(updates)
      .where(eq(rolesTable.id, id))

    // Invalidate the roles cache so subsequent requests pick up the updated
    // permissions immediately. Without this, the 30-second cache TTL causes
    // stale permissions in E2E tests where test-seed updates the volunteer
    // role then the app immediately queries a newly-permitted endpoint.
    invalidateRolesCache()

    const [updated] = await this.db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.id, id))

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      permissions: updated.permissions,
      isDefault: updated.isDefault ?? false,
      isSystem: updated.isSystem ?? false,
      description: updated.description,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    }
  }

  async deleteRole(id: string): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Role not found')
    }
    if (existing.isDefault) {
      throw new ServiceError(403, 'Cannot delete default roles')
    }

    await this.db.delete(rolesTable).where(eq(rolesTable.id, id))
    return { ok: true }
  }

  async addRoleEnvelopes(
    roleId: string,
    envelopes: Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }>,
  ): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select()
      .from(rolesTable)
      .where(eq(rolesTable.id, roleId))
    if (!existing) {
      throw new ServiceError(404, 'Role not found')
    }

    const now = new Date()
    for (const env of envelopes) {
      await this.db
        .insert(platformRoleEnvelopes)
        .values({
          roleId,
          adminPubkey: env.adminPubkey,
          encryptedName: env.encryptedName,
          encryptedDescription: env.encryptedDescription,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [platformRoleEnvelopes.roleId, platformRoleEnvelopes.adminPubkey],
          set: {
            encryptedName: env.encryptedName,
            encryptedDescription: env.encryptedDescription,
            updatedAt: now,
          },
        })
    }
    return { ok: true }
  }

  async getEffectivePermissions(userId: string, hubId?: string): Promise<{ userId: string; permissions: string[] }> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.pubkey, userId))
    if (!user) {
      throw new ServiceError(404, 'User not found')
    }

    const { resolveHubPermissions, resolvePermissions } = await import('@shared/permissions')
    const allRoles = await this.getRoles()
    const hubRoles = Array.isArray(user.hubRoles) ? user.hubRoles as Array<{ hubId: string; roleIds: string[] }> : []

    let permissions: string[]
    if (hubId) {
      // Resolve for a specific hub (global + that hub's roles)
      permissions = resolveHubPermissions(user.roles ?? [], hubRoles, allRoles.roles, hubId)
    } else {
      // Union global permissions with all hub-scoped permissions
      const allPerms = new Set<string>(resolvePermissions(user.roles ?? [], allRoles.roles))
      for (const assignment of hubRoles) {
        for (const p of resolveHubPermissions(user.roles ?? [], hubRoles, allRoles.roles, assignment.hubId)) {
          allPerms.add(p)
        }
      }
      permissions = Array.from(allPerms)
    }
    return { userId, permissions }
  }

  // =========================================================================
  // CAPTCHA Server-Side State
  // =========================================================================

  async storeCaptcha(data: {
    callSid: string
    expected: string
  }): Promise<{ ok: true }> {
    await this.db
      .insert(captchas)
      .values({
        callSid: data.callSid,
        expected: data.expected,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: captchas.callSid,
        set: {
          expected: data.expected,
          createdAt: new Date(),
        },
      })
    return { ok: true }
  }

  async verifyCaptcha(data: {
    callSid: string
    digits: string
  }): Promise<{ match: boolean; expected: string }> {
    const [stored] = await this.db
      .select()
      .from(captchas)
      .where(eq(captchas.callSid, data.callSid))

    // Always delete after first attempt (one-time use)
    await this.db.delete(captchas).where(eq(captchas.callSid, data.callSid))

    if (!stored) {
      return { match: false, expected: '' }
    }

    // Expire after 5 minutes
    if (Date.now() - stored.createdAt.getTime() > CAPTCHA_TTL_MS) {
      return { match: false, expected: stored.expected }
    }

    // Constant-time comparison
    const expected = stored.expected
    const digits = data.digits
    let match = expected.length === digits.length ? 1 : 0
    for (let i = 0; i < expected.length; i++) {
      match &= expected.charCodeAt(i) === digits.charCodeAt(i) ? 1 : 0
    }
    return { match: match === 1, expected }
  }

  // =========================================================================
  // TTL Overrides
  // =========================================================================

  async getTTLOverrides(): Promise<{ overrides: TTLOverrides }> {
    const row = await getSettings(this.db)
    return { overrides: (row.ttlOverrides as TTLOverrides) ?? {} }
  }

  async updateTTLOverrides(
    data: Record<string, unknown>,
  ): Promise<{ overrides: TTLOverrides }> {
    const error = validateTTLOverrides(data)
    if (error) {
      throw new ServiceError(400, error)
    }
    const row = await getSettings(this.db)
    const current = (row.ttlOverrides as TTLOverrides) ?? {}
    const updated: TTLOverrides = { ...current }
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'number') {
        updated[key] = value
      }
    }
    await this.db
      .update(systemSettings)
      .set({ ttlOverrides: updated })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { overrides: updated }
  }

  // =========================================================================
  // Cleanup Metrics
  // =========================================================================

  async getCleanupMetrics(): Promise<CleanupMetrics> {
    const row = await getSettings(this.db)
    const metrics = row.cleanupMetrics as CleanupMetrics | null
    return metrics && Object.keys(metrics).length > 0
      ? metrics
      : emptyCleanupMetrics()
  }

  // =========================================================================
  // Hub Registry
  // =========================================================================

  async getHubs(): Promise<{ hubs: Hub[] }> {
    const rows = await this.db.select().from(hubsTable)
    const hubList: Hub[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description ?? '',
      status: r.status as Hub['status'],
      phoneNumber: r.phoneNumber ?? undefined,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    return { hubs: hubList }
  }

  async createHub(hub: Hub): Promise<{ hub: Hub }> {
    // Check slug uniqueness
    const [existing] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.slug, hub.slug))
    if (existing) {
      throw new ServiceError(409, 'Hub slug already exists')
    }

    const now = new Date()
    await this.db.insert(hubsTable).values({
      id: hub.id,
      name: hub.name,
      slug: hub.slug,
      description: hub.description,
      status: hub.status ?? 'active',
      phoneNumber: hub.phoneNumber,
      createdBy: hub.createdBy,
      createdAt: now,
      updatedAt: now,
    })

    // Create hub_settings row
    await this.db
      .insert(hubSettingsTable)
      .values({ hubId: hub.id, settings: {} })
      .onConflictDoNothing()

    return { hub }
  }

  async getHub(id: string): Promise<{ hub: Hub }> {
    const [row] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))
    if (!row) {
      throw new ServiceError(404, 'Not found')
    }
    return {
      hub: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description ?? '',
        status: row.status as Hub['status'],
        phoneNumber: row.phoneNumber ?? undefined,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    }
  }

  async updateHub(
    id: string,
    data: Partial<Hub>,
  ): Promise<{ hub: Hub }> {
    const [existing] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Not found')
    }

    const now = new Date()
    const updates: Record<string, unknown> = { updatedAt: now }
    if (data.name !== undefined) updates.name = data.name
    if (data.slug !== undefined) updates.slug = data.slug
    if (data.description !== undefined) updates.description = data.description
    if (data.status !== undefined) updates.status = data.status
    if (data.phoneNumber !== undefined) updates.phoneNumber = data.phoneNumber

    await this.db
      .update(hubsTable)
      .set(updates)
      .where(eq(hubsTable.id, id))

    const [updated] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))

    return {
      hub: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        description: updated.description ?? '',
        status: updated.status as Hub['status'],
        phoneNumber: updated.phoneNumber ?? undefined,
        createdBy: updated.createdBy,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    }
  }

  async archiveHub(id: string): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Not found')
    }

    await this.db
      .update(hubsTable)
      .set({
        status: 'archived',
        updatedAt: new Date(),
      })
      .where(eq(hubsTable.id, id))
    return { ok: true }
  }

  async deleteHub(id: string): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Hub not found')
    }

    return this.purgeHub(id)
  }

  /**
   * Delete a hub and every hub-scoped row, without requiring the hub row to
   * exist — so orphaned data (hub row already gone) can still be cleared.
   */
  async purgeHub(id: string): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      // 1. Delete users who belong exclusively to this hub (cascade deletes sessions, webauthn, etc.)
      // Exclude super-admins — they are system-level accounts that must survive hub deletion.
      await tx.execute(sql`
        DELETE FROM users
        WHERE (
          SELECT COUNT(*) FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' = ${id}
        ) > 0
        AND (
          SELECT COUNT(*) FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' != ${id}
        ) = 0
        AND NOT ('role-super-admin' = ANY(roles))
      `)

      // 2. Remove this hub from remaining users' hubRoles
      await tx.execute(sql`
        UPDATE users
        SET hub_roles = (
          SELECT COALESCE(jsonb_agg(hr), '[]'::jsonb)
          FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' != ${id}
        )
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(hub_roles) AS hr
          WHERE hr->>'hubId' = ${id}
        )
      `)

      // 3. Notes (noteReplies cascade from notes via FK)
      const hubNoteIds = await tx
        .select({ id: notes.id })
        .from(notes)
        .where(eq(notes.hubId, id))
      if (hubNoteIds.length > 0) {
        await tx.delete(noteReplies).where(
          inArray(noteReplies.noteId, hubNoteIds.map(n => n.id))
        )
      }
      await tx.delete(notes).where(eq(notes.hubId, id))

      // 4. Bans, contact metadata, audit log
      await tx.delete(bans).where(eq(bans.hubId, id))
      await tx.delete(contactMetadata).where(eq(contactMetadata.hubId, id))
      await tx.delete(auditLog).where(eq(auditLog.hubId, id))

      // 5. Case-related tables (join tables reference caseId, not hubId)
      const hubCaseIds = await tx
        .select({ id: caseRecords.id })
        .from(caseRecords)
        .where(eq(caseRecords.hubId, id))
      if (hubCaseIds.length > 0) {
        const ids = hubCaseIds.map(c => c.id)
        // Delete custody entries (grandchildren of evidence)
        const hubEvidenceIds = await tx
          .select({ id: evidence.id })
          .from(evidence)
          .where(inArray(evidence.caseId, ids))
        if (hubEvidenceIds.length > 0) {
          await tx.delete(custodyEntries).where(
            inArray(custodyEntries.evidenceId, hubEvidenceIds.map(e => e.id))
          )
        }
        await tx.delete(evidence).where(inArray(evidence.caseId, ids))
        await tx.delete(caseInteractions).where(inArray(caseInteractions.caseId, ids))
        await tx.delete(caseContacts).where(inArray(caseContacts.caseId, ids))
        await tx.delete(caseEvents).where(inArray(caseEvents.caseId, ids))
        await tx.delete(reportEvents).where(inArray(reportEvents.reportId, ids))
        // reportCases joins reports to cases — delete where either side is from this hub
        await tx.delete(reportCases).where(
          or(inArray(reportCases.reportId, ids), inArray(reportCases.caseId, ids))
        )
      }
      await tx.delete(caseRecords).where(eq(caseRecords.hubId, id))
      await tx.delete(hubCaseEvents).where(eq(hubCaseEvents.hubId, id))

      // 6. Conversations (messages, files, contactIdentifiers cascade via FK)
      await tx.delete(conversations).where(eq(conversations.hubId, id))

      // 7. Contacts
      await tx.delete(contactRelationships).where(eq(contactRelationships.hubId, id))
      const hubGroupIds = await tx
        .select({ id: affinityGroups.id })
        .from(affinityGroups)
        .where(eq(affinityGroups.hubId, id))
      if (hubGroupIds.length > 0) {
        await tx.delete(groupMembers).where(
          inArray(groupMembers.groupId, hubGroupIds.map(g => g.id))
        )
      }
      await tx.delete(affinityGroups).where(eq(affinityGroups.hubId, id))
      await tx.delete(contacts).where(eq(contacts.hubId, id))

      // 8. Shifts
      await tx.delete(shifts).where(eq(shifts.hubId, id))

      // 9. Calls
      await tx.delete(activeCalls).where(eq(activeCalls.hubId, id))
      await tx.delete(callRecords).where(eq(callRecords.hubId, id))

      // 10. Blasts
      await tx.delete(blasts).where(eq(blasts.hubId, id))
      await tx.delete(subscribers).where(eq(subscribers.hubId, id))
      await tx.delete(blastSettings).where(eq(blastSettings.hubId, id))

      // 11. CMS definitions
      await tx.delete(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, id))
      await tx.delete(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.hubId, id))
      await tx.delete(reportTypeDefinitions).where(eq(reportTypeDefinitions.hubId, id))
      await tx.delete(caseNumberSequences).where(eq(caseNumberSequences.hubId, id))

      // 12. Storage credentials and settings
      await tx.delete(hubStorageCredentials).where(eq(hubStorageCredentials.hubId, id))
      await tx.delete(hubStorageSettings).where(eq(hubStorageSettings.hubId, id))

      // 13. Delete hub (hub_settings and hub_keys cascade via FK)
      await tx.delete(hubsTable).where(eq(hubsTable.id, id))
    })

    return { ok: true }
  }

  // =========================================================================
  // Hub Storage Credentials
  // =========================================================================

  async storeHubStorageCredentials(data: {
    hubId: string
    accessKeyId: string
    encryptedSecretKey: string
    policyName: string
    userName: string
  }): Promise<{ ok: true }> {
    await this.db.insert(hubStorageCredentials).values({
      hubId: data.hubId,
      accessKeyId: data.accessKeyId,
      encryptedSecretKey: data.encryptedSecretKey,
      policyName: data.policyName,
      userName: data.userName,
    })
    return { ok: true }
  }

  async getHubStorageCredentials(hubId: string): Promise<{
    hubId: string
    accessKeyId: string
    encryptedSecretKey: string
    policyName: string
    userName: string
    createdAt: Date
  } | null> {
    const [row] = await this.db
      .select()
      .from(hubStorageCredentials)
      .where(eq(hubStorageCredentials.hubId, hubId))
    return row ?? null
  }

  async deleteHubStorageCredentials(hubId: string): Promise<{ ok: true }> {
    await this.db
      .delete(hubStorageCredentials)
      .where(eq(hubStorageCredentials.hubId, hubId))
    return { ok: true }
  }

  async getHubStorageSettings(hubId: string, namespace: string): Promise<{ retentionDays: number | null }> {
    const [row] = await this.db
      .select()
      .from(hubStorageSettings)
      .where(
        and(
          eq(hubStorageSettings.hubId, hubId),
          eq(hubStorageSettings.namespace, namespace)
        )
      )
    return { retentionDays: row?.retentionDays ?? null }
  }

  async setHubStorageRetention(hubId: string, namespace: string, days: number | null): Promise<{ ok: true }> {
    await this.db
      .insert(hubStorageSettings)
      .values({ hubId, namespace, retentionDays: days })
      .onConflictDoUpdate({
        target: [hubStorageSettings.hubId, hubStorageSettings.namespace],
        set: { retentionDays: days },
      })
    return { ok: true }
  }

  async getHubSettings(
    hubId: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .select()
      .from(hubSettingsTable)
      .where(eq(hubSettingsTable.hubId, hubId))
    return (row?.settings as Record<string, unknown>) ?? {}
  }

  async updateHubSettings(
    hubId: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Strip unknown keys
    const sanitized: Record<string, unknown> = {}
    for (const key of Object.keys(data)) {
      if (ALLOWED_HUB_SETTINGS.has(key)) {
        sanitized[key] = data[key]
      }
    }

    const existing = await this.getHubSettings(hubId)
    const merged = { ...existing, ...sanitized }

    await this.db
      .insert(hubSettingsTable)
      .values({ hubId, settings: merged })
      .onConflictDoUpdate({
        target: hubSettingsTable.hubId,
        set: { settings: merged },
      })

    return merged
  }

  async getHubProviderSettings(
    hubId: string,
  ): Promise<Record<string, unknown>> {
    const settings = await this.getHubSettings(hubId)
    return {
      providerSetupComplete: settings.providerSetupComplete ?? false,
      channels: settings.channels ?? {},
      quotas: settings.quotas ?? {},
      usage: settings.usage ?? [],
      subAccountEnabled: settings.subAccountEnabled ?? false,
      subAccountConfigId: settings.subAccountConfigId ?? undefined,
    }
  }

  async updateHubQuotas(
    hubId: string,
    quotas: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const current = await this.getHubSettings(hubId)
    const updated = { ...current, quotas }
    await this.db
      .insert(hubSettingsTable)
      .values({ hubId, settings: updated })
      .onConflictDoUpdate({
        target: hubSettingsTable.hubId,
        set: { settings: updated },
      })
    return updated.quotas as Record<string, unknown>
  }

  async updateHubUsage(
    hubId: string,
    usage: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const current = await this.getHubSettings(hubId)
    const updated = { ...current, usage }
    await this.db
      .insert(hubSettingsTable)
      .values({ hubId, settings: updated })
      .onConflictDoUpdate({
        target: hubSettingsTable.hubId,
        set: { settings: updated },
      })
    return updated.usage as Record<string, unknown>[]
  }

  async incrementHubUsage(
    hubId: string,
    resource: string,
    amount = 1,
  ): Promise<Record<string, unknown>> {
    const settings = await this.getHubSettings(hubId)
    const usage = (settings.usage as Record<string, unknown>[]) ?? []
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    let currentMonth = usage.find((u) => u.month === month)
    if (!currentMonth) {
      currentMonth = { month, year: now.getFullYear() }
      usage.push(currentMonth)
    }

    currentMonth[resource] = ((currentMonth[resource] as number) ?? 0) + amount

    const updated = { ...settings, usage }
    await this.db
      .insert(hubSettingsTable)
      .values({ hubId, settings: updated })
      .onConflictDoUpdate({
        target: hubSettingsTable.hubId,
        set: { settings: updated },
      })

    return currentMonth
  }

  /**
   * Hub-scoped telephony provider config.
   *
   * Delegates to {@link getTelephonyProvider}, which is the established read
   * path for exactly this row — same table, same hub predicate, same credential
   * handling. No separate parsing, key handling or decrypt helper here.
   *
   * The previous implementation read the row itself and did
   * `JSON.parse(row.credentials)`. That could never succeed: every writer stores
   * ciphertext (`provider-setup/index.ts` encrypts via `encryptCredentials`),
   * and the provider type lives in the `provider_configs.provider_type` COLUMN,
   * never inside the credentials JSON — so even a successful parse would have
   * yielded an object with no `type`. It therefore returned null for every
   * configured hub, which silently
   *   - disabled the hub-scoped IVR speakability constraint (#1260) by making
   *     the catalog resolution fall through to the instance-wide provider, and
   *   - made `getHubTelephonyFromService` fall back to the global provider for
   *     every hub, so per-hub provider configuration never took effect at all.
   */
  async getHubTelephonyProvider(
    hubId: string,
    hmacSecret?: string,
  ): Promise<TelephonyProviderConfig | null> {
    return this.getTelephonyProvider(hmacSecret, hubId)
  }

  async setHubTelephonyProvider(
    hubId: string,
    config: TelephonyProviderConfig,
  ): Promise<{ ok: true }> {
    if (!config || typeof config !== 'object') {
      throw new ServiceError(400, 'Invalid request body')
    }
    if (!config.type) {
      throw new ServiceError(400, 'Provider type is required')
    }
    if (!(VALID_PROVIDER_TYPES as readonly string[]).includes(config.type)) {
      throw new ServiceError(
        400,
        `Invalid provider type: ${config.type}`,
      )
    }
    const required = PROVIDER_REQUIRED_FIELDS[config.type]
    for (const field of required) {
      if (!config[field]) {
        throw new ServiceError(400, `Missing required field: ${field}`)
      }
    }
    if (config.phoneNumber && !/^\+\d{7,15}$/.test(config.phoneNumber)) {
      throw new ServiceError(
        400,
        'Phone number must be in E.164 format',
      )
    }

    const existing = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.hubId, hubId))
      .limit(1)
    const id = existing[0]?.id ?? crypto.randomUUID()
    await this.db
      .insert(providerConfigs)
      .values({
        id,
        hubId,
        providerType: config.type,
        credentials: JSON.stringify(config),
        status: 'connected',
        capabilities: [],
        phoneNumbers: config.phoneNumber ? [config.phoneNumber] : [],
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: providerConfigs.id,
        set: {
          providerType: config.type,
          credentials: JSON.stringify(config),
          status: 'connected',
          phoneNumbers: config.phoneNumber ? [config.phoneNumber] : [],
          updatedAt: new Date(),
        },
      })
    return { ok: true }
  }

  /**
   * Select the demo-only mock telephony provider (type `mock`) for a hub.
   *
   * Callers MUST have already checked `assertMockTelephonyAllowed` — this only
   * persists the selection. Refuses to overwrite a real provider's credentials.
   */
  async enableHubMockTelephony(hubId: string, phoneNumber: string): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.hubId, hubId))
      .limit(1)
    if (existing && existing.providerType !== MOCK_PROVIDER_TYPE) {
      throw new ServiceError(
        409,
        `Hub already has a ${existing.providerType} telephony provider — remove it before enabling the mock`,
      )
    }
    const id = existing?.id ?? crypto.randomUUID()
    const values = {
      providerType: MOCK_PROVIDER_TYPE,
      credentials: JSON.stringify({ type: MOCK_PROVIDER_TYPE, phoneNumber }),
      status: 'connected',
      phoneNumbers: [phoneNumber],
      updatedAt: new Date(),
    }
    await this.db
      .insert(providerConfigs)
      .values({ id, hubId, capabilities: [], createdAt: new Date(), ...values })
      .onConflictDoUpdate({ target: providerConfigs.id, set: values })
    return { ok: true }
  }

  /** Remove the mock provider from a hub. Never touches a real provider's config. */
  async disableHubMockTelephony(hubId: string): Promise<{ ok: true }> {
    await this.db
      .delete(providerConfigs)
      .where(and(eq(providerConfigs.hubId, hubId), eq(providerConfigs.providerType, MOCK_PROVIDER_TYPE)))
    return { ok: true }
  }

  /** Whether the hub currently selects the mock provider. */
  async isHubMockTelephonyEnabled(hubId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ providerType: providerConfigs.providerType })
      .from(providerConfigs)
      .where(eq(providerConfigs.hubId, hubId))
      .limit(1)
    return row?.providerType === MOCK_PROVIDER_TYPE
  }

  async getHubByPhone(
    phone: string,
  ): Promise<{ hub: Hub }> {
    const [row] = await this.db
      .select()
      .from(hubsTable)
      .where(
        and(eq(hubsTable.phoneNumber, phone), eq(hubsTable.status, 'active')),
      )
    if (!row) {
      throw new ServiceError(404, 'No hub for this number')
    }
    return {
      hub: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description ?? '',
        status: row.status as Hub['status'],
        phoneNumber: row.phoneNumber ?? undefined,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    }
  }

  // =========================================================================
  // Hub Key Management
  // =========================================================================

  async getHubKeyEnvelopes(hubId: string): Promise<{
    envelopes: Array<{
      pubkey: string
      enc: string
      ct: string
    }>
  }> {
    const rows = await this.db
      .select()
      .from(hubKeys)
      .where(eq(hubKeys.hubId, hubId))

    return {
      envelopes: rows.map((r) => ({
        pubkey: r.recipientPubkey,
        enc: r.enc,
        ct: r.ct,
      })),
    }
  }

  async setHubKeyEnvelopes(
    hubId: string,
    data: {
      envelopes: Array<{
        pubkey: string
        enc: string
        ct: string
      }>
    },
  ): Promise<{ ok: true }> {
    // Validate hub exists
    const [hub] = await this.db
      .select()
      .from(hubsTable)
      .where(eq(hubsTable.id, hubId))
    if (!hub) {
      throw new ServiceError(404, 'Hub not found')
    }

    // Replace all envelopes in a transaction
    await this.db.transaction(async (tx) => {
      await tx.delete(hubKeys).where(eq(hubKeys.hubId, hubId))
      for (const envelope of data.envelopes) {
        await tx.insert(hubKeys).values({
          hubId,
          recipientPubkey: envelope.pubkey,
          enc: envelope.enc,
          ct: envelope.ct,
        })
      }
    })

    return { ok: true }
  }

  // =========================================================================
  // Case Management — Entity Type Definitions (Epic 315)
  // =========================================================================

  async getCaseManagementEnabled(hubId?: string): Promise<{ enabled: boolean }> {
    // Hub-scoped: check hub_settings first; fall back to global system_settings
    if (hubId) {
      const hubSettingsRow = await this.getHubSettings(hubId)
      if (typeof hubSettingsRow.caseManagementEnabled === 'boolean') {
        return { enabled: hubSettingsRow.caseManagementEnabled }
      }
    }
    const row = await getSettings(this.db)
    return { enabled: row.caseManagementEnabled ?? false }
  }

  async setCaseManagementEnabled(data: {
    enabled: boolean
  }, hubId?: string): Promise<{ enabled: boolean }> {
    const enabled = !!data.enabled
    if (hubId) {
      // Hub-scoped: store in hub_settings so parallel tests don't interfere
      await this.updateHubSettings(hubId, { caseManagementEnabled: enabled })
    } else {
      // Global fallback (non-hub-scoped path)
      await this.db
        .update(systemSettings)
        .set({ caseManagementEnabled: enabled })
        .where(eq(systemSettings.id, SINGLETON_ID))
    }
    return { enabled }
  }

  // =========================================================================
  // Cross-Hub Sharing (Epic 328)
  // =========================================================================

  async getCrossHubSharingEnabled(): Promise<{ enabled: boolean }> {
    const row = await getSettings(this.db)
    return { enabled: row.crossHubSharingEnabled ?? false }
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

  // =========================================================================
  // Entity Types
  // =========================================================================

  async getEntityTypes(hubId?: string): Promise<{
    entityTypes: EntityTypeDefinition[]
  }> {
    const rows = hubId !== undefined
      ? await this.db.select().from(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, hubId))
      : await this.db.select().from(entityTypeDefinitions)
    return {
      entityTypes: rows.map((r) => this.rowToEntityType(r)),
    }
  }

  async getEntityTypeById(
    id: string,
  ): Promise<EntityTypeDefinition> {
    const [row] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(eq(entityTypeDefinitions.id, id))
    if (!row) {
      throw new ServiceError(404, 'Entity type not found')
    }
    return this.rowToEntityType(row)
  }

  async createEntityType(
    data: Record<string, unknown>,
  ): Promise<EntityTypeDefinition> {
    const hubId = (data.hubId as string) ?? ''
    const count = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(entityTypeDefinitions)
      .where(eq(entityTypeDefinitions.hubId, hubId))
    if (Number(count[0].count) >= MAX_ENTITY_TYPES) {
      throw new ServiceError(
        400,
        `Maximum of ${MAX_ENTITY_TYPES} entity types allowed`,
      )
    }

    const name = data.name as string
    // Check for duplicate name (non-archived) within the same hub
    const [dup] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(
        and(
          eq(entityTypeDefinitions.hubId, hubId),
          eq(entityTypeDefinitions.name, name),
          eq(entityTypeDefinitions.isArchived, false),
        ),
      )
    if (dup) {
      throw new ServiceError(
        409,
        `Entity type with name "${name}" already exists`,
      )
    }

    const now = new Date()
    const id = crypto.randomUUID()

    // Assign IDs to fields
    const fields = ((data.fields as EntityFieldDefinition[]) ?? []).map(
      (f) => ({
        ...f,
        id: f.id || crypto.randomUUID(),
      }),
    )

    await this.db.insert(entityTypeDefinitions).values({
      id,
      hubId: (data.hubId as string) ?? '',
      name,
      label: (data.label as string) ?? name,
      labelPlural: (data.labelPlural as string) ?? '',
      description: (data.description as string) ?? '',
      icon: data.icon as string | undefined,
      color: data.color as string | undefined,
      category: (data.category as string) ?? 'case',
      templateId: data.templateId as string | undefined,
      templateVersion: data.templateVersion as string | undefined,
      fields,
      statuses: (data.statuses as unknown[]) ?? [],
      defaultStatus: (data.defaultStatus as string) ?? '',
      closedStatuses: (data.closedStatuses as string[]) ?? [],
      severities: data.severities as unknown,
      defaultSeverity: data.defaultSeverity as string | undefined,
      categories: data.categories as unknown,
      contactRoles: data.contactRoles as unknown,
      numberPrefix: data.numberPrefix as string | undefined,
      numberingEnabled: (data.numberingEnabled as boolean) ?? false,
      defaultAccessLevel: (data.defaultAccessLevel as string) ?? 'assigned',
      piiFields: (data.piiFields as string[]) ?? [],
      allowSubRecords: (data.allowSubRecords as boolean) ?? false,
      allowFileAttachments: (data.allowFileAttachments as boolean) ?? true,
      allowInteractionLinks: (data.allowInteractionLinks as boolean) ?? true,
      showInNavigation: (data.showInNavigation as boolean) ?? true,
      showInDashboard: (data.showInDashboard as boolean) ?? true,
      accessRoles: data.accessRoles as string[] | undefined,
      editRoles: data.editRoles as string[] | undefined,
      autoAssign: (data.autoAssign as boolean) ?? false,
      autoAssignThreshold: (data.autoAssignThreshold as number) ?? 30,
      requiredSpecializations: (data.requiredSpecializations as string[]) ?? [],
      isArchived: false,
      isSystem: (data.isSystem as boolean) ?? false,
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(eq(entityTypeDefinitions.id, id))
    return this.rowToEntityType(created)
  }

  async updateEntityType(
    id: string,
    data: Record<string, unknown>,
  ): Promise<EntityTypeDefinition> {
    const [existing] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(eq(entityTypeDefinitions.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Entity type not found')
    }

    // Assign IDs to new fields
    if (data.fields && Array.isArray(data.fields)) {
      data.fields = (data.fields as EntityFieldDefinition[]).map((f) => ({
        ...f,
        id: f.id || crypto.randomUUID(),
      }))
    }

    const now = new Date()
    const updates: Record<string, unknown> = { updatedAt: now }

    // Map through all possible update fields
    const fieldMap: Record<string, string> = {
      name: 'name',
      label: 'label',
      labelPlural: 'labelPlural',
      description: 'description',
      icon: 'icon',
      color: 'color',
      category: 'category',
      fields: 'fields',
      statuses: 'statuses',
      defaultStatus: 'defaultStatus',
      closedStatuses: 'closedStatuses',
      severities: 'severities',
      defaultSeverity: 'defaultSeverity',
      categories: 'categories',
      contactRoles: 'contactRoles',
      numberPrefix: 'numberPrefix',
      numberingEnabled: 'numberingEnabled',
      defaultAccessLevel: 'defaultAccessLevel',
      piiFields: 'piiFields',
      allowSubRecords: 'allowSubRecords',
      allowFileAttachments: 'allowFileAttachments',
      allowInteractionLinks: 'allowInteractionLinks',
      showInNavigation: 'showInNavigation',
      showInDashboard: 'showInDashboard',
      accessRoles: 'accessRoles',
      editRoles: 'editRoles',
      autoAssign: 'autoAssign',
      autoAssignThreshold: 'autoAssignThreshold',
      requiredSpecializations: 'requiredSpecializations',
      isArchived: 'isArchived',
      isSystem: 'isSystem',
      templateId: 'templateId',
      templateVersion: 'templateVersion',
    }

    for (const [dataKey, dbKey] of Object.entries(fieldMap)) {
      if (data[dataKey] !== undefined) {
        updates[dbKey] = data[dataKey]
      }
    }

    await this.db
      .update(entityTypeDefinitions)
      .set(updates)
      .where(eq(entityTypeDefinitions.id, id))

    const [updated] = await this.db
      .select()
      .from(entityTypeDefinitions)
      .where(eq(entityTypeDefinitions.id, id))
    return this.rowToEntityType(updated)
  }

  async bulkSetEntityTypes(data: {
    entityTypes: EntityTypeDefinition[]
    hubId?: string
  }): Promise<{ entityTypes: EntityTypeDefinition[] }> {
    await this.db.transaction(async (tx) => {
      if (data.hubId !== undefined) {
        await tx.delete(entityTypeDefinitions).where(eq(entityTypeDefinitions.hubId, data.hubId))
      } else {
        await tx.delete(entityTypeDefinitions)
      }
      for (const et of data.entityTypes) {
        const now = new Date()
        await tx.insert(entityTypeDefinitions).values({
          id: et.id,
          hubId: et.hubId ?? '',
          name: et.name,
          label: et.label,
          labelPlural: et.labelPlural ?? '',
          description: et.description ?? '',
          icon: et.icon,
          color: et.color,
          category: et.category ?? 'case',
          templateId: et.templateId,
          templateVersion: et.templateVersion,
          fields: et.fields ?? [],
          statuses: et.statuses ?? [],
          defaultStatus: et.defaultStatus ?? '',
          closedStatuses: et.closedStatuses ?? [],
          severities: et.severities,
          defaultSeverity: et.defaultSeverity,
          categories: et.categories,
          contactRoles: et.contactRoles,
          numberPrefix: et.numberPrefix,
          numberingEnabled: et.numberingEnabled ?? false,
          defaultAccessLevel: et.defaultAccessLevel ?? 'assigned',
          piiFields: et.piiFields ?? [],
          allowSubRecords: et.allowSubRecords ?? false,
          allowFileAttachments: et.allowFileAttachments ?? true,
          allowInteractionLinks: et.allowInteractionLinks ?? true,
          showInNavigation: et.showInNavigation ?? true,
          showInDashboard: et.showInDashboard ?? true,
          accessRoles: et.accessRoles,
          editRoles: et.editRoles,
          isArchived: et.isArchived ?? false,
          isSystem: et.isSystem ?? false,
          createdAt: et.createdAt ? new Date(et.createdAt) : now,
          updatedAt: et.updatedAt ? new Date(et.updatedAt) : now,
        })
      }
    })
    return { entityTypes: data.entityTypes }
  }

  async deleteEntityType(id: string): Promise<{ deleted: true }> {
    const result = await this.db
      .delete(entityTypeDefinitions)
      .where(eq(entityTypeDefinitions.id, id))
      .returning()
    if (result.length === 0) {
      throw new ServiceError(404, 'Entity type not found')
    }
    return { deleted: true }
  }

  // =========================================================================
  // Relationship Types
  // =========================================================================

  async getRelationshipTypes(hubId?: string): Promise<{
    relationshipTypes: RelationshipTypeDefinition[]
  }> {
    const rows = hubId !== undefined
      ? await this.db.select().from(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.hubId, hubId))
      : await this.db.select().from(relationshipTypeDefinitions)
    return {
      relationshipTypes: rows.map((r) => this.rowToRelationshipType(r)),
    }
  }

  async createRelationshipType(
    data: Record<string, unknown>,
  ): Promise<RelationshipTypeDefinition> {
    const hubId = (data.hubId as string) ?? ''
    const count = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(relationshipTypeDefinitions)
      .where(eq(relationshipTypeDefinitions.hubId, hubId))
    if (Number(count[0].count) >= MAX_RELATIONSHIP_TYPES) {
      throw new ServiceError(
        400,
        `Maximum of ${MAX_RELATIONSHIP_TYPES} relationship types allowed`,
      )
    }

    const now = new Date()
    const id = crypto.randomUUID()

    await this.db.insert(relationshipTypeDefinitions).values({
      id,
      hubId: (data.hubId as string) ?? '',
      sourceEntityTypeId: data.sourceEntityTypeId as string | undefined,
      targetEntityTypeId: data.targetEntityTypeId as string | undefined,
      cardinality: (data.cardinality as string) ?? 'M:N',
      label: data.label as string,
      reverseLabel: (data.reverseLabel as string) ?? '',
      sourceLabel: (data.sourceLabel as string) ?? '',
      targetLabel: (data.targetLabel as string) ?? '',
      roles: data.roles as unknown,
      defaultRole: data.defaultRole as string | undefined,
      joinFields: data.joinFields as unknown,
      cascadeDelete: (data.cascadeDelete as boolean) ?? false,
      required: (data.required as boolean) ?? false,
      templateId: data.templateId as string | undefined,
      isSystem: (data.isSystem as boolean) ?? false,
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await this.db
      .select()
      .from(relationshipTypeDefinitions)
      .where(eq(relationshipTypeDefinitions.id, id))
    return this.rowToRelationshipType(created)
  }

  async updateRelationshipType(
    id: string,
    data: Record<string, unknown>,
  ): Promise<RelationshipTypeDefinition> {
    const [existing] = await this.db
      .select()
      .from(relationshipTypeDefinitions)
      .where(eq(relationshipTypeDefinitions.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Relationship type not found')
    }

    const now = new Date()
    const updates: Record<string, unknown> = { updatedAt: now }

    const fieldMap: Record<string, string> = {
      sourceEntityTypeId: 'sourceEntityTypeId',
      targetEntityTypeId: 'targetEntityTypeId',
      cardinality: 'cardinality',
      label: 'label',
      reverseLabel: 'reverseLabel',
      sourceLabel: 'sourceLabel',
      targetLabel: 'targetLabel',
      roles: 'roles',
      defaultRole: 'defaultRole',
      joinFields: 'joinFields',
      cascadeDelete: 'cascadeDelete',
      required: 'required',
      templateId: 'templateId',
      isSystem: 'isSystem',
    }

    for (const [dataKey, dbKey] of Object.entries(fieldMap)) {
      if (data[dataKey] !== undefined) {
        updates[dbKey] = data[dataKey]
      }
    }

    await this.db
      .update(relationshipTypeDefinitions)
      .set(updates)
      .where(eq(relationshipTypeDefinitions.id, id))

    const [updated] = await this.db
      .select()
      .from(relationshipTypeDefinitions)
      .where(eq(relationshipTypeDefinitions.id, id))
    return this.rowToRelationshipType(updated)
  }

  async bulkSetRelationshipTypes(data: {
    relationshipTypes: RelationshipTypeDefinition[]
    hubId?: string
  }): Promise<{ relationshipTypes: RelationshipTypeDefinition[] }> {
    await this.db.transaction(async (tx) => {
      if (data.hubId !== undefined) {
        await tx.delete(relationshipTypeDefinitions).where(eq(relationshipTypeDefinitions.hubId, data.hubId))
      } else {
        await tx.delete(relationshipTypeDefinitions)
      }
      for (const rt of data.relationshipTypes) {
        const now = new Date()
        await tx.insert(relationshipTypeDefinitions).values({
          id: rt.id,
          hubId: rt.hubId ?? '',
          sourceEntityTypeId: rt.sourceEntityTypeId,
          targetEntityTypeId: rt.targetEntityTypeId,
          cardinality: rt.cardinality ?? 'M:N',
          label: rt.label,
          reverseLabel: rt.reverseLabel ?? '',
          sourceLabel: rt.sourceLabel ?? '',
          targetLabel: rt.targetLabel ?? '',
          roles: rt.roles,
          defaultRole: rt.defaultRole,
          joinFields: rt.joinFields,
          cascadeDelete: rt.cascadeDelete ?? false,
          required: rt.required ?? false,
          templateId: rt.templateId,
          isSystem: rt.isSystem ?? false,
          createdAt: rt.createdAt ? new Date(rt.createdAt) : now,
          updatedAt: rt.updatedAt ? new Date(rt.updatedAt) : now,
        })
      }
    })
    return { relationshipTypes: data.relationshipTypes }
  }

  async deleteRelationshipType(id: string): Promise<{ deleted: true }> {
    const result = await this.db
      .delete(relationshipTypeDefinitions)
      .where(eq(relationshipTypeDefinitions.id, id))
      .returning()
    if (result.length === 0) {
      throw new ServiceError(404, 'Relationship type not found')
    }
    return { deleted: true }
  }

  // =========================================================================
  // Case Number Sequence
  // =========================================================================

  async generateCaseNumber(data: {
    prefix: string
    year?: number
    hubId?: string
  }): Promise<{ number: string; sequence: number }> {
    const year = data.year ?? new Date().getFullYear()
    const hubId = data.hubId ?? ''

    // Use upsert with RETURNING to atomically get the next value
    const [result] = await this.db
      .insert(caseNumberSequences)
      .values({ hubId, prefix: data.prefix, year, nextValue: 1 })
      .onConflictDoUpdate({
        target: [caseNumberSequences.hubId, caseNumberSequences.prefix, caseNumberSequences.year],
        set: {
          nextValue: sql`${caseNumberSequences.nextValue} + 1`,
        },
      })
      .returning()

    const sequence = result.nextValue
    return {
      number: `${data.prefix}-${year}-${String(sequence).padStart(4, '0')}`,
      sequence,
    }
  }

  // =========================================================================
  // Applied Templates
  // =========================================================================

  async getAppliedTemplates(): Promise<{
    appliedTemplates: unknown[]
  }> {
    const row = await getSettings(this.db)
    return {
      appliedTemplates: (row.appliedTemplates as unknown[]) ?? [],
    }
  }

  async setAppliedTemplates(data: {
    appliedTemplates: unknown[]
  }): Promise<{ ok: true }> {
    await this.db
      .update(systemSettings)
      .set({ appliedTemplates: data.appliedTemplates })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { ok: true }
  }

  // =========================================================================
  // CMS Report Type Definitions (Epic 343)
  // =========================================================================

  async getCmsReportTypes(hubId?: string): Promise<{
    reportTypes: ReportTypeDefinition[]
  }> {
    const rows = hubId !== undefined
      ? await this.db.select().from(reportTypeDefinitions).where(eq(reportTypeDefinitions.hubId, hubId))
      : await this.db.select().from(reportTypeDefinitions)
    return {
      reportTypes: rows.map((r) => this.rowToReportTypeDefinition(r)),
    }
  }

  async getCmsReportTypeById(
    id: string,
  ): Promise<ReportTypeDefinition> {
    const [row] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(eq(reportTypeDefinitions.id, id))
    if (!row) {
      throw new ServiceError(404, 'Report type not found')
    }
    return this.rowToReportTypeDefinition(row)
  }

  async createCmsReportType(
    data: Record<string, unknown>,
  ): Promise<ReportTypeDefinition> {
    const hubId = (data.hubId as string) ?? ''
    const count = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(reportTypeDefinitions)
      .where(eq(reportTypeDefinitions.hubId, hubId))
    if (Number(count[0].count) >= MAX_ENTITY_TYPES) {
      throw new ServiceError(
        400,
        `Maximum of ${MAX_ENTITY_TYPES} report type definitions allowed`,
      )
    }

    const name = data.name as string
    const [dup] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(
        and(
          eq(reportTypeDefinitions.hubId, hubId),
          eq(reportTypeDefinitions.name, name),
          eq(reportTypeDefinitions.isArchived, false),
        ),
      )
    if (dup) {
      throw new ServiceError(
        409,
        `Report type with name "${name}" already exists`,
      )
    }

    const now = new Date()
    const id = crypto.randomUUID()

    const fields = ((data.fields as ReportFieldDefinition[]) ?? []).map(
      (f) => ({
        ...f,
        id: f.id || crypto.randomUUID(),
      }),
    )

    await this.db.insert(reportTypeDefinitions).values({
      id,
      hubId: (data.hubId as string) ?? '',
      name,
      label: (data.label as string) ?? name,
      labelPlural: (data.labelPlural as string) ?? '',
      description: (data.description as string) ?? '',
      icon: data.icon as string | undefined,
      color: data.color as string | undefined,
      fields,
      statuses: (data.statuses as unknown[]) ?? [],
      defaultStatus: (data.defaultStatus as string) ?? '',
      closedStatuses: (data.closedStatuses as string[]) ?? [],
      allowCaseConversion: (data.allowCaseConversion as boolean) ?? false,
      mobileOptimized: (data.mobileOptimized as boolean) ?? false,
      templateId: data.templateId as string | undefined,
      isArchived: false,
      isSystem: (data.isSystem as boolean) ?? false,
      createdAt: now,
      updatedAt: now,
    })

    const [created] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(eq(reportTypeDefinitions.id, id))
    return this.rowToReportTypeDefinition(created)
  }

  async updateCmsReportType(
    id: string,
    data: Record<string, unknown>,
  ): Promise<ReportTypeDefinition> {
    const [existing] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(eq(reportTypeDefinitions.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Report type not found')
    }

    // Assign IDs to new fields
    if (data.fields && Array.isArray(data.fields)) {
      data.fields = (data.fields as ReportFieldDefinition[]).map((f) => ({
        ...f,
        id: f.id || crypto.randomUUID(),
      }))
    }

    const now = new Date()
    const updates: Record<string, unknown> = { updatedAt: now }

    const fieldMap: Record<string, string> = {
      name: 'name',
      label: 'label',
      labelPlural: 'labelPlural',
      description: 'description',
      icon: 'icon',
      color: 'color',
      fields: 'fields',
      statuses: 'statuses',
      defaultStatus: 'defaultStatus',
      closedStatuses: 'closedStatuses',
      allowCaseConversion: 'allowCaseConversion',
      mobileOptimized: 'mobileOptimized',
      templateId: 'templateId',
      isArchived: 'isArchived',
      isSystem: 'isSystem',
    }

    for (const [dataKey, dbKey] of Object.entries(fieldMap)) {
      if (data[dataKey] !== undefined) {
        updates[dbKey] = data[dataKey]
      }
    }

    await this.db
      .update(reportTypeDefinitions)
      .set(updates)
      .where(eq(reportTypeDefinitions.id, id))

    const [updated] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(eq(reportTypeDefinitions.id, id))
    return this.rowToReportTypeDefinition(updated)
  }

  async bulkSetCmsReportTypes(data: {
    reportTypes: ReportTypeDefinition[]
    hubId?: string
  }): Promise<{ reportTypes: ReportTypeDefinition[] }> {
    await this.db.transaction(async (tx) => {
      if (data.hubId !== undefined) {
        await tx.delete(reportTypeDefinitions).where(eq(reportTypeDefinitions.hubId, data.hubId))
      } else {
        await tx.delete(reportTypeDefinitions)
      }
      for (const rt of data.reportTypes) {
        const now = new Date()
        await tx.insert(reportTypeDefinitions).values({
          id: rt.id,
          hubId: rt.hubId ?? '',
          name: rt.name,
          label: rt.label,
          labelPlural: rt.labelPlural ?? '',
          description: rt.description ?? '',
          icon: rt.icon,
          color: rt.color,
          fields: rt.fields ?? [],
          statuses: rt.statuses ?? [],
          defaultStatus: rt.defaultStatus ?? '',
          closedStatuses: rt.closedStatuses ?? [],
          allowCaseConversion: rt.allowCaseConversion ?? false,
          mobileOptimized: rt.mobileOptimized ?? false,
          templateId: rt.templateId,
          isArchived: rt.isArchived ?? false,
          isSystem: rt.isSystem ?? false,
          createdAt: rt.createdAt ? new Date(rt.createdAt) : now,
          updatedAt: rt.updatedAt ? new Date(rt.updatedAt) : now,
        })
      }
    })
    return { reportTypes: data.reportTypes }
  }

  async deleteCmsReportType(
    id: string,
  ): Promise<{ archived: true; id: string }> {
    const [existing] = await this.db
      .select()
      .from(reportTypeDefinitions)
      .where(eq(reportTypeDefinitions.id, id))
    if (!existing) {
      throw new ServiceError(404, 'Report type not found')
    }

    // Soft delete: mark as archived
    await this.db
      .update(reportTypeDefinitions)
      .set({
        isArchived: true,
        updatedAt: new Date(),
      })
      .where(eq(reportTypeDefinitions.id, id))

    return { archived: true, id }
  }

  // =========================================================================
  // Periodic Cleanup (replaces DO alarm)
  // =========================================================================

  /**
   * Run periodic cleanup of expired rate limits and captchas.
   * Called by the task scheduler instead of DO alarms.
   */
  async runCleanup(): Promise<CleanupMetrics> {
    log.info('Starting periodic cleanup')

    const cb = getCircuitBreaker({
      name: 'settings-cleanup',
      failureThreshold: 5,
      resetTimeoutMs: 5 * 60 * 1000, // 5 minutes
      onStateChange: (_name, _from, to) => {
        if (to === 'open') {
          log.error(
            'CRITICAL: Settings cleanup circuit opened — persistent cleanup failures detected',
            new Error('Circuit opened: settings-cleanup'),
          )
        } else if (to === 'closed') {
          log.info('Settings cleanup circuit recovered')
        }
      },
    })

    try {
      return await cb.execute(() =>
        withRetry(
          async () => {
            const row = await getSettings(this.db)
            const overrides = (row.ttlOverrides as TTLOverrides) ?? {}
            const metrics =
              (row.cleanupMetrics as CleanupMetrics) ?? emptyCleanupMetrics()
            const now = Date.now()

            // Clean up expired rate limit entries
            const rateLimitTTL = resolveTTL('rateLimit', overrides)
            const allRateLimits = await this.db.select().from(rateLimits)
            for (const rl of allRateLimits) {
              const timestamps = rl.timestamps as number[]
              const recent = timestamps.filter((t) => now - t < rateLimitTTL)
              if (recent.length === 0) {
                await this.db
                  .delete(rateLimits)
                  .where(eq(rateLimits.key, rl.key))
                metrics.rateLimitEntriesDeleted++
              } else {
                await this.db
                  .update(rateLimits)
                  .set({ timestamps: recent })
                  .where(eq(rateLimits.key, rl.key))
              }
            }

            // Clean up expired CAPTCHA challenges
            const captchaTTL = resolveTTL('captchaChallenge', overrides)
            const cutoff = new Date(now - captchaTTL)
            const deleted = await this.db
              .delete(captchas)
              .where(lt(captchas.createdAt, cutoff))
              .returning()
            metrics.captchaChallengesDeleted += deleted.length

            metrics.lastCleanupAt = new Date().toISOString()
            await this.db
              .update(systemSettings)
              .set({ cleanupMetrics: metrics })
              .where(eq(systemSettings.id, SINGLETON_ID))

            log.info('Periodic cleanup complete', {
              rateLimitEntriesDeleted: metrics.rateLimitEntriesDeleted,
              captchaChallengesDeleted: metrics.captchaChallengesDeleted,
            })
            return metrics
          },
          {
            maxAttempts: 3,
            baseDelayMs: 1_000,
            maxDelayMs: 10_000,
            isRetryable: isRetryableDbError,
            onRetry: (attempt, error) => {
              log.warn('Settings cleanup attempt failed, retrying', {
                attempt,
                error: error instanceof Error ? error.message : String(error),
              })
            },
          },
        ),
      )
    } catch (err) {
      log.error('Settings cleanup failed', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  // =========================================================================
  // Test Reset (demo/development only)
  // =========================================================================

  /** Clear rate limit counters — used in BDD tests to prevent cross-scenario bleed.
   *  If prefix is provided, only clears keys starting with that prefix. */
  async clearRateLimits(prefix?: string): Promise<void> {
    if (prefix) {
      await this.db.delete(rateLimits).where(sql`${rateLimits.key} LIKE ${prefix + '%'}`)
    } else {
      await this.db.delete(rateLimits)
    }
  }

  async reset(env: {
    DEMO_MODE?: string
    DEMO_MODE_CONFIRM?: string
    ENVIRONMENT?: string
  }): Promise<{ ok: true }> {
    const isDemoMode = env.DEMO_MODE === 'true'
    const isDev = env.ENVIRONMENT === 'development'
    if (!isDemoMode && !isDev) {
      throw new ServiceError(403, 'Reset not allowed outside demo/development mode')
    }
    // When resetting via DEMO_MODE (not a development env), require explicit two-factor confirmation.
    if (isDemoMode && !isDev && env.DEMO_MODE_CONFIRM !== 'DESTROY_ALL_DATA') {
      throw new ServiceError(
        403,
        'DEMO_MODE reset requires DEMO_MODE_CONFIRM=DESTROY_ALL_DATA',
      )
    }

    await this.db.transaction(async (tx) => {
      // Clear all settings tables
      await tx.delete(customFieldDefinitions)
      await tx.delete(entityTypeDefinitions)
      await tx.delete(relationshipTypeDefinitions)
      await tx.delete(reportTypeDefinitions)
      await tx.delete(ivrAudio)
      await tx.delete(rateLimits)
      await tx.delete(captchas)
      await tx.delete(caseNumberSequences)
      await tx.delete(hubKeys)
      await tx.delete(hubSettingsTable)
      await tx.delete(hubsTable)
      await tx.delete(rolesTable)
      await tx.delete(systemSettings)
    })

    // Invalidate roles cache so concurrent requests don't see stale empty roles
    // between the delete above and the ensureInit re-seed below.
    invalidateRolesCache()

    this.initializedModes.clear()
    await this.ensureInit(env)

    // Invalidate again after re-seeding: a concurrent request may have cached
    // the empty roles table between the delete and ensureInit.
    invalidateRolesCache()

    return { ok: true }
  }

  // =========================================================================
  // Private helpers — row → domain type mappers
  // =========================================================================

  private rowToEntityType(
    r: typeof entityTypeDefinitions.$inferSelect,
  ): EntityTypeDefinition {
    return {
      id: r.id,
      hubId: r.hubId,
      name: r.name,
      label: r.label,
      labelPlural: r.labelPlural,
      description: r.description,
      icon: r.icon ?? undefined,
      color: r.color ?? undefined,
      category: r.category as EntityTypeDefinition['category'],
      templateId: r.templateId ?? undefined,
      templateVersion: r.templateVersion ?? undefined,
      fields: (r.fields as EntityFieldDefinition[]) ?? [],
      statuses: (r.statuses as EntityTypeDefinition['statuses']) ?? [],
      defaultStatus: r.defaultStatus,
      closedStatuses: r.closedStatuses ?? [],
      severities: r.severities as EntityTypeDefinition['severities'],
      defaultSeverity: r.defaultSeverity ?? undefined,
      categories: r.categories as EntityTypeDefinition['categories'],
      contactRoles: r.contactRoles as EntityTypeDefinition['contactRoles'],
      numberPrefix: r.numberPrefix ?? undefined,
      numberingEnabled: r.numberingEnabled ?? false,
      defaultAccessLevel:
        (r.defaultAccessLevel as EntityTypeDefinition['defaultAccessLevel']) ??
        'assigned',
      piiFields: r.piiFields ?? [],
      allowSubRecords: r.allowSubRecords ?? false,
      allowFileAttachments: r.allowFileAttachments ?? true,
      allowInteractionLinks: r.allowInteractionLinks ?? true,
      showInNavigation: r.showInNavigation ?? true,
      showInDashboard: r.showInDashboard ?? true,
      accessRoles: r.accessRoles ?? undefined,
      editRoles: r.editRoles ?? undefined,
      autoAssign: r.autoAssign ?? false,
      autoAssignThreshold: r.autoAssignThreshold ?? 30,
      requiredSpecializations: r.requiredSpecializations ?? [],
      isArchived: r.isArchived ?? false,
      isSystem: r.isSystem ?? false,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    } as EntityTypeDefinition
  }

  private rowToRelationshipType(
    r: typeof relationshipTypeDefinitions.$inferSelect,
  ): RelationshipTypeDefinition {
    return {
      id: r.id,
      hubId: r.hubId,
      sourceEntityTypeId: r.sourceEntityTypeId ?? undefined,
      targetEntityTypeId: r.targetEntityTypeId ?? undefined,
      cardinality:
        (r.cardinality as RelationshipTypeDefinition['cardinality']) ?? 'M:N',
      label: r.label,
      reverseLabel: r.reverseLabel,
      sourceLabel: r.sourceLabel,
      targetLabel: r.targetLabel,
      roles: r.roles as RelationshipTypeDefinition['roles'],
      defaultRole: r.defaultRole ?? undefined,
      joinFields: r.joinFields as RelationshipTypeDefinition['joinFields'],
      cascadeDelete: r.cascadeDelete ?? false,
      required: r.required ?? false,
      templateId: r.templateId ?? undefined,
      isSystem: r.isSystem ?? false,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    } as RelationshipTypeDefinition
  }

  // =========================================================================
  // Geocoding Config
  // =========================================================================

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

  private rowToReportTypeDefinition(
    r: typeof reportTypeDefinitions.$inferSelect,
  ): ReportTypeDefinition {
    return {
      id: r.id,
      hubId: r.hubId,
      name: r.name,
      label: r.label,
      labelPlural: r.labelPlural,
      description: r.description,
      icon: r.icon ?? undefined,
      color: r.color ?? undefined,
      category: 'report',
      fields: (r.fields as ReportFieldDefinition[]) ?? [],
      statuses: (r.statuses as ReportTypeDefinition['statuses']) ?? [],
      defaultStatus: r.defaultStatus,
      closedStatuses: r.closedStatuses ?? [],
      allowCaseConversion: r.allowCaseConversion ?? false,
      mobileOptimized: r.mobileOptimized ?? false,
      templateId: r.templateId ?? undefined,
      isArchived: r.isArchived ?? false,
      isSystem: r.isSystem ?? false,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    } as ReportTypeDefinition
  }

  // ---------------------------------------------------------------------------
  // Platform Settings (EP08)
  // ---------------------------------------------------------------------------

  async getPlatformSettings(): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .select({ platformSettings: systemSettings.platformSettings })
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

    return (row.platformSettings ?? {}) as Record<string, unknown>
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

    await this.db
      .update(systemSettings)
      .set({ platformSettings: merged })
      .where(eq(systemSettings.id, SINGLETON_ID))

    return merged
  }
}
