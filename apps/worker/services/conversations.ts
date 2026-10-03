/**
 * ConversationsService — replaces ConversationDO.
 *
 * Manages messaging conversations, messages (individual rows, not arrays),
 * file records, contact identifiers, volunteer load, and contact summaries.
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, desc, sql, count, isNotNull, ne } from 'drizzle-orm'
import type { Database } from '../db'
import {
  conversations,
  messages,
  files,
  contactIdentifiers,
} from '../db/schema'
import type { ConversationStatus, MessageDeliveryStatus } from '../types'
import type { IncomingMessage, MessageStatusUpdate } from '../messaging/adapter'
import type { MessagingChannelType, FileKeyEnvelope } from '@shared/types'
import type { RecipientEnvelope } from '@shared/types'
import { encryptMessageForStorage, encryptContactIdentifier, decryptContactIdentifier } from '../lib/crypto'
import type { HpkeRecipientPubkey } from '../lib/hpke-recipient'
import { ServiceError } from './settings'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationFilters {
  hubId?: string
  status?: ConversationStatus
  assignedTo?: string
  channelType?: MessagingChannelType | 'web'
  type?: 'report' | 'conversation'
  contactHash?: string
  authorPubkey?: string
  limit?: number
  offset?: number
}

export interface CreateConversationInput {
  hubId?: string
  channelType?: MessagingChannelType | 'web'
  contactIdentifierHash?: string
  contactLast4?: string
  assignedTo?: string
  status?: ConversationStatus
  metadata?: Record<string, unknown>
}

export interface UpdateConversationInput {
  status?: ConversationStatus
  assignedTo?: string | null
  metadata?: Record<string, unknown>
}

export interface AddMessageInput {
  id?: string
  conversationId: string
  direction: 'inbound' | 'outbound'
  authorPubkey: string
  encryptedContent?: string
  readerEnvelopes?: RecipientEnvelope[]
  hasAttachments?: boolean
  attachmentIds?: string[]
  externalId?: string
  status?: MessageDeliveryStatus
  failureReason?: string
}

export interface MessagePagination {
  limit?: number
  offset?: number
}

export interface CreateFileInput {
  id: string
  conversationId: string
  messageId?: string
  uploadedBy: string
  recipientEnvelopes: FileKeyEnvelope[]
  encryptedMetadata: Array<{
    pubkey: string
    encryptedContent: string
    enc: string
    ct: string
  }>
  totalSize: number
  totalChunks: number
}

export interface ConversationStats {
  waiting: number
  active: number
  closed: number
  today: number
  total: number
}

export interface VolunteerLoadResult {
  pubkey: string
  load: number
  conversationIds: string[]
}

export interface ContactSummary {
  contactHash: string
  last4?: string | null
  conversationCount: number
  reportCount: number
  firstSeen: Date
  lastSeen: Date
}

// Infer row types from the schema
type ConversationRow = typeof conversations.$inferSelect
type MessageRow = typeof messages.$inferSelect
type FileRow = typeof files.$inferSelect

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ConversationsService {
  constructor(
    protected db: Database,
    protected hmacSecret?: string,
    protected adminPubkey?: string,
  ) {}

  // --- Conversation CRUD ---

  async create(input: CreateConversationInput): Promise<ConversationRow> {
    const [row] = await this.db
      .insert(conversations)
      .values({
        hubId: input.hubId,
        channelType: input.channelType ?? 'web',
        contactIdentifierHash: input.contactIdentifierHash ?? '',
        contactLast4: input.contactLast4,
        assignedTo: input.assignedTo,
        status: input.status ?? 'waiting',
        metadata: input.metadata ?? null,
        lastMessageAt: new Date(),
      })
      .returning()

    return row
  }

  async getById(id: string): Promise<ConversationRow> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1)

    if (!row) throw new ServiceError(404, 'Conversation not found')
    return row
  }

  async list(filters: ConversationFilters = {}): Promise<{ conversations: ConversationRow[]; total: number }> {
    const conditions = []

    if (filters.hubId) {
      conditions.push(eq(conversations.hubId, filters.hubId))
    }
    if (filters.status) {
      conditions.push(eq(conversations.status, filters.status))
    }
    if (filters.assignedTo) {
      conditions.push(eq(conversations.assignedTo, filters.assignedTo))
    }
    if (filters.channelType) {
      conditions.push(eq(conversations.channelType, filters.channelType))
    }
    if (filters.contactHash) {
      conditions.push(eq(conversations.contactIdentifierHash, filters.contactHash))
    }
    if (filters.authorPubkey) {
      conditions.push(eq(conversations.contactIdentifierHash, filters.authorPubkey))
    }

    // Filter by type using metadata JSONB.
    // Drizzle bun-sql double-serializes JSONB objects in insert .values(), storing
    // them as JSON strings instead of JSONB objects (jsonb_typeof = 'string').
    // Use a helper that handles both forms: try ->>'type' first (proper JSONB),
    // then fall back to parsing the string value (double-serialized).
    if (filters.type === 'report') {
      conditions.push(sql`COALESCE(
        ${conversations.metadata}->>'type',
        CASE WHEN jsonb_typeof(${conversations.metadata}) = 'string'
          THEN (${conversations.metadata} #>> '{}')::jsonb->>'type'
          ELSE NULL
        END
      ) = 'report'`)
    } else if (!filters.type) {
      // Default: exclude reports
      conditions.push(
        sql`(
          ${conversations.metadata} IS NULL
          OR COALESCE(
            ${conversations.metadata}->>'type',
            CASE WHEN jsonb_typeof(${conversations.metadata}) = 'string'
              THEN (${conversations.metadata} #>> '{}')::jsonb->>'type'
              ELSE NULL
            END
          ) IS DISTINCT FROM 'report'
        )`,
      )
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const limit = filters.limit ?? 50
    const offset = filters.offset ?? 0

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(conversations)
        .where(where)
        .orderBy(desc(conversations.lastMessageAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(conversations)
        .where(where),
    ])

    return { conversations: rows, total: totalRow.count }
  }

  async update(id: string, input: UpdateConversationInput): Promise<ConversationRow> {
    await this.getById(id) // throws 404 if not found
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    }
    if (input.status !== undefined) updates.status = input.status
    if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo
    if (input.metadata) {
      updates.metadata = sql`COALESCE(${conversations.metadata}, '{}'::jsonb) || ${input.metadata}::jsonb`
    }

    const [row] = await this.db
      .update(conversations)
      .set(updates)
      .where(eq(conversations.id, id))
      .returning()

    if (!row) throw new ServiceError(404, 'Conversation not found')
    return row
  }

  async delete(id: string): Promise<void> {
    const result = await this.db
      .delete(conversations)
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id })

    if (result.length === 0) throw new ServiceError(404, 'Conversation not found')
  }

  // --- Claim (assign to volunteer) ---

  async claim(id: string, pubkey: string): Promise<ConversationRow> {
    const existing = await this.getById(id)
    if (existing.status !== 'waiting') {
      throw new ServiceError(400, 'Conversation is not in waiting state')
    }

    const [row] = await this.db
      .update(conversations)
      .set({
        assignedTo: pubkey,
        status: 'active',
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, id))
      .returning()

    return row
  }

  // --- Messages ---

  async addMessage(input: AddMessageInput): Promise<MessageRow> {
    // Verify conversation exists (throws 404 if not found)
    await this.getById(input.conversationId)

    const [msg] = await this.db
      .insert(messages)
      .values({
        id: input.id ?? undefined,
        conversationId: input.conversationId,
        direction: input.direction,
        authorPubkey: input.authorPubkey,
        encryptedContent: input.encryptedContent ?? '',
        readerEnvelopes: input.readerEnvelopes,
        hasAttachments: input.hasAttachments ?? false,
        attachmentIds: input.attachmentIds,
        externalId: input.externalId,
        status: input.direction === 'outbound' ? (input.status ?? 'pending') : (input.status ?? 'sent'),
        failureReason: input.failureReason,
      })
      .returning()

    // Update conversation timestamps and count
    await this.db
      .update(conversations)
      .set({
        lastMessageAt: new Date(),
        updatedAt: new Date(),
        messageCount: sql`${conversations.messageCount} + 1`,
      })
      .where(eq(conversations.id, input.conversationId))

    return msg
  }

  async listMessages(
    conversationId: string,
    pagination: MessagePagination = {},
  ): Promise<{ messages: MessageRow[]; total: number }> {
    const limit = pagination.limit ?? 50
    const offset = pagination.offset ?? 0

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(messages)
        .where(eq(messages.conversationId, conversationId)),
    ])

    return { messages: rows, total: totalRow.count }
  }

  async updateMessageStatus(
    update: MessageStatusUpdate,
  ): Promise<{ conversationId: string; messageId: string; status: string } | { found: false }> {
    // Look up message by external ID
    const [msg] = await this.db
      .select()
      .from(messages)
      .where(eq(messages.externalId, update.externalId))
      .limit(1)

    if (!msg) return { found: false }

    // Only update if the new status is "more advanced" than current
    const statusOrder: Record<string, number> = {
      pending: 0,
      sent: 1,
      delivered: 2,
      read: 3,
      failed: 3,
    }

    const currentOrder = statusOrder[msg.status ?? 'pending']
    const newOrder = statusOrder[update.status]

    if (newOrder <= currentOrder && update.status !== 'failed') {
      return { conversationId: msg.conversationId, messageId: msg.id, status: msg.status ?? 'pending' }
    }

    const updateFields: Record<string, unknown> = {
      status: update.status,
    }

    if (update.status === 'delivered') {
      updateFields.deliveredAt = new Date(update.timestamp)
    } else if (update.status === 'read') {
      updateFields.readAt = new Date(update.timestamp)
      if (!msg.deliveredAt) {
        updateFields.deliveredAt = new Date(update.timestamp)
      }
    } else if (update.status === 'failed') {
      updateFields.failureReason = update.failureReason
    }

    await this.db
      .update(messages)
      .set(updateFields)
      .where(eq(messages.id, msg.id))

    return { conversationId: msg.conversationId, messageId: msg.id, status: update.status }
  }

  // --- External ID lookup ---

  async getByExternalId(
    externalId: string,
  ): Promise<{ conversationId: string; messageId: string } | null> {
    const [msg] = await this.db
      .select({
        conversationId: messages.conversationId,
        messageId: messages.id,
      })
      .from(messages)
      .where(eq(messages.externalId, externalId))
      .limit(1)

    return msg ?? null
  }

  // --- Inbound message processing ---

  async handleIncoming(
    incoming: IncomingMessage,
    /**
     * The platform admin's X25519 HPKE recipient, or `undefined` when the
     * deployment has none. Typed as a brand so an Ed25519 auth key — which is
     * also 64 hex characters, and which the messaging router used to pass here
     * — cannot be supplied by mistake (#1283).
     */
    adminDecryptionPubkey: HpkeRecipientPubkey | undefined,
    hubId?: string,
  ): Promise<{
    conversationId: string
    messageId: string
    isNew: boolean
    status: string
  }> {
    if (!this.hmacSecret) {
      throw new ServiceError(500, 'HMAC secret not configured')
    }

    // Find existing conversation from this sender on this channel.
    // hubId scoping prevents cross-worker bleed in parallel test execution.
    const whereConditions = [
      eq(conversations.channelType, incoming.channelType),
      eq(conversations.contactIdentifierHash, incoming.senderIdentifierHash),
      sql`${conversations.status} IN ('active', 'waiting', 'closed')`,
    ]
    if (hubId) {
      whereConditions.push(eq(conversations.hubId, hubId))
    } else {
      whereConditions.push(sql`${conversations.hubId} IS NULL`)
    }

    const [existingConv] = await this.db
      .select()
      .from(conversations)
      .where(and(...whereConditions))
      .orderBy(desc(conversations.updatedAt))
      .limit(1)

    let conv: ConversationRow
    let isNew = false

    if (existingConv) {
      conv = existingConv
      // Reopen closed conversations when a new message arrives
      if (conv.status === 'closed') {
        const [updated] = await this.db
          .update(conversations)
          .set({ status: 'waiting', updatedAt: new Date(), lastMessageAt: new Date() })
          .where(eq(conversations.id, conv.id))
          .returning()
        conv = updated
      }
    } else {
      // Create new conversation
      const digits = incoming.senderIdentifier.replace(/\D/g, '')
      const last4 = digits.length >= 4 ? digits.slice(-4) : digits

      const [created] = await this.db
        .insert(conversations)
        .values({
          hubId: hubId ?? null,
          channelType: incoming.channelType,
          contactIdentifierHash: incoming.senderIdentifierHash,
          contactLast4: last4,
          status: 'waiting',
          lastMessageAt: new Date(),
        })
        .returning()

      conv = created
      isNew = true

      // Store encrypted contact identifier for outbound sends
      await this.setContactIdentifier(
        conv.id,
        encryptContactIdentifier(incoming.senderIdentifier, this.hmacSecret),
      )
    }

    // Encrypt the message content using envelope pattern. An absent admin
    // recipient means one fewer reader, never a substituted key (#1283).
    const readerPubkeys: string[] = adminDecryptionPubkey ? [adminDecryptionPubkey] : []
    if (conv.assignedTo && conv.assignedTo !== adminDecryptionPubkey) {
      readerPubkeys.push(conv.assignedTo)
    }

    const encrypted = encryptMessageForStorage(incoming.body ?? '', readerPubkeys)

    const msg = await this.addMessage({
      conversationId: conv.id,
      direction: 'inbound',
      authorPubkey: 'system:inbound',
      encryptedContent: encrypted.encryptedContent,
      readerEnvelopes: encrypted.readerEnvelopes,
      hasAttachments: !!(incoming.mediaUrls && incoming.mediaUrls.length > 0),
      externalId: incoming.externalId,
    })

    return {
      conversationId: conv.id,
      messageId: msg.id,
      isNew,
      status: conv.status,
    }
  }

  // --- Contact identifier ---

  async setContactIdentifier(conversationId: string, encrypted: string): Promise<void> {
    await this.db
      .insert(contactIdentifiers)
      .values({
        conversationId,
        encryptedIdentifier: encrypted,
      })
      .onConflictDoUpdate({
        target: contactIdentifiers.conversationId,
        set: { encryptedIdentifier: encrypted },
      })
  }

  async getContactIdentifier(conversationId: string): Promise<string> {
    if (!this.hmacSecret) {
      throw new ServiceError(500, 'HMAC secret not configured')
    }

    const [row] = await this.db
      .select()
      .from(contactIdentifiers)
      .where(eq(contactIdentifiers.conversationId, conversationId))
      .limit(1)

    if (!row) throw new ServiceError(404, 'No contact identifier stored')

    const identifier = decryptContactIdentifier(row.encryptedIdentifier, this.hmacSecret)

    // Lazy migration: re-encrypt legacy plaintext entries
    if (!row.encryptedIdentifier.startsWith('enc:')) {
      await this.setContactIdentifier(
        conversationId,
        encryptContactIdentifier(identifier, this.hmacSecret),
      )
    }

    return identifier
  }

  // --- File management ---

  async createFile(input: CreateFileInput): Promise<FileRow> {
    const [row] = await this.db
      .insert(files)
      .values({
        id: input.id,
        conversationId: input.conversationId,
        messageId: input.messageId,
        uploadedBy: input.uploadedBy,
        recipientEnvelopes: input.recipientEnvelopes,
        encryptedMetadata: input.encryptedMetadata,
        totalSize: input.totalSize,
        totalChunks: input.totalChunks,
        completedChunks: 0,
        status: 'uploading',
      })
      .returning()

    return row
  }

  async getFile(id: string): Promise<FileRow> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(eq(files.id, id))
      .limit(1)

    if (!row) throw new ServiceError(404, 'File not found')
    return row
  }

  async updateFileStatus(
    id: string,
    update: { completedChunks?: number; status?: string; completedAt?: Date },
  ): Promise<FileRow> {
    const updates: Record<string, unknown> = {}
    if (update.completedChunks !== undefined) {
      updates.completedChunks = update.completedChunks
    }
    if (update.status !== undefined) updates.status = update.status
    if (update.completedAt !== undefined) updates.completedAt = update.completedAt

    const [row] = await this.db
      .update(files)
      .set(updates)
      .where(eq(files.id, id))
      .returning()

    if (!row) throw new ServiceError(404, 'File not found')
    return row
  }

  async markChunkComplete(id: string): Promise<FileRow> {
    const [row] = await this.db
      .update(files)
      .set({
        completedChunks: sql`${files.completedChunks} + 1`,
      })
      .where(eq(files.id, id))
      .returning()

    if (!row) throw new ServiceError(404, 'File not found')
    return row
  }

  async markFileComplete(id: string): Promise<FileRow> {
    const [row] = await this.db
      .update(files)
      .set({
        status: 'complete',
        completedAt: new Date(),
      })
      .where(eq(files.id, id))
      .returning()

    if (!row) throw new ServiceError(404, 'File not found')
    return row
  }

  async addFileRecipient(
    id: string,
    envelope: FileKeyEnvelope,
    encryptedMetadata: { pubkey: string; encryptedContent: string; enc: string; ct: string },
  ): Promise<FileRow> {
    // Use JSONB append to add envelope and metadata atomically
    const [row] = await this.db
      .update(files)
      .set({
        recipientEnvelopes: sql`(
          CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(${files.recipientEnvelopes}) elem
              WHERE elem->>'pubkey' = ${envelope.pubkey}
            )
            THEN ${files.recipientEnvelopes} || ${JSON.stringify(envelope)}::jsonb
            ELSE ${files.recipientEnvelopes}
          END
        )`,
        encryptedMetadata: sql`(
          CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(${files.encryptedMetadata}) elem
              WHERE elem->>'pubkey' = ${encryptedMetadata.pubkey}
            )
            THEN ${files.encryptedMetadata} || ${JSON.stringify(encryptedMetadata)}::jsonb
            ELSE ${files.encryptedMetadata}
          END
        )`,
      })
      .where(eq(files.id, id))
      .returning()

    if (!row) throw new ServiceError(404, 'File not found')
    return row
  }

  async listFiles(conversationId?: string): Promise<FileRow[]> {
    const conditions = [eq(files.status, 'complete')]
    if (conversationId) {
      conditions.push(eq(files.conversationId, conversationId))
    }

    return this.db
      .select()
      .from(files)
      .where(and(...conditions))
      .orderBy(desc(files.createdAt))
  }

  // --- Volunteer load ---

  async getVolunteerLoad(pubkey: string, hubId?: string): Promise<VolunteerLoadResult> {
    const conditions = [
      eq(conversations.assignedTo, pubkey),
      ne(conversations.status, 'closed'),
    ]
    if (hubId) {
      conditions.push(eq(conversations.hubId, hubId))
    }

    const rows = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(...conditions))

    return {
      pubkey,
      load: rows.length,
      conversationIds: rows.map((r) => r.id),
    }
  }

  async getAllVolunteerLoads(hubId?: string): Promise<Record<string, number>> {
    const conditions = [
      isNotNull(conversations.assignedTo),
      ne(conversations.status, 'closed'),
    ]
    if (hubId) {
      conditions.push(eq(conversations.hubId, hubId))
    }

    const rows = await this.db
      .select({
        assignedTo: conversations.assignedTo,
        count: count(),
      })
      .from(conversations)
      .where(and(...conditions))
      .groupBy(conversations.assignedTo)

    const loads: Record<string, number> = {}
    for (const row of rows) {
      if (row.assignedTo) {
        loads[row.assignedTo] = row.count
      }
    }
    return loads
  }

  // --- Stats ---

  async getStats(hubId?: string): Promise<ConversationStats> {
    const baseCondition = sql`(${conversations.metadata} IS NULL OR ${conversations.metadata}->>'type' IS NULL OR ${conversations.metadata}->>'type' != 'report')`
    const hubCondition = hubId ? and(baseCondition, eq(conversations.hubId, hubId)) : baseCondition

    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)

    const [statusCounts, [todayRow], [totalRow]] = await Promise.all([
      this.db
        .select({
          status: conversations.status,
          count: count(),
        })
        .from(conversations)
        .where(hubCondition)
        .groupBy(conversations.status),
      this.db
        .select({ count: count() })
        .from(conversations)
        .where(and(hubCondition, sql`${conversations.createdAt} >= ${todayStart}`)),
      this.db
        .select({ count: count() })
        .from(conversations)
        .where(hubCondition),
    ])

    const byStatus: Record<string, number> = {}
    for (const row of statusCounts) {
      byStatus[row.status] = row.count
    }

    return {
      waiting: byStatus.waiting ?? 0,
      active: byStatus.active ?? 0,
      closed: byStatus.closed ?? 0,
      today: todayRow.count,
      total: totalRow.count,
    }
  }

  // --- Contacts ---

  async getContactSummaries(hubId?: string): Promise<ContactSummary[]> {
    const conditions = [
      ne(conversations.contactIdentifierHash, ''),
    ]
    if (hubId) {
      conditions.push(eq(conversations.hubId, hubId))
    }

    const rows = await this.db
      .select({
        contactHash: conversations.contactIdentifierHash,
        last4: sql<string | null>`MIN(${conversations.contactLast4})`,
        conversationCount: sql<number>`COUNT(*) FILTER (WHERE ${conversations.metadata} IS NULL OR ${conversations.metadata}->>'type' IS NULL OR ${conversations.metadata}->>'type' != 'report')`,
        reportCount: sql<number>`COUNT(*) FILTER (WHERE ${conversations.metadata}->>'type' = 'report')`,
        firstSeen: sql<Date>`MIN(${conversations.createdAt})`,
        lastSeen: sql<Date>`MAX(COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}))`,
      })
      .from(conversations)
      .where(and(...conditions))
      .groupBy(conversations.contactIdentifierHash)
      .orderBy(sql`MAX(COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})) DESC`)

    return rows.map((r) => ({
      contactHash: r.contactHash,
      last4: r.last4,
      conversationCount: Number(r.conversationCount),
      reportCount: Number(r.reportCount),
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    }))
  }

  async getContactConversations(contactHash: string): Promise<ConversationRow[]> {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.contactIdentifierHash, contactHash))
      .orderBy(desc(conversations.lastMessageAt))
  }

  // --- Auto-close inactive conversations ---

  async autoCloseInactive(timeoutMs: number = 60 * 60 * 1000): Promise<string[]> {
    const cutoff = new Date(Date.now() - timeoutMs)

    const closed = await this.db
      .update(conversations)
      .set({
        status: 'closed',
        updatedAt: new Date(),
      })
      .where(
        and(
          sql`${conversations.status} IN ('active', 'waiting')`,
          sql`${conversations.lastMessageAt} < ${cutoff}`,
        ),
      )
      .returning({ id: conversations.id, assignedTo: conversations.assignedTo })

    return closed.filter((r) => r.assignedTo).map((r) => r.assignedTo!)
  }

  // --- Cleanup stale file uploads ---

  async cleanupStaleFiles(staleTTLMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - staleTTLMs)

    const deleted = await this.db
      .delete(files)
      .where(
        and(
          eq(files.status, 'uploading'),
          sql`${files.createdAt} < ${cutoff}`,
        ),
      )
      .returning({ id: files.id })

    return deleted.length
  }

  // --- Reset (demo/development only) ---

  async reset(): Promise<void> {
    await this.db.delete(contactIdentifiers)
    await this.db.delete(files)
    await this.db.delete(messages)
    await this.db.delete(conversations)
  }
}
