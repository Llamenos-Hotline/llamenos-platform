import { z } from 'zod'
import { paginationSchema, paginatedMeta, recipientEnvelopeSchema } from './common'

// --- Response schemas ---

export const callStatusSchema = z.enum(['ringing', 'in-progress', 'completed', 'unanswered'])

/**
 * A call as the server sends it — active (`/calls/active`) or finished (`/calls/history`).
 *
 * The server never sends the HMAC of the caller's number: it is a stable, correlatable
 * caller identifier, and no client needs it (bans resolve it server-side). Nor the
 * volunteer who reported spam. Routes project their rows onto this shape; they never
 * pass a database row through.
 */
export const callRecordResponseSchema = z.object({
  id: z.string(),
  hubId: z.string().optional(),
  callerLast4: z.string().optional(),
  answeredBy: z.string().nullable().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  duration: z.number().optional(),
  status: callStatusSchema.optional(),
  hasTranscription: z.boolean().optional(),
  hasVoicemail: z.boolean().optional(),
  hasRecording: z.boolean().optional(),
  recordingSid: z.string().optional(),
  encryptedContent: z.string().optional(),
  adminEnvelopes: z.array(recipientEnvelopeSchema).optional(),
  // Client-side decrypted field (populated after envelope decryption)
  callerNumber: z.string().optional(),
})

export const activeCallResponseSchema = z.object({
  id: z.string(),
  callerNumber: z.string(),
  answeredBy: z.string().nullable().optional(),
  startedAt: z.string(),
  status: callStatusSchema,
})

export type CallRecord = z.infer<typeof callRecordResponseSchema>
export type ActiveCall = z.infer<typeof activeCallResponseSchema>
export type UserPresence = z.infer<typeof callPresenceResponseSchema>['users'][number]

export const callPresenceResponseSchema = z.object({
  users: z.array(z.object({
    pubkey: z.string(),
    status: z.enum(['available', 'on-call', 'online']),
  })),
})

// --- List/wrapper response schemas ---

export const activeCallsResponseSchema = z.object({
  calls: z.array(callRecordResponseSchema),
})

export const todayCountResponseSchema = z.object({
  count: z.number(),
})

export const callerContactSummarySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  caseCount: z.number().int().optional(),
  entityType: z.string().optional(),
})

export const callerIdentifyResponseSchema = z.object({
  contact: callerContactSummarySchema.nullable(),
  activeCaseCount: z.number(),
  recentCases: z.array(z.object({
    id: z.string(),
    caseNumber: z.string().optional(),
    status: z.string(),
  })),
})

export const callActionResponseSchema = z.object({
  call: callRecordResponseSchema,
})

export const banCallResponseSchema = z.object({
  banned: z.boolean(),
  hungUp: z.boolean(),
})

export const callHistoryResponseSchema = z.object({
  calls: z.array(callRecordResponseSchema),
  ...paginatedMeta,
})

// --- Input schemas ---

export const banCallerBodySchema = z.object({
  reason: z.string().max(500).optional(),
})

export const callHistoryQuerySchema = paginationSchema.extend({
  cursor: z.string().optional(),
  search: z.string().max(100).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
})
