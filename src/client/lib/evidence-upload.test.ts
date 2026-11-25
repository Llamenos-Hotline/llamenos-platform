import { describe, it, expect, vi } from 'vitest'

// Stand-ins for the Rust-backed primitives. The AEAD mock prepends a 12-byte
// nonce and appends a 16-byte tag so ciphertext length differs from plaintext.
vi.mock('./platform', () => ({
  hpkeWrapKey: vi.fn(async () => ({ enc: 'enc', ct: 'ct' })),
  aesGcmEncrypt: vi.fn(async (plaintextHexOrJson: string) => {
    const body = Array.from(new TextEncoder().encode(plaintextHexOrJson), (b) => b.toString(16).padStart(2, '0')).join('')
    return '11'.repeat(12) + body + '22'.repeat(16)
  }),
  aesGcmSealBytes: vi.fn(async (plaintext: Uint8Array) => {
    const out = new Uint8Array(12 + plaintext.length + 16)
    out.fill(0x11, 0, 12)
    out.set(plaintext, 12)
    out.fill(0x22, 12 + plaintext.length)
    return out
  }),
  aesGcmOpenBytes: vi.fn(),
  resolveEncryptionPubkey: vi.fn(async (pubkey: string) => pubkey),
  unwrapFileKey: vi.fn(),
  decryptFileMetadata: vi.fn(),
  rewrapFileKey: vi.fn(),
  hpkeSealKey: vi.fn(),
  hpkeOpenKeyFromState: vi.fn(),
}))

import { prepareEvidenceUpload } from './evidence-upload'

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

describe('prepareEvidenceUpload', () => {
  const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const file = new File([plaintext], 'evidence.bin', { type: 'application/octet-stream' })

  it('hashes the ciphertext, not the plaintext', async () => {
    const { encrypted, integrityHash } = await prepareEvidenceUpload(file, ['pk1'])
    expect(integrityHash).toBe(await sha256Hex(encrypted.encryptedContent as Uint8Array<ArrayBuffer>))
    expect(integrityHash).not.toBe(await sha256Hex(plaintext))
  })

  it('reports the ciphertext length, not the plaintext length', async () => {
    const { encrypted, sizeBytes } = await prepareEvidenceUpload(file, ['pk1'])
    expect(sizeBytes).toBe(encrypted.encryptedContent.length)
    expect(sizeBytes).not.toBe(plaintext.length)
  })

  it('wraps the key for every recipient', async () => {
    const { encrypted } = await prepareEvidenceUpload(file, ['pk1', 'pk2'])
    expect(encrypted.recipientEnvelopes.map((e) => e.pubkey)).toEqual(['pk1', 'pk2'])
    expect(encrypted.encryptedMetadata.map((m) => m.pubkey)).toEqual(['pk1', 'pk2'])
  })
})
