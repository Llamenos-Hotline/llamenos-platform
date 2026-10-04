/**
 * Real HPKE encrypt/decrypt helpers for BDD step definitions (Epic 365).
 *
 * These use the EXACT same algorithms as `packages/crypto/src/encryption.rs`:
 * - AES-256-GCM for symmetric content encryption (12-byte nonce, AAD = label)
 * - HPKE (RFC 9180) key wrapping: DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM
 * - Wire format: hex(nonce_12 || ciphertext || tag_16)
 */
import { CipherSuite, KemId, KdfId, AeadId } from 'hpke-js'
import { contentAad, keyWrapAad } from '@shared/envelope-aad'
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { LABEL_DEVICE_ENCRYPTION_SEED, LABEL_MESSAGE } from '@shared/crypto-labels'
import { hpkeSealMock, base64urlDecode } from './mocks/hpke-mock'
import { utf8ToBytes } from '@noble/ciphers/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'

/** HPKE cipher suite matching Rust: DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM */
const hpkeSuite = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
})

/**
 * Derive an X25519 public key from a 32-byte seed.
 *
 * Ed25519 public keys and X25519 public keys are different byte representations
 * even when derived from the same seed. HPKE operations (key wrapping) require
 * X25519 keys, NOT Ed25519 keys.
 */
export function x25519PubkeyFromSeed(seedHex: string): string {
  return bytesToHex(x25519.getPublicKey(hexToBytes(seedHex)))
}

/**
 * The X25519 encryption public key the desktop client derives for a device it
 * imports from a known Ed25519 signing seed (`device_import_and_load`): the
 * encryption seed is HKDF-SHA256(signingSeed, salt="", info=LABEL_DEVICE_ENCRYPTION_SEED),
 * NOT the signing seed itself — so this differs from `x25519PubkeyFromSeed`.
 * A reader envelope is only found by the client when its `pubkey` equals this.
 */
export function deviceEncryptionPubkeyFromSigningSeed(signingSeedHex: string): string {
  const encryptionSeed = hkdf(
    sha256,
    hexToBytes(signingSeedHex),
    new Uint8Array(0),
    utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED),
    32,
  )
  return bytesToHex(x25519.getPublicKey(encryptionSeed))
}

/** Reader envelope in the wire shape the desktop client's `decryptMessage` consumes. */
export interface DesktopReaderEnvelope {
  pubkey: string
  /** Hex-encoded HPKE encapsulated key (PROTOCOL.md §2.4). */
  enc: string
  /** Hex-encoded wrapped content key (PROTOCOL.md §2.4). */
  ct: string
}

/**
 * Encrypt `plaintext` exactly as the server and the desktop client do, so the
 * UI can decrypt what a test seeds through the API:
 *   - content:  hex(iv(12) || AES-256-GCM(ct || tag)), AAD = UTF-8(label)
 *   - key wrap: HPKE seal under LABEL_MESSAGE, AAD = UTF-8(label + ':key-wrap'),
 *               one envelope per reader
 *
 * The AAD comes from `@shared/envelope-aad`, the same module `apps/worker/lib/crypto.ts`
 * and `src/client/lib/platform.ts` use — a seeder that spells the wire format
 * out for itself is a seeder that can pass while production is broken.
 *
 * Readers are given as Ed25519 signing seeds (the identity a test logs in with).
 */
export async function encryptMessageForDesktop(
  plaintext: string,
  readerSigningSeedHexes: string[],
): Promise<{ encryptedContent: string; readerEnvelopes: DesktopReaderEnvelope[] }> {
  const contentKey = generateContentKey()
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const sealed = gcm(contentKey, iv, contentAad(LABEL_MESSAGE)).encrypt(utf8ToBytes(plaintext))
  const packed = new Uint8Array(iv.length + sealed.length)
  packed.set(iv)
  packed.set(sealed, iv.length)

  const readerEnvelopes = await Promise.all(
    readerSigningSeedHexes.map(async (seedHex) => {
      const pubkey = deviceEncryptionPubkeyFromSigningSeed(seedHex)
      const envelope = await hpkeSealMock(contentKey, pubkey, LABEL_MESSAGE, keyWrapAad(LABEL_MESSAGE))
      return {
        pubkey,
        enc: bytesToHex(base64urlDecode(envelope.enc)),
        ct: bytesToHex(base64urlDecode(envelope.ct)),
      }
    }),
  )
  return { encryptedContent: bytesToHex(packed), readerEnvelopes }
}

/**
 * Generate an X25519 keypair for HPKE operations (key wrapping).
 * Returns raw 32-byte hex strings for both secret and public keys.
 */
export async function generateHpkeKeypair(): Promise<{ skHex: string; pubkeyHex: string }> {
  const kp = await hpkeSuite.generateKeyPair()
  const skRaw = await crypto.subtle.exportKey('raw', kp.privateKey)
  const pkRaw = await crypto.subtle.exportKey('raw', kp.publicKey)
  return {
    skHex: bytesToHex(new Uint8Array(skRaw)),
    pubkeyHex: bytesToHex(new Uint8Array(pkRaw)),
  }
}

// ---------------------------------------------------------------------------
// Symmetric content encryption (AES-256-GCM with AAD)
// ---------------------------------------------------------------------------

