/**
 * Records domain tables: notes, note replies, bans,
 * contact metadata, and audit log.
 */
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

export const notes = pgTable(
  'notes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id'),
    authorPubkey: text('author_pubkey').notNull(),
    callId: text('call_id'),
    conversationId: text('conversation_id'),
    contactHash: text('contact_hash'),
    encryptedContent: text('encrypted_content').notNull(),
    authorEnvelope: jsonb('author_envelope').notNull(),
    adminEnvelopes: jsonb('admin_envelopes').notNull().default([]),
    encryptedFields: text('encrypted_fields'),
    fieldEnvelopes: jsonb('field_envelopes'),
    replyCount: integer('reply_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('notes_hub_id_idx').on(table.hubId),
    index('notes_author_pubkey_idx').on(table.authorPubkey),
    index('notes_contact_hash_idx').on(table.contactHash),
    index('notes_created_at_idx').on(table.createdAt.desc()),
  ],
)

// ---------------------------------------------------------------------------
// note_replies
// ---------------------------------------------------------------------------

export const noteReplies = pgTable(
  'note_replies',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    authorPubkey: text('author_pubkey').notNull(),
    encryptedContent: text('encrypted_content').notNull(),
    readerEnvelopes: jsonb('reader_envelopes').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('note_replies_note_id_idx').on(table.noteId)],
)

// ---------------------------------------------------------------------------
// bans
// ---------------------------------------------------------------------------

export const bans = pgTable(
  'bans',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id'),
    phone: text('phone_hash').notNull(),  // HMAC-SHA256 of raw phone number (used for matching)
    phoneDisplay: text('phone_display'),  // Original E.164 phone for admin display
    reason: text('reason'),
    bannedBy: text('banned_by'),
    bannedAt: timestamp('banned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('bans_hub_id_phone_hash_idx').on(table.hubId, table.phone),
    // Closes the dedup gap for platform-wide bans (#1144): in Postgres
    // NULL <> NULL for uniqueness purposes, so the composite index above
    // never fires for hub_id IS NULL rows — two platform-wide bans for the
    // same phone were never deduped at all. This partial index gives
    // platform bans their own uniqueness guarantee.
    uniqueIndex('bans_platform_phone_hash_idx')
      .on(table.phone)
      .where(sql`hub_id IS NULL`),
  ],
)

// ---------------------------------------------------------------------------
// contact_metadata
// ---------------------------------------------------------------------------

export const contactMetadata = pgTable(
  'contact_metadata',
  {
    contactHash: text('contact_hash').notNull(),
    hubId: text('hub_id'),
    firstSeen: timestamp('first_seen', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true })
      .notNull()
      .defaultNow(),
    noteCount: integer('note_count').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.contactHash, table.hubId] }),
  ],
)

// ---------------------------------------------------------------------------
// audit_log
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id'),
    action: text('action').notNull(),
    actorPubkey: text('actor_pubkey').notNull(),
    details: jsonb('details'),
    previousEntryHash: text('previous_entry_hash'),
    entryHash: text('entry_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    erasedAt: timestamp('erased_at', { withTimezone: true }),
  },
  (table) => [
    index('audit_log_hub_id_created_at_idx').on(
      table.hubId,
      table.createdAt.desc(),
    ),
    index('audit_log_action_idx').on(table.action),
  ],
)
