import { z } from 'zod'
import { paginationSchema, paginatedMeta } from './common'

// --- Blast content schemas (single-language and multi-language) ---

/**
 * Blast body string validator — rejects control characters that corrupt SMS
 * encoding or exploit downstream parsers. Null bytes (\x00) break PostgreSQL
 * text storage. BEL, BS, and other C0 controls (except \t, \n, \r) are blocked.
 * Newlines and tabs are permitted (normal message formatting).
 */
const blastBodyString = (maxLen: number) =>
  z.string()
    .min(1)
    .max(maxLen)
    .refine(
      (s) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s),
      'Blast content must not contain control characters (null bytes, BEL, BS, etc.)',
    )

/** Single-language blast content (body + optional media URL) */
export const singleBlastContentSchema = z.object({
  body: blastBodyString(1600),
  mediaUrl: z.url().optional(),
})

export type SingleBlastContent = z.infer<typeof singleBlastContentSchema>

/** Multi-language blast content: Record<langCode, SingleBlastContent> — at least one language required */
export const multiBlastContentSchema = z.record(
  z.string().max(10),
  singleBlastContentSchema,
).refine(
  (obj) => Object.keys(obj).length > 0,
  'Multi-language content must have at least one language entry',
)

export type MultiBlastContent = z.infer<typeof multiBlastContentSchema>

/** Union: either old single-language format or new multi-language record */
export const blastContentSchema = z.union([singleBlastContentSchema, multiBlastContentSchema])

export type BlastContentInput = z.infer<typeof blastContentSchema>

/** Response content uses relaxed string types (no refinement on read) */
const singleBlastContentResponseSchema = z.object({
  body: z.string(),
  mediaUrl: z.string().optional(),
})

const blastContentResponseSchema = z.union([
  singleBlastContentResponseSchema,
  z.record(z.string(), singleBlastContentResponseSchema),
])

// --- Response schemas ---

export const blastResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: blastContentResponseSchema,
  defaultLanguage: z.string().optional(),
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']),
  targetChannels: z.array(z.string()),
  targetTags: z.array(z.string()).optional(),
  targetLanguages: z.array(z.string()).optional(),
  createdBy: z.string().optional(),
  scheduledAt: z.string().nullable().optional(),
  sentAt: z.string().nullable().optional(),
  cancelledAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stats: z.object({
    totalRecipients: z.number(),
    sent: z.number(),
    delivered: z.number(),
    failed: z.number(),
    optedOut: z.number(),
  }).optional(),
})

export type Blast = z.infer<typeof blastResponseSchema>

/**
 * What every blast MUTATION answers with (create, update, send, schedule,
 * cancel): the blast, wrapped. `GET /blasts/:id` answers with it bare.
 */
export const blastEnvelopeResponseSchema = z.object({
  blast: blastResponseSchema,
})

export type BlastEnvelopeResponse = z.infer<typeof blastEnvelopeResponseSchema>

export const subscriberResponseSchema = z.object({
  id: z.string(),
  identifierHash: z.string(),
  channels: z.array(z.object({
    type: z.string(),
    verified: z.boolean(),
  })),
  tags: z.array(z.string()),
  language: z.string(),
  subscribedAt: z.string(),
  status: z.enum(['active', 'paused', 'unsubscribed']),
  doubleOptInConfirmed: z.boolean().optional(),
})

export type Subscriber = z.infer<typeof subscriberResponseSchema>

export const subscriberStatsResponseSchema = z.object({
  total: z.number(),
  byChannel: z.record(z.string(), z.number()),
  byStatus: z.record(z.string(), z.number()),
})

export const blastSettingsResponseSchema = z.object({
  subscribeKeyword: z.string().optional(),
  unsubscribeKeyword: z.string().optional(),
  confirmationMessage: z.string().optional(),
  unsubscribeMessage: z.string().optional(),
  doubleOptIn: z.boolean().optional(),
  maxBlastsPerDay: z.number().optional(),
})

export type BlastSettings = z.infer<typeof blastSettingsResponseSchema>

// --- List/wrapper response schemas ---

export const subscriberListResponseSchema = z.object({
  subscribers: z.array(subscriberResponseSchema),
  ...paginatedMeta,
})

export const blastListResponseSchema = z.object({
  blasts: z.array(blastResponseSchema),
  ...paginatedMeta,
})

