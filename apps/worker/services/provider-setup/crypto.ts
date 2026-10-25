import { serverEncrypt, serverDecrypt } from '../../lib/crypto'
import { LABEL_STORAGE_CREDENTIAL_WRAP } from '@shared/crypto-labels'
import { hexToBytes, bytesToHex, utf8ToBytes } from '@shared/encoding'

/**
 * Encrypt provider credentials for at-rest storage.
 *
 * Uses serverEncrypt (HKDF-SHA256 key derivation + symmetric encryption via FFI)
 * with LABEL_STORAGE_CREDENTIAL_WRAP for domain separation.
 * Returns a hex-encoded ciphertext string.
 */
export function encryptCredentials(
  creds: Record<string, unknown>,
  serverKek: string,
): string {
  const plaintext = utf8ToBytes(JSON.stringify(creds))
  const ct = serverEncrypt(plaintext, LABEL_STORAGE_CREDENTIAL_WRAP, hexToBytes(serverKek))
  return bytesToHex(ct)
}

/**
 * Decrypt provider credentials from at-rest storage.
 *
 * Inverse of encryptCredentials. Returns the parsed credential object.
 */
export function decryptCredentials(
  encrypted: string,
  serverKek: string,
): Record<string, unknown> {
  const ct = hexToBytes(encrypted)
  const plaintext = serverDecrypt(ct, LABEL_STORAGE_CREDENTIAL_WRAP, hexToBytes(serverKek))
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
}
