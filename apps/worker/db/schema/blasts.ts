/**
 * Blast domain tables: subscribers, blasts, blast settings, blast deliveries.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// subscribers
// ---------------------------------------------------------------------------

export const subscribers = pgTable(
  'subscribers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id'),
    identifierHash: text('identifier_hash').notNull(),
    encryptedIdentifier: text('encrypted_identifier'),
    channels: jsonb('channels').notNull().default(sql`'[]'::jsonb`),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    language: text('language').notNull().default('en'),
    status: text('status').notNull().default('active'),
    doubleOptInConfirmed: boolean('double_opt_in_confirmed').default(false),
    preferenceToken: text('preference_token').unique(),
    subscribedAt: timestamp('subscribed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('subscribers', table.cryptoFormat),
    unique('subscribers_hub_identifier_idx').on(
      table.hubId,
      table.identifierHash,
    ),
  ],
)

// ---------------------------------------------------------------------------
// blasts
// ---------------------------------------------------------------------------

export const blasts = pgTable('blasts', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  hubId: text('hub_id'),
  name: text('name').notNull(),
  content: jsonb('content').notNull().default(sql`'{}'::jsonb`),
  defaultLanguage: text('default_language').notNull().default('en'),
  status: text('status').notNull().default('draft'),
  targetChannels: text('target_channels')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  targetTags: text('target_tags').array().notNull().default(sql`'{}'::text[]`),
  targetLanguages: text('target_languages')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdBy: text('created_by'),
  stats: jsonb('stats').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// blast_deliveries — per-recipient delivery tracking
// ---------------------------------------------------------------------------

export const blastDeliveries = pgTable(
  'blast_deliveries',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    blastId: text('blast_id')
      .notNull()
      .references(() => blasts.id, { onDelete: 'cascade' }),
    subscriberId: text('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('pending'),
    externalId: text('external_id'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('blast_deliveries_blast_status_idx').on(table.blastId, table.status),
    index('blast_deliveries_pending_idx').on(table.nextRetryAt).where(sql`status IN ('pending', 'sending')`),
    index('blast_deliveries_external_id_idx').on(table.externalId),
    unique('blast_delivery_unique').on(table.blastId, table.subscriberId, table.channel),
  ],
)

// ---------------------------------------------------------------------------
// blast_settings
// ---------------------------------------------------------------------------

export const blastSettings = pgTable('blast_settings', {
  hubId: text('hub_id').primaryKey(),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
})

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const blastsRelations = relations(blasts, ({ many }) => ({
  deliveries: many(blastDeliveries),
}))

export const blastDeliveriesRelations = relations(blastDeliveries, ({ one }) => ({
  blast: one(blasts, {
    fields: [blastDeliveries.blastId],
    references: [blasts.id],
  }),
  subscriber: one(subscribers, {
    fields: [blastDeliveries.subscriberId],
    references: [subscribers.id],
  }),
}))

export const subscribersRelations = relations(subscribers, ({ many }) => ({
  deliveries: many(blastDeliveries),
}))
