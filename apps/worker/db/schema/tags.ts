/**
 * Tags domain table: hub-scoped tags with encrypted labels and plaintext slugs.
 * Tag-contact associations are stored as HMAC blind indexes in contacts.tagHashes.
 */
import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { hubs } from './settings'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

export const tags = pgTable(
  'tags',
  {
    id: text('id').primaryKey(),
    hubId: text('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    encryptedLabel: text('encrypted_label').notNull(),
    color: text('color').notNull().default('#6b7280'),
    encryptedCategory: text('encrypted_category'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('tags', table.cryptoFormat),
    unique('tags_hub_name_unique').on(table.hubId, table.name),
    index('tags_hub_idx').on(table.hubId),
  ],
)
