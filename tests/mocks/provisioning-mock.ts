/**
 * Provisioning (device linking) wire format, mirrored from
 * `packages/crypto/src/provisioning.rs` for the Playwright IPC mock and for
 * tests that act as the PRIMARY device.
 *
 * The real implementation lives in the Rust crate and is reached by desktop
 * through `llamenos_core::provisioning`; this file exists only because the
 * browser-side mock cannot call Rust. It must follow the crate, never lead it:
 *
 *   claim (129 bytes): version(1) || ePK_primary(32) || primary Ed25519 pk(32)
 *                      || Ed25519 signature(64)
 *   signature covers:  UTF-8(LABEL_DEVICE_PROVISION_CLAIM) || version
 *                      || ePK_new || ePK_primary
 *   bundle AAD:        UTF-8(LABEL_DEVICE_PROVISION_BUNDLE) || ePK_new || claim
 *   shared secret:     X25519(eSK_primary, ePK_new); both sides are ephemeral
 *
 * The new device verifies the claim against ITS OWN ephemeral public key before
 * deriving the SAS or decrypting anything (#1865), so a bare pubkey, a claim
 * minted for another room, or a claim with a flipped byte is refused.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  LABEL_DEVICE_PROVISION,
  LABEL_DEVICE_PROVISION_BUNDLE,
  LABEL_DEVICE_PROVISION_CLAIM,
  LABEL_PROVISIONING_SALT,
  SAS_INFO,
  SAS_SALT,
} from '@shared/crypto-labels'

export const PROVISIONING_CLAIM_VERSION = 1
/** version(1) + ePK_primary(32) + signing pk(32) + signature(64). */
export const PROVISIONING_CLAIM_LEN = 129
/** Mirrors packages/crypto/src/provisioning.rs PROVISIONING_BUNDLE_VERSION. */
export const PROVISIONING_BUNDLE_VERSION = 1
/** version(1) + signing seed(32) + encryption seed(32). */
export const PROVISIONING_BUNDLE_LEN = 65

function claimSigningMessage(newDeviceEphemeralPk: Uint8Array, primaryEphemeralPk: Uint8Array): Uint8Array {
  return concatBytes(
    utf8ToBytes(LABEL_DEVICE_PROVISION_CLAIM),
    new Uint8Array([PROVISIONING_CLAIM_VERSION]),
    newDeviceEphemeralPk,
    primaryEphemeralPk,
  )
}

function bundleAad(newDeviceEphemeralPk: Uint8Array, claim: Uint8Array): Uint8Array {
  return concatBytes(utf8ToBytes(LABEL_DEVICE_PROVISION_BUNDLE), newDeviceEphemeralPk, claim)
}

/** `NNN NNN`, derived from the ECDH output. */
export function provisioningSas(sharedSecret: Uint8Array): string {
  const sasBytes = hkdf(sha256, sharedSecret, utf8ToBytes(SAS_SALT), utf8ToBytes(SAS_INFO), 4)
  const num = ((sasBytes[0] << 24) | (sasBytes[1] << 16) | (sasBytes[2] << 8) | sasBytes[3]) >>> 0
  const code = (num % 1_000_000).toString().padStart(6, '0')
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

function provisioningKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, utf8ToBytes(LABEL_PROVISIONING_SALT), utf8ToBytes(LABEL_DEVICE_PROVISION), 32)
}

function checkedSharedSecret(secret: Uint8Array, peerPk: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secret, peerPk)
  if (shared.every((b) => b === 0)) throw new Error('ECDH shared secret is all-zeros (low-order point)')
  return shared
}

export interface VerifiedClaim {
  bytes: Uint8Array
  primaryEphemeralPk: Uint8Array
  primarySigningPk: Uint8Array
}

/**
 * Verify a claim against the new device's own ephemeral public key. Throws on a
 * wrong length or version, or a signature that does not cover THIS room.
 */
export function verifyProvisioningClaim(claimHex: string, newDeviceEphemeralPk: Uint8Array): VerifiedClaim {
  const bytes = hexToBytes(claimHex)
  if (bytes.length !== PROVISIONING_CLAIM_LEN) {
    throw new Error(`provisioning claim must be ${PROVISIONING_CLAIM_LEN} bytes, got ${bytes.length}`)
  }
  if (bytes[0] !== PROVISIONING_CLAIM_VERSION) {
    throw new Error(`unsupported provisioning claim version: ${bytes[0]}`)
  }
  const primaryEphemeralPk = bytes.slice(1, 33)
  const primarySigningPk = bytes.slice(33, 65)
  const signature = bytes.slice(65, PROVISIONING_CLAIM_LEN)
  const ok = ed25519.verify(
    signature,
    claimSigningMessage(newDeviceEphemeralPk, primaryEphemeralPk),
    primarySigningPk,
    { zip215: false },
  )
  if (!ok) throw new Error('signature verification failed')
  return { bytes, primaryEphemeralPk, primarySigningPk }
}

