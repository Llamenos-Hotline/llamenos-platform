/**
 * A stand-in for IvrSpeechService.urlBuilder() in adapter tests: the URL names
 * what would be spoken, so a test can assert what the caller hears.
 */
import type { SpeechUrlBuilder } from '@worker/telephony/adapter'

const SCHEME = 'speech://'
const DIGIT_SCHEME = 'speech-captcha-digit://'

export const fakeSpeech: SpeechUrlBuilder = Object.assign(
  (text: string, locale: string) => `${SCHEME}${locale}/${encodeURIComponent(text)}`,
  { captchaDigit: (digit: string, locale: string) => `${DIGIT_SCHEME}${locale}/${digit}` },
)

/**
 * What a fakeSpeech URL speaks, or null for any other URL (an operator's
 * upload). A CAPTCHA digit comes back as `digit`, so a test can tell it went
 * through the builder that keeps the answer out of the URL.
 */
export function spoken(
  url: string,
): { locale: string; text: string; digit?: never } | { locale: string; digit: string; text?: never } | null {
  if (url.startsWith(DIGIT_SCHEME)) {
    const [locale, digit] = url.slice(DIGIT_SCHEME.length).split('/')
    return { locale, digit }
  }
  if (!url.startsWith(SCHEME)) return null
  const [locale, ...rest] = url.slice(SCHEME.length).split('/')
  return { locale, text: decodeURIComponent(rest.join('/')) }
}
