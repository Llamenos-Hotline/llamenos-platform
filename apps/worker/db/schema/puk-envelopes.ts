/**
 * PUK (Per-User Key) envelope table.
 *
 * On identity initialisation and after each PUK rotation the client stores one
 * HPKE envelope of the PUK seed per device its sigchain authorises. The device
 * fetches its envelope and opens it with its X25519 private key. Old envelopes
 * are superseded when a newer generation is written for the same device.
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
import type { PukHpkeEnvelope } from '@protocol/schemas/sigchain'
import { jsonb } from '../bun-jsonb'
import { users } from './users'

// ---------------------------------------------------------------------------
// puk_envelopes
// ---------------------------------------------------------------------------

export const pukEnvelopes = pgTable(
  'puk_envelopes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** User who owns this PUK seed (references users.pubkey). */
    userPubkey: text('user_pubkey')
      .notNull()
      .references(() => users.pubkey, { onDelete: 'cascade' }),
    /**
     * Sigchain device ID the envelope is sealed for (the genesis / device_add
     * payload `deviceId`). NOT devices.id: the push-registry row ID is
     * server-assigned and unrelated to the ID the envelope's HPKE AAD binds.
     */
    deviceId: text('device_id').notNull(),
    /**
     * Monotonically increasing PUK generation counter.  Clients should
     * discard older generations once a newer one is fetched.
     */
    generation: integer('generation').notNull(),
    /**
     * HPKE v3 envelope of the PUK seed (packages/crypto HpkeEnvelope), sealed
     * to the device's X25519 key under LABEL_PUK_WRAP_TO_DEVICE.
     */
    envelope: jsonb('envelope').$type<PukHpkeEnvelope>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('puk_envelopes_user_pubkey_idx').on(table.userPubkey),
    index('puk_envelopes_device_id_idx').on(table.deviceId),
    // One envelope per (user, device, generation). userPubkey is part of the
    // key so an upsert by one user can never touch another user's envelope.
    unique('puk_envelopes_user_device_gen_uniq').on(table.userPubkey, table.deviceId, table.generation),
  ],
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const pukEnvelopesRelations = relations(pukEnvelopes, ({ one }) => ({
  user: one(users, {
    fields: [pukEnvelopes.userPubkey],
    references: [users.pubkey],
  }),
}))
