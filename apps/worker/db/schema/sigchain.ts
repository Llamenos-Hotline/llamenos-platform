/**
 * Sigchain domain table: per-user hash-chained device/key event log.
 *
 * Each link records a key management event (device add/remove, key rotation,
 * PUK epoch bump, etc.) signed by the user's Ed25519 signing key. The chain
 * is append-only; the server validates hash continuity before accepting a link.
 */
import { relations } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { users } from './users'

// ---------------------------------------------------------------------------
// sigchain_links
// ---------------------------------------------------------------------------

export const sigchainLinks = pgTable(
  'sigchain_links',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Owner of this sigchain (references users.pubkey). */
    userPubkey: text('user_pubkey')
      .notNull()
      .references(() => users.pubkey, { onDelete: 'cascade' }),
    /** Monotonically increasing sequence number (0-indexed, per user). */
    seqNo: integer('seq_no').notNull(),
    /**
     * Link type — describes the key management event:
     * 'device_add' | 'device_remove' | 'key_rotate' | 'puk_epoch' | 'genesis'
     */
    linkType: text('link_type').notNull(),
    /** Arbitrary JSON payload for the event (device pubkeys, epoch number, etc.). */
    payload: jsonb('payload').notNull(),
    /**
     * Ed25519 signature over canonical(prevHash || linkType || seqNo || payload).
     * Hex-encoded.
     */
    signature: text('signature').notNull(),
    /** SHA-256 hash of the previous link (hex). Empty string for genesis link. */
    prevHash: text('prev_hash').notNull().default(''),
    /** SHA-256 hash of this link's canonical representation (hex). */
    hash: text('hash').notNull(),
    /** Device ID of the signing device. */
    signerDeviceId: text('signer_device_id').notNull().default(''),
    /** Ed25519 pubkey of the signing device, hex-encoded. */
    signerPubkey: text('signer_pubkey').notNull().default(''),
    /** ISO-8601 timestamp of link creation (client-provided). */
    linkTimestamp: text('timestamp').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('sigchain_links_user_pubkey_idx').on(table.userPubkey),
    // UNIQUE, not a plain index: this is the load-bearing guard against a
    // forked chain. Two concurrent appends at the same seqNo race the
    // check-then-insert in appendSigchainLink (see the pg_advisory_xact_lock
    // there for the application-level half of the fix); the database must
    // refuse the loser's insert even if the lock is ever bypassed — e.g. by
    // a future code path that forgets to take it. See issue #1146.
    uniqueIndex('sigchain_links_user_seq_idx').on(table.userPubkey, table.seqNo),
    index('sigchain_links_hash_idx').on(table.hash),
  ],
)

// ---------------------------------------------------------------------------
// device_key_claims
// ---------------------------------------------------------------------------

/**
 * Every device public key the server has ever seen, and the ONE user it belongs
 * to (#2496; spec 2026-11-25-v2-device-linking-and-recovery §6, L5). The primary
 * key is the UNIQUE-across-all-users constraint on signing keys and on
 * encryption keys: a key named by one user's sigchain or device registration can
 * never be registered by another user. Claims are permanent — a removed device's
 * or an erased user's key stays claimed, so it can never be re-registered as
 * someone else's device. Deliberately no foreign key to `users`, for that reason.
 *
 * Written by `claimDeviceKeys` (services/crypto-keys.ts) in the same transaction
 * as the sigchain link or `devices` row that names the key.
 */
export const deviceKeyClaims = pgTable('device_key_claims', {
  /** Lowercase hex public key: Ed25519 signing, X25519 or X-Wing encryption. */
  key: text('key').primaryKey(),
  /** The user the key belongs to. */
  userPubkey: text('user_pubkey').notNull(),
  /** `signing` | `encryption` */
  kind: text('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const sigchainLinksRelations = relations(sigchainLinks, ({ one }) => ({
  user: one(users, {
    fields: [sigchainLinks.userPubkey],
    references: [users.pubkey],
  }),
}))
