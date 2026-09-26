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
  unique,
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
    /** Monotonically increasing sequence number per user; genesis is 1 (SIGCHAIN_GENESIS_SEQ). */
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
    // Unique: two concurrent appends for the same slot must not fork the chain.
    unique('sigchain_links_user_seq_uniq').on(table.userPubkey, table.seqNo),
    index('sigchain_links_hash_idx').on(table.hash),
  ],
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const sigchainLinksRelations = relations(sigchainLinks, ({ one }) => ({
  user: one(users, {
    fields: [sigchainLinks.userPubkey],
    references: [users.pubkey],
  }),
}))
