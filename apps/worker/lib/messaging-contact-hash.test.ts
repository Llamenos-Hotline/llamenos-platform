/**
 * The thread hash: HMAC(HKDF(MESSAGING_HASH_KEY, hubId), identifier) (#2182, D2).
 *
 * The construction is pinned against an independent implementation (node:crypto)
 * so a change to the labels, the info string or the message prefix cannot slip
 * through as "still deterministic".
 */
import { describe, it, expect } from 'vitest'
import { createHmac, hkdfSync } from 'node:crypto'
import { HMAC_MESSAGING_CONTACT_PREFIX, LABEL_MESSAGING_CONTACT_HUB_KEY, HMAC_PHONE_PREFIX } from '@shared/crypto-labels'
import {
  messagingContactHash,
  GLOBAL_MESSAGING_SCOPE,
  SUPPRESSION_SCOPE,
  canonicalSubscriberIdentifier,
  subscriberHashes,
  suppressionHashes,
} from './messaging-contact-hash'
import { banHash, hashPhone } from './crypto'

const KEY = 'ab'.repeat(32) // gitleaks:allow
const OTHER_KEY = 'cd'.repeat(32) // gitleaks:allow
const HUB_A = '9f2c1b64-0000-4000-8000-0000000000aa'
const HUB_B = '9f2c1b64-0000-4000-8000-0000000000bb'
const NUMBER = '+15551234567'

function reference(identifier: string, scope: string, key: string): string {
  const scopeKey = Buffer.from(
    hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.alloc(0), `${LABEL_MESSAGING_CONTACT_HUB_KEY}:${scope}`, 32),
  )
  return createHmac('sha256', scopeKey).update(`${HMAC_MESSAGING_CONTACT_PREFIX}${identifier}`).digest('hex')
}

