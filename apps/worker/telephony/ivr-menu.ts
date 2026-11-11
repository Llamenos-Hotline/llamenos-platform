/**
 * IVR language menu — one deterministic construction shared by every adapter (#657).
 *
 * A caller dialling in hears "for <language>, press <digit>" for a set of
 * languages. Every option announced must be one the active provider can
 * actually speak, and the digit for a language must never move just because a
 * voice was added, removed, or the hub switched providers — repeat callers
 * learn the digits.
 *
 * Rules enforced here:
 *
 * 1. **Explicit voices, never inferred.** Each provider declares an
 *    {@link IvrVoiceCatalog}: an ordered list of `[localeCode, voice]` pairs.
 *    A locale is speakable if and only if its exact code has an entry. There is
 *    no prefix matching, no tag negotiation (`pt` ↔ `pt-BR`), and no
 *    substituting a "closest" language (Kreyòl read by a French voice).
 *
 * 2. **Stable digits.** A language's digit is derived from its position in the
 *    hub's ordered IVR language list (`ivrIndexToDigit(index)`), which is also
 *    exactly how the `/language-selected` route resolves the pressed digit
 *    (`languageFromDigit(digit, hubLanguages)`). Languages the provider cannot
 *    speak are omitted from the announcement but do not renumber the others.
 *    Positions past the last keypad digit (index ≥ 10) cannot be resolved by
 *    the route, so they are never offered.
 *
 * 3. **Empty intersection is defined.** If exactly one hub language is
 *    offerable, the menu is skipped and that language is forced. If none is,
 *    the menu is skipped and {@link DEFAULT_LANGUAGE} is forced when the
 *    provider speaks it; otherwise the first language in the provider's
 *    declared order is forced; a provider with an empty catalog is a
 *    programming error and throws.
 */
import { DEFAULT_LANGUAGE, LANGUAGE_CODES, ivrIndexToDigit } from '@shared/languages'
import { IVR_PROMPTS, resolveIvrPrompt } from '@shared/voice-prompts'

/** An explicit, ordered locale-code → provider-voice mapping for one provider. */
export class IvrVoiceCatalog<Voice> {
  /** Locale codes this provider can speak, in declared order. */
  readonly languages: readonly string[]
  private readonly voices: ReadonlyMap<string, Voice>

  constructor(readonly provider: string, entries: ReadonlyArray<readonly [code: string, voice: Voice]>) {
    if (entries.length === 0) {
      throw new Error(`IvrVoiceCatalog(${provider}): a provider must declare at least one voice`)
    }
    const voices = new Map<string, Voice>()
    for (const [code, voice] of entries) {
      if (!LANGUAGE_CODES.includes(code)) {
        throw new Error(`IvrVoiceCatalog(${provider}): '${code}' is not a shipped locale code`)
      }
      if (voices.has(code)) {
        throw new Error(`IvrVoiceCatalog(${provider}): duplicate voice entry for '${code}'`)
      }
      voices.set(code, voice)
    }
    this.voices = voices
    this.languages = entries.map(([code]) => code)
  }

  /** Exact-code lookup. `undefined` means the provider has no voice for this locale. */
  voiceFor(code: string): Voice | undefined {
    return this.voices.get(code)
  }

  speaks(code: string): boolean {
    return this.voices.has(code)
  }

  /**
   * Voice for non-menu prompts (greeting, captcha, voicemail) once a caller
   * language is already fixed. Unknown codes use the default-language voice.
   */
  voiceForPrompt(code: string): Voice {
    const voice = this.voices.get(code) ?? this.voices.get(DEFAULT_LANGUAGE) ?? this.voices.get(this.languages[0])
    // Unreachable: the constructor rejects an empty catalog.
    if (voice === undefined) throw new Error(`IvrVoiceCatalog(${this.provider}): no voice available`)
    return voice
  }
}

/** One announced menu entry. */
export interface IvrMenuOption<Voice> {
  language: string
  digit: string
  voice: Voice
  /** The self-announcement with the digit substituted, e.g. "Para español, marque 1." */
  prompt: string
}

export type IvrLanguageMenu<Voice> =
  /** Skip the menu entirely; the call proceeds in this language. */
  | { kind: 'single'; language: string }
  /** Announce these options, in this order, then gather one digit. */
  | { kind: 'menu'; options: ReadonlyArray<IvrMenuOption<Voice>> }

/**
 * Build the IVR language menu for a hub's ordered language list against the
 * active provider's voice catalog. Pure and deterministic.
 */
export function buildIvrLanguageMenu<Voice>(
  hubLanguages: readonly string[],
  catalog: IvrVoiceCatalog<Voice>,
): IvrLanguageMenu<Voice> {
  const options: IvrMenuOption<Voice>[] = []
  hubLanguages.forEach((language, index) => {
    const digit = ivrIndexToDigit(index)
    if (!digit) return
    const voice = catalog.voiceFor(language)
    const selfAnnouncement = IVR_PROMPTS[language]
    if (voice === undefined || !selfAnnouncement) return
    options.push({ language, digit, voice, prompt: resolveIvrPrompt(selfAnnouncement, digit) })
  })

  if (options.length === 1) return { kind: 'single', language: options[0].language }
  if (options.length > 1) return { kind: 'menu', options }

  return { kind: 'single', language: defaultSpeakableLanguage(catalog) }
}

/**
 * The language a call proceeds in when nothing the hub or caller asked for is
 * speakable: {@link DEFAULT_LANGUAGE} when the provider speaks it, otherwise
 * the first language in the provider's declared order. One definition, shared
 * by the menu's empty-intersection rule and {@link resolveCallerLanguage}.
 */
function defaultSpeakableLanguage(catalog: IvrVoiceCatalog<unknown>): string {
  return catalog.speaks(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : catalog.languages[0]
}

/**
 * Resolve the language a caller's call proceeds in against the active
 * provider's voice catalog (#679). Every source of a caller language — the
 * forced language, the phone-prefix guess, the digit the caller pressed —
 * must come through here, because a language the provider has no voice for
 * would be handed to that provider as a code it cannot speak: a caller in
 * distress reaching an IVR that cannot talk to them.
 *
 * `candidates` are tried in priority order and the first the provider can
 * speak wins (`undefined` entries are skipped). When none is speakable the
 * call falls back to the hub's first speakable language, and, if the hub
 * lists none, to the same default the menu forces
 * (see {@link buildIvrLanguageMenu}, rule 3). Exact-code matching only: no
 * `pt` ↔ `pt-BR` negotiation, no "closest" substitute.
 */
export function resolveCallerLanguage(
  candidates: ReadonlyArray<string | undefined>,
  hubLanguages: readonly string[],
  catalog: IvrVoiceCatalog<unknown>,
): string {
  for (const candidate of candidates) {
    if (candidate !== undefined && catalog.speaks(candidate)) return candidate
  }
  return hubLanguages.find((language) => catalog.speaks(language)) ?? defaultSpeakableLanguage(catalog)
}
