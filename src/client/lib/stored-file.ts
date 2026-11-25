/**
 * Open a file that is already stored: the one reader for conversation
 * attachments, case-record evidence and entity file fields.
 *
 * Everything needed to read the file is derived from the file itself — its own
 * key envelopes and its own metadata — so a record that points at a file stores
 * the file's id and nothing else. The file's name, type and size are plaintext
 * to nobody but its readers, and a copy of any of them in the owning record
 * would be one more place for them to leak.
 */

import type { EncryptedFileMetadata } from '@shared/types'
import { downloadFile, getFileEnvelopes, getFileMetadata } from './api'
import { decryptFile, decryptFileMetadata, pickAddressedTo } from './file-crypto'
import { getDevicePubkeys } from './platform'

/** The caller holds no key this file was sealed to (or has no unlocked device). */
export class FileAccessDeniedError extends Error {
  constructor(fileId: string) {
    super(`this device is not a reader of file ${fileId}`)
    this.name = 'FileAccessDeniedError'
  }
}

export interface StoredFile {
  blob: Blob
  /** `null` when the metadata entry addressed to this device would not open. */
  metadata: EncryptedFileMetadata | null
}

/**
 * Download, unwrap and open `fileId`.
 *
 * `hubId` is the hub the file belongs to — the hub of the conversation, record
 * or entity it hangs off — never inferred from the hub being browsed: a file in
 * hub B must open while hub A is on screen. Omit it only for a file of the hub
 * being browsed.
 *
 * Throws {@link FileAccessDeniedError} when no envelope is addressed to this
 * device's keys. It never falls back to another reader's envelope.
 */
export async function openStoredFile(fileId: string, hubId?: string): Promise<StoredFile> {
  const device = await getDevicePubkeys()
  if (!device) throw new FileAccessDeniedError(fileId)

  const [encrypted, { envelopes }, { metadata: metadataList }] = await Promise.all([
    downloadFile(fileId, hubId),
    getFileEnvelopes(fileId, hubId),
    getFileMetadata(fileId, hubId),
  ])

  const envelope = pickAddressedTo(envelopes, device)
  if (!envelope) throw new FileAccessDeniedError(fileId)

  const mine = pickAddressedTo(metadataList, device)
  const metadata = mine ? await decryptFileMetadata(mine) : null

  const { blob } = await decryptFile(encrypted, envelope)
  return { blob, metadata }
}
