/**
 * Which locales generated IVR speech can speak, and what a caller whose
 * locale it cannot speak hears instead.
 *
 * The self-hosted PBXs (Asterisk, FreeSWITCH) have no speech engine the app
 * can rely on, so their prompts are synthesised by the worker (IvrSpeechService)
 * with espeak-ng — offline, in the app image. A voice is listed only if it
 * exists in the espeak-ng the image installs (see the Dockerfile), reads the
 * locale's own script, and is intelligible over a phone line.
 *
 * Intelligibility was measured (#1347) by ASR over the 8 kHz G.711 channel
 * (Whisper large-v3, calibrated against human speech through the same
 * channel): es, en, ko, pt near-perfect; fr, de, ru, tr, vi, zh, uk, fa, hi
 * robotic but understood. ht was measured without a human baseline.
 *
 * A language is spoken only once it is known to be understood: a caller in
 * crisis who picks their language and hears noise shaped like speech takes it
 * as "this line is not for me". Unmeasured and failed languages fall back
 * (SPEECH_FALLBACK_LANGUAGE) until measured (#1355).
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
]

/**
 * What a caller hears when no offline engine has a voice for their language
 * and the operator has uploaded no recording for it: the prompts in the
 * language they are most likely to understand. No offline engine is known to speak these
 * locales intelligibly; reading their text with another language's voice
 * produces sounds, not words.
 *
 * - Tagalog → English: an official language of the Philippines.
 * - Mixtec → Spanish: Mixtec communities, in Mexico and the US, are served in Spanish.
 * - Somali → English: no second language is shared widely enough to be better.
 * - Arabic → English: espeak-ng has a voice, but Arabic text carries no
 *   vowels and it cannot restore them — measured unintelligible, even after
 *   automatic diacritisation. Arabic speakers need an upload or a neural voice.
 *
 * UNVERIFIED — espeak-ng has a voice, but no ASR model judges these languages
 * validly, and its Burmese output was judged garbled on inspection. They fall
 * back until someone who speaks them has listened (#1355); the espeak-ng
 * voices are am, my, ku (Kurmanji, matching our Latin-script `ku` locale) and quc.
 * - Amharic, Burmese, Kurdish → English.
 * - K'iche' → Spanish: K'iche' communities, in Guatemala and the US, are served in Spanish.
 *
 * Every shipped locale must be voiced or listed here (ivr-speech tests).
 */
export const SPEECH_FALLBACK_LANGUAGE: Readonly<Record<string, string>> = {
  tl: DEFAULT_LANGUAGE,
  so: DEFAULT_LANGUAGE,
  mix: 'es',
  ar: DEFAULT_LANGUAGE,
  am: DEFAULT_LANGUAGE,
  my: DEFAULT_LANGUAGE,
  ku: DEFAULT_LANGUAGE,
  quc: 'es',
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
