/**
 * Messaging opt-out (suppression) records.
 *
 * An opt-out is a fact about an identifier, not about a subscriber row: a STOP from
 * someone we hold no subscriber for is recorded here all the same, and import and
 * every outbound send consult it, so a later import cannot make that person
 * reachable again. Only an explicit opt-in from the person (START / UNSTOP)
 * removes an identifier from it.
 *
 * No identifier is stored in a readable or reversible form: a record is found by
 * `HMAC(HKDF(MESSAGING_HASH_KEY, "suppression"), canonical identifier)` — see
 * `suppressionHashes` in `lib/messaging-contact-hash.ts`. One record can be
 * reached by several hashes, because one person reaches us under several
 * identifiers (a Signal UUID and the phone number beside it).
 */
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const messagingSuppressions = pgTable('messaging_suppressions', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  /** Channel the most recent opt-out arrived on. Enforcement does not depend on it. */
  channel: text('channel').notNull(),
  /** Hub whose webhook received the most recent opt-out; NULL for the hub-less webhook. */
  sourceHubId: text('source_hub_id'),
  /** Provider message id of the inbound message that caused it (the same value `messages.external_id` holds). */
  sourceExternalId: text('source_external_id'),
  /** When the most recent opt-out arrived. */
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  /** When the first opt-out for this person arrived. */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Outbound sends refused because of this record — a refused send is counted, never silent. */
  blockedCount: integer('blocked_count').notNull().default(0),
  lastBlockedAt: timestamp('last_blocked_at', { withTimezone: true }),
})

export const messagingSuppressionIdentifiers = pgTable(
  'messaging_suppression_identifiers',
  {
    /** Keyed hash of one canonical identifier of the person. Unique: one hash belongs to one record. */
    identifierHash: text('identifier_hash').primaryKey(),
    suppressionId: text('suppression_id')
      .notNull()
      .references(() => messagingSuppressions.id, { onDelete: 'cascade' }),
  },
  (table) => [index('messaging_suppression_identifiers_suppression_idx').on(table.suppressionId)],
)
