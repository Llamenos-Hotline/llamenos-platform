import { describe, it, expect } from 'vitest'
import { contactLabel, matchesContactHash, CONTACT_LABEL_LENGTH } from './contact-label'

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('contactLabel', () => {
  it('is a prefix of the thread hash for a messaging channel', () => {
    expect(contactLabel({ channelType: 'sms', contactIdentifierHash: HASH })).toBe(HASH.slice(0, CONTACT_LABEL_LENGTH))
  })

  it('is absent when the hash was cleared', () => {
    expect(contactLabel({ channelType: 'signal', contactIdentifierHash: '' })).toBeUndefined()
  })

  it('is absent for a web report, whose "hash" is its author key', () => {
    expect(contactLabel({ channelType: 'web', contactIdentifierHash: HASH })).toBeUndefined()
  })
})

describe('matchesContactHash', () => {
  it('matches the start of the hash', () => {
    expect(matchesContactHash({ channelType: 'sms', contactIdentifierHash: HASH }, 'a1b2c3')).toBe(true)
    expect(matchesContactHash({ channelType: 'sms', contactIdentifierHash: HASH }, 'A1B2')).toBe(true)
  })

  it('does not match inside the hash', () => {
    expect(matchesContactHash({ channelType: 'sms', contactIdentifierHash: HASH }, 'b2c3d4')).toBe(false)
  })

  it('never matches a web report or an empty query', () => {
    expect(matchesContactHash({ channelType: 'web', contactIdentifierHash: HASH }, 'a1b2')).toBe(false)
    expect(matchesContactHash({ channelType: 'sms', contactIdentifierHash: HASH }, '')).toBe(false)
  })
})
