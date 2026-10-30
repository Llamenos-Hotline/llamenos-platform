import { z } from 'zod'
import { paginationSchema, paginatedMeta, pubkeySchema, recipientEnvelopeSchema, keyEnvelopeSchema } from './common'

// --- Response schemas ---

export const noteResponseSchema = z.object({
  id: z.uuid(),
  callId: z.string().optional(),
  conversationId: z.string().optional(),
  contactHash: z.string().optional(),
  encryptedContent: z.string(),
  authorPubkey: pubkeySchema,
  authorEnvelope: keyEnvelopeSchema.optional(),
  adminEnvelopes: z.array(recipientEnvelopeSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  replyCount: z.number().optional(),
})

export type EncryptedNote = z.infer<typeof noteResponseSchema>

/** What `POST /notes` (201) and `PATCH /notes/:id` (200) answer: the stored note, wrapped — never bare. */
export const noteStoredResponseSchema = z.object({
  note: noteResponseSchema,
})

/**
 * A note reply as the server serialises it: a `note_replies` row. NOT a note —
 * a reply has no `updatedAt`, no `authorEnvelope`/`adminEnvelopes`, and is
 * readable through `readerEnvelopes` (what `createReplyBodySchema` accepts).
 */
export const noteReplyResponseSchema = z.object({
  id: z.uuid(),
  noteId: z.uuid(),
  authorPubkey: pubkeySchema,
  encryptedContent: z.string(),
  readerEnvelopes: z.array(recipientEnvelopeSchema),
  createdAt: z.string(),
})

/** What `POST /notes/:id/replies` (201) answers: the stored reply, wrapped under `reply` — never bare. */
export const noteReplyStoredResponseSchema = z.object({
  reply: noteReplyResponseSchema,
})

// --- List/wrapper response schemas ---

export const noteListResponseSchema = z.object({
  notes: z.array(noteResponseSchema),
  ...paginatedMeta,
})

export const noteRepliesResponseSchema = z.object({
  replies: z.array(noteResponseSchema),
})

// --- Input schemas ---

export const listNotesQuerySchema = paginationSchema.extend({
  callId: z.string().optional(),
  conversationId: z.string().optional(),
  contactHash: z.string().optional(),
})

export const createNoteBodySchema = z.object({
  callId: z.string().optional(),
  conversationId: z.string().optional(),
  contactHash: z.string().optional(),
  encryptedContent: z.string().min(1, 'encryptedContent is required').max(65536),
  authorEnvelope: keyEnvelopeSchema.optional(),
  adminEnvelopes: z.array(recipientEnvelopeSchema).optional(),
  /** Optional case linkage — auto-creates an interaction tying this note to a case */
  caseId: z.string().optional(),
  /** Encrypted interaction type hash for the case interaction */
  interactionTypeHash: z.string().optional(),
}).refine(
  data => data.callId || data.conversationId,
  { message: 'callId or conversationId is required' }
)

export const updateNoteBodySchema = z.object({
  encryptedContent: z.string().min(1).max(65536).optional(),
  authorEnvelope: keyEnvelopeSchema.optional(),
  adminEnvelopes: z.array(recipientEnvelopeSchema).optional(),
})

export const createReplyBodySchema = z.object({
  encryptedContent: z.string().min(1, 'encryptedContent is required').max(65536),
  readerEnvelopes: z.array(recipientEnvelopeSchema).min(1, 'At least one reader envelope required'),
})