export const blastDeliveryResponseSchema = z.object({
  id: z.string(),
  blastId: z.string(),
  subscriberId: z.string(),
  channel: z.string(),
  status: z.enum(['pending', 'sending', 'sent', 'delivered', 'failed', 'opted_out', 'skipped', 'cancelled']),
  externalId: z.string().nullable().optional(),
  attempts: z.number(),
  lastAttemptAt: z.string().nullable().optional(),
  nextRetryAt: z.string().nullable().optional(),
  deliveredAt: z.string().nullable().optional(),
  failedAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string(),
})

export type BlastDelivery = z.infer<typeof blastDeliveryResponseSchema>

export const blastDeliveryListResponseSchema = z.object({
  deliveries: z.array(blastDeliveryResponseSchema),
  ...paginatedMeta,
})

export const importSubscribersResponseSchema = z.object({
  imported: z.number(),
  skipped: z.number(),
  errors: z.array(z.object({ identifier: z.string(), error: z.string() })).optional(),
})

// --- Input schemas ---

export const listBlastsQuerySchema = paginationSchema.extend({
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'cancelled']).optional(),
})

export const listSubscribersQuerySchema = paginationSchema.extend({
  channel: z.enum(['sms', 'whatsapp', 'signal']).optional(),
  status: z.enum(['active', 'paused', 'unsubscribed']).optional(),
  tag: z.string().optional(),
})

export const listDeliveriesQuerySchema = paginationSchema.extend({
  status: z.enum(['pending', 'sent', 'delivered', 'failed', 'opted_out', 'skipped']).optional(),
})

export const createBlastBodySchema = z.object({
  name: z.string().min(1).max(200),
  content: blastContentSchema,
  defaultLanguage: z.string().max(10).optional().default('en'),
  channels: z.array(z.enum(['sms', 'whatsapp', 'signal'])).min(1),
  scheduledAt: z.iso.datetime().optional(),
})

export const updateBlastBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  content: blastContentSchema.optional(),
  defaultLanguage: z.string().max(10).optional(),
  channels: z.array(z.enum(['sms', 'whatsapp', 'signal'])).min(1).optional(),
  scheduledAt: z.iso.datetime().optional().nullable(),
})

export const scheduleBlastBodySchema = z.object({
  scheduledAt: z.iso.datetime(),
})

export const importSubscribersBodySchema = z.object({
  subscribers: z.array(z.object({
    identifier: z.string().min(1).max(200),
    channel: z.enum(['sms', 'whatsapp', 'signal']),
    tags: z.array(z.string().max(100)).optional(),
    language: z.string().max(10).optional(),
  })).min(1).max(10000),
})

export const updateBlastSettingsBodySchema = z.object({
  subscribeKeyword: z.string().max(50).optional(),
  unsubscribeKeyword: z.string().max(50).optional(),
  confirmationMessage: z.string().max(500).optional(),
  unsubscribeMessage: z.string().max(500).optional(),
  doubleOptIn: z.boolean().optional(),
  maxBlastsPerDay: z.number().int().min(1).max(100).optional(),
})

export const messagingPreferencesBodySchema = z.object({
  optedOut: z.boolean().optional(),
  channels: z.array(z.enum(['sms', 'whatsapp', 'signal'])).optional(),
  language: z.string().max(10).optional(),
})

// --- Blast progress WS event ---

export const blastProgressDeliverySchema = z.object({
  deliveryId: z.string(),
  subscriberHash: z.string(),
  channel: z.string(),
  status: z.string(),
  error: z.string().optional(),
})

export const blastProgressEventSchema = z.object({
  type: z.literal('blast:progress'),
  hubId: z.string(),
  blastId: z.string(),
  stats: z.object({
    pending: z.number(),
    sent: z.number(),
    delivered: z.number(),
    failed: z.number(),
    optedOut: z.number(),
    total: z.number(),
  }),
  batch: z.array(blastProgressDeliverySchema),
})

export type BlastProgressEvent = z.infer<typeof blastProgressEventSchema>

// --- Retry response ---

export const retryDeliveryResponseSchema = z.object({
  ok: z.boolean(),
  delivery: blastDeliveryResponseSchema,
})

export const retryFailedResponseSchema = z.object({
  ok: z.boolean(),
  retriedCount: z.number(),
})
