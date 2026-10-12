import { describe, it, expect } from 'vitest'
import { aesGcmEncrypt, aesGcmDecrypt } from './platform'

describe('aesGcmEncrypt / aesGcmDecrypt roundtrip', () => {
  it('encrypts and decrypts plaintext', async () => {
    const keyHex = '0'.repeat(64) // 32 bytes = 256 bits
    const plaintext = 'Hello, world!'

    const encrypted = await aesGcmEncrypt(plaintext, keyHex, '')
    expect(encrypted).toBeTruthy()
    expect(encrypted.length).toBeGreaterThan(0)

    const decrypted = await aesGcmDecrypt(encrypted, keyHex, '')
    expect(decrypted).toBe(plaintext)
  })

  it('handles unicode content', async () => {
    const keyHex = 'f'.repeat(64)
    const plaintext = 'Unicode: 🎉 ñ 中文'

    const encrypted = await aesGcmEncrypt(plaintext, keyHex, '')
    const decrypted = await aesGcmDecrypt(encrypted, keyHex, '')
    expect(decrypted).toBe(plaintext)
  })

  it('handles empty string', async () => {
    const keyHex = 'a'.repeat(64)
    const plaintext = ''

    const encrypted = await aesGcmEncrypt(plaintext, keyHex, '')
    const decrypted = await aesGcmDecrypt(encrypted, keyHex, '')
    expect(decrypted).toBe('')
  })

  it('produces different ciphertexts for same plaintext (IV randomness)', async () => {
    const keyHex = 'b'.repeat(64)
    const plaintext = 'Same text'

    const encrypted1 = await aesGcmEncrypt(plaintext, keyHex, '')
    const encrypted2 = await aesGcmEncrypt(plaintext, keyHex, '')

    expect(encrypted1).not.toBe(encrypted2)
  })

  it('fails decryption with wrong key', async () => {
    const keyHex = 'c'.repeat(64)
    const wrongKey = 'd'.repeat(64)
    const plaintext = 'Secret'

    const encrypted = await aesGcmEncrypt(plaintext, keyHex, '')
    await expect(aesGcmDecrypt(encrypted, wrongKey, '')).rejects.toThrow()
  })

  it('fails decryption with tampered ciphertext', async () => {
    const keyHex = 'e'.repeat(64)
    const plaintext = 'Secret'

    const encrypted = await aesGcmEncrypt(plaintext, keyHex, '')
    // Flip a byte in the middle of the ciphertext (past the 12-byte IV = 24 hex chars)
    // to ensure the AES-GCM authentication tag check fails reliably
    const midpoint = 24 + Math.floor((encrypted.length - 24) / 2)
    const originalByte = parseInt(encrypted.slice(midpoint, midpoint + 2), 16)
    const flippedByte = (originalByte ^ 0xff).toString(16).padStart(2, '0')
    const tampered = encrypted.slice(0, midpoint) + flippedByte + encrypted.slice(midpoint + 2)

    await expect(aesGcmDecrypt(tampered, keyHex, '')).rejects.toThrow()
  })
})

describe('aesGcm AAD binding', () => {
  const keyHex = '1'.repeat(64)
  const aadHex = '6c6c616d656e6f733a6d657373616765' // UTF-8 "llamenos:message"

  it('round-trips when both sides supply the same AAD', async () => {
    const encrypted = await aesGcmEncrypt('bound', keyHex, aadHex)
    expect(await aesGcmDecrypt(encrypted, keyHex, aadHex)).toBe('bound')
  })

  it('refuses to open an AAD-bound ciphertext with no AAD', async () => {
    const encrypted = await aesGcmEncrypt('bound', keyHex, aadHex)
    await expect(aesGcmDecrypt(encrypted, keyHex, '')).rejects.toThrow()
  })

  it('refuses to open a bare ciphertext with an AAD', async () => {
    const encrypted = await aesGcmEncrypt('bare', keyHex, '')
    await expect(aesGcmDecrypt(encrypted, keyHex, aadHex)).rejects.toThrow()
  })

  it('refuses to open with a different AAD', async () => {
    const encrypted = await aesGcmEncrypt('bound', keyHex, aadHex)
    const other = '6c6c616d656e6f733a63616c6c2d6d657461' // UTF-8 "llamenos:call-meta"
    await expect(aesGcmDecrypt(encrypted, keyHex, other)).rejects.toThrow()
  })
})
