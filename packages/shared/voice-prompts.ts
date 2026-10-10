/**
 * Shared voice prompt accessors for all telephony adapters.
 *
 * Translations live in packages/i18n/locales/{lang}.json under the "voice"
 * and "ivr" namespaces. This module builds lookup tables from that data so
 * telephony adapters can continue using the same API (getPrompt, IVR_PROMPTS,
 * etc.) without knowing about the i18n system.
 */
import { getLocaleString } from '@llamenos/i18n'
import { DEFAULT_LANGUAGE, LANGUAGE_CODES } from './languages'

// ---------------------------------------------------------------------------
// Voice prompts — built from locale "voice.*" keys
// ---------------------------------------------------------------------------

const VOICE_PROMPT_KEYS = [
  'greeting',
  'recordingNotice',
  'rateLimited',
  'captchaPrompt',
  'captchaTimeout',
  'pleaseHold',
  'captchaSuccess',
  'captchaFail',
  'captchaRetry',
  'waitMessage',
  'unavailableMessage',
  'voicemailPrompt',
] as const

/** Voice prompts keyed by prompt name then language code. */
export const VOICE_PROMPTS: Record<string, Record<string, string>> = {}

for (const key of VOICE_PROMPT_KEYS) {
  const byLang: Record<string, string> = {}
  for (const lang of LANGUAGE_CODES) {
    const val = getLocaleString(lang, `voice.${key}`)
    if (val) byLang[lang] = val
  }
  VOICE_PROMPTS[key] = byLang
}

// ---------------------------------------------------------------------------
// IVR prompts — built from locale "ivr.*" keys
// ---------------------------------------------------------------------------

/** IVR self-announcement prompts keyed by language code. */
export const IVR_PROMPTS: Record<string, string> = {}

/** "For more languages, press [N]" keyed by language code. */
export const IVR_MORE_PROMPTS: Record<string, string> = {}

/** "To go back, press 0" keyed by language code. */
export const IVR_BACK_PROMPTS: Record<string, string> = {}

for (const lang of LANGUAGE_CODES) {
  const self = getLocaleString(lang, 'ivr.selfAnnouncement')
  if (self) IVR_PROMPTS[lang] = self

  const more = getLocaleString(lang, 'ivr.moreLanguages')
  if (more) IVR_MORE_PROMPTS[lang] = more

  const back = getLocaleString(lang, 'ivr.goBack')
  if (back) IVR_BACK_PROMPTS[lang] = back
}

// ---------------------------------------------------------------------------
// Voicemail thanks — built from locale "voice.voicemailThanks" key
// ---------------------------------------------------------------------------

/** Voicemail "thank you" messages, keyed by language code. */
export const VOICEMAIL_THANKS: Record<string, string> = {}

for (const lang of LANGUAGE_CODES) {
  const val = getLocaleString(lang, 'voice.voicemailThanks')
  if (val) VOICEMAIL_THANKS[lang] = val
}

// ---------------------------------------------------------------------------
// Public accessor functions (unchanged API)
// ---------------------------------------------------------------------------

/** Replace [N] placeholder in an IVR prompt with the actual digit */
export function resolveIvrPrompt(prompt: string, digit: string): string {
  return prompt.replace(/\[N\]/g, digit)
}

/** Get a voice prompt in the given language, falling back to English. */
export function getPrompt(key: string, lang: string): string {
  return VOICE_PROMPTS[key]?.[lang] ?? VOICE_PROMPTS[key]?.[DEFAULT_LANGUAGE] ?? ''
}

/** Get the voicemail thank-you message in the given language, falling back to English. */
export function getVoicemailThanks(lang: string): string {
  return VOICEMAIL_THANKS[lang] ?? VOICEMAIL_THANKS[DEFAULT_LANGUAGE]
}
