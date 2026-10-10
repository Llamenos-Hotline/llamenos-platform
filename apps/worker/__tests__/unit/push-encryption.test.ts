import { describe, it, expect } from 'vitest'
import { encryptWakePayload, encryptFullPayload } from '@worker/lib/push-encryption'
import type { WakePayload, FullPushPayload } from '@worker/types/infra'

/**
 * Push encryption uses HPKE via FFI.
 * Output format: hex-encoded enc(32) || ciphertext+tag.
 *
 * We cannot perform a JS-side round-trip decrypt because HPKE open
 * requires the FFI private key. Instead we verify output format and
 * deterministic properties.
 */

describe('Push Encryption (HPKE)', () => {
  // Use a valid 32-byte x-only pubkey (hex, 64 chars)
  const publicKey = 'a'.repeat(64)

  const wakePayload: WakePayload = {
    hubId: 'hub-123',
    type: 'message',
    conversationId: 'conv-456',
  }

  const fullPayload: FullPushPayload = {
    hubId: 'hub-123',
    type: 'message',
    conversationId: 'conv-456',
    previewText: 'Hello there',
    senderLast4: '1234',
  }

  it('encrypts wake-tier payload to valid hex', () => {
    const encrypted = encryptWakePayload(wakePayload, publicKey)
    expect(encrypted).toMatch(/^[0-9a-f]+$/)
    // HPKE output: enc(32 bytes = 64 hex) + ciphertext+tag (at least 16 bytes = 32 hex for tag alone)
    expect(encrypted.length).toBeGreaterThan(64 + 32)
  })

  it('encrypts full-tier payload to valid hex', () => {
    const encrypted = encryptFullPayload(fullPayload, publicKey)
    expect(encrypted).toMatch(/^[0-9a-f]+$/)
    expect(encrypted.length).toBeGreaterThan(64 + 32)
  })

  it('produces different ciphertext on each call (randomized enc)', () => {
    const enc1 = encryptWakePayload(wakePayload, publicKey)
    const enc2 = encryptWakePayload(wakePayload, publicKey)

    expect(enc1).not.toBe(enc2)
  })

  it('enc portion (first 64 hex chars) differs between calls', () => {
    const enc1 = encryptWakePayload(wakePayload, publicKey)
    const enc2 = encryptWakePayload(wakePayload, publicKey)

    // First 64 hex chars = 32-byte enc (ephemeral public key)
    const encPart1 = enc1.slice(0, 64)
    const encPart2 = enc2.slice(0, 64)
    expect(encPart1).not.toBe(encPart2)
  })

  it('wake and full payloads produce different outputs', () => {
    const wakeEncrypted = encryptWakePayload(wakePayload, publicKey)
    const fullEncrypted = encryptFullPayload(fullPayload, publicKey)

    expect(wakeEncrypted).not.toBe(fullEncrypted)
  })
})
