/**
 * Envelope encryption for the sample dataset.
 *
 * The sample accounts' device keys are derived exactly the way the desktop client
 * derives them when it imports a sample seed (`device_import_and_load`):
 *   encryptionSeed = HKDF-SHA256(signingSeed, salt = none, info = LABEL_DEVICE_ENCRYPTION_SEED)
 *   encryptionPubkey = X25519(encryptionSeed)
 *
 * Content is encrypted in the envelope wire format the real UI decrypts: a
 * random per-item AES-256-GCM key (hex(iv || ct || tag)), HPKE-wrapped per
 * reader, both layers through the crate's shape API — the crate chooses the
 * label and AAD for the shape (spec D1). Envelopes carry lowercase hex `enc`
 * and `ct` (spec D2).
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { caseSeal, contentSeal, hkdfSha256, shapeSeal, type CasePurpose, type Shape } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_DEVICE_ENCRYPTION_SEED } from '@shared/crypto-labels'
import type { RecipientEnvelope } from '@shared/types'
import type { SampleIdentity } from './sample-identities'

/** An account that can read sample content: identified by its signing pubkey, sealed to its X25519 key. */
export interface SampleReader {
  /** Ed25519 signing pubkey (the account identity; what envelopes are addressed to). */
  pubkey: string
  /** X25519 encryption pubkey the HPKE key wrap is sealed to. */
  encryptionPubkey: string
}

/** X25519 encryption pubkey of a sample account, derived from its Ed25519 signing seed. */
export function deriveSampleEncryptionPubkey(signingSeedHex: string): string {
  const encryptionSeed = hkdfSha256(
    hexToBytes(signingSeedHex),
    new Uint8Array(0),
    utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED),
    32,
  )
  return bytesToHex(x25519.getPublicKey(encryptionSeed))
}

/** A sample account as an envelope reader: addressed by signing pubkey, sealed to its derived X25519 key. */
export function sampleReader(identity: SampleIdentity): SampleReader {
  return { pubkey: identity.pubkey, encryptionPubkey: deriveSampleEncryptionPubkey(identity.seedHex) }
}

/**
 * Encrypt `plaintext` under a fresh content key and HPKE-wrap that key for
 * every reader, as `shape`.
 */
export function sealForReaders(
  plaintext: string,
  readers: SampleReader[],
  shape: Extract<Shape, 'note-key' | 'message-key' | 'call-meta-key'>,
): { encryptedContent: string; envelopes: RecipientEnvelope[] } {
  const { packed, key } = contentSeal(shape, utf8ToBytes(plaintext))
  const envelopes = readers.map((reader): RecipientEnvelope => ({
    pubkey: reader.pubkey,
    ...shapeSeal(shape, hexToBytes(reader.encryptionPubkey), [], key),
  }))
  key.fill(0)
  const encryptedContent = bytesToHex(packed)
  return { encryptedContent, envelopes }
}

/**
 * Seal a case record's summary or fields, or a case comment, for every reader.
 *
 * Not [sealForReaders]: a case ciphertext's label, AAD and envelope addressing
 * are decided in `packages/crypto/src/case_record.rs`, the same code every
 * client runs (#2499), so the sample cases open in the real UI on every
 * platform. Envelopes are addressed to each reader's X25519 key.
 */
export function sealCaseForReaders(
  purpose: CasePurpose,
  plaintext: string,
  readers: SampleReader[],
): { encryptedContent: string; envelopes: RecipientEnvelope[] } {
  const sealed = caseSeal(purpose, plaintext, readers.map(r => r.encryptionPubkey))
  return { encryptedContent: sealed.encryptedContent, envelopes: sealed.readerEnvelopes }
}
