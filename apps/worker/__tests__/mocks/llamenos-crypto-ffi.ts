/**
 * Pure-TypeScript test mock for @llamenos/crypto/ffi.
 *
 * The real ffi.ts uses bun:ffi to call the Rust native library (.so),
 * which is unavailable in the Vitest (Node) environment. This mock
 * re-implements the same contract using @noble/curves and @noble/hashes
 * so unit tests can import any code that transitively imports auth.ts
 * or server-identity.ts without loading the native library.
 *
 * HPKE is implemented as X25519-HKDF-SHA256 + AES-256-GCM (simplified
 * base mode matching the Rust implementation's wire format).
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 as sha256Noble } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { gcm } from '@noble/ciphers/aes.js'
import { concatBytes } from '@noble/hashes/utils.js'

export function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len)
  crypto.getRandomValues(out)
  return out
}

export function sha256(data: Uint8Array): Uint8Array {
  return sha256Noble(data)
}

export function sha256Hash(data: Uint8Array): Uint8Array {
  return sha256Noble(data)
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256Noble, key, data)
}

export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  return hkdf(sha256Noble, ikm, salt.length > 0 ? salt : undefined, info.length > 0 ? info : undefined, len)
}

export function ed25519Sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey)
}

export function ed25519Verify(pubkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, pubkey)
  } catch {
    return false
  }
}

export function ed25519PubkeyFromSeed(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed)
}

// ---------------------------------------------------------------------------
// HPKE Base Mode (X25519-HKDF-SHA256-AES256GCM) — simplified mock
// ---------------------------------------------------------------------------

/**
 * HPKE Seal: encrypt plaintext for recipientPk.
 * The `label` parameter must be a registered domain separation label
 * (enforced in the real FFI; mock accepts any bytes for test flexibility).
 * Returns: enc(32 bytes) || ciphertext+tag
 */
export function hpkeSeal(recipientPk: Uint8Array, plaintext: Uint8Array, label: Uint8Array, aad: Uint8Array): Uint8Array {
  // 1. Generate ephemeral X25519 keypair
  const ephSecretKey = randomBytes(32)
  const enc = x25519.getPublicKey(ephSecretKey) // 32 bytes

  // 2. ECDH: shared_secret = X25519(ephSecretKey, recipientPk)
  const sharedSecret = x25519.getSharedSecret(ephSecretKey, recipientPk)

  // 3. KDF: derive symmetric key via HKDF
  const kem_context = concatBytes(enc, recipientPk)
  const prk = hkdf(sha256Noble, sharedSecret, new Uint8Array(0), kem_context, 32)
  const symmetricKey = hkdf(sha256Noble, prk, new Uint8Array(0), label, 32)

  // 4. AEAD: AES-256-GCM encrypt
  const nonce = randomBytes(12)
  const cipher = gcm(symmetricKey, nonce, aad)
  const ciphertext = cipher.encrypt(plaintext)

  // Wire format: enc(32) || nonce(12) || ciphertext+tag
  return concatBytes(enc, nonce, ciphertext)
}

/**
 * HPKE Open: decrypt ciphertext using secretKey.
 * The `label` parameter must match the label used during seal.
 * envelope = enc(32) || nonce(12) || ciphertext+tag
 */
export function hpkeOpen(secretKey: Uint8Array, envelope: Uint8Array, label: Uint8Array, aad: Uint8Array): Uint8Array {
  const enc = envelope.subarray(0, 32)
  const nonce = envelope.subarray(32, 44)
  const ciphertext = envelope.subarray(44)

  // Compute recipient public key from secret key
  const recipientPk = x25519.getPublicKey(secretKey)

  // ECDH: shared_secret = X25519(secretKey, enc)
  const sharedSecret = x25519.getSharedSecret(secretKey, enc)

  // KDF
  const kem_context = concatBytes(enc, recipientPk)
  const prk = hkdf(sha256Noble, sharedSecret, new Uint8Array(0), kem_context, 32)
  const symmetricKey = hkdf(sha256Noble, prk, new Uint8Array(0), label, 32)

  // AEAD decrypt
  const cipher = gcm(symmetricKey, nonce, aad)
  return cipher.decrypt(ciphertext)
}

