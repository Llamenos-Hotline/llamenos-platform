import {
  hpkeSeal,
  symmetricEncrypt,
  symmetricDecrypt,
  hkdfSha256,
  hmacSha256,
  sha256,
  randomBytes,
} from '@llamenos/crypto/ffi'
import { hexToBytes, bytesToHex, utf8ToBytes } from '@shared/encoding'
import { LABEL_MESSAGE, LABEL_CALL_META, LABEL_CONTACT_ID, LABEL_STORAGE_CREDENTIAL_WRAP, HMAC_PHONE_PREFIX, HMAC_IP_PREFIX } from '@shared/crypto-labels'
import type { RecipientEnvelope } from '@shared/types'

// getClientIp lives in ./client-ip — it has no crypto/FFI dependency and
// needs to stay importable from contexts (like the rate-limit middleware)
// that must not pull in `bun:ffi` via this module. Re-exported here so
// existing `import { getClientIp } from '../lib/crypto'` call sites keep
// working unchanged.
export { getClientIp } from './client-ip'

/** Decode a secret string as hex bytes if valid hex, else as UTF-8 bytes. */
function secretToKey(secret: string): Uint8Array {
  try {
    return hexToBytes(secret)
  } catch {
    return utf8ToBytes(secret)
  }
}

/**
 * Hash a phone number for storage (one-way — compare by re-hashing).
 * Uses HMAC-SHA256 with a server secret to prevent precomputation attacks.
 */
export function hashPhone(phone: string, secret: string): string {
  const key = secretToKey(secret)
  const input = utf8ToBytes(`${HMAC_PHONE_PREFIX}${phone}`)
  return bytesToHex(hmacSha256(key, input))
}

/**
 * Hash an IP address for storage in audit logs.
 * Uses HMAC-SHA256 with a server secret, truncated to 96 bits.
 */
export function hashIP(ip: string, secret: string): string {
  const key = secretToKey(secret)
  const input = utf8ToBytes(`${HMAC_IP_PREFIX}${ip}`)
  return bytesToHex(hmacSha256(key, input)).slice(0, 24)
}

// --- Server-Side Symmetric Encryption (Tier 1) ---

/**
 * Encrypt data with a server-derived key (HKDF + AES-256-GCM via FFI).
 * Used for data the server must read at runtime (credentials, push endpoints).
 */
export function serverEncrypt(plaintext: Uint8Array, label: string, serverSecret: Uint8Array): Uint8Array {
  const key = hkdfSha256(serverSecret, new Uint8Array(0), utf8ToBytes(label), 32)
  return symmetricEncrypt(key, plaintext, utf8ToBytes(label))
}

/**
 * Decrypt server-encrypted data (HKDF + AES-256-GCM via FFI).
 */
export function serverDecrypt(ciphertext: Uint8Array, label: string, serverSecret: Uint8Array): Uint8Array {
  const key = hkdfSha256(serverSecret, new Uint8Array(0), utf8ToBytes(label), 32)
  return symmetricDecrypt(key, ciphertext, utf8ToBytes(label))
}

// --- Envelope-Pattern Encryption (Tier 3: E2EE) ---
//
// Server-sealed records use the stored-record format every reader opens
// (`open_record_for_reader` in packages/crypto/src/encryption.rs):
//   encryptedContent = hex(iv || AES-256-GCM(contentKey, plaintext) || tag), no AAD
//   envelope = { pubkey, enc: hex(32), ct: hex(48) }, HPKE info = label, no AAD
// No AAD, because client-sealed and server-sealed messages share a conversation
// and carry no format marker — a reader cannot tell which AAD to supply. The
// label is bound as HPKE `info`.

const NO_AAD = new Uint8Array(0)

function sealForPubkeys(
  plaintext: string,
  pubkeys: string[],
  label: string,
): { encryptedContent: string; envelopes: RecipientEnvelope[] } {
  const contentKey = randomBytes(32)
  const labelBytes = utf8ToBytes(label)
  const encryptedContent = bytesToHex(symmetricEncrypt(contentKey, utf8ToBytes(plaintext), NO_AAD))
  const envelopes = pubkeys.map((pk): RecipientEnvelope => {
    // hpkeSeal output is enc(32) || ct+tag
    const sealed = hpkeSeal(hexToBytes(pk), contentKey, labelBytes, NO_AAD)
    return {
      pubkey: pk,
      enc: bytesToHex(sealed.subarray(0, 32)),
      ct: bytesToHex(sealed.subarray(32)),
    }
  })
  return { encryptedContent, envelopes }
}

