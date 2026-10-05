/**
 * Envelope encryption for the demo dataset.
 *
 * The demo accounts' device keys are derived exactly the way the desktop client
 * derives them when it imports a demo seed (`device_import_and_load`):
 *   encryptionSeed = HKDF-SHA256(signingSeed, salt = none, info = LABEL_DEVICE_ENCRYPTION_SEED)
 *   encryptionPubkey = X25519(encryptionSeed)
 *
 * Content is encrypted in the canonical envelope wire format so the real UI can
 * decrypt it: a random per-item AES-256-GCM key (hex(iv || ct || tag)) bound to
 * `contentAad(label)`, HPKE-wrapped per reader under a registered
 * domain-separation label bound to `keyWrapAad(label)`; envelopes carry hex
 * `enc` and base64url `ct`. Both AADs come from `@shared/envelope-aad` — the
 * same single definition the desktop client and the Rust core derive — never
 * re-spelt here.
 */
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdfSha256, hpkeSeal, randomBytes, symmetricEncrypt } from '@llamenos/crypto/ffi'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { contentAad, keyWrapAad } from '@shared/envelope-aad'
import { LABEL_DEVICE_ENCRYPTION_SEED } from '@shared/crypto-labels'
import type { RecipientEnvelope } from '@shared/types'
import type { DemoIdentity } from './demo-identities'

/** An account that can read demo content: identified by its signing pubkey, sealed to its X25519 key. */
export interface DemoReader {
  /** Ed25519 signing pubkey (the account identity; what envelopes are addressed to). */
  pubkey: string
  /** X25519 encryption pubkey the HPKE key wrap is sealed to. */
  encryptionPubkey: string
}

/** X25519 encryption pubkey of a demo account, derived from its Ed25519 signing seed. */
export function deriveDemoEncryptionPubkey(signingSeedHex: string): string {
  const encryptionSeed = hkdfSha256(
    hexToBytes(signingSeedHex),
    new Uint8Array(0),
    utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED),
    32,
  )
  return bytesToHex(x25519.getPublicKey(encryptionSeed))
}

/** A demo account as an envelope reader: addressed by signing pubkey, sealed to its derived X25519 key. */
export function demoReader(identity: DemoIdentity): DemoReader {
  return { pubkey: identity.pubkey, encryptionPubkey: deriveDemoEncryptionPubkey(identity.seedHex) }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Encrypt `plaintext` under a fresh random content key and HPKE-wrap that key
 * for every reader with `label` (a constant from crypto-labels).
 */
export function sealForReaders(
  plaintext: string,
  readers: DemoReader[],
  label: string,
): { encryptedContent: string; envelopes: RecipientEnvelope[] } {
  const contentKey = randomBytes(32)
  const encryptedContent = bytesToHex(symmetricEncrypt(contentKey, utf8ToBytes(plaintext), contentAad(label)))
  const labelBytes = utf8ToBytes(label)
  const aadKeyWrap = keyWrapAad(label)

  const envelopes = readers.map((reader): RecipientEnvelope => {
    // hpkeSeal output is enc(32) || ct+tag
    const sealed = hpkeSeal(hexToBytes(reader.encryptionPubkey), contentKey, labelBytes, aadKeyWrap)
    return {
      pubkey: reader.pubkey,
      enc: bytesToHex(sealed.subarray(0, 32)),
      ct: base64url(sealed.subarray(32)),
    }
  })

  return { encryptedContent, envelopes }
}
