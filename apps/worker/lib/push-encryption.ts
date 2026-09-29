/**
 * Two-tier HPKE push payload encryption (Epic 86).
 *
 * Wake tier: encrypted with device-specific wake key — decryptable without PIN.
 * Full tier: encrypted with the recipient device's X25519 encryption pubkey
 *            (devices.x25519Pubkey) — decryptable only after PIN unlock.
 */

import { hpkeSeal } from '@llamenos/crypto/ffi'
import { hexToBytes, bytesToHex, utf8ToBytes } from '@shared/encoding'
import { LABEL_PUSH_WAKE, LABEL_PUSH_FULL } from '@shared/crypto-labels'
import type { WakePayload, FullPushPayload } from '../types'

/**
 * HPKE encrypt a payload for a single recipient pubkey with domain separation.
 * Returns hex-encoded: enc(32) || ciphertext+tag.
 */
function hpkeEncryptPayload(plaintext: string, recipientPubkeyHex: string, label: string): string {
  const labelBytes = utf8ToBytes(label)
  const aad = utf8ToBytes(`${label}:push`)
  const sealed = hpkeSeal(hexToBytes(recipientPubkeyHex), utf8ToBytes(plaintext), labelBytes, aad)
  return bytesToHex(sealed)
}

/**
 * Encrypt wake-tier push payload for a specific device.
 * Uses the device's wake key — accessible without user's PIN.
 */
export function encryptWakePayload(payload: WakePayload, deviceWakeKeyPublic: string): string {
  return hpkeEncryptPayload(JSON.stringify(payload), deviceWakeKeyPublic, LABEL_PUSH_WAKE)
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
  return hpkeEncryptPayload(JSON.stringify(payload), deviceEncryptionPubkey, LABEL_PUSH_FULL)
}
