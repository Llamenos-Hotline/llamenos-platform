import {
  eq,
  and,
  sql,
  inArray,
} from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings, ivrAudio, users } from '../db/schema'
import { isHubMember } from '../lib/hub-membership'
import type { IvrLanguageSettings } from '@protocol/schemas/settings'
import { IVR_LANGUAGES, IVR_MENU_MAX_LANGUAGES, LANGUAGE_CODES } from '@shared/languages'
import type { IvrVoiceCatalog } from '../telephony/ivr-menu'
import { getIvrVoiceCatalogForProvider } from '../telephony/ivr-voice-catalogs'
import { speechLanguageFor } from './ivr-speech/voices'
import { ServiceError } from './service-error'
import { SINGLETON_ID, getSettings } from './system-settings-row'
import type { HubSettingsService } from './hub-settings'
import type { ProviderConfigService } from './provider-config'

/**
 * Outcome of resolving the IVR voice catalog for a hub. Three distinct states:
 * nothing configured yet (no constraint can be applied), a catalog resolved
 * (constraint applies), or a provider configured whose catalog we do not hold
 * (speakability unknown — must be refused, never silently permitted).
 */
export type IvrCatalogResolution =
  | { state: 'unconfigured' }
  | { state: 'resolved'; catalog: IvrVoiceCatalog<unknown> }
  | { state: 'unsupported'; providerType: string }

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
  // #1505: the caller-facing "this call will be recorded" disclosure. Uploadable
  // like any other prompt so a hub can record the legal notice in a human voice
  // rather than relying on generated speech; falls back to TTS when not uploaded.
  'recordingNotice',
  'pleaseHold',
  'waitMessage',
  'rateLimited',
  'captchaPrompt',
] as const

const MAX_AUDIO_SIZE = 1_048_576

 // 1 MB

/** `ivr_audio.hub_id` of a platform default recording (db/schema/settings.ts) */
const PLATFORM_IVR_SCOPE = ''

const ivrAudioScope = (hubId: string | undefined): string => hubId || PLATFORM_IVR_SCOPE

/**
 * IVR configuration: the enabled IVR languages and the uploaded IVR audio prompts (`ivr_audio`).
 */
export class IvrSettingsService {
  constructor(
    protected db: Database,
    private readonly hubSettings: HubSettingsService,
    private readonly providerConfig: ProviderConfigService,
  ) {}

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
   * The IVR language settings screen's view: the enabled list plus how many of
   * those languages nobody in the hub speaks. A COUNT only — the distinct set of
   * spoken languages is computed in SQL and never leaves this method, so the
   * response cannot be used to learn who speaks what.
   *
   * Kept apart from `getIvrLanguages`, which runs on every inbound call and has
   * no use for a roster query.
   */
  async getIvrLanguageSettings(hubId?: string): Promise<IvrLanguageSettings> {
    const { enabledLanguages } = await this.getIvrLanguages(hubId)
    const spoken = await this.db
      .selectDistinct({ code: sql<string>`unnest(${users.spokenLanguages})` })
      .from(users)
      .where(and(eq(users.active, true), eq(users.status, 'active'), hubId ? isHubMember(hubId) : undefined))
    const covered = new Set(spoken.map((row) => row.code))
    return {
      enabledLanguages,
      uncoveredLanguageCount: enabledLanguages.filter((code) => !covered.has(code)).length,
    }
  }

