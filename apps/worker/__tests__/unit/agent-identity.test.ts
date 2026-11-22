/**
 * Unit tests for apps/worker/lib/agent-identity.ts
 *
 * Tests agent keypair generation, sealing, and unsealing.
 * Bug-hunting focus: key isolation, domain separation, zeroization.
 */
import { describe, it, expect } from 'vitest'
import { generateAgentKeypair, unsealAgentKey } from '@worker/lib/agent-identity'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// A valid 32-byte hex seal key
const SEAL_KEY = 'a'.repeat(64)
const SEAL_LABEL = 'llamenos:agent-seal'

describe('agent-identity', () => {
  describe('generateAgentKeypair', () => {
    it('generates a valid X25519 keypair', () => {
      const { pubkey, sealedAgentKey } = generateAgentKeypair('agent-1', SEAL_KEY, SEAL_LABEL)

      // Pubkey should be 64 hex chars (32 bytes)
      expect(pubkey).toMatch(/^[0-9a-f]{64}$/)
      // Sealed agent key should be non-empty hex
      expect(sealedAgentKey).toMatch(/^[0-9a-f]+$/)
      // AES-256-GCM: 12 byte nonce + (64 byte secret-key-hex plaintext + 16 byte tag = 80 bytes)
      // nonce(12) + ciphertext(80) = 92 bytes = 184 hex chars
      expect(sealedAgentKey.length).toBe(184)
    })

    it('generates different keypairs for different agentIds', () => {
      const kp1 = generateAgentKeypair('agent-1', SEAL_KEY, SEAL_LABEL)
      const kp2 = generateAgentKeypair('agent-2', SEAL_KEY, SEAL_LABEL)

      expect(kp1.pubkey).not.toBe(kp2.pubkey)
      expect(kp1.sealedAgentKey).not.toBe(kp2.sealedAgentKey)
    })

    it('generates different keypairs on each call (random)', () => {
      const kp1 = generateAgentKeypair('agent-1', SEAL_KEY, SEAL_LABEL)
      const kp2 = generateAgentKeypair('agent-1', SEAL_KEY, SEAL_LABEL)

      // Random private key means different pubkeys each time
      expect(kp1.pubkey).not.toBe(kp2.pubkey)
    })

    it('pubkey is the X25519 public key of the sealed secret', () => {
      const { pubkey, sealedAgentKey } = generateAgentKeypair('agent-test', SEAL_KEY, SEAL_LABEL)
      const pubkeyBytes = hexToBytes(pubkey)
      expect(pubkeyBytes.length).toBe(32)

      // Unseal the private key and verify it derives the same pubkey
      const agentSecretKeyHex = unsealAgentKey('agent-test', sealedAgentKey, SEAL_KEY, SEAL_LABEL)
      const derivedPubkey = bytesToHex(x25519.getPublicKey(hexToBytes(agentSecretKeyHex)))
      expect(derivedPubkey).toBe(pubkey)
    })
  })

  describe('unsealAgentKey', () => {
    it('round-trips: seal then unseal recovers private key that matches pubkey', () => {
      const { pubkey, sealedAgentKey } = generateAgentKeypair('agent-rt', SEAL_KEY, SEAL_LABEL)
      const agentSecretKeyHex = unsealAgentKey('agent-rt', sealedAgentKey, SEAL_KEY, SEAL_LABEL)

      // Private key should be 64 hex chars (32 bytes)
      expect(agentSecretKeyHex).toMatch(/^[0-9a-f]{64}$/)

      // Derive pubkey from recovered private key to verify it matches
      const recoveredPubkey = bytesToHex(x25519.getPublicKey(hexToBytes(agentSecretKeyHex)))
      expect(recoveredPubkey).toBe(pubkey)
    })

    it('fails with wrong agentId (key isolation)', () => {
      const { sealedAgentKey } = generateAgentKeypair('agent-a', SEAL_KEY, SEAL_LABEL)

      expect(() => {
        unsealAgentKey('agent-b', sealedAgentKey, SEAL_KEY, SEAL_LABEL)
      }).toThrow()
    })

    it('fails with wrong seal key', () => {
      const { sealedAgentKey } = generateAgentKeypair('agent-1', SEAL_KEY, SEAL_LABEL)
      const wrongKey = 'b'.repeat(64)

      expect(() => {
        unsealAgentKey('agent-1', sealedAgentKey, wrongKey, SEAL_LABEL)
      }).toThrow()
    })

    it('fails with wrong seal label (domain separation)', () => {
      const { sealedAgentKey } = generateAgentKeypair('agent-1', SEAL_KEY, SEAL_LABEL)

      expect(() => {
        unsealAgentKey('agent-1', sealedAgentKey, SEAL_KEY, 'wrong-label')
      }).toThrow()
    })

    it('fails with tampered ciphertext', () => {
      const { sealedAgentKey } = generateAgentKeypair('agent-1', SEAL_KEY, SEAL_LABEL)
      // Flip a byte in the middle of the ciphertext (after the 48 char nonce)
      // Substitute a byte guaranteed to differ from the original (a fixed 'ff' is a no-op ~1/256 runs)
      const original = sealedAgentKey.slice(60, 62)
      const tampered = sealedAgentKey.slice(0, 60) + (original === 'ff' ? '00' : 'ff') + sealedAgentKey.slice(62)
      expect(tampered).not.toBe(sealedAgentKey)

      expect(() => {
        unsealAgentKey('agent-1', tampered, SEAL_KEY, SEAL_LABEL)
      }).toThrow()
    })
  })
})
