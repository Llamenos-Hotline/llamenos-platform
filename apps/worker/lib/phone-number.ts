import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min'

/**
 * Telephone-number normalisation — the single place a dialled or declared number
 * becomes the E.164 form the `hub_numbers` table stores (#1331).
 *
 * Inbound routing is an exact match on that stored form, so two spellings of one
 * number must never reach it. Carriers disagree: a SIP trunk's Request-URI user
 * part is `+15551234567`, `15551234567`, `0015551234567` or a national
 * `(555) 123-4567` depending on the carrier. Normalising on the way in (the
 * webhook lookup) and on the way out (every declaration) is what makes the
 * match hold whichever the carrier sends.
 */

/** Env var naming the ISO 3166-1 alpha-2 country national-format numbers are read in. */
export const DEFAULT_PHONE_COUNTRY_ENV = 'DEFAULT_PHONE_COUNTRY'

/** A bare E.164 number: `+`, then 7 to 15 digits. */
const E164 = /^\+\d{7,15}$/

/**
 * The deployment's default country for national-format numbers, from
 * `DEFAULT_PHONE_COUNTRY` (e.g. `US`, `GB`). Undefined when unset or not a
 * two-letter code, in which case only numbers carrying their own country code
 * (leading `+` or `00`) can be normalised.
 */
export function configuredDefaultCountry(env: Record<string, string | undefined> = process.env): CountryCode | undefined {
  const raw = env[DEFAULT_PHONE_COUNTRY_ENV]?.trim().toUpperCase()
  return raw && /^[A-Z]{2}$/.test(raw) ? (raw as CountryCode) : undefined
}

/**
 * The E.164 form of `raw`, or null when it cannot be read as a telephone number.
 *
 * A number is "possible", not necessarily "valid": reserved and test ranges
 * (the 555 block) are legitimate DIDs on a private PBX, so validity against the
 * public numbering plan is not a requirement for routing.
 */
export function normalizeE164(raw: string, defaultCountry: CountryCode | undefined = configuredDefaultCountry()): string | null {
  // Keep a leading '+' and the digits; drop every separator a carrier or an
  // operator may type (spaces, dashes, dots, brackets).
  const trimmed = raw.trim()
  if (!trimmed) return null
  const hasPlus = trimmed.startsWith('+')
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  // `+` and the `00` international call prefix both mean "country code follows".
  const international = hasPlus ? `+${digits}` : digits.startsWith('00') ? `+${digits.slice(2)}` : null
  if (international) return E164.test(international) ? international : null

  const parsed = parsePhoneNumberFromString(digits, defaultCountry)
  if (!parsed?.isPossible()) return null
  return E164.test(parsed.number) ? parsed.number : null
}
