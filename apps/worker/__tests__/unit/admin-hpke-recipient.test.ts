/**
 * The admin's HPKE recipient key: what the server does when it does not have
 * one, and why the answer matters (#1283).
 *
 * The defect these tests pin: `ADMIN_DECRYPTION_PUBKEY || ADMIN_PUBKEY`.
 * ADMIN_PUBKEY is the admin's Ed25519 *signing* key; the admin envelope on
 * every note is HPKE, whose KEM is DHKEM(X25519). X25519 accepts any 32 bytes
 * as a peer public key, so `hpkeSeal` to an Ed25519 key does not throw, does
 * not warn, and produces a structurally perfect envelope for which no secret
 * key exists. The note is written, the UI reports success, and the content is
 * gone — discovered later, or never. For a crisis hotline the lost artefact is
 * the record of a call.
 *
 * The first group is pure configuration logic. The second demonstrates the
 * consequence with real X25519 arithmetic, using the admin keypair derived from
 * the committed test seed, so the claim "these keys are not interchangeable" is
 * shown rather than asserted.
 */
import { describe, it, expect } from 'vitest'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { validateConfig } from '@worker/lib/config'
import {
  adminHpkeRecipient,
  hpkeRecipientPubkey,
  ed25519AuthPubkey,
} from '@worker/lib/hpke-recipient'
import { encryptMessageForStorage } from '@worker/lib/crypto'
import { hpkeOpen } from '@llamenos/crypto/ffi'
import { LABEL_MESSAGE, LABEL_DEVICE_ENCRYPTION_SEED } from '@shared/crypto-labels'
import { deriveAdminKeys } from '../../../../scripts/bootstrap-admin'

/** The admin seed every test harness in this repo already uses. */
const ADMIN_SEED = 'f54a5851e9372b87810a8e60cdd2e7cfd80b6e31c7af18188f7db106ceda8be7'
const ADMIN = deriveAdminKeys(hexToBytes(ADMIN_SEED))

/** A deployment env that boots, minus the admin keys. */
function envWithoutAdmin(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://llamenos:dev@localhost:5432/llamenos',
    HMAC_SECRET: 'a'.repeat(64),
    SERVER_SECRET: 'b'.repeat(64),
    HOTLINE_NAME: 'Test Hotline',
    ENVIRONMENT: 'test',
  }
}

