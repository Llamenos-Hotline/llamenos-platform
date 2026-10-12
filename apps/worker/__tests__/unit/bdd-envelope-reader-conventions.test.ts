/**
 * The two things a BDD envelope reader has to get right, pinned.
 *
 * Both were wrong on `main` at the same time, and together they failed three
 * backend-BDD scenarios with nothing but hpke-js's `OpenError: The operation
 * failed for an operation-specific reason` — which names neither cause. The
 * merge queue was blocked on the result, so each cause gets a test that fails
 * loudly and says which one it is.
 *
 * 1. **AAD convention.** #1393 adjudicated two, and which one applies is a
 *    property of the WRITER, not of the label: `apps/worker/lib/crypto.ts`
 *    seals stored records with no AAD, while clients,
 *    `apps/worker/lib/demo-crypto.ts` and the Rust interop vectors seal the
 *    same labels canonically. `unwrapKey` assumed canonical unconditionally;
 *    `tests/steps/backend/demo-dataset.steps.ts` assumed the other one.
 *
 * 2. **The admin's HPKE recipient key.** Derived three times now as
 *    `x25519PubkeyFromSeed(ADMIN_SEED)` — the signing seed used as a raw
 *    scalar, a key nobody holds. The server seals to
 *    `X25519(HKDF(signingSeed, info = LABEL_DEVICE_ENCRYPTION_SEED))`.
 *
 * Lives here because `vitest.unit.config.ts` is the repo's only unit-test
 * runner that can import `tests/crypto-helpers.ts` (as
 * `bootstrap-admin-script.test.ts` already does); the interop half — that these
 * readers open what the real server wrote — is asserted by the backend BDD
 * suite against a live server.
 */
import { describe, it, expect } from 'vitest'
import { CipherSuite, KemId, KdfId, AeadId } from 'hpke-js'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { gcm } from '@noble/ciphers/aes.js'
import { contentAad, keyWrapAad, NO_AAD } from '@shared/envelope-aad'
import { LABEL_MESSAGE, LABEL_NOTE_KEY } from '@shared/crypto-labels'
import { deriveAdminKeys } from '../../../../scripts/bootstrap-admin'
import {
  ADMIN_SIGNING_SEED,
  adminHpkeRecipient,
  decryptStoredRecordContent,
  generateContentKey,
  hpkeRecipientForSeed,
  openStoredRecordKey,
  testDeviceHpkeRecipient,
  unwrapKey,
  wrapKeyForRecipient,
  x25519PubkeyFromSeed,
} from '../../../../tests/crypto-helpers'

const suite = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
})

/** A seed that is not the admin's, so the raw-scalar convention applies. */
const OTHER_SEED = '11'.repeat(32)

/**
 * Seal a content key the way a given writer does — the only difference between
 * the two conventions being the AAD.
 */
async function sealKeyFor(
  contentKey: Uint8Array,
  recipientPubkeyHex: string,
  label: string,
  aad: Uint8Array,
): Promise<{ ct: string; enc: string }> {
  const recipientPublicKey = await suite.importKey(
    'raw',
    Uint8Array.from(hexToBytes(recipientPubkeyHex)).buffer,
    true,
  )
  const sealed = await suite.seal(
    { recipientPublicKey, info: new TextEncoder().encode(label) },
    contentKey,
    aad,
  )
  return {
    enc: bytesToHex(new Uint8Array(sealed.enc)),
    ct: bytesToHex(new Uint8Array(sealed.ct)),
  }
}

/** Content sealed the way `apps/worker/lib/crypto.ts` seals a stored record. */
function sealStoredRecordContent(plaintext: string, key: Uint8Array): string {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const ct = gcm(key, iv, NO_AAD).encrypt(new TextEncoder().encode(plaintext))
  return bytesToHex(new Uint8Array([...iv, ...ct]))
}

describe("the admin's HPKE recipient key", () => {
  it('is the HKDF-derived encryption key scripts/bootstrap-admin.ts prints', () => {
    expect(adminHpkeRecipient().pubkeyHex).toBe(
      deriveAdminKeys(hexToBytes(ADMIN_SIGNING_SEED)).decryptionPubkey,
    )
  })

  it('is NOT the signing seed used as a raw X25519 scalar', () => {
    const rawScalarKey = bytesToHex(x25519.getPublicKey(hexToBytes(ADMIN_SIGNING_SEED)))
    expect(adminHpkeRecipient().pubkeyHex).not.toBe(rawScalarKey)
  })

  it('opens what is sealed to it', async () => {
    const admin = adminHpkeRecipient()
    const key = generateContentKey()
    const env = await sealKeyFor(key, admin.pubkeyHex, LABEL_NOTE_KEY, keyWrapAad(LABEL_NOTE_KEY))
    const opened = await unwrapKey(env.ct, env.enc, admin.skHex, LABEL_NOTE_KEY)
    expect(bytesToHex(opened)).toBe(bytesToHex(key))
  })

  it('is what hpkeRecipientForSeed returns for the admin seed', () => {
    expect(hpkeRecipientForSeed(ADMIN_SIGNING_SEED)).toEqual(adminHpkeRecipient())
  })

  it('is NOT what hpkeRecipientForSeed returns for any other identity', () => {
    // Identities the tests mint register the seed-as-scalar key, so that stays
    // the convention for them — the admin is the exception, not the rule.
    expect(hpkeRecipientForSeed(OTHER_SEED)).toEqual(testDeviceHpkeRecipient(OTHER_SEED))
    expect(hpkeRecipientForSeed(OTHER_SEED).skHex).toBe(OTHER_SEED)
  })
})

