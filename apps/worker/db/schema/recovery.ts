/**
 * Recovery group domain tables: per-hub K-of-N Shamir recovery groups,
 * share holder envelopes, user PUK seed envelopes, recovery sessions,
 * and session contributions.
 *
 * The server is zero-knowledge: all share data and PUK seeds are stored
 * as HPKE ciphertext only. The server relays but cannot read them.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { hubs } from './settings'

// ---------------------------------------------------------------------------
// hub_recovery_groups
// ---------------------------------------------------------------------------

export const hubRecoveryGroups = pgTable(
  'hub_recovery_groups',
  {
    hubId: text('hub_id').primaryKey(),
    groupPublicKey: text('group_public_key').notNull(),
    threshold: integer('threshold').notNull(),
    totalShares: integer('total_shares').notNull(),
    shareCommitments: jsonb('share_commitments').notNull(),
    duressCommitments: jsonb('duress_commitments'),
    sigchainLinkHash: text('sigchain_link_hash').notNull(),
    delayHours: integer('delay_hours').notNull().default(24),
    emergencyFloorHours: integer('emergency_floor_hours').notNull().default(4),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'threshold_range',
      sql`${table.threshold} >= 2 AND ${table.threshold} <= 5`,
    ),
    check(
      'total_shares_range',
      sql`${table.totalShares} >= 3 AND ${table.totalShares} <= 5`,
    ),
    check(
      'threshold_lte_total',
      sql`${table.threshold} <= ${table.totalShares}`,
    ),
    check(
      'delay_hours_range',
      sql`${table.delayHours} >= 4 AND ${table.delayHours} <= 168`,
    ),
    check(
      'emergency_floor_range',
      sql`${table.emergencyFloorHours} >= 1 AND ${table.emergencyFloorHours} <= 24`,
    ),
    check(
      'emergency_lte_delay',
      sql`${table.emergencyFloorHours} <= ${table.delayHours}`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// hub_recovery_group_shares
// ---------------------------------------------------------------------------

export const hubRecoveryGroupShares = pgTable(
  'hub_recovery_group_shares',
  {
    hubId: text('hub_id')
      .notNull()
      .references(() => hubRecoveryGroups.hubId, { onDelete: 'cascade' }),
    holderPubkey: text('holder_pubkey').notNull(),
    shareEnvelope: text('share_envelope').notNull(),
    /**
     * Hex Ed25519 public key derived from this holder's Shamir share by the
     * enrolling client (`recovery_liveness::liveness_public_key`, #2782). The
     * verifier for liveness proofs — it reveals nothing that narrows the share.
     *
     * Nullable only for the expand phase (docs/runbooks/migrations.md): the
     * previous release inserts share rows without it. The enroll and rotate
     * APIs require it, and a row without one cannot be proven live (the
     * challenge endpoint refuses it) until the group is rotated. Contract to
     * NOT NULL once no deployed release writes rows without it.
     */
    livenessPublicKey: text('liveness_public_key'),
    /** Last VERIFIED liveness proof. Cleared by a proof that fails to verify. */
    lastLivenessProof: timestamp('last_liveness_proof', {
      withTimezone: true,
    }),
    /** Last liveness proof that did NOT verify — surfaced to admins. */
    lastLivenessFailure: timestamp('last_liveness_failure', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.hubId, table.holderPubkey] }),
  ],
)

// ---------------------------------------------------------------------------
// recovery_liveness_challenges
// ---------------------------------------------------------------------------

/**
 * Outstanding single-use liveness challenges (#2782) — at most one per holder
 * per hub (the primary key), so issuing a new challenge replaces the old one
 * and the table is bounded by the number of enrolled holders.
 *
 * Cascades from the holder's share row: rotating or re-enrolling a group (which
 * replaces every share row) invalidates every challenge issued against it.
 */
export const recoveryLivenessChallenges = pgTable(
  'recovery_liveness_challenges',
  {
    hubId: text('hub_id').notNull(),
    holderPubkey: text('holder_pubkey').notNull(),
    /** 32 random bytes, hex. */
    challenge: text('challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.hubId, table.holderPubkey] }),
    foreignKey({
      name: 'recovery_liveness_challenges_share_fk',
      columns: [table.hubId, table.holderPubkey],
      foreignColumns: [hubRecoveryGroupShares.hubId, hubRecoveryGroupShares.holderPubkey],
    }).onDelete('cascade'),
  ],
)

// ---------------------------------------------------------------------------
// user_recovery_envelopes
// ---------------------------------------------------------------------------

export const userRecoveryEnvelopes = pgTable(
  'user_recovery_envelopes',
  {
    userPubkey: text('user_pubkey').notNull(),
    hubId: text('hub_id').notNull().references(() => hubs.id, { onDelete: 'cascade' }),
    envelope: text('envelope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userPubkey, table.hubId] }),
  ],
)

// ---------------------------------------------------------------------------
// recovery_sessions
// ---------------------------------------------------------------------------

export const recoverySessions = pgTable(
  'recovery_sessions',
  {
    sessionId: text('session_id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    hubId: text('hub_id').notNull(),
    userPubkey: text('user_pubkey').notNull(),
    newDevicePubkey: text('new_device_pubkey').notNull(),
    signalVerified: boolean('signal_verified').notNull().default(false),
    /** pending | verified | active | completed | expired | cancelled */
    status: text('status').notNull().default('pending'),
    /** Verification code for Signal challenge (hashed, not plaintext) */
    verificationCodeHash: text('verification_code_hash'),
    /** Number of failed verification attempts */
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: text('cancelled_by'),
    emergencyOverride: jsonb('emergency_override'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('recovery_sessions_hub_id_idx').on(table.hubId),
    index('recovery_sessions_user_pubkey_idx').on(table.userPubkey),
    index('recovery_sessions_status_idx').on(table.status),
  ],
)

// ---------------------------------------------------------------------------
// recovery_session_contributions
// ---------------------------------------------------------------------------

export const recoverySessionContributions = pgTable(
  'recovery_session_contributions',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => recoverySessions.sessionId, { onDelete: 'cascade' }),
    contributorPubkey: text('contributor_pubkey').notNull(),
    encryptedShare: text('encrypted_share').notNull(),
    contributorSignature: text('contributor_signature').notNull(),
    contributedAt: timestamp('contributed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.contributorPubkey] }),
  ],
)
