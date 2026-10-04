/**
 * The AAD of an envelope is a wire format, and it is derived in one place.
 *
 * `encryptMessageForStorage` (server) and `decryptMessage` (desktop,
 * `src/client/lib/platform.ts`) used to spell the AAD out independently, and
 * disagreed: the server bound `UTF-8(label)` to the content and
 * `UTF-8("${label}:key-wrap")` to the HPKE key wrap, while the desktop bound
 * nothing to either. Every message, transcription and call record the server
 * wrote was therefore unopenable on the desktop — it failed the HPKE tag check
 * first, and `decryptMessage` swallowed that as `null`, which the UI rendered
 * as `[Encrypted]`.
 *
 * `docs/protocol/PROTOCOL.md` §2.4 already specified the server's convention
 * normatively, and `packages/crypto/src/encryption.rs` (`encrypt_message` /
 * `decrypt_message`) implements it, so the server was right and the clients
 * moved. These tests pin that decision against the real Rust FFI:
 *
 *   - the canonical AAD pair opens what the server writes
 *   - each of the three other combinations fails, at the layer it should
 *   - both sides derive the AAD from `@shared/envelope-aad`, not by hand
 *
 * Revert the desktop to empty AAD and the `desktop convention` case below
 * stops failing — which is the whole bug.
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

  it('opens with the canonical AAD pair', () => {
    const { secret, recipient } = makeReader()
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])
    expect(readerEnvelopes).toHaveLength(1)

    const messageKey = hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      keyWrapAad(LABEL_MESSAGE),
    )
    const opened = symmetricDecrypt(messageKey, hexToBytes(encryptedContent), contentAad(LABEL_MESSAGE))
    expect(new TextDecoder().decode(opened)).toBe(plaintext)
  })

  it('refuses the desktop convention — empty AAD on both layers — at the HPKE layer', () => {
    const { secret, recipient } = makeReader()
    const { readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])

    expect(() => hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      new Uint8Array(0),
    )).toThrow()
  })

  it('refuses the right key-wrap AAD with no content AAD, at the content layer', () => {
    const { secret, recipient } = makeReader()
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])

    const messageKey = hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      keyWrapAad(LABEL_MESSAGE),
    )
    expect(() => symmetricDecrypt(messageKey, hexToBytes(encryptedContent), new Uint8Array(0))).toThrow()
  })

  it('refuses a content AAD taken from a different label', () => {
    const { secret, recipient } = makeReader()
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(plaintext, [recipient])

    const messageKey = hpkeOpen(
      secret,
      packEnvelope(readerEnvelopes[0].enc, readerEnvelopes[0].ct),
      utf8ToBytes(LABEL_MESSAGE),
      keyWrapAad(LABEL_MESSAGE),
    )
    expect(() => symmetricDecrypt(messageKey, hexToBytes(encryptedContent), contentAad(LABEL_CALL_META))).toThrow()
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

describe('server-written call records use the same derivation', () => {
  it('opens with the LABEL_CALL_META AAD pair and not the LABEL_MESSAGE one', () => {
    const { secret, recipient } = makeReader()
    const { encryptedContent, adminEnvelopes } = encryptCallRecordForStorage(
      { answeredBy: null, callerNumber: '+15550001111' },
      [recipient],
    )

    const recordKey = hpkeOpen(
      secret,
      packEnvelope(adminEnvelopes[0].enc, adminEnvelopes[0].ct),
      utf8ToBytes(LABEL_CALL_META),
      keyWrapAad(LABEL_CALL_META),
    )
    const opened = symmetricDecrypt(recordKey, hexToBytes(encryptedContent), contentAad(LABEL_CALL_META))
    expect(JSON.parse(new TextDecoder().decode(opened)).callerNumber).toBe('+15550001111')

    expect(() => hpkeOpen(
      secret,
      packEnvelope(adminEnvelopes[0].enc, adminEnvelopes[0].ct),
      utf8ToBytes(LABEL_CALL_META),
      keyWrapAad(LABEL_MESSAGE),
    )).toThrow()
  })
})
