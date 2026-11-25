/**
 * File encryption/decryption.
 *
 * All HPKE and symmetric operations delegate to Rust via platform.ts IPC.
 * No direct noble/crypto imports — everything routes through the Rust backend.
 */

import type { EncryptedFileMetadata, FileKeyEnvelope } from '@shared/types'
import { LABEL_FILE_KEY, LABEL_FILE_METADATA } from '@shared/crypto-labels'
import { contentAadHex } from '@shared/envelope-aad'
import { bytesToHex } from '@shared/encoding'
import {
  unwrapFileKey as platformUnwrapFileKey,
  decryptFileMetadata as platformDecryptFileMetadata,
  rewrapFileKey as platformRewrapFileKey,
  hpkeWrapKey,
  resolveEncryptionPubkey,
  aesGcmEncrypt,
  aesGcmSealBytes,
  aesGcmOpenBytes,
  type DeviceKeyState,
} from './platform'

/** The two public keys an envelope can be addressed to for one device. */
export type FileReaderDevice = Pick<DeviceKeyState, 'signingPubkeyHex' | 'encryptionPubkeyHex'>

/**
 * The entry of a file's envelope or metadata list addressed to THIS device —
 * its Ed25519 account key (how the uploader names itself) or its X25519 key
 * (how an admin of the hub is named) — and `null` when none is.
 *
 * There is deliberately no fallback to the first entry. An entry for someone
 * else's key cannot be opened by this device, and handing it to the opener
 * turns "you are not a reader of this file" into a misleading decrypt failure
 * (or, for a server that returns every admin's entry, into a wrong-key open
 * attempt). Refusing is the correct answer; the caller says "no access".
 */
export function pickAddressedTo<T extends { pubkey: string }>(
  entries: readonly T[],
  device: FileReaderDevice,
): T | null {
  return entries.find(e => e.pubkey === device.encryptionPubkeyHex || e.pubkey === device.signingPubkeyHex) ?? null
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  crypto.getRandomValues(buf)
  return buf
}

/**
 * Decrypt a file's metadata entry addressed to this device. `null` when the
 * entry will not open — a metadata blob is never the reason a file is refused.
 */
export async function decryptFileMetadata(
  entry: { encryptedContent: string; enc: string; ct: string },
): Promise<EncryptedFileMetadata | null> {
  try {
    return JSON.parse(await platformDecryptFileMetadata(entry)) as EncryptedFileMetadata
  } catch (err) {
    console.error('[crypto] file metadata addressed to this device failed to open —', err instanceof Error ? err.message : err)
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
 * One entry per READER. An uploader who is also an admin of the hub is named
 * twice — by their account key and by their encryption key — and sealing to
 * both writes two envelopes for one reader, so the stored set stops describing
 * who can open the file. Entries are compared by the encryption key they
 * resolve to; the first spelling is kept.
 */
async function distinctRecipients(pubkeys: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const distinct: string[] = []
  for (const pubkey of pubkeys) {
    const resolved = await resolveEncryptionPubkey(pubkey)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    distinct.push(pubkey)
  }
  return distinct
}

/**
 * Encrypt a file for multiple recipients.
 * Uses a single random symmetric key to encrypt the file content once (AES-256-GCM),
 * then wraps that key for each recipient using HPKE via Rust.
 */
export async function encryptFile(
  file: File,
  allRecipientPubkeys: string[],
): Promise<EncryptedFileUpload> {
  const recipientPubkeys = await distinctRecipients(allRecipientPubkeys)
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
  //
  // The RAW file bytes are sealed — not their hex text. Every client seals and
  // opens raw bytes through the crate (`mobile_symmetric_encrypt` hex-decodes
  // its input first), so the ciphertext is n+28 bytes and opens everywhere.
  const encryptedContent = await aesGcmSealBytes(plaintextBytes, fileKeyHex, contentAadHex(LABEL_FILE_KEY))

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
 * Decrypt a file given the encrypted content and the key envelope addressed to
 * this device. The content key is opened through CryptoState (Rust holds the
 * device key); the content layer is AES-256-GCM over the raw file bytes.
 */
export async function decryptFile(
  encryptedContent: ArrayBuffer,
  envelope: FileKeyEnvelope,
): Promise<{ blob: Blob; checksum: string }> {
  const fileKeyHex = await platformUnwrapFileKey(envelope)

  const plaintext = await aesGcmOpenBytes(new Uint8Array(encryptedContent), fileKeyHex, contentAadHex(LABEL_FILE_KEY))

  // Compute checksum for verification
  const hashBuffer = await crypto.subtle.digest('SHA-256', plaintext as Uint8Array<ArrayBuffer>)
  const checksum = bytesToHex(new Uint8Array(hashBuffer))

  return {
    blob: new Blob([plaintext as Uint8Array<ArrayBuffer>]),
    checksum,
  }
}

/**
 * Re-wrap a file's symmetric key for a new recipient: open it with this
 * device's key and seal it to the recipient's.
 */
export async function rewrapFileKey(
  envelope: FileKeyEnvelope,
  newRecipientPubkeyHex: string,
): Promise<FileKeyEnvelope> {
  const rewrapped = await platformRewrapFileKey(envelope, newRecipientPubkeyHex)
  return { pubkey: newRecipientPubkeyHex, enc: rewrapped.enc, ct: rewrapped.ct }
}
