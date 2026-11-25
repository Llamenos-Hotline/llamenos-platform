/**
 * #3003 — opening a stored file.
 *
 * Opens only through an envelope addressed to THIS device's keys (account key or
 * encryption key), never through another reader's, and requests the file
 * through the hub it belongs to rather than the one on screen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const DEVICE = { signingPubkeyHex: 'sig-me', encryptionPubkeyHex: 'enc-me' }

const mocks = vi.hoisted(() => ({
  getDevicePubkeys: vi.fn(),
  downloadFile: vi.fn(),
  getFileEnvelopes: vi.fn(),
  getFileMetadata: vi.fn(),
  decryptFile: vi.fn(),
  decryptFileMetadata: vi.fn(),
}))

vi.mock('./platform', () => ({ getDevicePubkeys: mocks.getDevicePubkeys }))
vi.mock('./api', () => ({
  downloadFile: mocks.downloadFile,
  getFileEnvelopes: mocks.getFileEnvelopes,
  getFileMetadata: mocks.getFileMetadata,
}))
vi.mock('./file-crypto', async importOriginal => ({
  ...(await importOriginal<typeof import('./file-crypto')>()),
  decryptFile: mocks.decryptFile,
  decryptFileMetadata: mocks.decryptFileMetadata,
}))

import { FileAccessDeniedError, openStoredFile } from './stored-file'

const envelope = (pubkey: string) => ({ pubkey, enc: 'ab'.repeat(32), ct: 'cd'.repeat(48) })
const metadata = (pubkey: string) => ({ pubkey, encryptedContent: `meta-${pubkey}`, enc: 'ab'.repeat(32), ct: 'cd'.repeat(48) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getDevicePubkeys.mockResolvedValue(DEVICE)
  mocks.downloadFile.mockResolvedValue(new ArrayBuffer(8))
  mocks.decryptFile.mockResolvedValue({ blob: new Blob(['x']), checksum: 'c' })
  mocks.decryptFileMetadata.mockResolvedValue({ originalName: 'a.txt', mimeType: 'text/plain', size: 1, checksum: 'c' })
})

describe('openStoredFile', () => {
  it('opens through the envelope and the metadata entry addressed to this device’s encryption key', async () => {
    mocks.getFileEnvelopes.mockResolvedValue({ envelopes: [envelope('enc-other'), envelope('enc-me')] })
    mocks.getFileMetadata.mockResolvedValue({ metadata: [metadata('enc-other'), metadata('enc-me')] })

    const file = await openStoredFile('f-1', 'hub-b')

    expect(mocks.decryptFile).toHaveBeenCalledWith(expect.any(ArrayBuffer), envelope('enc-me'))
    expect(mocks.decryptFileMetadata).toHaveBeenCalledWith(metadata('enc-me'))
    expect(file.metadata?.originalName).toBe('a.txt')
  })

  it('matches the uploader’s account key too', async () => {
    mocks.getFileEnvelopes.mockResolvedValue({ envelopes: [envelope('sig-me')] })
    mocks.getFileMetadata.mockResolvedValue({ metadata: [metadata('sig-me')] })
    await openStoredFile('f-1')
    expect(mocks.decryptFile).toHaveBeenCalledWith(expect.any(ArrayBuffer), envelope('sig-me'))
  })

  it('refuses when no envelope is addressed to this device — it does not try envelopes[0]', async () => {
    mocks.getFileEnvelopes.mockResolvedValue({ envelopes: [envelope('enc-other'), envelope('enc-third')] })
    mocks.getFileMetadata.mockResolvedValue({ metadata: [metadata('enc-other')] })

    await expect(openStoredFile('f-1')).rejects.toBeInstanceOf(FileAccessDeniedError)
    expect(mocks.decryptFile).not.toHaveBeenCalled()
    expect(mocks.decryptFileMetadata).not.toHaveBeenCalled()
  })

  it('refuses when the device has no keys loaded', async () => {
    mocks.getDevicePubkeys.mockResolvedValue(null)
    await expect(openStoredFile('f-1')).rejects.toBeInstanceOf(FileAccessDeniedError)
    expect(mocks.downloadFile).not.toHaveBeenCalled()
  })

  it('still opens the file when its metadata entry is not addressed to this device', async () => {
    mocks.getFileEnvelopes.mockResolvedValue({ envelopes: [envelope('enc-me')] })
    mocks.getFileMetadata.mockResolvedValue({ metadata: [metadata('enc-other')] })
    const file = await openStoredFile('f-1')
    expect(file.metadata).toBeNull()
    expect(mocks.decryptFile).toHaveBeenCalled()
  })

  it('requests content, envelopes and metadata through the file’s own hub', async () => {
    mocks.getFileEnvelopes.mockResolvedValue({ envelopes: [envelope('enc-me')] })
    mocks.getFileMetadata.mockResolvedValue({ metadata: [] })

    await openStoredFile('f-1', 'hub-b')

    expect(mocks.downloadFile).toHaveBeenCalledWith('f-1', 'hub-b')
    expect(mocks.getFileEnvelopes).toHaveBeenCalledWith('f-1', 'hub-b')
    expect(mocks.getFileMetadata).toHaveBeenCalledWith('f-1', 'hub-b')
  })
})
