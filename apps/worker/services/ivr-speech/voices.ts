/**
 * Which locales generated IVR speech can speak, and what a caller whose
 * locale it cannot speak hears instead.
 *
 * The self-hosted PBXs (Asterisk, FreeSWITCH) have no speech engine the app
 * can rely on, so their prompts are synthesised by the worker (IvrSpeechService)
 * with espeak-ng — offline, in the app image, 19 of the shipped locales. A
 * voice is listed only after checking it exists in the espeak-ng the image
 * installs (see the Dockerfile) and reads the locale's own script.
 */
import { DEFAULT_LANGUAGE } from '@shared/languages'

/** Shipped locale code → espeak-ng voice. Absent locales have no voice (see SPEECH_FALLBACK_LANGUAGE). */
export const ESPEAK_NG_VOICES: ReadonlyArray<readonly [locale: string, voice: string]> = [
  ['en', 'en-us'],
  // Latin American Spanish: the hotline's Spanish-speaking callers are overwhelmingly from the Americas
  ['es', 'es-419'],
  // Reads Han characters as Mandarin
  ['zh', 'cmn'],
  ['vi', 'vi'],
  ['ar', 'ar'],
  ['fr', 'fr-fr'],
  ['ht', 'ht'],
  ['ko', 'ko'],
  ['ru', 'ru'],
  ['hi', 'hi'],
  ['pt', 'pt-br'],
  ['de', 'de'],
  ['uk', 'uk'],
  ['fa', 'fa'],
  ['tr', 'tr'],
  // Kurmanji, in the Latin script our `ku` locale is written in
  ['ku', 'ku'],
  ['am', 'am'],
  ['my', 'my'],
  ['quc', 'quc'],
]

/**
 * What a caller hears when no offline engine has a voice for their language
 * and the operator has uploaded no recording for it: the prompts in the
 * language they are most likely to understand. Neither espeak-ng nor Piper
 * has a voice for these locales; reading their text with another language's
 * voice produces sounds, not words.
 *
 * - Tagalog → English: an official language of the Philippines.
 * - Mixtec → Spanish: Mixtec communities, in Mexico and the US, are served in Spanish.
 * - Somali → English: no second language is shared widely enough to be better.
 *
 * Every shipped locale must be voiced or listed here (ivr-speech tests).
 */
export const SPEECH_FALLBACK_LANGUAGE: Readonly<Record<string, string>> = {
  tl: DEFAULT_LANGUAGE,
  so: DEFAULT_LANGUAGE,
  mix: 'es',
}

const VOICES: ReadonlyMap<string, string> = new Map(ESPEAK_NG_VOICES)

/** The espeak-ng voice for a locale, or undefined when there is none */
export function espeakVoiceFor(locale: string): string | undefined {
  return VOICES.get(locale)
}

/** Locales generated speech can speak, in declared order */
export const GENERATED_SPEECH_LOCALES: readonly string[] = ESPEAK_NG_VOICES.map(([locale]) => locale)

/**
 * The language a caller's prompts are generated in: their own when it has a
 * voice, else the declared fallback, else the default language.
 */
export function speechLanguageFor(locale: string): string {
  if (VOICES.has(locale)) return locale
  const fallback = SPEECH_FALLBACK_LANGUAGE[locale]
  return fallback && VOICES.has(fallback) ? fallback : DEFAULT_LANGUAGE
}
