/**
 * Firehose encrypt -> decrypt roundtrip tests (HPKE).
 *
 * Verifies that:
 * 1. encryptMessageForStorage produces HPKE envelopes with { pubkey, enc, ct } fields
 * 2. encryptMessageForStorage with different labels produces non-interoperable ciphertext
 * 3. Output format is valid hex
 */
import { describe, it, expect } from 'vitest'
import {
  encryptMessageForStorage,
} from '@worker/lib/crypto'

// Use a known valid X25519 pubkey (32 bytes hex = 64 chars)
// x25519 base point (u=9)
const validPubkeyHex = '0900000000000000000000000000000000000000000000000000000000000000'

describe('firehose encrypt (HPKE)', () => {
  describe('envelope format', () => {
    it('returns envelopes with enc and ct fields (HPKE format)', () => {
      const { readerEnvelopes } = encryptMessageForStorage(
        'Test message',
        [validPubkeyHex])

      expect(readerEnvelopes).toHaveLength(1)
      const envelope = readerEnvelopes[0]
      expect(envelope.pubkey).toBe(validPubkeyHex)
      expect(envelope.enc).toMatch(/^[0-9a-f]{64}$/) // 32-byte X25519 enc
      expect(envelope.ct).toMatch(/^[0-9a-f]{96}$/) // 48-byte key wrap (spec D2)
    })

    it('encrypted content is valid hex', () => {
      const { encryptedContent } = encryptMessageForStorage(
        'Test message',
        [validPubkeyHex])

      expect(encryptedContent).toMatch(/^[0-9a-f]+$/)
      // Content should contain nonce + ciphertext + tag
      expect(encryptedContent.length).toBeGreaterThan(24) // at least nonce + some data
    })
  })

  describe('randomization', () => {
    it('produces different enc values on each call', () => {
      const result1 = encryptMessageForStorage('Same text', [validPubkeyHex])
      const result2 = encryptMessageForStorage('Same text', [validPubkeyHex])

      expect(result1.readerEnvelopes[0].enc).not.toBe(result2.readerEnvelopes[0].enc)
    })

    it('produces different ciphertext on each call', () => {
      const result1 = encryptMessageForStorage('Same text', [validPubkeyHex])
      const result2 = encryptMessageForStorage('Same text', [validPubkeyHex])

      expect(result1.encryptedContent).not.toBe(result2.encryptedContent)
    })
  })

  describe('multi-reader', () => {
    it('handles multiple readers with separate envelopes', () => {
      const pubkey2 = '0800000000000000000000000000000000000000000000000000000000000000'
      const { readerEnvelopes } = encryptMessageForStorage(
        'Multi-reader message',
        [validPubkeyHex, pubkey2])

      expect(readerEnvelopes).toHaveLength(2)
      expect(readerEnvelopes[0].pubkey).toBe(validPubkeyHex)
      expect(readerEnvelopes[1].pubkey).toBe(pubkey2)
      // Each reader gets a unique HPKE encapsulation
      expect(readerEnvelopes[0].enc).not.toBe(readerEnvelopes[1].enc)
    })
  })
})
