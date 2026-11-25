/**
 * Firehose domain tables: connections, message buffer, window keys, notification opt-outs.
 *
 * Firehose connections link a Signal group to an inference agent that extracts
 * structured reports from rapid response chat messages. Buffer messages are
 * encrypted at rest with per-window ephemeral keys for forward secrecy.
 */
import { relations } from 'drizzle-orm'
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
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// firehose_connections
// ---------------------------------------------------------------------------

export const firehoseConnections = pgTable(
  'firehose_connections',
  {
    id: text('id').primaryKey(),
    hubId: text('hub_id').notNull(),
    signalGroupId: text('signal_group_id'),
    displayName: text('display_name').notNull().default(''),
    encryptedDisplayName: jsonb('encrypted_display_name'),
    reportTypeId: text('report_type_id').notNull(),
    agentPubkey: text('agent_pubkey').notNull(),
    // Column name is legacy ("nsec"): holds the AES-256-GCM-sealed X25519 agent key (the HPKE secret for `agent_pubkey`), not a nostr key.
    sealedAgentKey: text('encrypted_agent_nsec').notNull(),
    geoContext: text('geo_context'),
    geoContextCountryCodes: text('geo_context_country_codes').array(),
    inferenceEndpoint: text('inference_endpoint'),
    extractionIntervalSec: integer('extraction_interval_sec').notNull().default(60),
    systemPromptSuffix: text('system_prompt_suffix'),
    bufferTtlDays: integer('buffer_ttl_days').notNull().default(7),
    notifyViaSignal: boolean('notify_via_signal').notNull().default(true),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('firehose_connections', table.cryptoFormat),
    index('firehose_connections_hub_idx').on(table.hubId),
    index('firehose_connections_signal_group_idx').on(table.signalGroupId),
  ],
)

// ---------------------------------------------------------------------------
// firehose_message_buffer
// ---------------------------------------------------------------------------

export const firehoseMessageBuffer = pgTable(
  'firehose_message_buffer',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => firehoseConnections.id, { onDelete: 'cascade' }),
    signalTimestamp: timestamp('signal_timestamp', { withTimezone: true }).notNull(),
    encryptedContent: text('encrypted_content').notNull(),
    encryptedSenderInfo: text('encrypted_sender_info').notNull(),
    windowKeyId: text('window_key_id'),
    clusterId: text('cluster_id'),
    extractedReportId: text('extracted_report_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('firehose_message_buffer', table.cryptoFormat),
    index('firehose_buffer_connection_idx').on(table.connectionId),
    index('firehose_buffer_expires_idx').on(table.expiresAt),
    index('firehose_buffer_window_key_idx').on(table.windowKeyId),
  ],
)

// ---------------------------------------------------------------------------
// firehose_window_keys — per-window ephemeral keys for forward secrecy
// ---------------------------------------------------------------------------

export const firehoseWindowKeys = pgTable(
  'firehose_window_keys',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => firehoseConnections.id, { onDelete: 'cascade' }),
    /** Sealed ephemeral key (XChaCha20-Poly1305 under agent seal key) */
    sealedKey: text('sealed_key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    messageCount: integer('message_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('firehose_window_keys', table.cryptoFormat),
    index('firehose_window_keys_connection_idx').on(table.connectionId),
    index('firehose_window_keys_window_idx').on(table.connectionId, table.windowStart),
  ],
)

// ---------------------------------------------------------------------------
// firehose_notification_optouts
// ---------------------------------------------------------------------------

export const firehoseNotificationOptouts = pgTable(
  'firehose_notification_optouts',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => firehoseConnections.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('firehose_optout_unique').on(table.connectionId, table.userId),
  ],
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const firehoseConnectionsRelations = relations(
  firehoseConnections,
  ({ many }) => ({
    bufferMessages: many(firehoseMessageBuffer),
    windowKeys: many(firehoseWindowKeys),
    optouts: many(firehoseNotificationOptouts),
  }),
)

export const firehoseMessageBufferRelations = relations(
  firehoseMessageBuffer,
  ({ one }) => ({
    connection: one(firehoseConnections, {
      fields: [firehoseMessageBuffer.connectionId],
      references: [firehoseConnections.id],
    }),
    windowKey: one(firehoseWindowKeys, {
      fields: [firehoseMessageBuffer.windowKeyId],
      references: [firehoseWindowKeys.id],
    }),
  }),
)

export const firehoseWindowKeysRelations = relations(
  firehoseWindowKeys,
  ({ one, many }) => ({
    connection: one(firehoseConnections, {
      fields: [firehoseWindowKeys.connectionId],
      references: [firehoseConnections.id],
    }),
    messages: many(firehoseMessageBuffer),
  }),
)

export const firehoseNotificationOptoutsRelations = relations(
  firehoseNotificationOptouts,
  ({ one }) => ({
    connection: one(firehoseConnections, {
      fields: [firehoseNotificationOptouts.connectionId],
      references: [firehoseConnections.id],
    }),
  }),
)
