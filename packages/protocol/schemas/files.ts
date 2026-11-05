import { z } from 'zod'
import { paginationSchema, fileKeyEnvelopeSchema, encryptedMetadataEntrySchema } from './common'

// --- Ownership ---

/**
 * What a file belongs to. Every file belongs to exactly one hub (`hubId`), and
 * names its parent inside that hub by a typed reference with its own foreign
 * key — never by overloading one nullable column (#2462).
 *
 * - `conversation`: an attachment to a conversation or report thread (a report
 *   IS a conversation row; a message names its attachments by id).
 * - `case_record`: a file attached to a case record (its evidence entry, which
 *   is written after the upload completes, references the file).
 * - `entity_field`: the value of an entity's file field. The entity may not
 *   exist yet when the file is uploaded (forms upload before submit), so its
 *   parent is the hub itself; the field value carries the file id.
 */
export const fileOwnerKindSchema = z.enum(['conversation', 'case_record', 'entity_field'])
export type FileOwnerKind = z.infer<typeof fileOwnerKindSchema>

export const fileOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), conversationId: z.string().min(1) }),
  z.object({ kind: z.literal('case_record'), caseRecordId: z.string().min(1) }),
  z.object({ kind: z.literal('entity_field') }),
])
export type FileOwner = z.infer<typeof fileOwnerSchema>

// --- Storage/wire types ---

/** Full file record — storage type used by server and client */
export const fileRecordSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  ownerKind: fileOwnerKindSchema,
  conversationId: z.string().nullable(),
  caseRecordId: z.string().nullable(),
  uploadedBy: z.string(),
  recipientEnvelopes: z.array(fileKeyEnvelopeSchema),
  encryptedMetadata: z.array(encryptedMetadataEntrySchema),
  totalSize: z.number(),
  totalChunks: z.number(),
  status: z.enum(['uploading', 'complete', 'failed']),
  completedChunks: z.number(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
})
export type FileRecord = z.infer<typeof fileRecordSchema>

// --- Input schemas ---

export const listFilesQuerySchema = paginationSchema

export const shareFileBodySchema = z.object({
  envelope: fileKeyEnvelopeSchema,
  encryptedMetadata: encryptedMetadataEntrySchema,
})
export type ShareFileBody = z.infer<typeof shareFileBodySchema>

// --- Response schemas ---

/** The caller's own key envelope (every envelope for `files:download-all`). */
export const fileEnvelopesResponseSchema = z.object({
  envelopes: z.array(fileKeyEnvelopeSchema),
})
export type FileEnvelopesResponse = z.infer<typeof fileEnvelopesResponseSchema>

/** The caller's own metadata entry (every entry for `files:download-all`). */
export const fileMetadataResponseSchema = z.object({
  metadata: z.array(encryptedMetadataEntrySchema),
})
export type FileMetadataResponse = z.infer<typeof fileMetadataResponseSchema>
