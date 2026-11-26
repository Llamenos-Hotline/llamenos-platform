/**
 * File envelopes take their AAD from the crate, by shape, at the desktop call sites.
 *
 * The content layer runs in WebCrypto (#3003), so its AAD crosses IPC — but only
 * as the value `shape_content_aad` returns for the file shapes; the webview never
 * builds one. Files were once a missed call site that passed `''`, so a file
 * sealed by the desktop failed the tag check on every other implementation.
 *
 * `file-crypto.ts` imports its crypto from `./platform`, so mocking that module
 * boundary intercepts every call and the arguments each function receives ARE
 * the contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shapeContentAadHexMock } from '../../../tests/mocks/hpke-mock'

const mocks = vi.hoisted(() => ({
  aesGcmEncrypt: vi.fn(async (_pt: string, _key: string, _aadHex: string) => '00'),
  aesGcmSealBytes: vi.fn(async (_pt: Uint8Array, _key: string, _aadHex: string) => new Uint8Array(29)),
  aesGcmOpenBytes: vi.fn(async (_ct: Uint8Array, _key: string, _aadHex: string) => new Uint8Array([1, 2, 3])),
  resolveEncryptionPubkey: vi.fn(async (pubkey: string) => pubkey),
  hpkeWrapKey: vi.fn(async (_key: string, _pubkey: string, _shape: string) => ({ enc: 'ab'.repeat(32), ct: 'cd'.repeat(48) })),
  shapeContentAadHex: vi.fn(async (shape: Parameters<typeof shapeContentAadHexMock>[0]) => shapeContentAadHexMock(shape)),
  unwrapFileKey: vi.fn(async (_envelope: unknown) => 'cd'.repeat(32)),
  decryptFileMetadata: vi.fn(async (_entry: unknown) => '{}'),
  rewrapFileKey: vi.fn(async (_envelope: unknown, _pub: string) => ({ enc: 'ab', ct: 'cd' })),
}))
const { aesGcmEncrypt, aesGcmSealBytes, aesGcmOpenBytes, hpkeWrapKey } = mocks

vi.mock('./platform', async importOriginal => ({
  ...(await importOriginal<typeof import('./platform')>()),
  aesGcmEncrypt: mocks.aesGcmEncrypt,
  aesGcmSealBytes: mocks.aesGcmSealBytes,
  aesGcmOpenBytes: mocks.aesGcmOpenBytes,
  resolveEncryptionPubkey: mocks.resolveEncryptionPubkey,
  hpkeWrapKey: mocks.hpkeWrapKey,
  shapeContentAadHex: mocks.shapeContentAadHex,
  unwrapFileKey: mocks.unwrapFileKey,
  decryptFileMetadata: mocks.decryptFileMetadata,
  rewrapFileKey: mocks.rewrapFileKey,
}))

import { encryptFile, decryptFile } from './file-crypto'

const READER_PUBKEY = 'ee'.repeat(32)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('file envelopes take their AAD from the crate by shape', () => {
  it('encryptFile binds the file-key content AAD on the content and the file-metadata-key AAD on the metadata', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'evidence.txt', { type: 'text/plain' })
    await encryptFile(file, [READER_PUBKEY])

    expect(aesGcmSealBytes).toHaveBeenCalledTimes(1)
    expect(aesGcmSealBytes.mock.calls[0][2]).toBe(shapeContentAadHexMock('file-key'))
    expect(aesGcmEncrypt).toHaveBeenCalledTimes(1)
    expect(aesGcmEncrypt.mock.calls[0][2]).toBe(shapeContentAadHexMock('file-metadata-key'))

    // The key wraps go through hpkeWrapKey as the matching shapes.
    expect(hpkeWrapKey).toHaveBeenCalledTimes(2)
    expect(hpkeWrapKey.mock.calls[0][2]).toBe('file-key')
    expect(hpkeWrapKey.mock.calls[1][2]).toBe('file-metadata-key')

    // No layer was sealed with an empty AAD.
    for (const call of [...aesGcmSealBytes.mock.calls, ...aesGcmEncrypt.mock.calls]) {
      expect(call[2]).not.toBe('')
    }
  })

  it('decryptFile opens the content with the file-key content AAD', async () => {
    await decryptFile(new ArrayBuffer(4), { pubkey: READER_PUBKEY, enc: 'ab'.repeat(32), ct: 'cd' })

    expect(aesGcmOpenBytes).toHaveBeenCalledTimes(1)
    expect(aesGcmOpenBytes.mock.calls[0][2]).toBe(shapeContentAadHexMock('file-key'))
  })
})
