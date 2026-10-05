/**
 * Stored-record envelopes carry NO AAD; canonical-label envelopes derive
 * their AAD in one place.
 *
 * History, in order:
 *
 * 1. `encryptMessageForStorage` (server) bound `UTF-8(label)` /
 *    `UTF-8("${label}:key-wrap")` while every client bound nothing, so every
 *    server-sealed message was unopenable anywhere (#1456, `[Encrypted]`).
 * 2. This branch made the desktop supply the canonical AAD pair, derived once
 *    from `@shared/envelope-aad`.
 * 3. Main's #1393 re-adjudicated the stored-record wire format: client-sealed
 *    and server-sealed messages share a conversation with no format marker,
 *    so a reader cannot know which AAD to supply. Stored records (messages,
 *    call metadata) now seal and open with empty AAD on every layer, with the
 *    label bound as HPKE `info` — implemented canonically in
 *    `packages/crypto/src/encryption.rs` (`open_record_for_reader`) and the
 *    mobile FFI (`mobile_decrypt_message`).
 *
 * The `@shared/envelope-aad` module remains the single definition for the
 * canonical-label envelopes (notes, files, contacts — Rust `encrypt_note` /
 * `hpke_wrap_key` bind it, and #1528's mobile FFI exports derive from the
 * same rule). These tests pin the merged convention against the real Rust FFI:
 *
 *   - stored records open with empty AAD, and refuse the retired AAD-bearing
 *     spellings at the layer each belongs to
 *   - the label is still enforced — opening with the wrong label's info fails
 *   - both AAD layers for canonical labels derive from `@shared/envelope-aad`
 */
import { describe, it, expect } from 'vitest'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_MESSAGE, LABEL_CALL_META } from '@shared/crypto-labels'
import { contentAad, keyWrapAad, contentAadHex, keyWrapAadHex, KEY_WRAP_AAD_SUFFIX } from '@shared/envelope-aad'
import { encryptMessageForStorage, encryptCallRecordForStorage } from '../../lib/crypto'
import { hpkeRecipientPubkey } from '../../lib/hpke-recipient'

/** A reader with a real X25519 secret, so the opens below are genuine. */
function makeReader() {
  // Any 32 bytes is a valid X25519 scalar; fixed so failures are reproducible.
  const secretHex = '77'.repeat(32)
  const pubkeyHex = bytesToHex(x25519.getPublicKey(hexToBytes(secretHex)))
  const recipient = hpkeRecipientPubkey(pubkeyHex)
  if (!recipient) throw new Error('fixture produced an invalid recipient key')
  return { secret: hexToBytes(secretHex), recipient }
}

/** Reassemble the wire envelope (enc || ct) the server splits into two hex fields. */
function packEnvelope(enc: string, ct: string): Uint8Array {
  const encBytes = hexToBytes(enc)
  const ctBytes = hexToBytes(ct)
  const packed = new Uint8Array(encBytes.length + ctBytes.length)
  packed.set(encBytes)
  packed.set(ctBytes, encBytes.length)
  return packed
}

describe('@shared/envelope-aad is the single definition', () => {
  it('derives the content AAD as UTF-8(label)', () => {
    expect(contentAad(LABEL_MESSAGE)).toEqual(utf8ToBytes('llamenos:message'))
    expect(contentAadHex(LABEL_MESSAGE)).toBe(bytesToHex(utf8ToBytes('llamenos:message')))
  })

  it('derives the key-wrap AAD as UTF-8(label + suffix), distinct from the content AAD', () => {
    expect(keyWrapAad(LABEL_MESSAGE)).toEqual(utf8ToBytes('llamenos:message:key-wrap'))
    expect(keyWrapAadHex(LABEL_MESSAGE)).toBe(bytesToHex(utf8ToBytes('llamenos:message:key-wrap')))
    expect(KEY_WRAP_AAD_SUFFIX).toBe(':key-wrap')
    // The separation is the point: hpkeSeal carries content directly *and*
    // wraps content keys under the same label, and only the AAD tells them apart.
    expect(keyWrapAadHex(LABEL_MESSAGE)).not.toBe(contentAadHex(LABEL_MESSAGE))
  })

  it('separates labels from one another', () => {
    expect(keyWrapAadHex(LABEL_MESSAGE)).not.toBe(keyWrapAadHex(LABEL_CALL_META))
  })
})

describe('server-written message envelopes, opened with the real FFI', () => {
  const plaintext = 'the caller said they are safe now'
  const NO_AAD = new Uint8Array(0)

  it('opens with empty AAD on both layers (#1393 stored-record format)', () => {
    const { secret, recipient } = makeReader()
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])
    expect(readerEnvelopes).toHaveLength(1)

    const messageKey = hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      NO_AAD,
    )
    const opened = symmetricDecrypt(messageKey, hexToBytes(encryptedContent), NO_AAD)
    expect(new TextDecoder().decode(opened)).toBe(plaintext)
  })

  it('refuses the retired canonical key-wrap AAD at the HPKE layer', () => {
    const { secret, recipient } = makeReader()
    const { readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])

    expect(() => hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      keyWrapAad(LABEL_MESSAGE),
    )).toThrow()
  })

  it('refuses the retired canonical content AAD at the content layer', () => {
    const { secret, recipient } = makeReader()
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])

    const messageKey = hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      NO_AAD,
    )
    expect(() => symmetricDecrypt(messageKey, hexToBytes(encryptedContent), contentAad(LABEL_MESSAGE))).toThrow()
  })

  it('still refuses a tampered ciphertext even with the right key and AAD', () => {
    const { secret, recipient } = makeReader()
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])

    const messageKey = hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      NO_AAD,
    )
    const tampered = hexToBytes(encryptedContent)
    tampered[tampered.length - 1] ^= 0x01
    expect(() => symmetricDecrypt(messageKey, tampered, NO_AAD)).toThrow()
  })

  it('refuses the content AAD where the key-wrap AAD belongs', () => {
    const { secret, recipient } = makeReader()
    const { readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])

    expect(() => hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      contentAad(LABEL_MESSAGE),
    )).toThrow()
  })
})

describe('server-written call records use the same stored-record format', () => {
  it('opens with empty AAD under LABEL_CALL_META, and refuses the LABEL_MESSAGE info', () => {
    const { secret, recipient } = makeReader()
    const { encryptedContent, adminEnvelopes } = encryptCallRecordForStorage(
      { answeredBy: null, callerNumber: '+15550001111' },
      [recipient],
    )

    const recordKey = hpkeOpen(
      secret,
      packEnvelope(adminEnvelopes[0].enc, adminEnvelopes[0].ct),
      utf8ToBytes(LABEL_CALL_META),
      new Uint8Array(0),
    )
    const opened = symmetricDecrypt(recordKey, hexToBytes(encryptedContent), new Uint8Array(0))
    expect(JSON.parse(new TextDecoder().decode(opened)).callerNumber).toBe('+15550001111')

    expect(() => hpkeOpen(
      secret,
      packEnvelope(adminEnvelopes[0].enc, adminEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      new Uint8Array(0),
    )).toThrow()
  })
})
