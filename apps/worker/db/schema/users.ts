/**
 * Identity domain tables: users, sessions, invite codes,
 * WebAuthn credentials/challenges, devices, provision rooms.
 */
import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  pubkey: text('pubkey').primaryKey(),
  roles: text('roles')
    .array()
    .notNull()
    .default(sql`'{"role-volunteer"}'::text[]`),
  displayName: text('display_name'),
  phone: text('phone'),
    // Valid values: 'active', 'inactive', 'erased' (EP08: set on account erasure)
    status: text('status').notNull().default('active'),
  hubRoles: jsonb('hub_roles').notNull().default([]),
  availability: text('availability').notNull().default('unavailable'),
  onBreak: boolean('on_break').default(false),
  callPreference: text('call_preference'),
  spokenLanguages: text('spoken_languages')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  uiLanguage: text('ui_language'),
  transcriptionEnabled: boolean('transcription_enabled').default(true),
  profileCompleted: boolean('profile_completed').default(false),
  active: boolean('active').notNull().default(true),
  encryptedSecretKey: text('encrypted_secret_key').default(''),
  supportedMessagingChannels: text('supported_messaging_channels')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  messagingEnabled: boolean('messaging_enabled'),
  specializations: text('specializations')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  maxCaseAssignments: integer('max_case_assignments'),
  teamId: text('team_id'),
  supervisorPubkey: text('supervisor_pubkey'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    id: text('id')
      .notNull()
      .$defaultFn(() => crypto.randomUUID()),
    token: text('token').primaryKey(),
    pubkey: text('pubkey')
      .notNull()
      .references(() => users.pubkey, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deviceInfo: jsonb('device_info'),
  },
  (table) => [
    index('sessions_pubkey_idx').on(table.pubkey),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
)

// ---------------------------------------------------------------------------
// invite_codes
// ---------------------------------------------------------------------------

export const inviteCodes = pgTable('invite_codes', {
  code: text('code').primaryKey(),
  name: text('name').notNull().default(''),
  phone: text('phone').notNull().default(''),
  roleIds: text('role_ids')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdBy: text('created_by'),
  hubId: text('hub_id'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedBy: text('used_by'),
})

// ---------------------------------------------------------------------------
// webauthn_credentials
// ---------------------------------------------------------------------------

export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    credentialId: text('credential_id').primaryKey(),
    pubkey: text('pubkey')
      .notNull()
      .references(() => users.pubkey, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    backedUp: boolean('backed_up').default(false),
    label: text('label').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [index('webauthn_credentials_pubkey_idx').on(table.pubkey)],
)

// ---------------------------------------------------------------------------
// webauthn_challenges
// ---------------------------------------------------------------------------

export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    challengeId: text('challenge_id').primaryKey(),
    challenge: text('challenge').notNull(),
    // RACE-08 Phase 2: Bind challenges to users to prevent cross-user consumption
    pubkey: text('pubkey'),
    // B-M14: Comma-separated credential IDs allowed for this challenge (relay prevention)
    allowedCredIds: text('allowed_cred_ids'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('webauthn_challenges_pubkey_idx').on(table.pubkey),
  ],
)

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

export const devices = pgTable(
  'devices',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    pubkey: text('pubkey')
      .notNull()
      .references(() => users.pubkey, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    pushToken: text('push_token'),
    voipToken: text('voip_token'),
    wakeKeyPublic: text('wake_key_public'),
    // Phase 6 crypto: per-device key material for HPKE/PUK distribution
    ed25519Pubkey: text('ed25519_pubkey'),   // hex-encoded Ed25519 signing public key
    x25519Pubkey: text('x25519_pubkey'),     // hex-encoded X25519 key agreement public key
    // When `x25519_pubkey` last took its current value (#2143). `registered_at`
    // cannot stand in: a registration that matches an existing row by its
    // Ed25519 key OVERWRITES the X25519 key and leaves `registered_at` alone, so
    // a stolen session swapping in its own key would look as old as the device.
    // Moves only when the key's value actually changes, never on a re-register of
    // the same key.
    x25519SetAt: timestamp('x25519_set_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    registeredAt: timestamp('registered_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    deviceName: text('device_name'),
    deviceModel: text('device_model'),
    osVersion: text('os_version'),
    appVersion: text('app_version'),
    lastIpHash: text('last_ip_hash'),
  },
  (table) => [index('devices_pubkey_idx').on(table.pubkey)],
)

// ---------------------------------------------------------------------------
// provision_rooms
// ---------------------------------------------------------------------------

export const provisionRooms = pgTable('provision_rooms', {
  roomId: text('room_id').primaryKey(),
  ephemeralPubkey: text('ephemeral_pubkey').notNull(),
  token: text('token').notNull(),
  status: text('status').notNull().default('waiting'),
  encryptedNsec: text('encrypted_nsec'),
  primaryPubkey: text('primary_pubkey'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  webauthnCredentials: many(webauthnCredentials),
  devices: many(devices),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.pubkey],
    references: [users.pubkey],
  }),
}))

export const webauthnCredentialsRelations = relations(
  webauthnCredentials,
  ({ one }) => ({
    user: one(users, {
      fields: [webauthnCredentials.pubkey],
      references: [users.pubkey],
    }),
  }),
)

export const devicesRelations = relations(devices, ({ one }) => ({
  user: one(users, {
    fields: [devices.pubkey],
    references: [users.pubkey],
  }),
}))
