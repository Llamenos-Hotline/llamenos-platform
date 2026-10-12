/**
 * Erasure domain tables: erasure requests, erasure config,
 * re-encryption jobs, audit user keys.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'

// ---------------------------------------------------------------------------
// erasure_requests
// ---------------------------------------------------------------------------

export const erasureRequests = pgTable(
  'erasure_requests',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /**
     * 'user' — a person's right to erasure. 'hub' — a hub crypto-shred.
     * Both destroy keys rather than rows, so they share this table and its
     * delay / cancellation / co-approval machinery rather than duplicating it.
     */
    scope: text('scope').notNull().default('user'),
    /** The subject when scope = 'user'. Null for a hub shred. */
    userId: text('user_id'),
    /** The subject when scope = 'hub'. Null for a person's erasure. */
    hubId: text('hub_id'),
    /**
     * The hub's status before the shred was scheduled, so a cancel inside the
     * window restores exactly what was there instead of assuming 'active'.
     * Null for scope = 'user'.
     */
    previousStatus: text('previous_status'),
    status: text('status').notNull().default('pending'),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    executeAt: timestamp('execute_at', { withTimezone: true }).notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    justification: text('justification'),
    emergencyOverride: boolean('emergency_override').notNull().default(false),
    coApproverPubkey: text('co_approver_pubkey'),
    coApproverSignature: text('co_approver_signature'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (table) => [
    index('erasure_requests_user_id_idx').on(table.userId),
    index('erasure_requests_hub_id_idx').on(table.hubId),
    index('erasure_requests_status_idx').on(table.status),
    index('erasure_requests_execute_at_idx').on(table.executeAt),
    /**
     * Exactly one subject per request. Without this, `scope` is a label that
     * can disagree with the columns actually set — and a request that names
     * both a person and a hub has no defined meaning.
     */
    check(
      'erasure_requests_scope_subject',
      sql`(scope = 'user' AND user_id IS NOT NULL AND hub_id IS NULL)
       OR (scope = 'hub'  AND hub_id  IS NOT NULL AND user_id IS NULL)`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// erasure_config (per-hub, PK = hubId)
// ---------------------------------------------------------------------------

export const erasureConfig = pgTable('erasure_config', {
  hubId: text('hub_id').primaryKey(),
  /** The delay before a person's erasure executes. */
  delayHours: integer('delay_hours').notNull().default(72),
  /**
   * The undo window before a hub crypto-shred executes. Separate from
   * delayHours — a hub is not a person — but subject to the same platform
   * floor and unlocked by the same co-approved emergency override.
   */
  hubShredDelayHours: integer('hub_shred_delay_hours').notNull().default(48),
  emergencyOverrideEnabled: boolean('emergency_override_enabled')
    .notNull()
    .default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: text('updated_by').notNull(),
})

// ---------------------------------------------------------------------------
// re_encryption_jobs
// ---------------------------------------------------------------------------

export const reEncryptionJobs = pgTable(
  're_encryption_jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** 'user' — strip one departed member's envelopes. 'hub' — shred them all. */
    scope: text('scope').notNull().default('user'),
    /** The departed member when scope = 'user'. Null for a hub shred. */
    userId: text('user_id'),
    hubId: text('hub_id').notNull(),
    status: text('status').notNull().default('queued'),
    totalEnvelopes: integer('total_envelopes').notNull().default(0),
    processedEnvelopes: integer('processed_envelopes').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('re_encryption_jobs_user_id_idx').on(table.userId),
    index('re_encryption_jobs_status_idx').on(table.status),
  ],
)

// ---------------------------------------------------------------------------
// audit_user_keys (per-user audit envelope key, HPKE-wrapped)
// ---------------------------------------------------------------------------

export const auditUserKeys = pgTable('audit_user_keys', {
  userPubkey: text('user_pubkey').primaryKey(),
  encryptedKey: text('encrypted_key').notNull(),
  adminEnvelopes: jsonb('admin_envelopes').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
