import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { shifts } from './shifts'

export const shiftJoinRequests = pgTable('shift_join_requests', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull(),
  shiftId: text('shift_id').notNull().references(() => shifts.id, { onDelete: 'cascade' }),
  userPubkey: text('user_pubkey').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('shift_join_requests_hub_idx').on(table.hubId, table.status),
  // Enforces "at most one pending request per shift/user/type" at the DB
  // level (#1144) — the service's create() uses this as its ON CONFLICT
  // target so two concurrent requests for the same shift/user/type can't
  // both insert a pending row.
  uniqueIndex('shift_join_requests_pending_unique_idx')
    .on(table.shiftId, table.userPubkey, table.type)
    .where(sql`status = 'pending'`),
])
