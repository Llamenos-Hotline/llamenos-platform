/**
 * The Playwright IPC mock's mirrors of `packages/crypto` for device linking and
 * Shamir commitments (#2764, #2765). These are pure functions — no browser —
 * and they are the only thing standing between the desktop E2E suite and a mock
 * that still speaks the pre-#1865 / un-labelled-commitment formats the Rust
 * side no longer does.
 *
 * Cross-checked against the Rust crate by pinned vectors:
 *   packages/crypto/src/shamir.rs   commitment_matches_the_pinned_cross_platform_vector
 *   apps/desktop/src/crypto.rs      shamir_commit_is_the_domain_separated_commitment_every_platform_uses
 */
import { test, expect } from '@playwright/test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import {
  decryptProvisioningBundle,
  encryptBundleForProvisioning,
  newDeviceProvisioningSas,
} from './mocks/provisioning-mock'
import { shamirCommitment } from './mocks/shamir-mock'

test.describe('shamir commitment mock', () => {
  const Y_HEX = '0102030405060708090a0b0c0d0e0f10'

  test('is the crate commitment: SHA-256(label || x || y)', () => {
    expect(shamirCommitment(7, Y_HEX)).toBe('5a46e2f7c18caaa8227164f370875bcea284606ed6abe0dc1d1fb8cc0dff2db5')
  })

  test('is not the retired un-labelled SHA-256(x || y)', () => {
    const retired = bytesToHex(sha256(new Uint8Array([7, ...Array.from({ length: 16 }, (_, i) => i + 1)])))
    expect(retired).toBe('504b8fe1342d38eb394453eb2b208a5532d442ba129731c8e001bd8b39480565')
    expect(shamirCommitment(7, Y_HEX)).not.toBe(retired)
  })
})

test.describe('provisioning mock', () => {
  function room() {
    const ephemeralSecret = randomBytes(32)
    const signingSeed = randomBytes(32)
    const encryptionSeed = randomBytes(32)
    const offer = encryptBundleForProvisioning(
      signingSeed,
      encryptionSeed,
      bytesToHex(x25519.getPublicKey(ephemeralSecret)),
    )
    return { ephemeralSecret, signingSeed, encryptionSeed, offer }
  }

  test('SAS from the verified claim matches the primary, and the bundle round-trips', () => {
    const { ephemeralSecret, signingSeed, encryptionSeed, offer } = room()
    expect(newDeviceProvisioningSas(offer.claimHex, ephemeralSecret)).toBe(offer.sasCode)
    const opened = decryptProvisioningBundle(offer.encryptedHex, offer.claimHex, ephemeralSecret)
    expect(bytesToHex(opened.signingSeed)).toBe(bytesToHex(signingSeed))
    expect(bytesToHex(opened.encryptionSeed)).toBe(bytesToHex(encryptionSeed))
    expect(opened.sasCode).toBe(offer.sasCode)
  })

  test('refuses a bare pubkey where the claim belongs', () => {
    const { ephemeralSecret, offer } = room()
    const pubkey = bytesToHex(x25519.getPublicKey(randomBytes(32)))
    expect(() => newDeviceProvisioningSas(pubkey, ephemeralSecret)).toThrow(/claim must be 129 bytes/)
    expect(() => decryptProvisioningBundle(offer.encryptedHex, pubkey, ephemeralSecret)).toThrow(
      /claim must be 129 bytes/,
    )
  })

  test("refuses a claim signed for another room's ephemeral key", () => {
    const { ephemeralSecret } = room()
    const other = room()
    expect(() => newDeviceProvisioningSas(other.offer.claimHex, ephemeralSecret)).toThrow(
      /signature verification failed/,
    )
  })

  test('refuses a claim with a flipped signature byte, and a tampered bundle', () => {
    const { ephemeralSecret, offer } = room()
    const flipped = offer.claimHex.slice(0, -2) + (offer.claimHex.endsWith('00') ? '01' : '00')
    expect(() => newDeviceProvisioningSas(flipped, ephemeralSecret)).toThrow(/signature verification failed/)

    const tampered = offer.encryptedHex.slice(0, -2) + (offer.encryptedHex.endsWith('00') ? '01' : '00')
    expect(() => decryptProvisioningBundle(tampered, offer.claimHex, ephemeralSecret)).toThrow()
  })
})
