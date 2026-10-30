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
import { LABEL_MESSAGE, LABEL_CALL_META, LABEL_CONTACT_ID, LABEL_STORAGE_CREDENTIAL_WRAP, LABEL_AUDIT_USER_KEY_WRAP, LABEL_AUDIT_USER_KEY_SERVER_SEAL, LABEL_AUDIT_DETAILS, HMAC_PHONE_PREFIX, HMAC_IP_PREFIX, HMAC_BAN_PREFIX, LABEL_BAN_KEY_DERIVE, LABEL_CALLER_NUMBER_SEAL, LABEL_CALL_RECORDING_SEAL } from '@shared/crypto-labels'
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

/** Ban scope of the platform-wide list; a hub's scope is its hub id. */
export const PLATFORM_BAN_SCOPE = 'platform'

/**
 * Hash of a BANNED number under one scope's key: HMAC(HKDF(BAN_HASH_KEY, scope), number).
 *
 * Only numbers an admin banned are ever hashed this way and stored. A caller who
 * has not been banned is hashed here transiently to be compared against the ban
 * list and the digest is dropped, so the server keeps no deterministic
 * identifier for an ordinary caller. The per-scope key means a hub's ban hashes
 * cannot be compared with another hub's, with the platform list, or with any
 * other hash of the same number. BAN_HASH_KEY is a file-only secret (never in
 * the DB, `.env` or a config backup), so a database dump alone confirms nothing.
 */
export function banHash(phone: string, scope: string, banHashKey: string): string {
  const scopeKey = hkdfSha256(hexToBytes(banHashKey), new Uint8Array(0), utf8ToBytes(`${LABEL_BAN_KEY_DERIVE}:${scope}`), 32)
  return bytesToHex(hmacSha256(scopeKey, utf8ToBytes(`${HMAC_BAN_PREFIX}${phone}`)))
}

/** The hashes a call must be compared against: its hub's list (when it has a hub) and the platform's. */
export interface BanHashes {
  hub?: string
  platform: string
}

export function banHashes(phone: string, hubId: string | undefined, banHashKey: string): BanHashes {
  return {
    hub: hubId ? banHash(phone, hubId, banHashKey) : undefined,
    platform: banHash(phone, PLATFORM_BAN_SCOPE, banHashKey),
  }
}

const CALLER_RATE_KEY_EPOCH_MS = 60_000
let callerRateKey: { epoch: number; key: Uint8Array } | null = null

/**
 * Digest that tells the per-caller rate limiter two calls came from one number,
 * and only within one rate-limit window. The key is random, lives in this
 * process's memory only and is replaced every window, so the digests left in
 * `rate_limits` cannot be linked to a number, to each other past the window, or
 * to a later call, even by someone holding every server secret. The cost is that
 * the limit is counted per process and restarts at each window boundary.
 */