  /**
   * Get the ordered IVR language list for a hub, with cascade fallback:
   * hub_settings.ivrLanguages → system_settings.ivr_languages → IVR_LANGUAGES constant
   */
  async getHubIvrLanguages(hubId: string): Promise<string[]> {
    const hubSettings = await this.hubSettings.getHubSettings(hubId)
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
  async resolveIvrVoiceCatalog(hubId?: string): Promise<IvrCatalogResolution> {
    const hubConfig = hubId ? await this.providerConfig.getHubTelephonyProvider(hubId) : null
    const config = hubConfig ?? (await this.providerConfig.getTelephonyProvider())
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
    // The keypad has ten digits. A language beyond the tenth would get no digit
    // from `ivrIndexToDigit` and be dropped from the menu the caller hears, so a
    // longer list is refused here rather than saved and silently truncated.
    if (valid.length > IVR_MENU_MAX_LANGUAGES) {
      throw new ServiceError(
        400,
        `The IVR menu holds at most ${IVR_MENU_MAX_LANGUAGES} languages — other languages are reached by phone-prefix detection`,
      )
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
      await this.hubSettings.updateHubSettings(hubId, { ivrLanguages: valid })
      return { enabledLanguages: valid }
    }
    await this.db
      .update(systemSettings)
      .set({ ivrLanguages: valid })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { enabledLanguages: valid }
  }

  /**
   * The recordings held in ONE scope: a hub's own, or (hubId undefined) the
   * platform defaults. This is what that scope's admin manages, so it never
   * lists another scope's rows. What a call actually plays is
   * {@link resolveIvrAudioList}.
   */
  async getIvrAudioList(hubId: string | undefined): Promise<{
    recordings: Array<{
      promptType: string
      language: string
      size: number
      uploadedAt: string
    }>
  }> {
    const rows = await this.db
      .select()
      .from(ivrAudio)
      .where(eq(ivrAudio.hubId, ivrAudioScope(hubId)))
    return {
      recordings: rows.map((r) => ({
        promptType: r.promptType,
        language: r.language,
        size: r.size,
        uploadedAt: r.uploadedAt.toISOString(),
      })),
    }
  }

  /**
   * The recordings a call in `hubId` plays: the hub's own, and for every prompt
   * it has not recorded the platform default. A hub's recording always wins.
   * With no hub, the platform defaults alone.
   */
  async resolveIvrAudioList(hubId: string | undefined): Promise<{
    recordings: Array<{ promptType: string; language: string }>
  }> {
    const scopes = hubId ? [PLATFORM_IVR_SCOPE, hubId] : [PLATFORM_IVR_SCOPE]
    const rows = await this.db
      .select({ promptType: ivrAudio.promptType, language: ivrAudio.language })
      .from(ivrAudio)
      .where(inArray(ivrAudio.hubId, scopes))
    const unique = new Map<string, { promptType: string; language: string }>()
    for (const r of rows) unique.set(`${r.promptType}:${r.language}`, r)
    return { recordings: [...unique.values()] }
  }

  async uploadIvrAudio(
    hubId: string | undefined,
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
        hubId: ivrAudioScope(hubId),
        promptType,
        language,
        audio: audioBase64,
        size,
        uploadedAt: now,
      })
      .onConflictDoUpdate({
        target: [ivrAudio.hubId, ivrAudio.promptType, ivrAudio.language],
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

  /**
   * One scope's own recording, exactly: the operator listening back to what
   * they uploaded must never be handed another scope's audio.
   */
  async getIvrAudio(
    hubId: string | undefined,
    promptType: string,
    language: string,
  ): Promise<{ audio: string; size: number } | null> {
    const [row] = await this.db
      .select()
      .from(ivrAudio)
      .where(
        and(
          eq(ivrAudio.hubId, ivrAudioScope(hubId)),
          eq(ivrAudio.promptType, promptType),
          eq(ivrAudio.language, language),
        ),
      )
    if (!row) return null
    return { audio: row.audio, size: row.size }
  }

  /**
   * The recording a caller in `hubId` hears: the hub's own, else the platform
   * default. Resolved when the provider fetches, not only when the URL was
   * minted, so a hub that deletes its recording mid-day falls back to the
   * default rather than to a 404 and silence on the line.
   */
  async getEffectiveIvrAudio(
    hubId: string | undefined,
    promptType: string,
    language: string,
  ): Promise<{ audio: string; size: number } | null> {
    const own = hubId ? await this.getIvrAudio(hubId, promptType, language) : null
    return own ?? this.getIvrAudio(undefined, promptType, language)
  }

  async deleteIvrAudio(
    hubId: string | undefined,
    promptType: string,
    language: string,
  ): Promise<{ ok: true }> {
    await this.db
      .delete(ivrAudio)
      .where(
        and(
          eq(ivrAudio.hubId, ivrAudioScope(hubId)),
          eq(ivrAudio.promptType, promptType),
          eq(ivrAudio.language, language),
        ),
      )
    return { ok: true }
  }
}
