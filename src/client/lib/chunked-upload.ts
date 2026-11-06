import { initUpload, uploadChunk, completeUpload } from './api'
import type { EncryptedFileUpload } from './file-crypto'
import type { FileOwner, UploadCompleteResponse } from '@protocol/schemas'

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024 // 5MB

export interface ChunkedUploadOptions {
  /** The output of `encryptFile`: ciphertext plus its key and metadata envelopes. */
  encrypted: EncryptedFileUpload
  /** What the file is attached to (#2462). */
  owner: FileOwner
  /**
   * The hub the file belongs to: the hub of the record it is attached to. Omit
   * it only for a file that belongs to the hub being browsed (a new row, a
   * conversation of the active hub).
   */
  hubId?: string
  chunkSize?: number
  onProgress?: (completed: number, total: number) => void
}

/**
 * Upload an encrypted file in chunks with progress reporting — the one upload
 * path for every file: conversation attachments, case-record evidence and
 * entity file fields. For files smaller than the chunk size, uses a single chunk.
 */
export async function chunkedUpload(options: ChunkedUploadOptions): Promise<UploadCompleteResponse> {
  const { encrypted } = options
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE
  const totalSize = encrypted.encryptedContent.length
  const totalChunks = Math.ceil(totalSize / chunkSize)

  const { uploadId } = await initUpload({
    totalSize,
    totalChunks,
    owner: options.owner,
    recipientEnvelopes: encrypted.recipientEnvelopes,
    encryptedMetadata: encrypted.encryptedMetadata,
  }, options.hubId)

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, totalSize)
    const chunk = encrypted.encryptedContent.slice(start, end).buffer as ArrayBuffer

    await uploadChunk(uploadId, i, chunk, options.hubId)
    options.onProgress?.(i + 1, totalChunks)
  }

  return completeUpload(uploadId, options.hubId)
}
