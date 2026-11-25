/**
 * Signal notification domain tables:
 *   - user_signal_contacts — HMAC-hashed + encrypted Signal identifiers per user
 *   - user_security_prefs  — per-user alert channel + disappearing timer settings
 */
import { index, pgTable, text, boolean, integer, timestamp } from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { users } from './users'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// user_signal_contacts
//
// App server stores ONLY the HMAC hash (zero-knowledge for the server).
// Plaintext identifiers live exclusively in the signal-notifier sidecar's SQLite DB.
// The ciphertext + envelope allow the volunteer to recover their own identifier.
// ---------------------------------------------------------------------------

export const userSignalContacts = pgTable(
  'user_signal_contacts',
  {
    /** Primary key — one Signal contact per user */
    userPubkey: text('user_pubkey')
      .primaryKey()
      .references(() => users.pubkey, { onDelete: 'cascade' }),

    /** HMAC-SHA-256 of the normalized Signal identifier using a per-user derived key.
     *  The server uses this to dispatch without knowing the plaintext. */
    identifierHash: text('identifier_hash').notNull(),

    /** HPKE-encrypted Signal identifier (hex: nonce + ciphertext).
     *  Encrypted with a random per-entry symmetric key. */
    identifierCiphertext: text('identifier_ciphertext').notNull(),

    /** Per-reader key envelopes (HPKE-wrapped symmetric key for each authorized reader).
     *  Follows the same envelope pattern as E2EE notes and messages. */
    identifierEnvelope: jsonb('identifier_envelope')
      .notNull()
      .$type<{ recipientPubkey: string; encryptedKey: string }[]>()
      .default([]),

    /** Whether the identifier is a phone number or Signal username */
    identifierType: text('identifier_type').notNull().$type<'phone' | 'username'>(),

    /** Timestamp of last successful verification (sidecar confirmed delivery) */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [cryptoFormatCheck('user_signal_contacts', table.cryptoFormat), index('user_signal_contacts_hash_idx').on(table.identifierHash)]
)

export type UserSignalContactRow = typeof userSignalContacts.$inferSelect

// ---------------------------------------------------------------------------
// user_security_prefs
//
// Per-user alert preferences. Created on first access with safe defaults.
// ---------------------------------------------------------------------------

export const userSecurityPrefs = pgTable('user_security_prefs', {
  userPubkey: text('user_pubkey')
    .primaryKey()
    .references(() => users.pubkey, { onDelete: 'cascade' }),

  /** Notification channel: 'web_push' or 'signal' */
  notificationChannel: text('notification_channel')
    .notNull()
    .default('web_push')
    .$type<'web_push' | 'signal'>(),

  /** Disappearing message timer in days (0 = off) */
  disappearingTimerDays: integer('disappearing_timer_days').notNull().default(1),

  /** Digest cadence: 'off', 'daily', 'weekly' */
  digestCadence: text('digest_cadence')
    .notNull()
    .default('weekly')
    .$type<'off' | 'daily' | 'weekly'>(),

  /** Alert on new device sign-in */
  alertOnNewDevice: boolean('alert_on_new_device').notNull().default(true),

  /** Alert on passkey add/remove */
  alertOnPasskeyChange: boolean('alert_on_passkey_change').notNull().default(true),

  /** Alert on PIN change */
  alertOnPinChange: boolean('alert_on_pin_change').notNull().default(true),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type UserSecurityPrefsRow = typeof userSecurityPrefs.$inferSelect
