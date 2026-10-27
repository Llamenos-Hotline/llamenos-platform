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
import { messagingContactHash, GLOBAL_MESSAGING_SCOPE, canonicalSubscriberIdentifier, subscriberHashes } from './messaging-contact-hash'
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
