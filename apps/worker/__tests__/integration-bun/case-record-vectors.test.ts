/**
 * The server's leg of the case-record pin (#2499) — real Rust crypto via bun:ffi.
 *
 * MUST run under `bun test`, NOT vitest (vitest aliases `@llamenos/crypto/ffi`
 * to a pure-TS stand-in whose bytes are not the wire format):
 *   bun test apps/worker/__tests__/integration-bun/case-record-vectors.test.ts
 *
 * `packages/crypto/tests/fixtures/case-record-vectors.json` holds a case
 * summary, case fields and a case comment as the server persisted them. The
 * server never reads case records — it holds no reader key — but it does seal
 * them (the sample dataset), so this pins both halves of its binding:
 *  - `caseOpen` opens the persisted bytes for every published reader key, and
 *    the stored-message reading of the same bytes (LABEL_MESSAGE, no AAD — the
 *    pre-#2499 desktop/Android format) fails;
 *  - what the sample seeder seals (`sealCaseForReaders`) opens under the same
 *    reader the fixture is opened with, and its envelopes carry the fixture's
 *    shape (X25519 addresses, hex enc/ct of fixed length).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { caseOpen, hpkeOpen, symmetricDecrypt, type CasePurpose, type EncryptedCaseCiphertext } from '@llamenos/crypto/ffi'
import { LABEL_MESSAGE } from '@shared/crypto-labels'
import { hexToBytes, utf8ToBytes } from '@shared/encoding'
import { sealCaseForReaders, type SampleReader } from '../../lib/sample-crypto'

interface Fixture {
  readers: { name: string; x25519SecretHex: string; x25519PubkeyHex: string }[]
  records: (EncryptedCaseCiphertext & { name: string; purpose: CasePurpose; label: string; plaintext: string })[]
}

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../../../packages/crypto/tests/fixtures/case-record-vectors.json'), 'utf-8'),
) as Fixture

describe('case-record vectors through the server binding', () => {
  it('names one record per purpose', () => {
    expect(fixture.records.map(r => r.purpose).sort()).toEqual(['comment', 'fields', 'summary'])
  })

  for (const rec of fixture.records) {
    for (const reader of fixture.readers) {
      it(`${reader.name} opens the persisted ${rec.name}`, () => {
        expect(caseOpen(rec.purpose, hexToBytes(reader.x25519SecretHex), rec)).toBe(rec.plaintext)
      })
    }

    it(`the persisted ${rec.name} does not open as a stored message`, () => {
      const reader = fixture.readers[0]
      const env = rec.readerEnvelopes.find(e => e.pubkey === reader.x25519PubkeyHex)
      if (!env) throw new Error(`the fixture sealed no ${rec.name} envelope to ${reader.name}`)
      expect(() => {
        const key = hpkeOpen(
          hexToBytes(reader.x25519SecretHex),
          new Uint8Array([...hexToBytes(env.enc), ...hexToBytes(env.ct)]),
          utf8ToBytes(LABEL_MESSAGE),
          new Uint8Array(0),
        )
        symmetricDecrypt(key, hexToBytes(rec.encryptedContent), new Uint8Array(0))
      }).toThrow()
    })

    const others = fixture.records.filter(r => r.purpose !== rec.purpose)
    it(`the persisted ${rec.name} opens as no other purpose`, () => {
      const secret = hexToBytes(fixture.readers[0].x25519SecretHex)
      for (const other of others) {
        expect(() => caseOpen(other.purpose, secret, rec)).toThrow()
      }
    })
  }

  it('the sample seeder seals case ciphertexts the fixture reader opens', () => {
    const readers: SampleReader[] = fixture.readers.map(r => ({ pubkey: `account-${r.name}`, encryptionPubkey: r.x25519PubkeyHex }))
    for (const purpose of ['summary', 'fields', 'comment'] as const) {
      const sealed = sealCaseForReaders(purpose, `sample ${purpose}`, readers)
      expect(sealed.envelopes.map(e => e.pubkey)).toEqual(fixture.readers.map(r => r.x25519PubkeyHex))
      for (const env of sealed.envelopes) {
        expect(env.enc).toMatch(/^[0-9a-f]{64}$/)
        expect(env.ct).toMatch(/^[0-9a-f]{96}$/)
      }
      for (const reader of fixture.readers) {
        expect(
          caseOpen(purpose, hexToBytes(reader.x25519SecretHex), {
            encryptedContent: sealed.encryptedContent,
            readerEnvelopes: sealed.envelopes,
          }),
        ).toBe(`sample ${purpose}`)
      }
    }
  })
})
