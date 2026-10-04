/**
 * A stand-in for IvrSpeechService.urlBuilder() in adapter tests: the URL names
 * what would be spoken, so a test can assert what the caller hears.
 */
import type { SpeechUrlBuilder } from '@worker/telephony/adapter'

const SCHEME = 'speech://'

export const fakeSpeech: SpeechUrlBuilder = (text, locale) => `${SCHEME}${locale}/${encodeURIComponent(text)}`

/** What a fakeSpeech URL speaks, or null for any other URL (an operator's upload) */
export function spoken(url: string): { locale: string; text: string } | null {
  if (!url.startsWith(SCHEME)) return null
  const [locale, ...rest] = url.slice(SCHEME.length).split('/')
  return { locale, text: decodeURIComponent(rest.join('/')) }
}
