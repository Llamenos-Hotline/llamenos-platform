import { z } from 'zod'
import { recipientEnvelopeSchema, paginationSchema } from './common'
import { auditEntryResponseSchema } from './audit'

// --- Evidence Classification ---

export const evidenceClassificationSchema = z.enum([
  'photo', 'video', 'document', 'audio', 'other',
])

export type EvidenceClassification = z.infer<typeof evidenceClassificationSchema>

// --- Custody Action ---

export const custodyActionSchema = z.enum([
  'uploaded', 'viewed', 'downloaded', 'shared', 'exported', 'integrity_verified',
])

export type CustodyAction = z.infer<typeof custodyActionSchema>

// --- Custody Entry (stored per evidence access) ---

export const custodyEntrySchema = z.object({
  id: z.uuid(),
  evidenceId: z.uuid(),
  action: custodyActionSchema,
  actorPubkey: z.string(),
  timestamp: z.string(),               // ISO 8601
  integrityHash: z.string(),           // SHA-256 of the file at time of action
  ipHash: z.string().optional(),       // Blind index of IP (for audit, not tracking)
  userAgent: z.string().optional(),    // Browser/client identifier
  notes: z.string().optional(),        // Optional reason (e.g., "downloaded for court filing")
})

export type CustodyEntry = z.infer<typeof custodyEntrySchema>

// --- Evidence Metadata (stored per evidence file) ---

export const evidenceMetadataSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  fileId: z.string(),                   // Reference to the R2 file
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  classification: evidenceClassificationSchema,

  // --- Integrity ---
  integrityHash: z.string(),           // SHA-256 of encrypted file at upload
  hashAlgorithm: z.literal('sha256'),

  // --- Source ---
  source: z.string().optional(),        // "volunteer_upload", "report_attachment", "observer_camera"
  sourceDescription: z.string().optional(),

  // --- E2EE metadata ---
  encryptedDescription: z.string().optional(),
  descriptionEnvelopes: z.array(recipientEnvelopeSchema).optional(),

  // --- Timestamps ---
  uploadedAt: z.string(),
  uploadedBy: z.string(),              // Pubkey

  // --- Custody chain ---
  custodyEntryCount: z.number(),
})

export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>

// --- Upload Evidence Body (from client) ---

export const uploadEvidenceBodySchema = z.object({
  fileId: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  classification: evidenceClassificationSchema,
  integrityHash: z.string().length(64),  // Client-computed SHA-256 hex
  source: z.string().optional(),
  sourceDescription: z.string().optional(),
  encryptedDescription: z.string().optional(),
  descriptionEnvelopes: z.array(recipientEnvelopeSchema).optional(),
  interactionTypeHash: z.string().optional(),
})

export type UploadEvidenceBody = z.infer<typeof uploadEvidenceBodySchema>

// --- Log Custody Event Body ---

export const logCustodyEventBodySchema = z.object({
  action: custodyActionSchema,
  integrityHash: z.string().length(64),
  notes: z.string().optional(),
})

export type LogCustodyEventBody = z.infer<typeof logCustodyEventBodySchema>

// --- Verify Integrity Body ---

export const verifyIntegrityBodySchema = z.object({
  currentHash: z.string().length(64),
})

export type VerifyIntegrityBody = z.infer<typeof verifyIntegrityBodySchema>

// --- List Evidence Query ---

export const listEvidenceQuerySchema = paginationSchema.extend({
  classification: evidenceClassificationSchema.optional(),
})

export type ListEvidenceQuery = z.infer<typeof listEvidenceQuerySchema>

// --- Response schemas for OpenAPI ---

export const evidenceListResponseSchema = z.object({
  evidence: z.array(evidenceMetadataSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
})

export const custodyChainResponseSchema = z.object({
  custodyChain: z.array(custodyEntrySchema),
  total: z.number(),
})
export type CustodyChainResponse = z.infer<typeof custodyChainResponseSchema>

export const verifyIntegrityResponseSchema = z.object({
  valid: z.boolean(),
  originalHash: z.string(),
  currentHash: z.string(),
})
export type VerifyIntegrityResponse = z.infer<typeof verifyIntegrityResponseSchema>

// --- Evidence Access Log (Issue #730) ---
// Admin-only, hash-chained view of every access to a single evidence item —
// backed by the Epic 77 audit_log chain, not a parallel unchained table.

export const evidenceAccessLogResponseSchema = z.object({
  entries: z.array(auditEntryResponseSchema),
  total: z.number(),
})

export type EvidenceAccessLogResponse = z.infer<typeof evidenceAccessLogResponseSchema>
