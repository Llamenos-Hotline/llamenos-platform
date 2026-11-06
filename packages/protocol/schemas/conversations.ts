import { z } from 'zod'
import { pubkeySchema, paginationSchema, paginatedMeta, recipientEnvelopeSchema } from './common'

// --- Response schemas ---

/**
 * What a conversation's `metadata` may hold. The server writes it (reports,
 * call links) and a PATCH may merge into it, so both the write path and the
 * response are bound to this one shape.
 */
export const conversationMetadataSchema = z.object({
  linkedCallId: z.string().optional(),
  reportId: z.string().optional(),
  type: z.literal('report').optional(),
  reportTitle: z.string().optional(),
  reportCategory: z.string().optional(),
  reportTypeId: z.string().optional(),
  customFieldValues: z.string().optional(),
  conversionStatus: z.enum(['pending', 'in_progress', 'completed']).optional(),
})

export type ConversationMetadata = z.infer<typeof conversationMetadataSchema>

export const conversationResponseSchema = z.object({
  id: z.string(),
  channelType: z.string(),
  contactIdentifierHash: z.string(),
  assignedTo: z.string().optional(),
  status: z.enum(['active', 'waiting', 'closed']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().optional(),
  messageCount: z.number(),
  metadata: conversationMetadataSchema.optional(),
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

/**
 * `GET /hubs/:hubId/conversations` — one page of the conversations the caller
 * may see, for every caller. Permissions decide WHICH rows are visible
 * (`conversations:read-all`: the whole hub; otherwise the caller's own plus the
 * waiting queue on channels they may claim), never the shape: `total` counts
 * that same visible set under the same filters, and `page`/`limit` are the
 * query's own, so `total > page * limit` means there is another page.
 */
export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationResponseSchema),
  ...paginatedMeta,
})

export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>

/** `GET /hubs/:hubId/conversations/:id/messages` — one page, newest first. */
export const messageListResponseSchema = z.object({
  messages: z.array(messageResponseSchema),
  ...paginatedMeta,
})

export type MessageListResponse = z.infer<typeof messageListResponseSchema>

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

// --- Assignee re-wrap (#1512, #2046) ---
//
// The client-mediated exchange that makes a conversation's existing messages
// readable by a newly assigned volunteer. See PROTOCOL.md §2.4.1. The server
// never sees a content key or plaintext on this path: a client that can
// already open a message unwraps its content key locally and seals it to the
// assignee's device keys.

/**
 * One X25519 device key of the assignee, with what the re-wrap gate needs to
 * decide whether history may be sealed to it (PROTOCOL.md §2.4.1 "Trust").
 */
export const assigneeRecipientSchema = z.object({
  pubkey: pubkeySchema,
  /** When the key last took its current value (ISO 8601). Not `registeredAt`. */
  keySetAt: z.string(),
  /**
   * True when a device verification (SAS) by the key's owner or a hub admin
   * covers the key as it stands now.
   */
  confirmed: z.boolean(),
})

export type AssigneeRecipient = z.infer<typeof assigneeRecipientSchema>

/** One message the current assignee cannot yet open. */
export const assigneeEnvelopeGapSchema = z.object({
  id: z.string(),
  /** When the message was written (ISO 8601): the age the recipient keys are judged against. */
  createdAt: z.string(),
  /** The message's existing envelopes, so the re-wrapper can open its own. */
  readerEnvelopes: z.array(recipientEnvelopeSchema),
  /** The assignee's X25519 device keys this message has no envelope for. */
  missingRecipients: z.array(pubkeySchema),
})

export type AssigneeEnvelopeGap = z.infer<typeof assigneeEnvelopeGapSchema>

/**
 * `GET /conversations/:id/assignee-envelopes` — at most 200 gaps, oldest
 * first. The re-wrapper posts envelopes and asks again until `messages` is
 * empty.
 */
export const assigneeEnvelopeGapsResponseSchema = z.object({
  assignedTo: pubkeySchema.nullable(),
  /** Every X25519 device key of the assignee — the keys that may be sealed to, subject to the gate. */
  recipients: z.array(assigneeRecipientSchema),
  messages: z.array(assigneeEnvelopeGapSchema),
})

export type AssigneeEnvelopeGapsResponse = z.infer<typeof assigneeEnvelopeGapsResponseSchema>

/** One client-sealed envelope addressed to one of the assignee's device keys. */
export const assigneeEnvelopeEntrySchema = z.object({
  messageId: z.string().min(1).max(64),
  envelope: recipientEnvelopeSchema,
})

export type AssigneeEnvelopeEntry = z.infer<typeof assigneeEnvelopeEntrySchema>

/**
 * `POST /conversations/:id/assignee-envelopes` — append-only, all-or-nothing.
 * Every envelope must name a registered X25519 device key of the CURRENT
 * assignee, and none may name a key set after its message was written unless
 * that key is confirmed (the same rule the re-wrapping client applies).
 */
export const addAssigneeEnvelopesBodySchema = z.object({
  envelopes: z.array(assigneeEnvelopeEntrySchema).min(1).max(1000),
})

export type AddAssigneeEnvelopesBody = z.infer<typeof addAssigneeEnvelopesBodySchema>

export const addAssigneeEnvelopesResponseSchema = z.object({
  /** Envelopes actually written; a recipient that already had one is skipped. */
  added: z.number().int().nonnegative(),
})

export type AddAssigneeEnvelopesResponse = z.infer<typeof addAssigneeEnvelopesResponseSchema>

// --- Input schemas ---

/**
 * Filters for `GET /hubs/:hubId/conversations`. Omit `status` for every
 * status. Reports are conversation rows too, but this endpoint never lists
 * them — they are read through `/reports`, under the reports permissions.
 */
export const listConversationsQuerySchema = paginationSchema.extend({
  status: z.enum(['waiting', 'active', 'closed']).optional(),
  assignedTo: pubkeySchema.optional(),
  channel: z.enum(['sms', 'whatsapp', 'signal', 'rcs', 'web']).optional(),
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
  /** Merged into the stored metadata, so it is held to the shape the response declares. */
  metadata: conversationMetadataSchema.optional(),
})

export const claimConversationBodySchema = z.object({
  pubkey: pubkeySchema,
})

export const createConversationBodySchema = z.object({
  channelType: z.enum(['sms', 'whatsapp', 'signal', 'rcs', 'web']).optional().default('web'),
  contactIdentifierHash: z.string().optional().default(''),
  assignedTo: pubkeySchema.optional(),
  status: z.enum(['waiting', 'active', 'closed']).optional().default('waiting'),
  metadata: conversationMetadataSchema.optional(),
})
