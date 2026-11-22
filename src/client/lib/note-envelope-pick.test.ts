/**
 * #1035 — every admin of a hub opens a note through their OWN envelope.
 *
 * A note carries one admin envelope per admin of its hub. The notes and
 * contacts pages used to look for one addressed to the user's Ed25519 identity
 * key — which no admin envelope ever is: they are addressed to device X25519
 * keys — and fall back to `adminEnvelopes[0]`. That handed every admin but the
 * first somebody else's envelope, so a second admin could open nothing.
 */
import { describe, it, expect } from 'vitest'
import { pickNoteEnvelope } from './platform'

const env = (pubkey: string) => ({ pubkey, enc: `enc-${pubkey.slice(0, 4)}`, ct: `ct-${pubkey.slice(0, 4)}` })

const FIRST_ADMIN = { signingPubkeyHex: '1a'.repeat(32), encryptionPubkeyHex: '1b'.repeat(32) }
const SECOND_ADMIN = { signingPubkeyHex: '2a'.repeat(32), encryptionPubkeyHex: '2b'.repeat(32) }
const AUTHOR = { signingPubkeyHex: '3a'.repeat(32), encryptionPubkeyHex: '3b'.repeat(32) }
const STRANGER = { signingPubkeyHex: '4a'.repeat(32), encryptionPubkeyHex: '4b'.repeat(32) }

const note = {
  authorPubkey: AUTHOR.signingPubkeyHex,
  authorEnvelope: { enc: 'enc-author', ct: 'ct-author' },
  adminEnvelopes: [env(FIRST_ADMIN.encryptionPubkeyHex), env(SECOND_ADMIN.encryptionPubkeyHex)],
}

describe('pickNoteEnvelope', () => {
  it("gives the second admin their own envelope, not the first admin's", () => {
    expect(pickNoteEnvelope(note, SECOND_ADMIN)).toEqual(env(SECOND_ADMIN.encryptionPubkeyHex))
    expect(pickNoteEnvelope(note, FIRST_ADMIN)).toEqual(env(FIRST_ADMIN.encryptionPubkeyHex))
  })

  it('gives the author their author envelope', () => {
    expect(pickNoteEnvelope(note, AUTHOR)).toEqual(note.authorEnvelope)
  })

  it("gives a device that holds neither nothing — never somebody else's envelope", () => {
    expect(pickNoteEnvelope(note, STRANGER)).toBeNull()
  })
})
