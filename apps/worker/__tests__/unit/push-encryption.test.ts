import { describe, it, expect } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { shapeOpen, type HpkeEnvelope } from '@llamenos/crypto/ffi'
import { encryptWakePayload, encryptFullPayload } from '@worker/lib/push-encryption'
import type { WakePayload, FullPushPayload } from '@worker/types/infra'

/**
 * Push payloads are the one envelope wire form (spec D1): the JSON `{enc, ct}`,
 * lowercase hex, sealed under the push-wake / push-full shape — what the iOS and
 * Android wake handlers decode and open. This returned `hex(enc || ct)` while
 * both clients parsed JSON, so no wake payload could open on a device.
 *
 * `@llamenos/crypto/ffi` is the JS mock here (vitest.unit.config.ts); the real
 * crate's shapes are pinned by the v2 vectors (`v2-vectors.test.ts`).
 */
describe('Push Encryption (HPKE)', () => {
  const secret = randomBytes(32)
  const publicKey = bytesToHex(x25519.getPublicKey(secret))

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
  }

  const parse = (wire: string): HpkeEnvelope => {
    const env = JSON.parse(wire) as Record<string, unknown>
    expect(Object.keys(env).sort()).toEqual(['ct', 'enc'])
    expect(env.enc).toMatch(/^[0-9a-f]{64}$/)
    expect(env.ct).toMatch(/^(?:[0-9a-f]{2})+$/)
    return env as unknown as HpkeEnvelope
  }

  const open = (shape: 'push-wake' | 'push-full', env: HpkeEnvelope): unknown =>
    JSON.parse(new TextDecoder().decode(shapeOpen(shape, secret, [], env)))

  it('seals the wake tier as a {enc, ct} envelope that opens under the push-wake shape', () => {
    const env = parse(encryptWakePayload(wakePayload, publicKey))
    expect(open('push-wake', env)).toEqual(wakePayload)
  })

  it('seals the full tier as a {enc, ct} envelope that opens under the push-full shape', () => {
    const env = parse(encryptFullPayload(fullPayload, publicKey))
    expect(open('push-full', env)).toEqual(fullPayload)
  })

  it('binds the tier: a wake payload does not open as full, nor full as wake', () => {
    expect(() => open('push-full', parse(encryptWakePayload(wakePayload, publicKey)))).toThrow()
    expect(() => open('push-wake', parse(encryptFullPayload(fullPayload, publicKey)))).toThrow()
  })

  it('uses a fresh ephemeral key on each call', () => {
    const a = parse(encryptWakePayload(wakePayload, publicKey))
    const b = parse(encryptWakePayload(wakePayload, publicKey))
    expect(a.enc).not.toBe(b.enc)
    expect(a.ct).not.toBe(b.ct)
  })
})
