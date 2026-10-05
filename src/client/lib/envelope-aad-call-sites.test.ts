/**
 * File envelopes bind the canonical AAD at the desktop call sites.
 *
 * `contentAad(label)` on the AES-256-GCM content layer, `keyWrapAad(label)`
 * on the HPKE key wrap — the single convention defined in
 * `@shared/envelope-aad` and mirrored in Rust. Files were a missed call site:
 * the content layers passed `''` (empty AAD) and `hpkeWrapKey` sealed its key
 * wrap with `''`, so a file sealed by the desktop failed the tag check on
 * every other implementation (iOS, Android) — and vice versa.
 *
 * `file-crypto.ts` imports its crypto from `./platform`, so mocking that
 * module boundary intercepts every call and the AAD argument each function
 * receives IS the contract. (The note and contact-identifier call sites live
 * inside `platform.ts` itself; they are pinned by the
 * `envelope_aad_cross_platform` Rust test, which scans these sources the same
 * way it scans the mobile ones.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { contentAadHex } from '@shared/envelope-aad'
import { LABEL_FILE_KEY, LABEL_FILE_METADATA } from '@shared/crypto-labels'

const mocks = vi.hoisted(() => ({
  aesGcmEncrypt: vi.fn(async (_pt: string, _key: string, _aadHex: string) => '00'),
  aesGcmDecrypt: vi.fn(async (_ct: string, _key: string, _aadHex: string) => '010203'),
  hpkeWrapKey: vi.fn(async (_key: string, _pubkey: string, _label: string) => ({ enc: 'ab'.repeat(32), ct: 'cd' })),
  unwrapFileKey: vi.fn(async (_enc: string, _ct: string) => 'cd'.repeat(32)),
  decryptFileMetadata: vi.fn(async (_content: string, _enc: string) => null),
  rewrapFileKey: vi.fn(async (_enc: string, _ct: string, _pub: string) => ({ enc: 'ab', ct: 'cd' })),
}))
const { aesGcmEncrypt, aesGcmDecrypt, hpkeWrapKey } = mocks

vi.mock('./platform', () => ({
  aesGcmEncrypt: mocks.aesGcmEncrypt,
  aesGcmDecrypt: mocks.aesGcmDecrypt,
  hpkeWrapKey: mocks.hpkeWrapKey,
  unwrapFileKey: mocks.unwrapFileKey,
  decryptFileMetadata: mocks.decryptFileMetadata,
  rewrapFileKey: mocks.rewrapFileKey,
}))

import { encryptFile, decryptFile } from './file-crypto'

const READER_PUBKEY = 'ee'.repeat(32)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('file envelopes bind the canonical AAD', () => {
  it('encryptFile binds contentAad(FILE_KEY) on the content and contentAad(FILE_METADATA) on the metadata', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'evidence.txt', { type: 'text/plain' })
    await encryptFile(file, [READER_PUBKEY])

    expect(aesGcmEncrypt).toHaveBeenCalledTimes(2)
    expect(aesGcmEncrypt.mock.calls[0][2]).toBe(contentAadHex(LABEL_FILE_KEY))
    expect(aesGcmEncrypt.mock.calls[1][2]).toBe(contentAadHex(LABEL_FILE_METADATA))

    // The key wraps go through hpkeWrapKey, which seals under keyWrapAad(label).
    expect(hpkeWrapKey).toHaveBeenCalledTimes(2)
    expect(hpkeWrapKey.mock.calls[0][2]).toBe(LABEL_FILE_KEY)
    expect(hpkeWrapKey.mock.calls[1][2]).toBe(LABEL_FILE_METADATA)

    // No layer was sealed with an empty AAD.
    for (const call of aesGcmEncrypt.mock.calls) {
      expect(call[2]).not.toBe('')
    }
  })

  it('decryptFile opens the content with contentAad(FILE_KEY)', async () => {
    await decryptFile(new ArrayBuffer(4), { pubkey: READER_PUBKEY, enc: 'ab'.repeat(32), ct: 'cd' })

    expect(aesGcmDecrypt).toHaveBeenCalledTimes(1)
    expect(aesGcmDecrypt.mock.calls[0][2]).toBe(contentAadHex(LABEL_FILE_KEY))
  })
})