describe('the wrong admin derivation is unavailable, not merely discouraged', () => {
  it('x25519PubkeyFromSeed refuses the admin signing seed', () => {
    expect(() => x25519PubkeyFromSeed(ADMIN_SIGNING_SEED)).toThrow(/adminHpkeRecipient/)
  })

  it('unwrapKey refuses the admin signing seed as an X25519 secret', async () => {
    await expect(
      unwrapKey('00'.repeat(48), '00'.repeat(32), ADMIN_SIGNING_SEED, LABEL_NOTE_KEY),
    ).rejects.toThrow(/adminHpkeRecipient/)
  })

  it('openStoredRecordKey refuses the admin signing seed as an X25519 secret', async () => {
    await expect(
      openStoredRecordKey('00'.repeat(48), '00'.repeat(32), ADMIN_SIGNING_SEED, LABEL_MESSAGE),
    ).rejects.toThrow(/adminHpkeRecipient/)
  })

  it('wrapKeyForRecipient refuses both keys the admin cannot hold', async () => {
    const rawScalarKey = bytesToHex(x25519.getPublicKey(hexToBytes(ADMIN_SIGNING_SEED)))
    const ed25519IdentityKey = deriveAdminKeys(hexToBytes(ADMIN_SIGNING_SEED)).identityPubkey
    for (const unholdable of [rawScalarKey, ed25519IdentityKey]) {
      await expect(
        wrapKeyForRecipient(generateContentKey(), unholdable, '', LABEL_NOTE_KEY),
      ).rejects.toThrow(/adminHpkeRecipient/)
    }
  })

  it('still derives the raw-scalar key for a non-admin seed', () => {
    expect(x25519PubkeyFromSeed(OTHER_SEED)).toBe(
      bytesToHex(x25519.getPublicKey(hexToBytes(OTHER_SEED))),
    )
  })
})

describe('the two AAD conventions have one reader each', () => {
  const reader = testDeviceHpkeRecipient(OTHER_SEED)

  it('openStoredRecordKey opens a server-sealed key wrap; unwrapKey does not', async () => {
    const key = generateContentKey()
    const env = await sealKeyFor(key, reader.pubkeyHex, LABEL_MESSAGE, NO_AAD)

    const opened = await openStoredRecordKey(env.ct, env.enc, reader.skHex, LABEL_MESSAGE)
    expect(bytesToHex(opened)).toBe(bytesToHex(key))

    await expect(unwrapKey(env.ct, env.enc, reader.skHex, LABEL_MESSAGE)).rejects.toThrow(
      /openStoredRecordKey/,
    )
  })

  it('unwrapKey opens a canonical key wrap; openStoredRecordKey does not', async () => {
    const key = generateContentKey()
    const env = await sealKeyFor(key, reader.pubkeyHex, LABEL_MESSAGE, keyWrapAad(LABEL_MESSAGE))

    const opened = await unwrapKey(env.ct, env.enc, reader.skHex, LABEL_MESSAGE)
    expect(bytesToHex(opened)).toBe(bytesToHex(key))

    await expect(
      openStoredRecordKey(env.ct, env.enc, reader.skHex, LABEL_MESSAGE),
    ).rejects.toThrow(/unwrapKey/)
  })

  it('decryptStoredRecordContent opens a no-AAD content layer', () => {
    const key = generateContentKey()
    const sealed = sealStoredRecordContent('Help me', key)
    expect(decryptStoredRecordContent(sealed, key)).toBe('Help me')
  })

  it('a canonical content layer is not readable as a stored record', () => {
    // The pair that failed `Then the volunteer can decrypt the message`: the
    // content AAD has to match too, not just the key wrap.
    const key = generateContentKey()
    const iv = new Uint8Array(12)
    crypto.getRandomValues(iv)
    const ct = gcm(key, iv, contentAad(LABEL_MESSAGE)).encrypt(new TextEncoder().encode('Help me'))
    const canonical = bytesToHex(new Uint8Array([...iv, ...ct]))
    expect(() => decryptStoredRecordContent(canonical, key)).toThrow()
  })
})
