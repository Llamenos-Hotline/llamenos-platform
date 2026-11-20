import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core'
import type { RecipientEnvelope } from '@protocol/schemas/common'
import { jsonb } from '../bun-jsonb'
import { shifts } from './shifts'

export const shiftOverrides = pgTable('shift_overrides', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull(),
  shiftId: text('shift_id').references(() => shifts.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  type: text('type').notNull(),
  userPubkeys: text('user_pubkeys').array(),
  // The override note, sealed client-side by `shift_record.rs` under
  // LABEL_SHIFT_OVERRIDE_NOTE (#2778): hex ciphertext here, the content key
  // wrapped per reader in note_envelopes. Both set or both NULL.
  encryptedNote: text('encrypted_note'),
  noteEnvelopes: jsonb('note_envelopes').$type<RecipientEnvelope[]>(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('shift_overrides_hub_shift_date').on(table.hubId, table.shiftId, table.date),
  index('shift_overrides_hub_date_idx').on(table.hubId, table.date),
])

