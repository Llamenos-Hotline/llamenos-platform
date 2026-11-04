import { z } from 'zod'
import { paginationSchema, paginatedMeta } from './common'

// --- Input schemas ---

export const listAuditQuerySchema = paginationSchema.extend({
  actorPubkey: z.string().optional(),
  eventType: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  search: z.string().optional(),
})

// --- Response schemas ---

export const auditEntryResponseSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorPubkey: z.string(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  previousEntryHash: z.string().optional(),
  entryHash: z.string().optional(),
})

export type AuditLogEntry = z.infer<typeof auditEntryResponseSchema>
export type ListAuditQuery = z.input<typeof listAuditQuerySchema>

// --- List response schema ---

export const auditListResponseSchema = z.object({
  entries: z.array(auditEntryResponseSchema),
  ...paginatedMeta,
})

// --- Chain verification ---

export const auditVerifyQuerySchema = z.object({
  hubId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(500),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

export const auditVerifyResponseSchema = z.object({
  valid: z.boolean(),
  totalEntries: z.number(),
  checkedEntries: z.number(),
  firstBrokenEntry: z.object({
    id: z.string(),
    seqIndex: z.number(),
    expected: z.string().nullable(),
    actual: z.string().nullable(),
    reason: z.string(),
  }).optional(),
})