// ---------------------------------------------------------------------------
// Symmetric encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Symmetric encrypt: AES-256-GCM.
 * Returns: nonce(12) || ciphertext+tag
 */
export function symmetricEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const nonce = randomBytes(12)
  const cipher = gcm(key, nonce, aad)
  const ciphertext = cipher.encrypt(plaintext)
  return concatBytes(nonce, ciphertext)
}

/**
 * Symmetric decrypt: AES-256-GCM.
 * Input: nonce(12) || ciphertext+tag
 */
export function symmetricDecrypt(key: Uint8Array, data: Uint8Array, aad: Uint8Array): Uint8Array {
  const nonce = data.subarray(0, 12)
  const ciphertext = data.subarray(12)
  const cipher = gcm(key, nonce, aad)
  return cipher.decrypt(ciphertext)
}

// ---------------------------------------------------------------------------
// Case records + case comments (#2499)
// ---------------------------------------------------------------------------
//
// The real `caseSeal` / `caseOpen` run `packages/crypto/src/case_record.rs`.
// This stand-in exists only so Node-side unit tests can import code that seals
// case ciphertexts (the sample seeder). It is built on this file's simplified
// HPKE, so its bytes are NOT the real wire format and nothing here may be read
// as evidence of interop: the server's real case seal is pinned against the
// server-persisted vectors by
// `apps/worker/__tests__/integration-bun/case-record-vectors.test.ts`, on the
// genuine native library.

export const CasePurpose = { summary: 0, fields: 1, comment: 2 } as const
export type CasePurpose = keyof typeof CasePurpose

export interface EncryptedCaseCiphertext {
  encryptedContent: string
  readerEnvelopes: { pubkey: string; enc: string; ct: string }[]
}

const MOCK_CASE_LABEL: Record<CasePurpose, string> = {
  summary: 'mock:case-summary',
  fields: 'mock:case-fields',
  comment: 'mock:case-comment',
}

const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => new Uint8Array((h.match(/.{2}/g) ?? []).map(x => parseInt(x, 16)))

export function caseSeal(purpose: CasePurpose, plaintext: string, readerPubkeys: readonly string[]): EncryptedCaseCiphertext {
  const readers = [...new Set(readerPubkeys.map(p => p.toLowerCase()))]
  if (readers.length === 0) throw new Error('case ciphertext has no readers')
  const label = new TextEncoder().encode(MOCK_CASE_LABEL[purpose])
  const key = randomBytes(32)
  const encryptedContent = toHex(symmetricEncrypt(key, new TextEncoder().encode(plaintext), label))
  const readerEnvelopes = readers.map((pubkey) => {
    const sealed = hpkeSeal(fromHex(pubkey), key, label, label)
    return { pubkey, enc: toHex(sealed.subarray(0, 32)), ct: toHex(sealed.subarray(32)) }
  })
  return { encryptedContent, readerEnvelopes }
}

export function caseOpen(purpose: CasePurpose, secretKey: Uint8Array, sealed: EncryptedCaseCiphertext): string {
  const pubkey = toHex(x25519.getPublicKey(secretKey))
  const env = sealed.readerEnvelopes.find(e => e.pubkey === pubkey)
  if (!env) throw new Error('no envelope for this reader')
  const label = new TextEncoder().encode(MOCK_CASE_LABEL[purpose])
  const key = hpkeOpen(secretKey, concatBytes(fromHex(env.enc), fromHex(env.ct)), label, label)
  return new TextDecoder().decode(symmetricDecrypt(key, fromHex(sealed.encryptedContent), label))
}
