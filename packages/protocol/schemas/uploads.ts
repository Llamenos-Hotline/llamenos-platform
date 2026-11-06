import { z } from 'zod'
import { fileKeyEnvelopeSchema, encryptedMetadataEntrySchema } from './common'
import { fileOwnerSchema } from './files'

// Uploads are mounted only under /hubs/:hubId (#2462): the path hub is the
// file's hub, and the owner names its parent inside that hub.

// --- Input schemas ---

export const uploadInitBodySchema = z.object({
  totalSize: z.number().int().min(1),
  totalChunks: z.number().int().min(1).max(10000),
  owner: fileOwnerSchema,
  recipientEnvelopes: z.array(fileKeyEnvelopeSchema).optional(),
  encryptedMetadata: z.array(encryptedMetadataEntrySchema).optional(),
})
export type UploadInitBody = z.infer<typeof uploadInitBodySchema>

// --- Response schemas ---

export const uploadInitResponseSchema = z.object({
  uploadId: z.string(),
  totalChunks: z.number(),
})
export type UploadInitResponse = z.infer<typeof uploadInitResponseSchema>

export const chunkUploadResponseSchema = z.object({
  chunkIndex: z.number(),
  completedChunks: z.number(),
  totalChunks: z.number(),
})
export type ChunkUploadResponse = z.infer<typeof chunkUploadResponseSchema>

export const uploadCompleteResponseSchema = z.object({
  fileId: z.string(),
  status: z.string(),
  completedAt: z.iso.datetime(),
})
export type UploadCompleteResponse = z.infer<typeof uploadCompleteResponseSchema>

export const uploadStatusResponseSchema = z.object({
  uploadId: z.string(),
  status: z.string(),
  completedChunks: z.number(),
  totalChunks: z.number(),
  totalSize: z.number(),
})
export type UploadStatusResponse = z.infer<typeof uploadStatusResponseSchema>
