/**
 * Shifts domain tables: shift schedules and push reminder tracking.
 */
import { sql } from 'drizzle-orm'
import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { ringGroups } from './ring-groups'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// shifts
// ---------------------------------------------------------------------------

export const shifts = pgTable('shifts', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  hubId: text('hub_id'),
  encryptedName: text('encrypted_name').notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  days: integer('days')
    .array()
    .notNull()
    .default(sql`'{}'::int[]`),
  ringGroupId: text('ring_group_id').references(() => ringGroups.id, { onDelete: 'restrict' }),
  userPubkeys: text('user_pubkeys')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  cryptoFormat: cryptoFormatColumn(),
}, (table) => [cryptoFormatCheck('shifts', table.cryptoFormat)])

// ---------------------------------------------------------------------------
// push_reminders_sent
// ---------------------------------------------------------------------------

export const pushRemindersSent = pgTable(
  'push_reminders_sent',
  {
    shiftId: text('shift_id').notNull(),
    reminderDate: text('reminder_date').notNull(),
    pubkey: text('pubkey').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.shiftId, table.reminderDate, table.pubkey],
    }),
  ],
)