/**
 * Encrypt a message for storage using the HPKE envelope pattern.
 * Generates a random per-message symmetric key, encrypts the plaintext with AES-256-GCM,
 * then wraps the key for each reader via HPKE.
 *
 * Each pubkey is both the envelope address and the X25519 key the wrap is sealed
 * to, so callers must pass X25519 encryption keys.
 *
 * The plaintext is discarded after encryption — the server cannot read
 * stored messages after this function returns.
 */
export function encryptMessageForStorage(
  plaintext: string,
  readerPubkeys: string[],
  label: string = LABEL_MESSAGE,
): { encryptedContent: string; readerEnvelopes: RecipientEnvelope[] } {
  // A record with no envelopes is ciphertext nobody will ever open — the same
  // unreadable-forever outcome as sealing to an Ed25519 key (#1021/#1283), just
  // arrived at by a different route. Refuse loudly rather than persist it: the
  // content is equally lost either way, and a thrown error is recoverable
  // operator feedback where a silent write is not.
  if (readerPubkeys.length === 0) {
    throw new Error(
      'encryptMessageForStorage: refusing to encrypt with an empty reader list — ' +
      'the result would be undecryptable by everyone. Ensure ADMIN_DECRYPTION_PUBKEY ' +
      'is configured and/or the reader has a registered X25519 device key.'
    )
  }

  const { encryptedContent, envelopes } = sealForPubkeys(plaintext, readerPubkeys, label)
  return { encryptedContent, readerEnvelopes: envelopes }
}

/**
 * Encrypt call record metadata for history storage.
 * Same format as messages, under LABEL_CALL_META: a random per-record key
 * wrapped via HPKE for each admin's X25519 pubkey.
 */
export function encryptCallRecordForStorage(
  metadata: Record<string, unknown>,
  adminPubkeys: string[],
): { encryptedContent: string; adminEnvelopes: RecipientEnvelope[] } {
  const { encryptedContent, envelopes } = sealForPubkeys(JSON.stringify(metadata), adminPubkeys, LABEL_CALL_META)
  return { encryptedContent, adminEnvelopes: envelopes }
}

// --- Contact Identifier Encryption ---

/**
 * Encrypt a contact identifier for at-rest storage.
 * Uses HKDF(HMAC_SECRET) → AES-256-GCM via FFI.
 * Stored with "enc:" prefix to distinguish from legacy plaintext.
 */
export function encryptContactIdentifier(identifier: string, hmacSecret: string): string {
  const ct = serverEncrypt(utf8ToBytes(identifier), LABEL_CONTACT_ID, hexToBytes(hmacSecret))
  return 'enc:' + bytesToHex(ct)
}

/**
 * Decrypt a contact identifier from storage.
 * Handles both encrypted ("enc:"-prefixed) and legacy plaintext values.
 */
export function decryptContactIdentifier(stored: string, hmacSecret: string): string {
  if (!stored.startsWith('enc:')) return stored
  const ct = hexToBytes(stored.slice(4))
  return new TextDecoder().decode(serverDecrypt(ct, LABEL_CONTACT_ID, hexToBytes(hmacSecret)))
}

// --- Storage Credential Encryption ---

/**
 * Encrypt a storage IAM secret key for at-rest protection.
 * Uses HKDF(HMAC_SECRET) → AES-256-GCM via FFI.
 */
export function encryptStorageCredential(secretKey: string, hmacSecret: string): string {
  const ct = serverEncrypt(utf8ToBytes(secretKey), LABEL_STORAGE_CREDENTIAL_WRAP, hexToBytes(hmacSecret))
  return bytesToHex(ct)
}

/**
 * Decrypt a storage IAM secret key from at-rest storage.
 */
export function decryptStorageCredential(encrypted: string, hmacSecret: string): string {
  const ct = hexToBytes(encrypted)
  return new TextDecoder().decode(serverDecrypt(ct, LABEL_STORAGE_CREDENTIAL_WRAP, hexToBytes(hmacSecret)))
}

// --- Audit Entry Hashing ---

/**
 * Deterministic JSON serialization with sorted keys.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      )
    }
    return val
  })
}

/**
 * Compute SHA-256 hash of an audit entry's core content for chain linking.
 */
export function hashAuditEntry(entry: {
  id: string
  action: string
  actorPubkey: string
  details: Record<string, unknown>
  createdAt: string
  previousEntryHash?: string
}): string {
  const content = `${entry.id}:${entry.action}:${entry.actorPubkey}:${entry.createdAt}:${stableJsonStringify(entry.details ?? {})}:${entry.previousEntryHash || ''}`
  return bytesToHex(sha256(utf8ToBytes(content)))
}
