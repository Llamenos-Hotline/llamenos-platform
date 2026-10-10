import { z } from 'zod'
import { pubkeySchema, paginationSchema, paginatedMeta, recipientEnvelopeSchema } from './common'

// --- Response schemas ---

export const conversationResponseSchema = z.object({
  id: z.string(),
  channelType: z.string(),
  contactIdentifierHash: z.string(),
  contactLast4: z.string().optional(),
  assignedTo: z.string().optional(),
  status: z.enum(['active', 'waiting', 'closed']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().optional(),
  messageCount: z.number(),
  metadata: z.object({
    linkedCallId: z.string().optional(),
    reportId: z.string().optional(),
    type: z.literal('report').optional(),
    reportTitle: z.string().optional(),
    reportCategory: z.string().optional(),
    reportTypeId: z.string().optional(),
    customFieldValues: z.string().optional(),
    conversionStatus: z.enum(['pending', 'in_progress', 'completed']).optional(),
  }).optional(),
})

export type Conversation = z.infer<typeof conversationResponseSchema>

export const messageResponseSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  authorPubkey: z.string().optional(),
  encryptedContent: z.string(),
  readerEnvelopes: z.array(recipientEnvelopeSchema),
  createdAt: z.string(),
  status: z.string().optional(),
  hasAttachments: z.boolean().optional(),
  attachmentIds: z.array(z.string()).optional(),
  deliveredAt: z.string().optional(),
  readAt: z.string().optional(),
  failureReason: z.string().optional(),
  retryCount: z.number().optional(),
  externalId: z.string().optional(),
})

export type ConversationMessage = z.infer<typeof messageResponseSchema>

// --- List/wrapper response schemas ---

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationResponseSchema),
  ...paginatedMeta,
})

export const messageListResponseSchema = z.object({
  messages: z.array(messageResponseSchema),
  ...paginatedMeta,
})

export const conversationStatsResponseSchema = z.object({
  waiting: z.number(),
  active: z.number(),
  closed: z.number(),
  today: z.number(),
  total: z.number(),
})

export const volunteerLoadResponseSchema = z.object({
  loads: z.record(z.string(), z.number()),
})

// --- Input schemas ---

export const listConversationsQuerySchema = paginationSchema.extend({
  status: z.enum(['waiting', 'active', 'closed']).optional(),
  assignedTo: pubkeySchema.optional(),
  channel: z.enum(['sms', 'whatsapp', 'signal', 'rcs', 'web']).optional(),
  type: z.enum(['report', 'conversation']).optional(),
  contactHash: z.string().optional(),
})

export const sendMessageBodySchema = z.object({
  /** E2EE encrypted content — required for web channel, optional for external channels with plaintextForSending */
  encryptedContent: z.string().max(65536).optional(),
  /** HPKE-wrapped keys for each reader — required for web channel, optional for external channels */
  readerEnvelopes: z.array(recipientEnvelopeSchema).optional(),
  /** Plaintext body for external channel dispatch (SMS/WhatsApp/Signal/RCS) — discarded after send */
  plaintextForSending: z.string().max(65536).optional(),
  /** Alias for plaintextForSending — convenience for API consumers */
  body: z.string().max(65536).optional(),
  /** Provider-assigned external message ID (used by simulation/test flows) */
  externalId: z.string().optional(),
})

export const updateConversationBodySchema = z.object({
  status: z.enum(['waiting', 'active', 'closed']).optional(),
  assignedTo: pubkeySchema.optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const claimConversationBodySchema = z.object({
  pubkey: pubkeySchema,
})

export const createConversationBodySchema = z.object({
  channelType: z.enum(['sms', 'whatsapp', 'signal', 'rcs', 'web']).optional().default('web'),
  contactIdentifierHash: z.string().optional().default(''),
  contactLast4: z.string().max(4).optional(),
  assignedTo: pubkeySchema.optional(),
  status: z.enum(['waiting', 'active', 'closed']).optional().default('waiting'),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