export function callerRateLimitDigest(phone: string, now: number = Date.now()): string {
  const epoch = Math.floor(now / CALLER_RATE_KEY_EPOCH_MS)
  if (callerRateKey?.epoch !== epoch) {
    callerRateKey?.key.fill(0)
    callerRateKey = { epoch, key: randomBytes(32) }
  }
  return bytesToHex(hmacSha256(callerRateKey.key, utf8ToBytes(`${HMAC_PHONE_PREFIX}${phone}`))).slice(0, 32)
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
 * AAD for the server-side seal: the label alone, or `label:context` when the
 * ciphertext must also be bound to one record (e.g. a user), so a row copied
 * onto another record's slot fails to open.
 */
function serverSealAad(label: string, context?: string): Uint8Array {
  return utf8ToBytes(context === undefined ? label : `${label}:${context}`)
}

/**
 * Encrypt data with a server-derived key (HKDF + AES-256-GCM via FFI).
 * Used for data the server must read at runtime (credentials, push endpoints).
 * `context` is optional extra AAD binding the ciphertext to one record.
 */
export function serverEncrypt(plaintext: Uint8Array, label: string, serverSecret: Uint8Array, context?: string): Uint8Array {
  const key = hkdfSha256(serverSecret, new Uint8Array(0), utf8ToBytes(label), 32)
  return symmetricEncrypt(key, plaintext, serverSealAad(label, context))
}

/**
 * Decrypt server-encrypted data (HKDF + AES-256-GCM via FFI). `context` must
 * match the one given to serverEncrypt.
 */
export function serverDecrypt(ciphertext: Uint8Array, label: string, serverSecret: Uint8Array, context?: string): Uint8Array {
  const key = hkdfSha256(serverSecret, new Uint8Array(0), utf8ToBytes(label), 32)
  return symmetricDecrypt(key, ciphertext, serverSealAad(label, context))
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
  // Same refusal as encryptMessageForStorage: a call record sealed to nobody
  // is ciphertext no admin will ever open — persist nothing rather than mint
  // an unreadable row and call it encrypted (#1684).
  if (adminPubkeys.length === 0) {
    throw new Error(
      'encryptCallRecordForStorage: refusing to encrypt with an empty reader list — ' +
      'the result would be undecryptable by everyone. Ensure ADMIN_DECRYPTION_PUBKEY ' +
      'is configured and/or an admin has a registered X25519 device key.'
    )
  }
  const { encryptedContent, envelopes } = sealForPubkeys(JSON.stringify(metadata), adminPubkeys, LABEL_CALL_META)
  return { encryptedContent, adminEnvelopes: envelopes }
}

// --- Per-User Audit Keys (CRYPTO_ARCHITECTURE.md → packages/crypto/src/audit_key.rs) ---
//
// Byte-compatible with audit_key.rs so a future client binding can unwrap and
// decrypt what the server wrote:
//   key wrap : HPKE info = LABEL_AUDIT_USER_KEY_WRAP, aad = `${label}:${userPubkey}`
//   details  : AES-256-GCM, aad = `${LABEL_AUDIT_DETAILS}:${userPubkey}:${entryId}`,
//              stored as "nonce_hex:ciphertext_hex"

/**
 * Wrap a per-user audit key for each admin recipient. Throws on an empty
 * recipient list, matching wrap_audit_key_to_admins — a key wrapped to nobody
 * can never be recovered by an admin.
 */
export function wrapAuditKeyForAdmins(
  auditKey: Uint8Array,
  adminPubkeys: string[],
  userPubkey: string,
): RecipientEnvelope[] {
  if (adminPubkeys.length === 0) {
    throw new Error('wrapAuditKeyForAdmins: at least one admin pubkey required')
  }
  const aad = utf8ToBytes(`${LABEL_AUDIT_USER_KEY_WRAP}:${userPubkey}`)
  const label = utf8ToBytes(LABEL_AUDIT_USER_KEY_WRAP)
  return adminPubkeys.map((pk): RecipientEnvelope => {
    const sealed = hpkeSeal(hexToBytes(pk), auditKey, label, aad)
    return {
      pubkey: pk,
      enc: bytesToHex(sealed.subarray(0, 32)),
      ct: bytesToHex(sealed.subarray(32)),
    }
  })
}

/** Encrypt audit entry details with the user's audit key. Returns "nonce_hex:ciphertext_hex". */
export function encryptAuditDetails(
  auditKey: Uint8Array,
  detailsJson: string,
  userPubkey: string,
  entryId: string,
): string {
  const aad = utf8ToBytes(`${LABEL_AUDIT_DETAILS}:${userPubkey}:${entryId}`)
  const sealed = symmetricEncrypt(auditKey, utf8ToBytes(detailsJson), aad)
  // symmetricEncrypt output is iv(12) || ciphertext || tag — split the nonce
  // out to match audit_key.rs's nonce_hex:ciphertext_hex storage format.
  return `${bytesToHex(sealed.subarray(0, 12))}:${bytesToHex(sealed.subarray(12))}`
}

/** Decrypt audit entry details produced by encryptAuditDetails. Throws on wrong key/user/entry. */
export function decryptAuditDetails(
  auditKey: Uint8Array,
  encrypted: string,
  userPubkey: string,
  entryId: string,
): string {
  const [nonceHex, ctHex] = encrypted.split(':')
  if (!nonceHex || !ctHex) {
    throw new Error('decryptAuditDetails: expected nonce_hex:ciphertext_hex format')
  }
  const data = new Uint8Array([...hexToBytes(nonceHex), ...hexToBytes(ctHex)])
  const aad = utf8ToBytes(`${LABEL_AUDIT_DETAILS}:${userPubkey}:${entryId}`)
  return new TextDecoder().decode(symmetricDecrypt(auditKey, data, aad))
}

/**
 * Seal a per-user audit key for the server-held copy
 * (audit_user_keys.encrypted_key), which lets the server decrypt details for
 * admin reads. Hex-encoded. Sealed under LABEL_AUDIT_USER_KEY_SERVER_SEAL — not
 * the admin HPKE wrap's LABEL_AUDIT_USER_KEY_WRAP, which names a different
 * construction — with the user's pubkey bound as AAD (`label:userPubkey`), so a
 * row copied onto another user's slot fails to open.
 */
export function sealAuditKeyForServer(auditKey: Uint8Array, userPubkey: string, serverSecret: Uint8Array): string {
  return bytesToHex(serverEncrypt(auditKey, LABEL_AUDIT_USER_KEY_SERVER_SEAL, serverSecret, userPubkey))
}

/** Open a key sealed by sealAuditKeyForServer. Throws on a wrong secret, wrong user, or tampered row. */
export function openServerSealedAuditKey(encryptedKey: string, userPubkey: string, serverSecret: Uint8Array): Uint8Array {
  return serverDecrypt(hexToBytes(encryptedKey), LABEL_AUDIT_USER_KEY_SERVER_SEAL, serverSecret, userPubkey)
}


// --- Contact Identifier Encryption ---
//
// Server-readable data (a reply address the server must be able to use later,
// a storage IAM secret) is sealed under SERVER_KEK, never under HMAC_SECRET:
// HMAC_SECRET is only a hashing key, so rotating or leaking it must not touch
// anything the server has to decrypt (#2171, D6).

/**
 * Encrypt a contact identifier for at-rest storage.
 * Uses HKDF(SERVER_KEK) → AES-256-GCM via FFI.
 * Stored with an "enc:" prefix so a value that was never sealed is rejected on
 * read rather than returned as if it were plaintext.
 */
export function encryptContactIdentifier(identifier: string, serverKek: string): string {
  const ct = serverEncrypt(utf8ToBytes(identifier), LABEL_CONTACT_ID, hexToBytes(serverKek))
  return 'enc:' + bytesToHex(ct)
}

/**
 * Decrypt a contact identifier from storage. Throws on a value without the
 * "enc:" prefix, a wrong key, or a tampered ciphertext.
 */
export function decryptContactIdentifier(stored: string, serverKek: string): string {
  if (!stored.startsWith('enc:')) {
    throw new Error('Contact identifier is not sealed (missing "enc:" prefix)')
  }
  const ct = hexToBytes(stored.slice(4))
  return new TextDecoder().decode(serverDecrypt(ct, LABEL_CONTACT_ID, hexToBytes(serverKek)))
}

// --- Live-Call Caller Number ---

/**
 * Seal a live caller's number for the life of one call. SERVER_KEK, under its own
 * label and bound to the call id: a value copied onto another call's row fails to
 * open, and the key is not the one that opens contact identifiers.
 */
export function sealCallerNumber(phone: string, callId: string, serverKek: string): string {
  return bytesToHex(serverEncrypt(utf8ToBytes(phone), LABEL_CALLER_NUMBER_SEAL, hexToBytes(serverKek), callId))
}

/** Open a number sealed by sealCallerNumber. Throws on a wrong key, wrong call, or tampered value. */
export function openCallerNumber(sealed: string, callId: string, serverKek: string): string {
  return new TextDecoder().decode(serverDecrypt(hexToBytes(sealed), LABEL_CALLER_NUMBER_SEAL, hexToBytes(serverKek), callId))
}

// --- Stored Call Recording ---

/**
 * Seal a call recording for the server's own object storage (#2309). The
 * provider's copy is deleted once this copy exists, so this is the only copy:
 * SERVER_KEK under its own label, bound to the hub and call, so a blob copied
 * onto another call's key fails to open rather than playing the wrong audio.
 */
export function sealCallRecording(audio: Uint8Array, hubId: string, callId: string, serverKek: string): Uint8Array {
  return serverEncrypt(audio, LABEL_CALL_RECORDING_SEAL, hexToBytes(serverKek), `${hubId}:${callId}`)
}

/** Open a recording sealed by sealCallRecording. Throws on a wrong key, wrong hub or call, or tampered blob. */
export function openCallRecording(sealed: Uint8Array, hubId: string, callId: string, serverKek: string): Uint8Array {
  return serverDecrypt(sealed, LABEL_CALL_RECORDING_SEAL, hexToBytes(serverKek), `${hubId}:${callId}`)
}

// --- Storage Credential Encryption ---

/**
 * Encrypt a storage IAM secret key for at-rest protection.
 * Uses HKDF(SERVER_KEK) → AES-256-GCM via FFI.
 */
export function encryptStorageCredential(secretKey: string, serverKek: string): string {
  const ct = serverEncrypt(utf8ToBytes(secretKey), LABEL_STORAGE_CREDENTIAL_WRAP, hexToBytes(serverKek))
  return bytesToHex(ct)
}

/**
 * Decrypt a storage IAM secret key from at-rest storage.
 */
export function decryptStorageCredential(encrypted: string, serverKek: string): string {
  const ct = hexToBytes(encrypted)
  return new TextDecoder().decode(serverDecrypt(ct, LABEL_STORAGE_CREDENTIAL_WRAP, hexToBytes(serverKek)))
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