describe('validateConfig: the admin HPKE recipient', () => {
  it('boots when both admin keys are configured', () => {
    expect(() => validateConfig({
      ...envWithoutAdmin(),
      ADMIN_PUBKEY: ADMIN.identityPubkey,
      ADMIN_DECRYPTION_PUBKEY: ADMIN.decryptionPubkey,
    })).not.toThrow()
  })

  it('boots when neither is configured — the bootstrap-via-desktop path', () => {
    expect(() => validateConfig(envWithoutAdmin())).not.toThrow()
  })

  /**
   * The condition an operator actually hits: `admin_pubkey` filled in from
   * `bootstrap-admin`, `admin_decryption_pubkey` left at its empty default.
   * The server used to start happily and begin destroying notes.
   */
  it('refuses to boot with ADMIN_PUBKEY set and no ADMIN_DECRYPTION_PUBKEY', () => {
    expect(() => validateConfig({
      ...envWithoutAdmin(),
      ADMIN_PUBKEY: ADMIN.identityPubkey,
    })).toThrow(/ADMIN_DECRYPTION_PUBKEY/)
  })

  it('treats an empty or whitespace-only ADMIN_DECRYPTION_PUBKEY as absent', () => {
    for (const blank of ['', '   ']) {
      expect(() => validateConfig({
        ...envWithoutAdmin(),
        ADMIN_PUBKEY: ADMIN.identityPubkey,
        ADMIN_DECRYPTION_PUBKEY: blank,
      }), `ADMIN_DECRYPTION_PUBKEY=${JSON.stringify(blank)} was accepted`).toThrow(/ADMIN_DECRYPTION_PUBKEY/)
    }
  })

  /**
   * Equal values mean one key was pasted into both slots. If it is the Ed25519
   * one — the likelier mistake, since that is the key operators are used to
   * copying — the deployment is in exactly the broken state, just spelled
   * explicitly instead of by omission.
   */
  it('refuses to boot when the two admin keys are the same value', () => {
    expect(() => validateConfig({
      ...envWithoutAdmin(),
      ADMIN_PUBKEY: ADMIN.identityPubkey,
      ADMIN_DECRYPTION_PUBKEY: ADMIN.identityPubkey,
    })).toThrow(/identical/)
  })

  it('refuses to boot on a malformed ADMIN_DECRYPTION_PUBKEY', () => {
    for (const bad of ['not-a-key', 'ABCD'.repeat(16), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(() => validateConfig({
        ...envWithoutAdmin(),
        ADMIN_PUBKEY: ADMIN.identityPubkey,
        ADMIN_DECRYPTION_PUBKEY: bad,
      }), `accepted ${bad.slice(0, 12)}…`).toThrow(/ADMIN_DECRYPTION_PUBKEY/)
    }
  })
})

describe('adminHpkeRecipient', () => {
  it('returns the X25519 key when it is configured', () => {
    expect(adminHpkeRecipient({
      ADMIN_PUBKEY: ADMIN.identityPubkey,
      ADMIN_DECRYPTION_PUBKEY: ADMIN.decryptionPubkey,
    })).toBe(ADMIN.decryptionPubkey)
  })

  /**
   * No fallback. There is nothing for this function to return when the X25519
   * key is absent, and ADMIN_PUBKEY is not a substitute for it — the whole
   * defect was treating it as one.
   */
  it('returns undefined rather than ADMIN_PUBKEY when the X25519 key is absent', () => {
    expect(adminHpkeRecipient({ ADMIN_PUBKEY: ADMIN.identityPubkey })).toBeUndefined()
  })

  it('rejects a malformed X25519 key instead of passing it through', () => {
    expect(adminHpkeRecipient({ ADMIN_DECRYPTION_PUBKEY: 'decrypt-pk' })).toBeUndefined()
  })

  /**
   * The nominal types, exercised at runtime. `HpkeRecipientPubkey` and
   * `Ed25519AuthPubkey` are phantom-branded strings: at compile time neither is
   * assignable to the other, and a bare `string` is assignable to neither. The
   * compile-time half cannot be asserted from inside a test that must compile,
   * so it is pinned by a `@ts-expect-error` — which fails the build if the
   * assignment ever becomes legal again.
   */
  it('keeps the two key types distinct at the type level', () => {
    const recipient = hpkeRecipientPubkey(ADMIN.decryptionPubkey)
    const auth = ed25519AuthPubkey(ADMIN.identityPubkey)
    expect(recipient).toBeDefined()
    expect(auth).toBeDefined()

    // An Ed25519 auth key may not stand in for an HPKE recipient.
    // @ts-expect-error Ed25519AuthPubkey is not assignable to HpkeRecipientPubkey
    const notARecipient: ReturnType<typeof hpkeRecipientPubkey> = auth
    expect(notARecipient).toBeDefined()

    // Nor may an unvalidated string.
    // @ts-expect-error string is not assignable to HpkeRecipientPubkey
    const alsoNot: ReturnType<typeof hpkeRecipientPubkey> = ADMIN.decryptionPubkey
    expect(alsoNot).toBeDefined()
  })
})

/**
 * Why the wrong key is not merely wrong but silent.
 *
 * The X25519 operations here are the same @noble primitives the Rust crate's
 * DHKEM uses, reached through the unit-test FFI shim
 * (apps/worker/__tests__/mocks/llamenos-crypto-ffi.ts), so the arithmetic is
 * real: sealing succeeds for both keys, and only one of them can be opened.
 */
describe('sealing to the Ed25519 key instead of the X25519 one', () => {
  /** The admin's X25519 *secret*, derived the way the client derives it. */
  const adminX25519Secret = hkdf(
    sha256,
    hexToBytes(ADMIN_SEED),
    new Uint8Array(0),
    new TextEncoder().encode(LABEL_DEVICE_ENCRYPTION_SEED),
    32,
  )

  function openAdminEnvelope(sealedHex: { enc: string; ct: string }): Uint8Array {
    const envelope = new Uint8Array([...hexToBytes(sealedHex.enc), ...hexToBytes(sealedHex.ct)])
    return hpkeOpen(
      adminX25519Secret,
      envelope,
      new TextEncoder().encode(LABEL_MESSAGE),
      new TextEncoder().encode(`${LABEL_MESSAGE}:key-wrap`),
    )
  }

  it('confirms the derived secret matches the X25519 public key the config names', () => {
    expect(bytesToHex(x25519.getPublicKey(adminX25519Secret))).toBe(ADMIN.decryptionPubkey)
  })

  it('an envelope sealed to the X25519 key opens', () => {
    const sealed = encryptMessageForStorage('caller is safe, follow up tomorrow', [ADMIN.decryptionPubkey])
    const envelope = sealed.readerEnvelopes.find(e => e.pubkey === ADMIN.decryptionPubkey)
    expect(envelope).toBeDefined()
    expect(() => openAdminEnvelope(envelope!)).not.toThrow()
  })

  /**
   * The same call with the Ed25519 key: it returns a complete envelope, reports
   * no problem, and the admin cannot open it. No other party can either — the
   * secret for that X25519 point does not exist.
   */
  it('an envelope sealed to the Ed25519 key is produced without error and cannot be opened', () => {
    const sealed = encryptMessageForStorage('caller is safe, follow up tomorrow', [ADMIN.identityPubkey])

    const envelope = sealed.readerEnvelopes.find(e => e.pubkey === ADMIN.identityPubkey)
    expect(envelope, 'sealing to an Ed25519 key did not even fail loudly').toBeDefined()
    expect(sealed.encryptedContent.length).toBeGreaterThan(0)

    expect(() => openAdminEnvelope(envelope!)).toThrow()
  })
})
