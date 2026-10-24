/**
 * #1505 — the caller-facing call-recording disclosure is a legal notice, so it
 * must exist in every language the IVR can speak, not just English. A caller who
 * selected Somali and is then recorded without being told is in exactly the
 * position the notice exists to prevent.
 *
 * `bun run i18n:validate` catches locale drift in general; this pins the one key
 * whose absence is a legal problem rather than a cosmetic one, and pins that it
 * is reachable through the accessor the adapters actually call.
 */
import { describe, it, expect } from 'vitest'
import { LANGUAGE_CODES, DEFAULT_LANGUAGE } from '@shared/languages'
import { getPrompt, VOICE_PROMPTS } from '@shared/voice-prompts'

describe('call recording notice (#1505)', () => {
  it('is defined for every IVR language', () => {
    const missing = LANGUAGE_CODES.filter((lang) => !VOICE_PROMPTS.recordingNotice?.[lang])
    expect(missing, `locales missing voice.recordingNotice: ${missing.join(', ')}`).toEqual([])
  })

  it('covers every language the IVR speaks, with none left on the English fallback', () => {
    const english = getPrompt('recordingNotice', DEFAULT_LANGUAGE)
    expect(english).toBeTruthy()

    // Every non-English locale must have its own text, not silently inherit
    // English via getPrompt's fallback.
    const untranslated = LANGUAGE_CODES.filter(
      (lang) => lang !== DEFAULT_LANGUAGE && getPrompt('recordingNotice', lang) === english,
    )
    expect(untranslated, `locales falling back to English: ${untranslated.join(', ')}`).toEqual([])
  })

  it('is a non-empty string in every language', () => {
    for (const lang of LANGUAGE_CODES) {
      const text = getPrompt('recordingNotice', lang)
      expect(text.trim().length, `${lang} recordingNotice is empty`).toBeGreaterThan(0)
    }
  })
})
