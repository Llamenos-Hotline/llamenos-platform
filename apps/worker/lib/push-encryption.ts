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
 * crate chooses the label and AAD). Returns the one envelope wire form (spec D1):
 * the JSON `{enc, ct}`, lowercase hex — what the iOS and Android wake handlers
 * decode. (This returned `hex(enc || ct)` while both clients parsed a JSON
 * envelope, so no wake payload could ever open.)
 */
function hpkeEncryptPayload(
  plaintext: string,
  recipientPubkeyHex: string,
  shape: 'push-wake' | 'push-full',
): string {
  return JSON.stringify(shapeSeal(shape, hexToBytes(recipientPubkeyHex), [], utf8ToBytes(plaintext)))
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
