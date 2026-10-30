import { z } from 'zod'
import { pubkeySchema } from './common'

// --- Erasure request status ---

export const erasureRequestStatusSchema = z.enum([
  'pending',
  'cancelled',
  'executing',
  'completed',
  'failed',
  // An erasure admin gave up on a `failed` request (#2347). Not `completed`:
  // nothing was erased, and the row says who stopped it and why.
  'abandoned',
])

export type ErasureRequestStatus = z.infer<typeof erasureRequestStatusSchema>

// --- Erasure config (per-hub) ---

export const erasureConfigSchema = z.object({
  hubId: z.string(),
  delayHours: z.number().int().min(24).max(168),
  emergencyOverrideEnabled: z.boolean(),
  /** null until an admin saves a config for the hub (defaults in force) */
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
})

export type ErasureConfig = z.infer<typeof erasureConfigSchema>

export const updateErasureConfigBodySchema = z.object({
  delayHours: z.number().int().min(24).max(168).optional(),
  emergencyOverrideEnabled: z.boolean().optional(),
})

// --- Erasure request ---

export const erasureRequestSchema = z.object({
  id: z.string(),
  userId: z.string(),
  status: erasureRequestStatusSchema,
  requestedBy: z.string(),
  requestedAt: z.string(),
  executeAt: z.string(),
  executedAt: z.string().nullable(),
  justification: z.string().nullable(),
  emergencyOverride: z.boolean(),
  coApproverPubkey: z.string().nullable(),
  cancelledAt: z.string().nullable(),
})

export type ErasureRequest = z.infer<typeof erasureRequestSchema>

// --- Self-service erasure request body ---

export const createSelfErasureBodySchema = z.object({
  justification: z.string().max(2000).optional(),
})

// --- Emergency override body ---

export const createEmergencySelfErasureBodySchema = z.object({
  justification: z.string().min(1).max(2000),
  coApproverPubkey: pubkeySchema,
  coApproverSignature: z.string().min(1),
  timestamp: z.string(),
})

// --- Admin immediate erasure body ---

export const adminErasureBodySchema = z.object({
  justification: z.string().min(1).max(2000),
})

// --- Abandon a failed erasure request ---

/** Abandoning is a decision about someone's erasure; the reason is part of the record. */
export const abandonErasureBodySchema = z.object({
  justification: z.string().trim().min(1).max(2000),
})

// --- Re-encryption job ---

export const reEncryptionJobSchema = z.object({
  id: z.string(),
  userId: z.string(),
  hubId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  totalEnvelopes: z.number(),
  processedEnvelopes: z.number(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
})

export type ReEncryptionJob = z.infer<typeof reEncryptionJobSchema>

// --- Response schemas ---

export const erasureConfigResponseSchema = z.object({
  config: erasureConfigSchema,
})

export const erasureRequestResponseSchema = z.object({
  request: erasureRequestSchema,
})

export const erasureRequestListResponseSchema = z.object({
  requests: z.array(erasureRequestSchema),
  total: z.number(),
})

export const reEncryptionJobListResponseSchema = z.object({
  jobs: z.array(reEncryptionJobSchema),
})

// --- Device wipe body ---

export const deviceWipeBodySchema = z.object({
  reason: z.string().max(500).optional(),
})
