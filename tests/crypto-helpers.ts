/**
 * Real HPKE encrypt/decrypt helpers for BDD step definitions (Epic 365).
 *
 * These use the EXACT same algorithms as `packages/crypto/src/encryption.rs`:
 * - AES-256-GCM for symmetric content encryption (12-byte nonce, AAD = label)
 * - HPKE (RFC 9180) key wrapping: DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM
 * - Wire format: hex(nonce_12 || ciphertext || tag_16)
 */
import { CipherSuite, KemId, KdfId, AeadId } from 'hpke-js'
import { contentAad, keyWrapAad, NO_AAD } from '@shared/envelope-aad'
import { deriveAdminKeys } from '../scripts/bootstrap-admin'
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
 * The committed admin signing seed the whole test harness authenticates as.
 *
 * `tests/api-helpers.ts` re-exports it as `ADMIN_SEED`; it is owned here
 * because the admin's HPKE recipient key is derived here, and the guards below
 * have to be able to recognise the seed when it turns up where a secret
 * X25519 scalar belongs.
 */
export const ADMIN_SIGNING_SEED =
  'f54a5851e9372b87810a8e60cdd2e7cfd80b6e31c7af18188f7db106ceda8be7'

/**
 * A key that can receive HPKE: the X25519 public key an envelope is addressed
 * to, paired with the scalar that opens it.
 *
 * Returning the pair together is deliberate. Every instance of #1283 and its
 * descendants came from a call site holding one half and guessing the other —
 * addressing an envelope to key A and trying to open it with the secret for
 * key B, which HPKE reports only as an opaque `OpenError`.
 */
export interface TestHpkeRecipient {
  /** X25519 public key — what a reader envelope's `pubkey` field must equal. */
  readonly pubkeyHex: string
  /** The 32-byte X25519 secret scalar that opens envelopes sealed to `pubkeyHex`. */
  readonly skHex: string
}

/**
 * HKDF-SHA256(signingSeed, salt = "", info = LABEL_DEVICE_ENCRYPTION_SEED).
 *
 * The one derivation of a device's X25519 encryption secret from its Ed25519
 * signing seed, matching `device_import_and_load` in the Rust core,
 * `scripts/bootstrap-admin.ts`, and `apps/worker/lib/demo-crypto.ts`.
 */
function deviceEncryptionSeed(signingSeedHex: string): Uint8Array {
  return hkdf(
    sha256,
    hexToBytes(signingSeedHex),
    new Uint8Array(0),
    utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED),
    32,
  )
}

/**
 * Why `x25519PubkeyFromSeed(ADMIN_SEED)` is never the admin's reader key, said
 * once so the guards below can all point at it.
 */
const WRONG_ADMIN_KEY =
  "the admin is not addressed by its signing seed used as a raw X25519 scalar. " +
  "Every admin envelope — on a note, a message, a call record — is sealed to " +
  "ADMIN_DECRYPTION_PUBKEY, which is " +
  "X25519(HKDF-SHA256(signingSeed, info = LABEL_DEVICE_ENCRYPTION_SEED)): the key " +
  "scripts/bootstrap-admin.ts prints and CI configures. The raw-scalar key is one " +
  "nobody holds, so sealing to it succeeds and opening it never will. " +
  "Call adminHpkeRecipient() — it returns both halves. " +
  "(This trap has now been walked into three times: #1283, and twice in the live " +
  "acceptance suite.)"

/**
 * Refuse the admin signing seed where a secret X25519 scalar is expected.
 *
 * A runtime guard rather than a type, because the seed reaches these helpers
 * through plainly-typed `string` fields on scenario state — which is exactly
 * how it kept slipping past review.
 */
function refuseAdminSeedAsX25519Secret(seedHex: string, fn: string): void {
  if (seedHex.toLowerCase() === ADMIN_SIGNING_SEED) {
    throw new Error(`${fn}: ${WRONG_ADMIN_KEY}`)
  }
}

/**
 * Derive an X25519 public key by treating a 32-byte seed as the secret scalar.
 *
 * This is the convention for identities the tests mint themselves: whatever
 * `registerDeviceKeyViaApi` registers as a device's `x25519Pubkey` is exactly
 * this, so the server seals to it and the same seed opens it.
 *
 * It is NOT how the admin is addressed — see `adminHpkeRecipient`. Passing
 * `ADMIN_SEED` here throws rather than returning a key no secret exists for.
 */
