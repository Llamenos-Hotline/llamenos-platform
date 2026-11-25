/**
 * Two-tier HPKE push payload encryption (Epic 86).
 *
 * Wake tier: encrypted with device-specific wake key — decryptable without PIN.
 * Full tier: encrypted with the recipient device's X25519 encryption pubkey
 *            (devices.x25519Pubkey) — decryptable only after PIN unlock.
 */

import { shapeSeal } from '@llamenos/crypto/ffi'
import { hexToBytes, utf8ToBytes } from '@shared/encoding'
import type { WakePayload, FullPushPayload } from '../types'

/**
 * HPKE-seal a push payload for one device through the crate's push shape (the
 * crate chooses the label and AAD). Returns hex `enc(32) || ct` — the push
 * transport carries one string, which clients split at 64 characters.
 */
function hpkeEncryptPayload(
  plaintext: string,
  recipientPubkeyHex: string,
  shape: 'push-wake' | 'push-full',
): string {
  const { enc, ct } = shapeSeal(shape, hexToBytes(recipientPubkeyHex), [], utf8ToBytes(plaintext))
  return enc + ct
}

/**
 * Encrypt wake-tier push payload for a specific device.
 * Uses the device's wake key — accessible without user's PIN.
 */
export function encryptWakePayload(payload: WakePayload, deviceWakeKeyPublic: string): string {
  return hpkeEncryptPayload(JSON.stringify(payload), deviceWakeKeyPublic, 'push-wake')
}

/**
 * Encrypt full-tier push payload for one device.
 *
 * `deviceEncryptionPubkey` MUST be that device's X25519 encryption public key
 * (`devices.x25519Pubkey`), never the user's Ed25519 auth pubkey: HPKE will
 * accept any 32 bytes as a recipient and silently produce an envelope for which
 * no secret key exists (#1021).
 */
export function encryptFullPayload(payload: FullPushPayload, deviceEncryptionPubkey: string): string {
  return hpkeEncryptPayload(JSON.stringify(payload), deviceEncryptionPubkey, 'push-full')
}