/** New device: verify the claim, then derive the SAS from the ECDH. */
export function newDeviceProvisioningSas(claimHex: string, ephemeralSecret: Uint8Array): string {
  const own = x25519.getPublicKey(ephemeralSecret)
  const claim = verifyProvisioningClaim(claimHex, own)
  return provisioningSas(checkedSharedSecret(ephemeralSecret, claim.primaryEphemeralPk))
}

export interface DecryptedProvisioningBundle {
  signingSeed: Uint8Array
  encryptionSeed: Uint8Array
  sasCode: string
}

/** New device: verify the claim, decrypt the bundle, and check it is the claim signer's. */
export function decryptProvisioningBundle(
  encryptedHex: string,
  claimHex: string,
  ephemeralSecret: Uint8Array,
): DecryptedProvisioningBundle {
  const data = hexToBytes(encryptedHex)
  if (data.length < 28) throw new Error('invalid ciphertext')
  const own = x25519.getPublicKey(ephemeralSecret)
  const claim = verifyProvisioningClaim(claimHex, own)
  const shared = checkedSharedSecret(ephemeralSecret, claim.primaryEphemeralPk)
  const plaintext = gcm(provisioningKey(shared), data.slice(0, 12), bundleAad(own, claim.bytes)).decrypt(data.slice(12))

  if (plaintext.length !== PROVISIONING_BUNDLE_LEN) {
    throw new Error(`provisioning bundle must be ${PROVISIONING_BUNDLE_LEN} bytes, got ${plaintext.length}`)
  }
  if (plaintext[0] !== PROVISIONING_BUNDLE_VERSION) {
    throw new Error(`unsupported provisioning bundle version: ${plaintext[0]}`)
  }
  const signingSeed = plaintext.slice(1, 33)
  const encryptionSeed = plaintext.slice(33, PROVISIONING_BUNDLE_LEN)
  if (bytesToHex(ed25519.getPublicKey(signingSeed)) !== bytesToHex(claim.primarySigningPk)) {
    throw new Error('provisioning bundle signing key does not match the claim signer')
  }
  if (bytesToHex(x25519.getPublicKey(encryptionSeed)) === bytesToHex(claim.primaryEphemeralPk)) {
    throw new Error('provisioning ECDH used the long-term encryption key instead of an ephemeral')
  }
  return { signingSeed, encryptionSeed, sasCode: provisioningSas(shared) }
}

export interface ProvisioningOffer {
  encryptedHex: string
  claimHex: string
  sasCode: string
}

/**
 * Primary device: build the claim and the encrypted bundle for a room. A test
 * uses this to play the primary; the production primary is the Rust crate.
 */
export function encryptBundleForProvisioning(
  signingSeed: Uint8Array,
  encryptionSeed: Uint8Array,
  newDeviceEphemeralPubkeyHex: string,
): ProvisioningOffer {
  const newDevicePk = hexToBytes(newDeviceEphemeralPubkeyHex)
  const primaryEphemeralSecret = randomBytes(32)
  const primaryEphemeralPk = x25519.getPublicKey(primaryEphemeralSecret)
  const shared = checkedSharedSecret(primaryEphemeralSecret, newDevicePk)

  const signature = ed25519.sign(claimSigningMessage(newDevicePk, primaryEphemeralPk), signingSeed)
  const claim = concatBytes(
    new Uint8Array([PROVISIONING_CLAIM_VERSION]),
    primaryEphemeralPk,
    ed25519.getPublicKey(signingSeed),
    signature,
  )

  const bundle = concatBytes(new Uint8Array([PROVISIONING_BUNDLE_VERSION]), signingSeed, encryptionSeed)
  const nonce = randomBytes(12)
  const ciphertext = gcm(provisioningKey(shared), nonce, bundleAad(newDevicePk, claim)).encrypt(bundle)
  return {
    encryptedHex: bytesToHex(concatBytes(nonce, ciphertext)),
    claimHex: bytesToHex(claim),
    sasCode: provisioningSas(shared),
  }
}