export function x25519PubkeyFromSeed(seedHex: string): string {
  refuseAdminSeedAsX25519Secret(seedHex, 'x25519PubkeyFromSeed')
  return bytesToHex(x25519.getPublicKey(hexToBytes(seedHex)))
}

/**
 * The HPKE recipient for a test identity whose device key the tests registered
 * through `registerDeviceKeyViaApi` — the raw-scalar convention.
 */
export function testDeviceHpkeRecipient(seedHex: string): TestHpkeRecipient {
  return { pubkeyHex: x25519PubkeyFromSeed(seedHex), skHex: seedHex }
}

/**
 * The HPKE recipient a client derives for a device it IMPORTS from a known
 * signing seed (`device_import_and_load`): the encryption key is HKDF'd from
 * the signing seed, not the signing seed itself.
 *
 * This is what the admin and the demo accounts are — any identity whose
 * encryption key the server learned from configuration or a seeder rather than
 * from a device registration.
 */
export function importedDeviceHpkeRecipient(signingSeedHex: string): TestHpkeRecipient {
  const skHex = bytesToHex(deviceEncryptionSeed(signingSeedHex))
  return { pubkeyHex: bytesToHex(x25519.getPublicKey(hexToBytes(skHex))), skHex }
}

/**
 * The X25519 encryption public key a client derives for an imported device.
 * Kept as its own export because several call sites want only the address.
 */
export function deviceEncryptionPubkeyFromSigningSeed(signingSeedHex: string): string {
  return importedDeviceHpkeRecipient(signingSeedHex).pubkeyHex
}

/**
 * Keys that look like a valid HPKE recipient for the admin and are not.
 *
 * X25519 accepts any 32 bytes as a peer public key, so sealing to either of
 * these produces a structurally perfect envelope for which no secret exists:
 *
 *   - the signing seed used as a raw X25519 scalar (what
 *     `x25519PubkeyFromSeed(ADMIN_SEED)` returned);
 *   - the admin's Ed25519 *identity* pubkey (#1283's original shape — the
 *     server makes this one a compile error via `lib/hpke-recipient.ts`).
 */
const UNHOLDABLE_ADMIN_KEYS: ReadonlySet<string> = new Set([
  bytesToHex(x25519.getPublicKey(hexToBytes(ADMIN_SIGNING_SEED))),
  deriveAdminKeys(hexToBytes(ADMIN_SIGNING_SEED)).identityPubkey,
])

let adminRecipient: TestHpkeRecipient | undefined

/**
 * The admin's HPKE recipient key — the only key an admin envelope opens with.
 *
 * The single named way to obtain it, so no call site re-derives it. The
 * derivation is cross-checked against `deriveAdminKeys`, the function
 * `scripts/bootstrap-admin.ts` prints `ADMIN_DECRYPTION_PUBKEY` from and the
 * value CI's `TEST_ADMIN_DECRYPTION_PUBKEY` carries: if the two ever disagree
 * this throws instead of handing back a key that quietly opens nothing.
 */
export function adminHpkeRecipient(): TestHpkeRecipient {
  if (!adminRecipient) {
    const derived = importedDeviceHpkeRecipient(ADMIN_SIGNING_SEED)
    const canonical = deriveAdminKeys(hexToBytes(ADMIN_SIGNING_SEED)).decryptionPubkey
    if (derived.pubkeyHex !== canonical) {
      throw new Error(
        'adminHpkeRecipient: this module derives a different admin X25519 key than ' +
        'scripts/bootstrap-admin.ts does, so nothing sealed to the configured ' +
        'ADMIN_DECRYPTION_PUBKEY would open. Fix the derivation, not this check.',
      )
    }
    adminRecipient = derived
  }
  return adminRecipient
}

/**
 * The HPKE recipient for a test identity, given its Ed25519 signing seed.
 *
 * **The only seed → recipient function test code should call.** Two conventions
 * exist and the distinction is invisible at the call site:
 *
 *   - identities the tests mint are addressed by the seed as a raw X25519
 *     scalar, because that is what `registerDeviceKeyViaApi` registers as the
 *     device's `x25519Pubkey` and therefore what the server seals to;
 *   - the admin is addressed by its HKDF-derived encryption key, because the
 *     server learned that key from `ADMIN_DECRYPTION_PUBKEY` rather than from a
 *     device registration.
 *
 * Getting that wrong produces a well-formed envelope no secret opens — #1283,
 * and twice more in the live acceptance suite. Dispatching here, once, is why
 * `x25519PubkeyFromSeed` now refuses the admin seed outright: there is a
 * correct function to call instead.
 */
