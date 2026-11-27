import { describe, expect, it } from 'vitest'
import { configuredDefaultCountry, normalizeE164 } from './phone-number'

describe('normalizeE164', () => {
  it('keeps a number that is already E.164', () => {
    expect(normalizeE164('+15551234567', 'US')).toBe('+15551234567')
    expect(normalizeE164('+15551234567', undefined)).toBe('+15551234567')
  })

  it('reads an E.164 number written with separators', () => {
    expect(normalizeE164('+1 (555) 123-4567', 'US')).toBe('+15551234567')
  })

  it('reads the 00 international prefix without needing a default country', () => {
    expect(normalizeE164('0015551234567', undefined)).toBe('+15551234567')
    expect(normalizeE164('00442071838750', undefined)).toBe('+442071838750')
  })

  it('reads a dialplan extension that dropped the plus (country code first)', () => {
    expect(normalizeE164('15551234567', 'US')).toBe('+15551234567')
    expect(normalizeE164('442071838750', 'GB')).toBe('+442071838750')
  })

  it('reads a national format against the default country', () => {
    expect(normalizeE164('(555) 123-4567', 'US')).toBe('+15551234567')
    expect(normalizeE164('5551234567', 'US')).toBe('+15551234567')
    expect(normalizeE164('020 7183 8750', 'GB')).toBe('+442071838750')
  })

  it('cannot read a national format with no default country', () => {
    expect(normalizeE164('5551234567', undefined)).toBeNull()
  })

  it('refuses what is not a telephone number', () => {
    expect(normalizeE164('', 'US')).toBeNull()
    expect(normalizeE164('   ', 'US')).toBeNull()
    expect(normalizeE164('abc', 'US')).toBeNull()
    expect(normalizeE164('1001', 'US')).toBeNull()
    expect(normalizeE164('+123', 'US')).toBeNull()
    expect(normalizeE164('+1234567890123456', 'US')).toBeNull()
  })

  it('maps different spellings of one number to one value', () => {
    const spellings = ['+15551234567', '15551234567', '0015551234567', '(555) 123-4567', '555-123-4567']
    expect(new Set(spellings.map((s) => normalizeE164(s, 'US'))).size).toBe(1)
  })
})

describe('configuredDefaultCountry', () => {
  it('reads DEFAULT_PHONE_COUNTRY, case-insensitively', () => {
    expect(configuredDefaultCountry({ DEFAULT_PHONE_COUNTRY: 'gb' })).toBe('GB')
  })
  it('is undefined when unset or malformed', () => {
    expect(configuredDefaultCountry({})).toBeUndefined()
    expect(configuredDefaultCountry({ DEFAULT_PHONE_COUNTRY: 'USA' })).toBeUndefined()
  })
})