describe('messagingContactHash', () => {
  it('is HMAC(HKDF(key, hubId), identifier) under the registered labels', () => {
    expect(messagingContactHash(NUMBER, HUB_A, KEY)).toBe(reference(NUMBER, HUB_A, KEY))
  })

  it('is deterministic, so a returning contact lands in the same thread', () => {
    expect(messagingContactHash(NUMBER, HUB_A, KEY)).toBe(messagingContactHash(NUMBER, HUB_A, KEY))
    expect(messagingContactHash(NUMBER, HUB_A, KEY)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs per hub: one contact in two hubs has two unrelated hashes', () => {
    expect(messagingContactHash(NUMBER, HUB_A, KEY)).not.toBe(messagingContactHash(NUMBER, HUB_B, KEY))
  })

  it('serves a hub-less webhook from the "global" scope, which no hub id can equal', () => {
    expect(messagingContactHash(NUMBER, undefined, KEY)).toBe(reference(NUMBER, GLOBAL_MESSAGING_SCOPE, KEY))
    expect(messagingContactHash(NUMBER, undefined, KEY)).not.toBe(messagingContactHash(NUMBER, HUB_A, KEY))
  })

  it('differs per identifier and per key', () => {
    expect(messagingContactHash(NUMBER, HUB_A, KEY)).not.toBe(messagingContactHash('+15559876543', HUB_A, KEY))
    expect(messagingContactHash(NUMBER, HUB_A, KEY)).not.toBe(messagingContactHash(NUMBER, HUB_A, OTHER_KEY))
  })

  it('does not answer from the per-hub key cache with a different root key', () => {
    messagingContactHash(NUMBER, HUB_A, KEY) // fills the cache for HUB_A
    expect(messagingContactHash(NUMBER, HUB_A, OTHER_KEY)).toBe(reference(NUMBER, HUB_A, OTHER_KEY))
  })

  it('shares nothing with the ban hash or the old HMAC_SECRET phone hash of the same number', () => {
    const hash = messagingContactHash(NUMBER, HUB_A, KEY)
    expect(hash).not.toBe(banHash(NUMBER, HUB_A, KEY))
    expect(hash).not.toBe(hashPhone(NUMBER, KEY))
  })

  it('has its own message prefix, distinct from the phone and ban prefixes', () => {
    expect(HMAC_MESSAGING_CONTACT_PREFIX).not.toBe(HMAC_PHONE_PREFIX)
    expect(HMAC_MESSAGING_CONTACT_PREFIX.startsWith('llamenos:')).toBe(true)
  })
})

describe('canonicalSubscriberIdentifier', () => {
  it('files a phone number on a phone channel as +digits, however it was written', () => {
    for (const written of ['+15551234567', '15551234567', '+1 (555) 123-4567', 'whatsapp:+15551234567']) {
      expect(canonicalSubscriberIdentifier('whatsapp', written)).toBe(NUMBER)
    }
    expect(canonicalSubscriberIdentifier('sms', '1 555 123 4567')).toBe(NUMBER)
  })

  it('leaves a Signal UUID untouched', () => {
    const uuid = '0b6f2c1e-1111-4222-8333-444455556666'
    expect(canonicalSubscriberIdentifier('signal', uuid)).toBe(uuid)
  })

  it('never turns a Telegram or RCS id into a phone number', () => {
    expect(canonicalSubscriberIdentifier('telegram', '15551234567')).toBe('15551234567')
    expect(canonicalSubscriberIdentifier('rcs', '15551234567')).toBe('15551234567')
  })
})

describe('subscriberHashes', () => {
  const UUID = '0b6f2c1e-1111-4222-8333-444455556666'
  const h = (identifier: string, hub = HUB_A) => messagingContactHash(identifier, hub, KEY)

  it('a Signal sender known by UUID and number is found under either', () => {
    const { identifierHash, lookupHashes } = subscriberHashes('signal', [UUID, NUMBER], HUB_A, KEY)
    expect(identifierHash).toBe(h(UUID))
    expect(lookupHashes).toEqual(expect.arrayContaining([h(UUID), h(NUMBER)]))
  })

  it('a bare-digits sender is found under the imported +number, and files new under it', () => {
    const { identifierHash, lookupHashes } = subscriberHashes('whatsapp', ['15551234567'], HUB_A, KEY)
    expect(identifierHash).toBe(h(NUMBER))
    expect(lookupHashes).toContain(h(NUMBER))
  })

  it('a Telegram id is looked up as itself only', () => {
    expect(subscriberHashes('telegram', ['15551234567'], HUB_A, KEY).lookupHashes).toEqual([h('15551234567')])
  })

  it('stays per hub, so a lookup never crosses hubs', () => {
    const { lookupHashes } = subscriberHashes('signal', [UUID, NUMBER], HUB_A, KEY)
    expect(lookupHashes).not.toContain(h(UUID, HUB_B))
    expect(lookupHashes).not.toContain(h(NUMBER, HUB_B))
  })
})

// The opt-out record (#2286). One person, every shape #2281 covers, one hash per
// canonical identifier — and no hash that equals any thread or subscriber hash.
describe('suppressionHashes', () => {
  const UUID = '0b6f2c1e-1111-4222-8333-444455556666'
  const one = (channel: string, identifier: string) => {
    const hashes = suppressionHashes(channel, [identifier], KEY)
    expect(hashes).toHaveLength(1)
    return hashes[0]!
  }

  it('is HMAC(HKDF(key, "suppression"), canonical identifier) under the registered labels', () => {
    expect(one('sms', NUMBER)).toBe(reference(NUMBER, SUPPRESSION_SCOPE, KEY))
    expect(one('signal', UUID)).toBe(reference(UUID, SUPPRESSION_SCOPE, KEY))
  })

  it.each([
    ['sms', '+15551234567', 'E.164'],
    ['sms', '15551234567', 'bare digits'],
    ['whatsapp', '15551234567', "Meta's bare digits"],
    ['whatsapp', 'whatsapp:+15551234567', "Twilio's channel-native handle"],
    ['whatsapp', '+1 (555) 123-4567', 'an import in loose formatting'],
    ['signal', '+15551234567', "a Signal sender's number"],
  ])('a phone number on %s written as %s (%s) resolves to the one record hash', (channel, written) => {
    expect(one(channel, written)).toBe(reference(NUMBER, SUPPRESSION_SCOPE, KEY))
  })

  it('a Signal UUID has a hash of its own, and a UUID+number STOP files both', () => {
    expect(one('signal', UUID)).not.toBe(one('signal', NUMBER))
    expect(suppressionHashes('signal', [UUID, NUMBER], KEY).sort()).toEqual([one('signal', UUID), one('signal', NUMBER)].sort())
  })

  it('collapses spellings of one number to one hash', () => {
    expect(suppressionHashes('whatsapp', ['15551234567', '+15551234567', 'whatsapp:+15551234567'], KEY)).toHaveLength(1)
  })

  it('never reads a Telegram or RCS id as a phone number', () => {
    expect(one('telegram', '15551234567')).not.toBe(one('sms', '15551234567'))
    expect(one('rcs', '15551234567')).not.toBe(one('sms', '15551234567'))
  })

  it('equals no hub, global-webhook or subscriber hash of the same identifier', () => {
    const hash = one('sms', NUMBER)
    expect(hash).not.toBe(messagingContactHash(NUMBER, HUB_A, KEY))
    expect(hash).not.toBe(messagingContactHash(NUMBER, undefined, KEY))
    expect(subscriberHashes('sms', [NUMBER], HUB_A, KEY).lookupHashes).not.toContain(hash)
    expect(SUPPRESSION_SCOPE).not.toBe(GLOBAL_MESSAGING_SCOPE)
  })
})
