/**
 * Signal domain tables: message queue (retry with exponential backoff)
 * and identity trust tracking (safety number verification).
 */
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { hubs } from './settings'

// ---------------------------------------------------------------------------
// signal_message_queue
// ---------------------------------------------------------------------------

export const signalMessageQueue = pgTable(
  'signal_message_queue',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id').notNull().references(() => hubs.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull(),
    /** Keyed HMAC used for recipient rate-limit lookups; not reversible. */
    recipientIdentifierHash: text('recipient_identifier_hash').notNull(),
    /** Server-encrypted destination needed by the sender; never plaintext at rest. */
    recipientIdentifierCiphertext: text('recipient_identifier_ciphertext').notNull(),
    /** Server-encrypted message text; never plaintext at rest. */
    encryptedBody: text('encrypted_body').notNull(),
    mediaUrl: text('media_url'),
    mediaType: text('media_type'),
    externalId: text('external_id'),
    idempotencyKey: text('idempotency_key'),
    status: text('status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Partial index for efficient polling of pending messages ready for retry
    index('signal_queue_pending_idx')
      .on(table.nextRetryAt)
      .where(sql`status = 'pending'`),
    // Rate-limit lookups: recent sends per recipient
    index('signal_queue_recipient_status_idx')
      .on(table.recipientIdentifierHash, table.status, table.updatedAt),
    // Idempotency: prevent duplicate enqueues
    uniqueIndex('signal_queue_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    // Hub-scoped stats queries
    index('signal_queue_hub_status_idx')
      .on(table.hubId, table.status),
  ],
)

// ---------------------------------------------------------------------------
// signal_identities — Signal contact identity trust tracking
// ---------------------------------------------------------------------------

export const signalIdentities = pgTable(
  'signal_identities',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id').notNull().references(() => hubs.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    uuid: text('uuid').notNull(),
    fingerprint: text('fingerprint'),
    trustLevel: text('trust_level').notNull().default('TRUSTED_UNVERIFIED'),
    verifiedBy: text('verified_by'),       // pubkey of admin who verified
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    keyChangeCount: integer('key_change_count').notNull().default(0),
  },
  (table) => [
    // Lookup by hub + uuid (unique per hub)
    uniqueIndex('signal_identities_hub_uuid_idx')
      .on(table.hubId, table.uuid),
    // Find untrusted identities for admin review
    index('signal_identities_trust_idx')
      .on(table.hubId, table.trustLevel),
  ],
)
