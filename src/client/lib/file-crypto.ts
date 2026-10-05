/**
 * File encryption/decryption.
 *
 * All HPKE and symmetric operations delegate to Rust via platform.ts IPC.
 * No direct noble/crypto imports — everything routes through the Rust backend.
 */

import type { EncryptedFileMetadata, FileKeyEnvelope } from '@shared/types'
import { LABEL_FILE_KEY, LABEL_FILE_METADATA } from '@shared/crypto-labels'
import { contentAadHex } from '@shared/envelope-aad'
import {
  unwrapFileKey as platformUnwrapFileKey,
  decryptFileMetadata as platformDecryptFileMetadata,
  rewrapFileKey as platformRewrapFileKey,
  hpkeWrapKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
} from './platform'

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}

/**
 * Unwrap a symmetric file key using CryptoState (private key stays in Rust).
 * Returns the file key as hex string.
 */
export async function unwrapFileKey(
  encHex: string,
  ctHex: string,
): Promise<string> {
  return platformUnwrapFileKey({ enc: encHex, ct: ctHex })
}

/**
 * Decrypt file metadata using CryptoState.
 */
export async function decryptFileMetadata(
  encryptedContentHex: string,
  encHex: string,
): Promise<EncryptedFileMetadata | null> {
  try {
    const json = await platformDecryptFileMetadata(encryptedContentHex, encHex)
    return json ? JSON.parse(json) : null
  } catch {
    return null
  }
}

export interface EncryptedFileUpload {
  encryptedContent: Uint8Array
  recipientEnvelopes: FileKeyEnvelope[]
  encryptedMetadata: Array<{
    pubkey: string
    encryptedContent: string
    enc: string
    ct: string
  }>
}

/**
 * Encrypt a file for multiple recipients.
 * Uses a single random symmetric key to encrypt the file content once (AES-256-GCM),
 * then wraps that key for each recipient using HPKE via Rust.
 */
export async function encryptFile(
  file: File,
  recipientPubkeys: string[],
): Promise<EncryptedFileUpload> {
  const plaintextBytes = new Uint8Array(await file.arrayBuffer())

  // Compute checksum
  const hashBuffer = await crypto.subtle.digest('SHA-256', plaintextBytes)
  const checksum = bytesToHex(new Uint8Array(hashBuffer))

  const metadata: EncryptedFileMetadata = {
    originalName: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    checksum,
  }

  // Generate random symmetric key for file content
  const fileKeyHex = bytesToHex(randomBytes(32))

  // AES-256-GCM encrypt file content under the canonical content AAD for
  // LABEL_FILE_KEY — the same derivation every other implementation binds, so
  // the file opens on any client. `hpkeWrapKey` seals the key under the
  // matching key-wrap AAD.
  const encryptedContentHex = await aesGcmEncrypt(
    bytesToHex(plaintextBytes),
    fileKeyHex,
    contentAadHex(LABEL_FILE_KEY),
  )
  const encryptedContent = hexToBytes(encryptedContentHex)

  // Wrap the file key for each recipient using HPKE via Rust
  const recipientEnvelopes: FileKeyEnvelope[] = await Promise.all(
    recipientPubkeys.map(async (pubkey) => {
      const { enc, ct } = await hpkeWrapKey(fileKeyHex, pubkey, LABEL_FILE_KEY)
      return { pubkey, enc, ct }
    })
  )

  // Encrypt metadata for each recipient using HPKE via Rust
  const metadataJson = JSON.stringify(metadata)
  const encryptedMetadataList = await Promise.all(
    recipientPubkeys.map(async (pubkey) => {
      const metadataKeyHex = bytesToHex(randomBytes(32))
      const encContent = await aesGcmEncrypt(metadataJson, metadataKeyHex, contentAadHex(LABEL_FILE_METADATA))
      const { enc, ct } = await hpkeWrapKey(metadataKeyHex, pubkey, LABEL_FILE_METADATA)
      return { pubkey, encryptedContent: encContent, enc, ct }
    })
  )

  return {
    encryptedContent,
    recipientEnvelopes,
    encryptedMetadata: encryptedMetadataList,
  }
}

/**
 * Decrypt a file given the encrypted content and key envelope.
 * HPKE unwrap goes through CryptoState (Rust); symmetric decryption also via IPC.
 */
export async function decryptFile(
  encryptedContent: ArrayBuffer,
  envelope: FileKeyEnvelope,
): Promise<{ blob: Blob; checksum: string }> {
  const fileKeyHex = await unwrapFileKey(envelope.enc, envelope.ct)

  const data = new Uint8Array(encryptedContent)
  const encryptedHex = bytesToHex(data)
  const plaintextHex = await aesGcmDecrypt(encryptedHex, fileKeyHex, contentAadHex(LABEL_FILE_KEY))
  const plaintext = hexToBytes(plaintextHex)

  // Compute checksum for verification
  const hashBuffer = await crypto.subtle.digest('SHA-256', plaintext.buffer as ArrayBuffer)
  const checksum = bytesToHex(new Uint8Array(hashBuffer))

  return {
    blob: new Blob([plaintext.buffer as ArrayBuffer]),
    checksum,
  }
}

/**
 * Re-wrap a file's symmetric key for a new recipient via CryptoState.
 * Admin's private key stays in Rust — decrypts and re-encrypts in one IPC call.
 */
export async function rewrapFileKey(
  encHex: string,
  ctHex: string,
  newRecipientPubkeyHex: string,
): Promise<FileKeyEnvelope> {
  const envelope = await platformRewrapFileKey(
    encHex,
    ctHex,
    newRecipientPubkeyHex,
  )
  return {
    pubkey: newRecipientPubkeyHex,
    enc: envelope.enc,
    ct: envelope.ct,
  }
}
