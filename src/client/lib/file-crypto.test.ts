/**
 * #3003 — a file's content layer is the RAW BYTES of the file, on every client.
 *
 * The desktop used to seal the hex TEXT of the file (`TextEncoder` over
 * `bytesToHex(file)`): 2n+28 bytes of ciphertext that opened to ASCII on every
 * client that reads the file as bytes, and a real size ceiling of half the
 * upload limit. The vectors below were sealed by the desktop's production
 * primitive and by the crate; `packages/crypto/src/ffi_v3.rs` opens the same
 * bytes through the function iOS and Android call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gcm } from '@noble/ciphers/aes.js'
import { bytesToHex, hexToBytes } from '@shared/encoding'
import { LABEL_FILE_KEY, LABEL_FILE_METADATA } from '@shared/crypto-labels'
import { contentAadHex } from '@shared/envelope-aad'

const wraps = vi.hoisted(() => ({
  keys: [] as Array<{ keyHex: string; pubkey: string; label: string }>,
}))

vi.mock('./platform', async importOriginal => {
  const actual = await importOriginal<typeof import('./platform')>()
  return {
    ...actual,
    // No Tauri here: the HPKE half is stubbed, the AES-GCM half is the real one.
    resolveEncryptionPubkey: vi.fn(async (pubkey: string) => (pubkey.startsWith('sig-') ? `enc-${pubkey.slice(4)}` : pubkey)),
    hpkeWrapKey: vi.fn(async (keyHex: string, pubkey: string, label: string) => {
      wraps.keys.push({ keyHex, pubkey, label })
      return { enc: 'ab'.repeat(32), ct: 'cd'.repeat(48) }
    }),
    unwrapFileKey: vi.fn(async () => wraps.keys.find(k => k.label === LABEL_FILE_KEY)!.keyHex),
  }
})

import { aesGcmOpenBytes, aesGcmSealBytes } from './platform'
import { decryptFile, encryptFile, pickAddressedTo } from './file-crypto'

interface FileContentVectors {
  label: string
  keyHex: string
  aadHex: string
  plaintextHex: string
  desktopCiphertextHex: string
  crateCiphertextHex: string
}

const vectors: FileContentVectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../packages/crypto/tests/fixtures/file-content-vectors.json'), 'utf8'),
)

beforeEach(() => {
  wraps.keys.length = 0
})

describe('the file-content vectors', () => {
  it('state the canonical file-label AAD', () => {
    expect(vectors.label).toBe(LABEL_FILE_KEY)
    expect(vectors.aadHex).toBe(contentAadHex(LABEL_FILE_KEY))
  })

  it.each(['desktopCiphertextHex', 'crateCiphertextHex'] as const)(
    'the desktop reader opens the %s to the file bytes',
    async which => {
      const opened = await aesGcmOpenBytes(hexToBytes(vectors[which]), vectors.keyHex, vectors.aadHex)
      expect(bytesToHex(opened)).toBe(vectors.plaintextHex)
      // n + nonce(12) + tag(16): the bytes, not an encoding of them.
      expect(vectors[which].length / 2).toBe(vectors.plaintextHex.length / 2 + 28)
    },
  )

  it('are bound to the file label: the metadata label’s AAD does not open them', async () => {
    await expect(
      aesGcmOpenBytes(hexToBytes(vectors.desktopCiphertextHex), vectors.keyHex, contentAadHex(LABEL_FILE_METADATA)),
    ).rejects.toThrow()
  })
})

describe('aesGcmSealBytes', () => {
  it('seals the bytes of the file: an independent AES-GCM reader gets the bytes back, n+28 long', async () => {
    const file = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256)
    const sealed = await aesGcmSealBytes(file, vectors.keyHex, vectors.aadHex)
    expect(sealed.length).toBe(file.length + 28)

    // What the crate does with the same layout: nonce(12) | ct | tag(16).
    const opened = gcm(hexToBytes(vectors.keyHex), sealed.slice(0, 12), hexToBytes(vectors.aadHex)).decrypt(sealed.slice(12))
    expect(bytesToHex(opened)).toBe(bytesToHex(file))
  })

  it('opens what an independent AES-GCM writer sealed, byte for byte', async () => {
    const file = Uint8Array.from({ length: 300 }, (_, i) => 255 - (i % 256))
    const nonce = Uint8Array.from({ length: 12 }, (_, i) => i + 1)
    const ct = gcm(hexToBytes(vectors.keyHex), nonce, hexToBytes(vectors.aadHex)).encrypt(file)
    const packed = new Uint8Array(12 + ct.length)
    packed.set(nonce)
    packed.set(ct, 12)
    expect(bytesToHex(await aesGcmOpenBytes(packed, vectors.keyHex, vectors.aadHex))).toBe(bytesToHex(file))
  })
})

describe('encryptFile / decryptFile', () => {
  it('a file of n bytes is n+28 bytes of ciphertext and round-trips', async () => {
    const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 31 + (i >> 8)) % 256)
    const file = new File([bytes], 'scan.bin', { type: 'application/octet-stream' })

    const encrypted = await encryptFile(file, ['reader-1'])
    expect(encrypted.encryptedContent.length).toBe(bytes.length + 28)

    const { blob } = await decryptFile(encrypted.encryptedContent.buffer as ArrayBuffer, encrypted.recipientEnvelopes[0])
    expect(bytesToHex(new Uint8Array(await blob.arrayBuffer()))).toBe(bytesToHex(bytes))
  })

  it('writes one envelope and one metadata entry per READER — an uploader who is also an admin is not named twice', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.txt', { type: 'text/plain' })
    // sig-x and enc-x are the same person: the account key and the encryption key.
    const encrypted = await encryptFile(file, ['sig-x', 'enc-x', 'enc-y', 'enc-y'])

    expect(encrypted.recipientEnvelopes.map(e => e.pubkey)).toEqual(['sig-x', 'enc-y'])
    expect(encrypted.encryptedMetadata.map(m => m.pubkey)).toEqual(['sig-x', 'enc-y'])
  })
})

describe('pickAddressedTo', () => {
  const device = { signingPubkeyHex: 'sig-me', encryptionPubkeyHex: 'enc-me' }
  const entry = (pubkey: string) => ({ pubkey })

  it('finds the entry addressed to the device’s account key or its encryption key', () => {
    expect(pickAddressedTo([entry('enc-other'), entry('sig-me')], device)).toEqual(entry('sig-me'))
    expect(pickAddressedTo([entry('enc-other'), entry('enc-me')], device)).toEqual(entry('enc-me'))
  })

  it('refuses rather than handing back someone else’s entry', () => {
    expect(pickAddressedTo([entry('enc-other'), entry('enc-third')], device)).toBeNull()
    expect(pickAddressedTo([], device)).toBeNull()
  })
})
