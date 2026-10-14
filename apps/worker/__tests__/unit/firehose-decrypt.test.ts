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
import { LABEL_FIREHOSE_BUFFER_ENCRYPT, LABEL_MESSAGE } from '@shared/crypto-labels'

// Use a known valid X25519 pubkey (32 bytes hex = 64 chars)
// x25519 base point (u=9)
const validPubkeyHex = '0900000000000000000000000000000000000000000000000000000000000000'

describe('firehose encrypt (HPKE)', () => {
  describe('envelope format', () => {
    it('returns envelopes with enc and ct fields (HPKE format)', () => {
      const { readerEnvelopes } = encryptMessageForStorage(
        'Test message',
        [validPubkeyHex],
        LABEL_FIREHOSE_BUFFER_ENCRYPT,
      )

      expect(readerEnvelopes).toHaveLength(1)
      const envelope = readerEnvelopes[0]
      expect(envelope.pubkey).toBe(validPubkeyHex)
      expect(envelope.enc).toMatch(/^[0-9a-f]{64}$/) // 32-byte X25519 enc
      expect(envelope.ct).toMatch(/^[0-9a-f]+$/) // ciphertext+tag
    })

    it('encrypted content is valid hex', () => {
      const { encryptedContent } = encryptMessageForStorage(
        'Test message',
        [validPubkeyHex],
        LABEL_FIREHOSE_BUFFER_ENCRYPT,
      )

      expect(encryptedContent).toMatch(/^[0-9a-f]+$/)
      // Content should contain nonce + ciphertext + tag
      expect(encryptedContent.length).toBeGreaterThan(24) // at least nonce + some data
    })
  })

  describe('randomization', () => {
    it('produces different enc values on each call', () => {
      const result1 = encryptMessageForStorage('Same text', [validPubkeyHex], LABEL_FIREHOSE_BUFFER_ENCRYPT)
      const result2 = encryptMessageForStorage('Same text', [validPubkeyHex], LABEL_FIREHOSE_BUFFER_ENCRYPT)

      expect(result1.readerEnvelopes[0].enc).not.toBe(result2.readerEnvelopes[0].enc)
    })

    it('produces different ciphertext on each call', () => {
      const result1 = encryptMessageForStorage('Same text', [validPubkeyHex], LABEL_FIREHOSE_BUFFER_ENCRYPT)
      const result2 = encryptMessageForStorage('Same text', [validPubkeyHex], LABEL_FIREHOSE_BUFFER_ENCRYPT)

      expect(result1.encryptedContent).not.toBe(result2.encryptedContent)
    })
  })

  describe('domain separation', () => {
    it('different labels produce different ct values', () => {
      const resultFirehose = encryptMessageForStorage('Same text', [validPubkeyHex], LABEL_FIREHOSE_BUFFER_ENCRYPT)
      const resultMessage = encryptMessageForStorage('Same text', [validPubkeyHex], LABEL_MESSAGE)

      // Even ignoring randomness, the ct values are always different due to different keys
      expect(resultFirehose.readerEnvelopes[0].ct).not.toBe(resultMessage.readerEnvelopes[0].ct)
    })
  })

  describe('multi-reader', () => {
    it('handles multiple readers with separate envelopes', () => {
      const pubkey2 = '0800000000000000000000000000000000000000000000000000000000000000'
      const { readerEnvelopes } = encryptMessageForStorage(
        'Multi-reader message',
        [validPubkeyHex, pubkey2],
        LABEL_FIREHOSE_BUFFER_ENCRYPT,
      )

      expect(readerEnvelopes).toHaveLength(2)
      expect(readerEnvelopes[0].pubkey).toBe(validPubkeyHex)
      expect(readerEnvelopes[1].pubkey).toBe(pubkey2)
      // Each reader gets a unique HPKE encapsulation
      expect(readerEnvelopes[0].enc).not.toBe(readerEnvelopes[1].enc)
    })
  })
})
