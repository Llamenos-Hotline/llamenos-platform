import { pgTable, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

export const ringGroups = pgTable('ring_groups', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull(),
  encryptedName: text('encrypted_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  cryptoFormat: cryptoFormatColumn(),
}, (table) => [
  cryptoFormatCheck('ring_groups', table.cryptoFormat),
  index('ring_groups_hub_idx').on(table.hubId),
])

export const ringGroupMembers = pgTable('ring_group_members', {
  ringGroupId: text('ring_group_id').notNull().references(() => ringGroups.id, { onDelete: 'cascade' }),
  userPubkey: text('user_pubkey').notNull(),
  addedBy: text('added_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.ringGroupId, table.userPubkey] }),
  index('ring_group_members_user_idx').on(table.userPubkey),
])