/** Generate a 32-byte random content key. */
export function generateContentKey(): Uint8Array {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return key
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns hex string: nonce(12) || ciphertext || tag(16).
 * AAD = label bytes (domain separation).
 * Matches the Rust `aes256gcm_encrypt` in `encryption.rs`.
 */
export function encryptContent(plaintext: string, key: Uint8Array, label: string): string {
  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)
  const aad = utf8ToBytes(label)
  const cipher = gcm(key, nonce, aad)
  const ciphertext = cipher.encrypt(utf8ToBytes(plaintext))

  const packed = new Uint8Array(nonce.length + ciphertext.length)
  packed.set(nonce)
  packed.set(ciphertext, nonce.length)

  return bytesToHex(packed)
}

/**
 * Decrypt hex ciphertext (nonce(12) || ct || tag(16)) with AES-256-GCM.
 * AAD = label bytes (domain separation).
 * Returns UTF-8 plaintext.
 */
export function decryptContent(ciphertextHex: string, key: Uint8Array, label: string): string {
  const data = hexToBytes(ciphertextHex)
  const nonce = data.slice(0, 12)
  const ct = data.slice(12)
  const aad = utf8ToBytes(label)
  const cipher = gcm(key, nonce, aad)
  return new TextDecoder().decode(cipher.decrypt(ct))
}

// ---------------------------------------------------------------------------
// HPKE key wrapping (RFC 9180: X25519-HKDF-SHA256-AES256-GCM)
// ---------------------------------------------------------------------------

/**
 * Wrap a content key for a recipient via HPKE (RFC 9180).
 *
 * Uses DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM.
 * info = label bytes, aad = "${label}:key-wrap" bytes.
 *
 * Output: { enc: hex(ephemeral_pubkey), ct: hex(ciphertext + tag) }
 *
 * Matches `hpke_wrap_key` in `packages/crypto/src/encryption.rs`.
 */
export async function wrapKeyForRecipient(
  contentKey: Uint8Array,
  recipientPubkeyHex: string,
  _senderSkHex: string,
  label: string,
): Promise<{ ct: string; enc: string }> {
  const recipientPub = await hpkeSuite.importKey('raw', Uint8Array.from(hexToBytes(recipientPubkeyHex)).buffer, true)
  const info = utf8ToBytes(label)
  const aad = keyWrapAad(label)

  const result = await hpkeSuite.seal(
    { recipientPublicKey: recipientPub, info },
    contentKey,
    aad,
  )

  return {
    enc: bytesToHex(new Uint8Array(result.enc)),
    ct: bytesToHex(new Uint8Array(result.ct)),
  }
}

/**
 * Unwrap a content key using the recipient's secret key via HPKE (RFC 9180).
 *
 * Reverses `wrapKeyForRecipient`: decapsulates the shared secret from enc,
 * then decrypts ct with the derived key.
 */
export async function unwrapKey(
  ctHex: string,
  encHex: string,
  recipientSkHex: string,
  label: string,
): Promise<Uint8Array> {
  const recipientSk = await hpkeSuite.importKey('raw', Uint8Array.from(hexToBytes(recipientSkHex)).buffer, false)
  const enc = hexToBytes(encHex)
  const ct = hexToBytes(ctHex)
  const info = utf8ToBytes(label)
  const aad = keyWrapAad(label)

  const plaintext = await hpkeSuite.open(
    { recipientKey: recipientSk, enc, info },
    ct,
    aad,
  )

  return new Uint8Array(plaintext)
}

// ---------------------------------------------------------------------------
// Self-test — verifies round-trip encrypt/decrypt and wrap/unwrap
// ---------------------------------------------------------------------------

if (import.meta.main) {
  console.log('Running crypto-helpers self-test...\n')

  // Test 1: Symmetric encrypt/decrypt round-trip
  const key = generateContentKey()
  const plaintext = 'Hello, world! This is a secret message.'
  const label = 'llamenos:note-key'
  const encrypted = encryptContent(plaintext, key, label)
  const decrypted = decryptContent(encrypted, key, label)
  console.assert(decrypted === plaintext, 'Symmetric round-trip failed')
  console.log('[PASS] Symmetric encrypt/decrypt round-trip')

  // Test 2: HPKE key wrap/unwrap round-trip
  const recipientKp = await generateHpkeKeypair()

  const contentKey = generateContentKey()
  const { ct, enc } = await wrapKeyForRecipient(
    contentKey, recipientKp.pubkeyHex, '', 'llamenos:message',
  )
  const unwrapped = await unwrapKey(ct, enc, recipientKp.skHex, 'llamenos:message')

  console.assert(
    bytesToHex(unwrapped) === bytesToHex(contentKey),
    'HPKE wrap/unwrap round-trip failed',
  )
  console.log('[PASS] HPKE key wrap/unwrap round-trip')

  // Test 3: Full envelope — encrypt content, wrap key, then unwrap and decrypt
  const noteText = 'Sensitive case notes about the call.'
  const noteKey = generateContentKey()
  const encryptedNote = encryptContent(noteText, noteKey, 'llamenos:note-key')
  const envelope = await wrapKeyForRecipient(
    noteKey, recipientKp.pubkeyHex, '', 'llamenos:note-key',
  )
  const recoveredKey = await unwrapKey(
    envelope.ct, envelope.enc, recipientKp.skHex, 'llamenos:note-key',
  )
  const recoveredNote = decryptContent(encryptedNote, recoveredKey, 'llamenos:note-key')
  console.assert(recoveredNote === noteText, 'Full envelope round-trip failed')
  console.log('[PASS] Full envelope round-trip (encrypt + wrap + unwrap + decrypt)')

  console.log('\nAll crypto-helpers self-tests passed.')
}
