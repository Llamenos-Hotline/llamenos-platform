import { z } from 'zod'
import { paginationSchema, paginatedMeta, recipientEnvelopeSchema } from './common'
import { forPatch } from './patch'

// --- Response schemas ---

export const callRecordStatusSchema = z.enum(['ringing', 'in-progress', 'completed', 'unanswered'])

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
  /**
   * The opaque reference the VoIP push carries in place of the call's id (#2374). `id` is the
   * telephony provider's identifier for the call, which a push must never expose; a client
   * woken by a push resolves it to the call by matching this field. Present on active calls only.
   */
  pushRef: z.string().optional(),
  hubId: z.string().optional(),
  answeredBy: z.string().nullable().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  duration: z.number().optional(),
  status: callRecordStatusSchema.optional(),
  hasTranscription: z.boolean().optional(),
  hasVoicemail: z.boolean().optional(),
  hasRecording: z.boolean().optional(),
  recordingSid: z.string().optional(),
  encryptedContent: z.string().optional(),
  adminEnvelopes: z.array(recipientEnvelopeSchema).optional(),
  // Client-side decrypted field (populated after envelope decryption)
  callerNumber: z.string().optional(),
})

export type CallRecord = z.infer<typeof callRecordResponseSchema>
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

/**
 * What part of the hub's call history a `GET /calls/history` page was drawn
 * from (#1342). Always present, so a client never has to infer it from a short
 * or empty list:
 *
 * - `all`: the caller holds `calls:read-history` — every call of the hub.
 * - `own`: the caller holds only `calls:read-own-history` — the calls they
 *   answered whose answer time is on or after `availableSince`, i.e. within the
 *   hub's `windowDays`. Older calls are NOT deleted (the admin system of record
 *   keeps them); they are no longer served to this caller, and a client says so
 *   ("calls older than N days are no longer available to you").
 *
 * The window is access control, not cryptographic expiry: a record the caller
 * already fetched stays decryptable with their device key.
 */
export const callHistoryAccessScopeSchema = z.enum(['all', 'own'])

export const callHistoryAccessSchema = z.object({
  scope: callHistoryAccessScopeSchema,
  /** The hub's volunteer access window in days. Present when `scope` is `own`. */
  windowDays: z.number().int().optional(),
  /** ISO 8601 server time: the oldest answer time served. Present when `scope` is `own`. */
  availableSince: z.string().optional(),
})

export type CallHistoryAccess = z.infer<typeof callHistoryAccessSchema>

export const callHistoryResponseSchema = z.object({
  calls: z.array(callRecordResponseSchema),
  ...paginatedMeta,
  access: callHistoryAccessSchema,
})

// --- Volunteer access window (#1342) ---

/** Bounds of a hub's volunteer call-history access window, in days. */
export const CALL_HISTORY_ACCESS_DAYS_MIN = 1
export const CALL_HISTORY_ACCESS_DAYS_MAX = 365
/** The operator's default (2026-11-15): one week. */
export const CALL_HISTORY_ACCESS_DAYS_DEFAULT = 7

/**
 * A hub's volunteer call-history ACCESS window (#1342): how far back a member
 * holding only `calls:read-own-history` may read the calls they answered.
 *
 * This is NOT data retention. Nothing here deletes anything, and it must never
 * be wired into `retention.ts` / the erasure path: the records stay the admin
 * system of record, readable by every holder of `calls:read-history`, for as
 * long as the hub's retention policy keeps them.
 *
 * `GET`/`PATCH /hubs/:hubId/settings/call-history-access`. The PATCH body is
 * `forPatch` of this schema, so a body that omits the key changes nothing
 * instead of resetting the window to the default (#1643).
 */
export const callHistoryAccessSettingsSchema = z.object({
  volunteerAccessDays: z.number().int()
    .min(CALL_HISTORY_ACCESS_DAYS_MIN)
    .max(CALL_HISTORY_ACCESS_DAYS_MAX)
    .optional()
    .default(CALL_HISTORY_ACCESS_DAYS_DEFAULT),
})

export type CallHistoryAccessSettings = z.infer<typeof callHistoryAccessSettingsSchema>

export const callHistoryAccessSettingsPatchSchema = forPatch(callHistoryAccessSettingsSchema)

export type CallHistoryAccessSettingsPatch = z.infer<typeof callHistoryAccessSettingsPatchSchema>

// --- Input schemas ---

export const banCallerBodySchema = z.object({
  reason: z.string().max(500).optional(),
})

export const callHistoryQuerySchema = paginationSchema.extend({
  cursor: z.string().optional(),
  search: z.string().max(100).optional(),
  /**
   * History rows only ever carry 'completed' or 'unanswered' (CallsService.endCall
   * and the stale-call sweep), so those are the only filter values. Filtering is
   * server-side: `total` and pagination describe the filtered set (#1139).
   */
  status: z.enum(['completed', 'unanswered']).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
})
