/**
 * The server's leg of the ban digest (#2759) — real Rust crypto via bun:ffi.
 *
 * MUST run under `bun test`, NOT vitest (vitest aliases `@llamenos/crypto/ffi` to a pure-TS
 * stand-in that is itself @noble/curves, so a comparison there proves nothing):
 *   bun test apps/worker/__tests__/integration-bun/ban-digest.test.ts
 *
 * The reference is @noble/curves' RFC 9497 implementation, independent of the crate. Both are
 * pinned to the RFC's vectors (the crate in `ban_digest.rs`, noble here). If they agree, a
 * client that follows the RFC — the desktop test mock is noble, iOS/Android/desktop-native are
 * the crate — produces exactly the digest the server matches an inbound call against.
 */
import { describe, expect, it } from 'bun:test'
import { ristretto255_oprf } from '@noble/curves/ed25519.js'
import { banDigestBlindEvaluate, banDigestEvaluate } from '@llamenos/crypto/ffi'
import { HMAC_BAN_PREFIX, LABEL_BAN_KEY_DERIVE } from '@shared/crypto-labels'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { banBlindEvaluate, banHash, callBanLookup } from '../../lib/crypto'
import { hubScope, PLATFORM_SCOPE } from '@shared/owner-scope'

const reference = ristretto255_oprf.oprf

/** RFC 9497 Evaluate, spelled as the interactive protocol it equals (noble types only the latter). */
function oprfEvaluate(secretKey: Uint8Array, input: Uint8Array): Uint8Array {
  const { blind, blinded } = ristretto255_oprf.oprf.blind(input)
  return ristretto255_oprf.oprf.finalize(input, blind, ristretto255_oprf.oprf.blindEvaluate(secretKey, blinded))
}
const KEY = 'b'.repeat(64) // gitleaks:allow
const NUMBER = '+15551234567'
const input = utf8ToBytes(`${HMAC_BAN_PREFIX}${NUMBER}`)
const scopeKey = (scope: string) =>
  reference.deriveKeyPair(hexToBytes(KEY), utf8ToBytes(`${LABEL_BAN_KEY_DERIVE}:${scope}`)).secretKey

describe('ban digest — crate (bun:ffi) against an independent RFC 9497 implementation', () => {
  it('the reference itself reproduces RFC 9497 A.1.1', () => {
    const sk = reference.deriveKeyPair(hexToBytes('a3'.repeat(32)), hexToBytes('74657374206b6579')).secretKey
    expect(bytesToHex(sk)).toBe('5ebcea5ee37023ccb9fc2d2019f9d7737be85591ae8652ffa9ef0f4d37063b0e')
    expect(bytesToHex(oprfEvaluate(sk, hexToBytes('00')))).toBe(
      '527759c3d9366f277d8c6020418d96bb393ba2afb20ff90df23fb7708264e2f3ab9135e3bd69955851de4b1f9fe8a0973396719b7912ba9ee8aa7d0b5e24bcf6',
    )
  })

  it('Evaluate: the crate digest of a held number equals the reference, per scope', () => {
    for (const scope of ['platform', 'hub-1', 'hub-2']) {
      expect(bytesToHex(banDigestEvaluate(hexToBytes(KEY), scope, NUMBER))).toBe(
        bytesToHex(oprfEvaluate(scopeKey(scope), input)),
      )
    }
  })

  it('BlindEvaluate: a client that blinds the number ends with the digest the server matches calls against', () => {
    const { blind, blinded } = reference.blind(input)
    const evaluated = banDigestBlindEvaluate(hexToBytes(KEY), 'platform', blinded)
    expect(bytesToHex(reference.finalize(input, blind, evaluated))).toBe(banHash(NUMBER, PLATFORM_SCOPE, KEY))
    expect(bytesToHex(evaluated)).toBe(banBlindEvaluate(bytesToHex(blinded), PLATFORM_SCOPE, KEY))
  })

  it('a call is checked against its hub and the platform, each under its own key', () => {
    const lookups = callBanLookup(NUMBER, 'hub-1', KEY)
    expect(lookups).toEqual([
      { scope: hubScope('hub-1'), phoneHash: bytesToHex(oprfEvaluate(scopeKey('hub-1'), input)) },
      { scope: PLATFORM_SCOPE, phoneHash: bytesToHex(oprfEvaluate(scopeKey('platform'), input)) },
    ])
  })

  it('refuses an invalid blinded element instead of evaluating it', () => {
    expect(() => banDigestBlindEvaluate(hexToBytes(KEY), 'platform', new Uint8Array(32))).toThrow()
    expect(() => banDigestBlindEvaluate(hexToBytes(KEY), 'platform', new Uint8Array(32).fill(0xff))).toThrow()
  })
})
