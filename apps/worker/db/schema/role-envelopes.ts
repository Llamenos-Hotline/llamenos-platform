/**
 * Per-user HPKE-encrypted role permission envelopes.
 *
 * When a role is assigned to a user, the server stores an HPKE-encrypted
 * copy of the permission set sealed for that user's X25519 public key.
 * This allows the client to verify its own effective permissions without
 * the server learning which specific permissions were granted.
 *
 * Envelope fields follow the same HPKE envelope pattern as puk_envelopes:
 *   - wrappedKey: base64url(HPKE kem_output) — ephemeral sender key material
 *   - nonce:      base64url(AEAD nonce)
 *   - encryptedPermissions: base64url(AEAD ciphertext of JSON permissions array)
 */
import { relations } from 'drizzle-orm'
import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { roles } from './settings'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// user_role_envelopes
// ---------------------------------------------------------------------------

export const userRoleEnvelopes = pgTable(
  'user_role_envelopes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Role whose permissions are encrypted in this envelope. */
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    /** User the envelope is sealed for (references users.pubkey). */
    userPubkey: text('user_pubkey')
      .notNull()
      .references(() => users.pubkey, { onDelete: 'cascade' }),
    /**
     * HPKE-encrypted JSON array of permission strings.
     * Encrypted with the user's X25519 public key.
     * Encoding: base64url(ciphertext)
     */
    encryptedPermissions: text('encrypted_permissions').notNull(),
    /**
     * HPKE KEM output (ephemeral sender public key material).
     * Encoding: base64url(kem_output)
     */
    wrappedKey: text('wrapped_key').notNull(),
    /** AEAD nonce. Encoding: base64url(nonce). */
    nonce: text('nonce').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [
    cryptoFormatCheck('user_role_envelopes', table.cryptoFormat),
    index('user_role_envelopes_role_id_idx').on(table.roleId),
    index('user_role_envelopes_user_pubkey_idx').on(table.userPubkey),
    // One envelope per (user, role) pair
    unique('user_role_envelopes_user_role_uniq').on(table.userPubkey, table.roleId),
  ],
)

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const userRoleEnvelopesRelations = relations(userRoleEnvelopes, ({ one }) => ({
  user: one(users, {
    fields: [userRoleEnvelopes.userPubkey],
    references: [users.pubkey],
  }),
  role: one(roles, {
    fields: [userRoleEnvelopes.roleId],
    references: [roles.id],
  }),
}))
