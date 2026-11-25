import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core'
import type { RecipientEnvelope } from '@protocol/schemas/common'
import { jsonb } from '../bun-jsonb'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

export const userAvailabilityBlocks = pgTable('user_availability_blocks', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull(),
  userPubkey: text('user_pubkey').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  // The volunteer's reason, sealed client-side by `shift_record.rs` under
  // LABEL_AVAILABILITY_REASON (#2777): hex ciphertext here, the content key
  // wrapped per reader in reason_envelopes. Both set or both NULL.
  encryptedReason: text('encrypted_reason'),
  reasonEnvelopes: jsonb('reason_envelopes').$type<RecipientEnvelope[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  cryptoFormat: cryptoFormatColumn(),
}, (table) => [
  cryptoFormatCheck('user_availability_blocks', table.cryptoFormat),
  index('availability_blocks_hub_user_idx').on(table.hubId, table.userPubkey),
  index('availability_blocks_hub_date_idx').on(table.hubId, table.startDate, table.endDate),
])
