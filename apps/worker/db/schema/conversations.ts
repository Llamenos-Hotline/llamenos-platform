/**
 * Conversation domain tables: conversations, messages, files,
 * contact identifiers.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id'),
    channelType: text('channel_type').notNull().default('web'),
    contactIdentifierHash: text('contact_identifier_hash')
      .notNull()
      .default(''),
    assignedTo: text('assigned_to'),
    status: text('status').notNull().default('waiting'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    messageCount: integer('message_count').notNull().default(0),
    metadata: jsonb('metadata'),
  },
  (table) => [
    index('conversations_hub_status_idx').on(table.hubId, table.status),
    index('conversations_assigned_to_idx').on(table.assignedTo),
  ],
)

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    authorPubkey: text('author_pubkey'),
    externalId: text('external_id'),
    encryptedContent: text('encrypted_content').notNull(),
    readerEnvelopes: jsonb('reader_envelopes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    hasAttachments: boolean('has_attachments').default(false),
    attachmentIds: text('attachment_ids').array().notNull().default(sql`'{}'::text[]`),
    status: text('status').default('sent'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    retryCount: integer('retry_count').default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('messages_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    uniqueIndex('messages_external_id_idx')
      .on(table.externalId)
      .where(sql`external_id IS NOT NULL`),
  ],
)

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

export const files = pgTable('files', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  conversationId: text('conversation_id').references(() => conversations.id),
  messageId: text('message_id'),
  uploadedBy: text('uploaded_by').notNull(),
  recipientEnvelopes: jsonb('recipient_envelopes')
    .notNull()
    .default(sql`'[]'::jsonb`),
  encryptedMetadata: jsonb('encrypted_metadata')
    .notNull()
    .default(sql`'[]'::jsonb`),
  totalSize: integer('total_size').notNull().default(0),
  totalChunks: integer('total_chunks').notNull().default(1),
  completedChunks: integer('completed_chunks').notNull().default(0),
  status: text('status').notNull().default('uploading'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

// ---------------------------------------------------------------------------
// contact_identifiers
// ---------------------------------------------------------------------------

export const contactIdentifiers = pgTable('contact_identifiers', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  encryptedIdentifier: text('encrypted_identifier').notNull(),
})

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const conversationsRelations = relations(
  conversations,
  ({ many, one }) => ({
    messages: many(messages),
    files: many(files),
    contactIdentifier: one(contactIdentifiers, {
      fields: [conversations.id],
      references: [contactIdentifiers.conversationId],
    }),
  }),
)

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}))

export const filesRelations = relations(files, ({ one }) => ({
  conversation: one(conversations, {
    fields: [files.conversationId],
    references: [conversations.id],
  }),
}))

export const contactIdentifiersRelations = relations(
  contactIdentifiers,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [contactIdentifiers.conversationId],
      references: [conversations.id],
    }),
  }),
)
