/**
 * Conversation domain tables: conversations, messages, files,
 * contact identifiers.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { caseRecords } from './cases'
import { hubs } from './settings'

// ---------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // A conversation belongs to the hub its webhook URL named (#2395, #2459);
    // a message that names no hub is refused, never stored hubless.
    hubId: text('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
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
    // The target of files' (conversation_id, hub_id) foreign key: a file can
    // only name a conversation of its own hub. `id` is the primary key, so the
    // pair is unique by construction.
    unique('conversations_id_hub_id_unique').on(table.id, table.hubId),
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

export const FILE_OWNER_KINDS = ['conversation', 'case_record', 'entity_field'] as const

/**
 * Every file belongs to exactly one hub, and names its parent inside that hub
 * through a typed reference (#2462, the M1 invariant of #2459):
 *
 * - `owner_kind` says which parent column is set, and `files_owner_check`
 *   makes the columns agree with it — exactly one parent column for
 *   `conversation` / `case_record`, none for `entity_field`, whose parent is
 *   the hub itself (the entity may not exist yet when its field's file is
 *   uploaded).
 * - Each parent column carries a composite foreign key on (parent id, hub_id)
 *   to the parent's (id, hub_id), so a file cannot name a parent of another
 *   hub, nor a parent that has no hub. A hub shred and every hub-scoped read
 *   therefore reach a file through its own `hub_id`, never through a join.
 *
 * A file follows its parent (operator ruling D7a A-D7A-5): deleting the
 * parent, or the hub, deletes the file row.
 */
export const files = pgTable(
  'files',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Nullable for ONE release only (expand/contract, docs/runbooks/migrations.md):
    // the release this replaces never names these columns on INSERT, so they
    // cannot be NOT NULL until it is gone. Every write of this release sets both,
    // the hub-scoped routes refuse a row whose hub is not the path hub, and the
    // next release tightens both to NOT NULL with a `constrain` annotation.
    hubId: text('hub_id').references(() => hubs.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind', { enum: FILE_OWNER_KINDS }),
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    caseRecordId: text('case_record_id'),
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
  },
  (table) => [
    index('files_hub_id_idx').on(table.hubId),
    index('files_case_record_id_idx').on(table.caseRecordId),
    foreignKey({
      name: 'files_conversation_hub_fk',
      columns: [table.conversationId, table.hubId],
      foreignColumns: [conversations.id, conversations.hubId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'files_case_record_hub_fk',
      columns: [table.caseRecordId, table.hubId],
      foreignColumns: [caseRecords.id, caseRecords.hubId],
    }).onDelete('cascade'),
    check(
      'files_owner_check',
      sql`(owner_kind = 'conversation' AND conversation_id IS NOT NULL AND case_record_id IS NULL)
       OR (owner_kind = 'case_record' AND case_record_id IS NOT NULL AND conversation_id IS NULL)
       OR (owner_kind = 'entity_field' AND conversation_id IS NULL AND case_record_id IS NULL)`,
    ),
  ],
)

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