export function hpkeRecipientForSeed(signingSeedHex: string): TestHpkeRecipient {
  return signingSeedHex.toLowerCase() === ADMIN_SIGNING_SEED
    ? adminHpkeRecipient()
    : testDeviceHpkeRecipient(signingSeedHex)
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
 * Encrypt `plaintext` exactly as the desktop client's `encryptMessage` does, so the
 * UI can decrypt what a test seeds through the API. Messages are stored
 * records (#1393): NO AAD on either layer, the label bound as HPKE `info` only —
 * the same format the server's `encryptMessageForStorage` writes, so both
 * directions interop:
 *   - content:  hex(iv(12) || AES-256-GCM(ct || tag)), aad = empty
 *   - key wrap: HPKE seal under LABEL_MESSAGE, info = label, aad = empty,
 *               one envelope per reader; enc/ct both hex (wire format)
 *
 * The HPKE primitive is the real RFC 9180 suite (`tests/mocks/hpke-mock.ts`),
 * the one the Playwright Tauri IPC mock serves and the Rust FFI implements, so
 * this seeder interoperates with the mocked desktop client AND the real Rust
 * core. The canonical `contentAad`/`keyWrapAad` pair is for notes/files/contacts
 * only — never derive it for LABEL_MESSAGE.
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
  const sealed = gcm(contentKey, iv).encrypt(utf8ToBytes(plaintext))
  const packed = new Uint8Array(iv.length + sealed.length)
  packed.set(iv)
  packed.set(sealed, iv.length)

  const readerEnvelopes = await Promise.all(
    readerSigningSeedHexes.map(async (seedHex) => {
      const pubkey = deviceEncryptionPubkeyFromSigningSeed(seedHex)
      const envelope = await hpkeSealMock(contentKey, pubkey, LABEL_MESSAGE, new Uint8Array(0))
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
 * Encrypt plaintext with AES-256-GCM under the **canonical** content AAD.
 *
 * Returns hex string: nonce(12) || ciphertext || tag(16), aad =
 * `contentAad(label)`. Matches the Rust `aes256gcm_encrypt` in `encryption.rs`.
 * A stored record the server wrote has no content AAD — read those with
 * `decryptStoredRecordContent`.
 */
export function encryptContent(plaintext: string, key: Uint8Array, label: string): string {
  const nonce = new Uint8Array(12)
  crypto.getRandomValues(nonce)
  const aad = contentAad(label)
  const cipher = gcm(key, nonce, aad)
  const ciphertext = cipher.encrypt(utf8ToBytes(plaintext))

  const packed = new Uint8Array(nonce.length + ciphertext.length)
  packed.set(nonce)
  packed.set(ciphertext, nonce.length)

  return bytesToHex(packed)
}

/**
 * Decrypt hex ciphertext (nonce(12) || ct || tag(16)) with AES-256-GCM under
 * the **canonical** content AAD (`contentAad(label)`).
 *
 * The inverse of `encryptContent`, and only of that. For a record the server
 * sealed use `decryptStoredRecordContent`.
 */
export function decryptContent(ciphertextHex: string, key: Uint8Array, label: string): string {
  const data = hexToBytes(ciphertextHex)
  const nonce = data.slice(0, 12)
  const ct = data.slice(12)
  const aad = contentAad(label)
  const cipher = gcm(key, nonce, aad)
  return new TextDecoder().decode(cipher.decrypt(ct))
}

// ---------------------------------------------------------------------------
// HPKE key wrapping (RFC 9180: X25519-HKDF-SHA256-AES256-GCM)
// ---------------------------------------------------------------------------

/**
 * Wrap a content key for a recipient via HPKE (RFC 9180), **canonical AAD**.
 *
 * Uses DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM, with
 * info = label bytes and aad = `keyWrapAad(label)`. That is the convention for
 * notes, files, contacts, hub keys, recovery material, and anything the demo
 * seeder writes — see `@shared/envelope-aad`.
 *
 * It is NOT the convention for a record the SERVER sealed
 * (`apps/worker/lib/crypto.ts`): those carry no AAD on either layer. Readers of
 * those use `openStoredRecordKey`.
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
  if (UNHOLDABLE_ADMIN_KEYS.has(recipientPubkeyHex.toLowerCase())) {
    throw new Error(`wrapKeyForRecipient: ${WRONG_ADMIN_KEY}`)
  }
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

/** Shared HPKE open, so the two conventions differ only in the AAD they pass. */
async function hpkeOpenKeyWrap(
  ctHex: string,
  encHex: string,
  recipientSkHex: string,
  label: string,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const recipientSk = await hpkeSuite.importKey('raw', Uint8Array.from(hexToBytes(recipientSkHex)).buffer, false)
  const plaintext = await hpkeSuite.open(
    { recipientKey: recipientSk, enc: hexToBytes(encHex), info: utf8ToBytes(label) },
    hexToBytes(ctHex),
    aad,
  )
  return new Uint8Array(plaintext)
}

/**
 * Unwrap a content key via HPKE (RFC 9180), **canonical AAD**.
 *
 * The exact inverse of `wrapKeyForRecipient`, and only of that: it binds
 * `keyWrapAad(label)`, so it opens notes, files, contacts, hub keys, recovery
 * material and demo-seeded records — never a record the server sealed.
 *
 * `OpenError` from hpke-js says only "the operation failed", with no hint as to
 * which of the two #1393 conventions the envelope actually carries. That cost
 * an entire blocked merge queue, so the failure is re-thrown naming the other
 * convention and the helper that implements it.
 */
export async function unwrapKey(
  ctHex: string,
  encHex: string,
  recipientSkHex: string,
  label: string,
): Promise<Uint8Array> {
  refuseAdminSeedAsX25519Secret(recipientSkHex, 'unwrapKey')
  try {
    return await hpkeOpenKeyWrap(ctHex, encHex, recipientSkHex, label, keyWrapAad(label))
  } catch (cause) {
    throw new Error(
      `unwrapKey: could not open this key wrap for "${label}" under the canonical AAD ` +
      `("${label}:key-wrap"). If the envelope was sealed by apps/worker/lib/crypto.ts — ` +
      `any conversation message, voicemail transcript or call-metadata record the SERVER ` +
      `wrote — it carries NO AAD on either layer (#1393): open it with ` +
      `openStoredRecordKey() and decrypt the content with decryptStoredRecordContent(). ` +
      `Otherwise the recipient secret does not match the envelope's pubkey.`,
      { cause },
    )
  }
}

/**
 * Open the HPKE key wrap of a **stored record** — one the server sealed.
 *
 * `apps/worker/lib/crypto.ts` (`encryptMessageForStorage`,
 * `encryptCallRecordForStorage`) binds the label as HPKE `info` and passes no
 * AAD, because client-sealed and server-sealed rows share a conversation with
 * no format marker, so a reader cannot tell which AAD to supply. This is the
 * reader for those rows, and the only one.
 */
export async function openStoredRecordKey(
  ctHex: string,
  encHex: string,
  recipientSkHex: string,
  label: string,
): Promise<Uint8Array> {
  refuseAdminSeedAsX25519Secret(recipientSkHex, 'openStoredRecordKey')
  try {
    return await hpkeOpenKeyWrap(ctHex, encHex, recipientSkHex, label, NO_AAD)
  } catch (cause) {
    throw new Error(
      `openStoredRecordKey: could not open this key wrap for "${label}" with no AAD. ` +
      `If the envelope was written canonically — by a client, by ` +
      `apps/worker/lib/demo-crypto.ts, or by the Rust interop vectors — it binds ` +
      `"${label}:key-wrap" and opens with unwrapKey(). Otherwise the recipient secret ` +
      `does not match the envelope's pubkey (for the admin, use adminHpkeRecipient()).`,
      { cause },
    )
  }
}

/**
 * Decrypt the AES-256-GCM content layer of a **stored record**: no AAD.
 *
 * The content counterpart of `openStoredRecordKey`. It takes no label, because
 * there is no AAD for a label to go into — passing one would only invite the
 * assumption that the label decides the convention. It does not; the writer
 * does (`@shared/envelope-aad`).
 */
export function decryptStoredRecordContent(ciphertextHex: string, key: Uint8Array): string {
  const data = hexToBytes(ciphertextHex)
  return new TextDecoder().decode(gcm(key, data.slice(0, 12), NO_AAD).decrypt(data.slice(12)))
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
