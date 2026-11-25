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
import { ristretto255_oprf } from '@noble/curves/ed25519.js'
import { LABEL_BAN_KEY_DERIVE, HMAC_BAN_PREFIX } from '@shared/crypto-labels'

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
// HPKE envelopes, by shape — a stand-in, NOT the crate's wire format
// ---------------------------------------------------------------------------
//
// The real `shapeSeal` / `shapeOpen` run `packages/crypto/src/shape.rs`, which
// owns each shape's label and AAD. This mock only has to let Node-side unit tests
// import code that seals: it binds `mock:<shape>` and the fields, keeps the real
// lengths (enc 32 B, a key wrap's ct 48 B) so schema validation sees real
// shapes, and is never evidence of interop. The server's real envelopes are
// pinned against `packages/crypto/tests/fixtures/v2/` under bun:ffi
// (`__tests__/integration-bun/v2-vectors.test.ts`).

export class CryptoError extends Error {
  readonly reason: string | null
  constructor(public code: number, message: string) {
    super(message)
    this.name = 'CryptoError'
    const m = /^([a-z_]+): /.exec(message)
    this.reason = m ? m[1] : null
  }
}

export const SHAPES = [
  'note-key', 'file-key', 'file-metadata-key', 'contact-profile-key', 'contact-id-key',
  'hub-key', 'firehose-window-key', 'message-key', 'call-meta-key', 'puk-seed',
  'audit-user-key', 'push-wake', 'push-full', 'platform-role-name',
  'platform-role-description', 'recovery-group-share', 'recovery-share-contribution',
  'recovery-puk-seed',
] as const
export type Shape = (typeof SHAPES)[number]
export interface HpkeEnvelope { enc: string; ct: string }

const enc8 = (s: string) => new TextEncoder().encode(s)

function mockAead(shared: Uint8Array, enc: Uint8Array, shape: Shape, fields: readonly string[]) {
  const okm = hkdf(sha256Noble, shared, enc, enc8(`mock:${shape}`), 44)
  return { key: okm.subarray(0, 32), nonce: okm.subarray(32), aad: enc8(`mock:${shape}:${fields.join('|')}`) }
}

export function shapeSeal(shape: Shape, recipientPk: Uint8Array, fields: readonly string[], plaintext: Uint8Array): HpkeEnvelope {
  const eph = randomBytes(32)
  const enc = x25519.getPublicKey(eph)
  const { key, nonce, aad } = mockAead(x25519.getSharedSecret(eph, recipientPk), enc, shape, fields)
  return { enc: toHex(enc), ct: toHex(gcm(key, nonce, aad).encrypt(plaintext)) }
}

export function shapeOpen(shape: Shape, secretKey: Uint8Array, fields: readonly string[], envelope: HpkeEnvelope): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(envelope.enc) || !/^(?:[0-9a-f]{2})+$/.test(envelope.ct)) {
    throw new CryptoError(-5, 'invalid_format: enc/ct must be lowercase hex')
  }
  const enc = fromHex(envelope.enc)
  const { key, nonce, aad } = mockAead(x25519.getSharedSecret(secretKey, enc), enc, shape, fields)
  try {
    return gcm(key, nonce, aad).decrypt(fromHex(envelope.ct))
  } catch {
    throw new CryptoError(-1, 'decryption_failed: mock open failed')
  }
}

export function contentSeal(shape: Shape, plaintext: Uint8Array): { packed: Uint8Array; key: Uint8Array } {
  const key = randomBytes(32)
  return { packed: symmetricEncrypt(key, plaintext, enc8(`mock:${shape}:content`)), key }
}

export function contentSealUnder(shape: 'firehose-window-key', key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return symmetricEncrypt(key, plaintext, enc8(`mock:${shape}:content`))
}

export function contentOpen(shape: Shape, key: Uint8Array, packed: Uint8Array): Uint8Array {
  return symmetricDecrypt(key, packed, enc8(`mock:${shape}:content`))
}

// Relay events — a stand-in; the real module is `packages/crypto/src/events.rs`.
export function serverEventKey(serverSecret: Uint8Array, hubId: string, epoch: number): Uint8Array {
  return hkdf(sha256Noble, serverSecret, enc8('mock:server-event'), enc8(`${hubId}|${epoch}`), 32)
}

export function sealServerEvent(serverSecret: Uint8Array, hubId: string, kind: number, epoch: number, json: string): string {
  const key = serverEventKey(serverSecret, hubId, epoch)
  return toHex(symmetricEncrypt(key, enc8(json), enc8(`mock:event:${hubId}:${kind}:${epoch}`)))
}

export function openServerEvent(key: Uint8Array, hubId: string, kind: number, epoch: number, payloadHex: string): string {
  return new TextDecoder().decode(symmetricDecrypt(key, fromHex(payloadHex), enc8(`mock:event:${hubId}:${kind}:${epoch}`)))
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
    return { pubkey, ...shapeSeal('message-key', fromHex(pubkey), [MOCK_CASE_LABEL[purpose]], key) }
  })
  return { encryptedContent, readerEnvelopes }
}

export function caseOpen(purpose: CasePurpose, secretKey: Uint8Array, sealed: EncryptedCaseCiphertext): string {
  const pubkey = toHex(x25519.getPublicKey(secretKey))
  const env = sealed.readerEnvelopes.find(e => e.pubkey === pubkey)
  if (!env) throw new Error('no envelope for this reader')
  const label = new TextEncoder().encode(MOCK_CASE_LABEL[purpose])
  const key = shapeOpen('message-key', secretKey, [MOCK_CASE_LABEL[purpose]], env)
  return new TextDecoder().decode(symmetricDecrypt(key, fromHex(sealed.encryptedContent), label))
}

// ── Ban digest (RFC 9497 OPRF, ristretto255-SHA512) ─────────────────────
// The crate (`packages/crypto/src/ban_digest.rs`) and @noble/curves both implement the RFC
// and both are pinned to its test vectors; the real library's agreement with this one is
// asserted under bun:ffi in `__tests__/integration-bun/ban-digest.test.ts`.

/** RFC 9497 Evaluate, spelled as the interactive protocol it equals (noble types only the latter). */
function oprfEvaluate(secretKey: Uint8Array, input: Uint8Array): Uint8Array {
  const { blind, blinded } = ristretto255_oprf.oprf.blind(input)
  return ristretto255_oprf.oprf.finalize(input, blind, ristretto255_oprf.oprf.blindEvaluate(secretKey, blinded))
}

function banScopeKey(banHashKey: Uint8Array, scope: string): Uint8Array {
  if (banHashKey.length !== 32) throw new Error('BAN_HASH_KEY must be 32 bytes')
  if (!scope) throw new Error('ban scope must not be empty')
  return ristretto255_oprf.oprf.deriveKeyPair(banHashKey, new TextEncoder().encode(`${LABEL_BAN_KEY_DERIVE}:${scope}`)).secretKey
}

export function banDigestEvaluate(banHashKey: Uint8Array, scope: string, identifier: string): Uint8Array {
  if (!identifier) throw new Error('caller identifier must not be empty')
  return oprfEvaluate(banScopeKey(banHashKey, scope), new TextEncoder().encode(`${HMAC_BAN_PREFIX}${identifier}`))
}

export function banDigestBlindEvaluate(banHashKey: Uint8Array, scope: string, blinded: Uint8Array): Uint8Array {
  if (blinded.length !== 32) throw new Error('group element must be 32 bytes')
  return ristretto255_oprf.oprf.blindEvaluate(banScopeKey(banHashKey, scope), blinded)
}
