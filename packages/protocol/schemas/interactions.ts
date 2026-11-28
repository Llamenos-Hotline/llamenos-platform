import { z } from 'zod'
import { recipientEnvelopeSchema, paginationSchema } from './common'

// --- Interaction Type ---

export const interactionTypeSchema = z.enum([
  'note',            // Linked existing note from RecordsDO
  'call',            // Linked call record
  'message',         // Linked conversation/message
  'status_change',   // Case status was changed
  'referral',        // Case referred to another role/hub
  'assessment',      // Assessment conducted (lethality, triage, etc.)
  'file_upload',     // Evidence or file attached
  'comment',         // Inline comment on the case timeline
])

export type InteractionType = z.infer<typeof interactionTypeSchema>

// --- CaseInteraction (stored in CaseDO) ---

export const caseInteractionSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),

  // --- Source link (for linked interactions) ---
  interactionType: interactionTypeSchema,
  sourceId: z.string().optional(),       // ID of the source entity (note ID, call ID, etc.)

  // --- E2EE content (for inline interactions) ---
  encryptedContent: z.string().optional(),
  contentEnvelopes: z.array(recipientEnvelopeSchema).optional(),

  // --- Cleartext metadata ---
  authorPubkey: z.string(),
  interactionTypeHash: z.string(),       // Blind index for filtering by type
  createdAt: z.string(),
})

export type CaseInteraction = z.infer<typeof caseInteractionSchema>

// --- Create Interaction Body ---

export const createInteractionBodySchema = z.object({
  interactionType: interactionTypeSchema,
  sourceId: z.string().optional(),
  encryptedContent: z.string().max(65536).optional(),
  contentEnvelopes: z.array(recipientEnvelopeSchema).optional(),
  interactionTypeHash: z.string(),
}).strict().refine(
  (data) => {
    // Linked interactions must have sourceId; inline interactions must have content
    if (['note', 'call', 'message'].includes(data.interactionType)) {
      return !!data.sourceId
    }
    if (data.interactionType === 'comment') {
      return !!data.encryptedContent
    }
    return true
  },
  { message: 'Linked interactions require sourceId; comments require encryptedContent' },
)

export type CreateInteractionBody = z.infer<typeof createInteractionBodySchema>

// --- List Interactions Query ---

export const listInteractionsQuerySchema = paginationSchema.extend({
  interactionTypeHash: z.string().optional(),
  after: z.string().optional(),          // ISO 8601 timestamp for pagination
  before: z.string().optional(),         // ISO 8601 timestamp for pagination
})

export type ListInteractionsQuery = z.infer<typeof listInteractionsQuerySchema>

// --- Encrypted payload (client-side only, for reference/codegen) ---

export const interactionContentSchema = z.object({
  text: z.string(),
  // For status changes:
  previousStatus: z.string().optional(),
  newStatus: z.string().optional(),
  changeReason: z.string().optional(),
  // For referrals:
  referredTo: z.string().optional(),
  referralNotes: z.string().optional(),
  // For assessments:
  assessmentType: z.string().optional(),
  assessmentResult: z.string().optional(),
})

export type InteractionContent = z.infer<typeof interactionContentSchema>

// --- Response schemas for OpenAPI ---

export const interactionListResponseSchema = z.object({
  interactions: z.array(caseInteractionSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
})

export const sourceInteractionLookupResponseSchema = z.object({
  linked: z.boolean(),
  caseId: z.string().optional(),
  interactionId: z.string().optional(),
})
