/**
 * Records domain tables: notes, note replies, bans,
 * contact metadata, and audit log.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { hubs } from './settings'

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

export const notes = pgTable(
  'notes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Every note belongs to a hub (#2459): its admins are its readers, so a
    // hubless note would be one no hub admin could ever see.
    hubId: text('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
    authorPubkey: text('author_pubkey').notNull(),
    callId: text('call_id'),
    conversationId: text('conversation_id'),
    contactHash: text('contact_hash'),
    encryptedContent: text('encrypted_content').notNull(),
    // NULL when the client sent none: the protocol says absent, never `{}`.
    authorEnvelope: jsonb('author_envelope'),
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
    // HMAC(HKDF(BAN_HASH_KEY, hubId | 'platform'), number) — see `banHash`. Rows exist
    // only for banned numbers; no digits of the number are stored beside it.
    phone: text('phone_hash').notNull(),
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
    // The hub of the notes this row counts (#2459) — the contact hash is
    // per-hub, so a row without one counts nobody's notes.
    hubId: text('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
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
    // Append order within a chain (#1175), assigned by AuditService.log() as
    // the locked tip's seq + 1 under the per-chain advisory lock — the lock's
    // output, not a second source of truth. created_at no longer carries
    // ordering, so it records when the event happened and nothing else. The
    // DEFAULT exists only so a previous release's INSERT (which does not name
    // seq) still succeeds against this schema during a rolling upgrade: it
    // issues values far above any per-chain counter, so such a row can
    // neither collide with nor sort before a real append; once a chain's tip
    // is in that space, log() draws from the same sequence (#2634), so the
    // two writers never issue the same value.
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('audit_log_seq_default_seq')`),
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
    // seq is unique per chain. As with bans below, Postgres treats NULL hub_id
    // as distinct in the composite index, so the platform chain gets its own
    // partial index.
    uniqueIndex('audit_log_hub_id_seq_idx').on(table.hubId, table.seq),
    uniqueIndex('audit_log_platform_seq_idx')
      .on(table.seq)
      .where(sql`hub_id IS NULL`),
  ],
)
