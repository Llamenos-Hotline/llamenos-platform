/**
 * The Playwright build's stand-in for `packages/crypto/src/case_record.rs`
 * (#2499), behind the `seal_case_from_state` / `open_case_from_state` mock
 * commands in `./tauri-core.ts`.
 *
 * The desktop reaches the crate through Tauri IPC; the Playwright browser has
 * no Rust and there is no WASM build of the crate, so this module re-states the
 * crate's rule over real RFC 9180 HPKE (hpke-js, via `./hpke-mock`). Restating
 * a crypto decision in a second language is exactly how the #2499 split
 * happened, so this file is pinned: `tests/crypto-interop.spec.ts` opens the
 * server-persisted `case-record-vectors.json` with `openCaseMock` and checks
 * that what `sealCaseMock` writes has the fixture's shape. A drift here fails
 * there. Relative imports only — the Playwright runner has no Vite aliases.
 */
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { LABEL_CASE_COMMENT, LABEL_CASE_FIELDS, LABEL_CASE_SUMMARY } from '../../packages/shared/crypto-labels'
import { contentAad, keyWrapAad } from '../../packages/shared/envelope-aad'
import { base64urlDecode, base64urlEncode, hpkeOpenMock, hpkeSealMock, labelToId } from './hpke-mock'

/** Mirrors `CasePurpose` (serde lowercase) in packages/crypto/src/case_record.rs. */
export type CasePurposeMock = 'summary' | 'fields' | 'comment'

export interface CaseCiphertextMock {
  encryptedContent: string
  readerEnvelopes: { pubkey: string; enc: string; ct: string }[]
}

/** Mirrors `CasePurpose::label`. */
export function caseLabelMock(purpose: CasePurposeMock): string {
  switch (purpose) {
    case 'summary': return LABEL_CASE_SUMMARY
    case 'fields': return LABEL_CASE_FIELDS
    case 'comment': return LABEL_CASE_COMMENT
  }
}

/** Mirrors `case_record::seal_as_device`. */
export async function sealCaseMock(
  purpose: CasePurposeMock,
  plaintext: string,
  readerPubkeys: readonly string[],
  device: { encryptionPubkeyHex: string; signingPubkeyHex: string },
): Promise<CaseCiphertextMock> {
  const label = caseLabelMock(purpose)
  const readers: string[] = []
  for (const pk of [device.encryptionPubkeyHex, ...readerPubkeys]) {
    if (pk.toLowerCase() === device.signingPubkeyHex.toLowerCase()) continue
    if (hexToBytes(pk).length !== 32) throw new Error('case reader pubkey must be a 32-byte X25519 key')
    const normalised = pk.toLowerCase()
    if (!readers.includes(normalised)) readers.push(normalised)
  }
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const ct = gcm(key, iv, contentAad(label)).encrypt(utf8ToBytes(plaintext))
  const readerEnvelopes = await Promise.all(readers.map(async (pubkey) => {
    const env = await hpkeSealMock(key, pubkey, label, keyWrapAad(label))
    return { pubkey, enc: bytesToHex(base64urlDecode(env.enc)), ct: bytesToHex(base64urlDecode(env.ct)) }
  }))
  return { encryptedContent: bytesToHex(new Uint8Array([...iv, ...ct])), readerEnvelopes }
}

/** Mirrors `case_record::open_as_device`: the envelope addressed to the device's X25519 key. */
export async function openCaseMock(
  purpose: CasePurposeMock,
  sealed: CaseCiphertextMock,
  device: { encryptionPubkeyHex: string },
  encryptionSecretHex: string,
): Promise<string> {
  const label = caseLabelMock(purpose)
  const ours = sealed.readerEnvelopes.find(e => e.pubkey === device.encryptionPubkeyHex)
  if (!ours) throw new Error('decryption failed')
  const key = await hpkeOpenMock(
    { v: 3, labelId: labelToId(label), enc: base64urlEncode(hexToBytes(ours.enc)), ct: base64urlEncode(hexToBytes(ours.ct)) },
    encryptionSecretHex,
    label,
    keyWrapAad(label),
  )
  const data = hexToBytes(sealed.encryptedContent)
  return new TextDecoder().decode(gcm(key, data.subarray(0, 12), contentAad(label)).decrypt(data.subarray(12)))
}
