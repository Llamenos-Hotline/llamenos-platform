/**
 * Storage domain tables: per-hub bucket settings and IAM credentials.
 */
import { integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core'
import { hubs } from './settings'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

export const hubStorageSettings = pgTable(
  'hub_storage_settings',
  {
    hubId: text('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    retentionDays: integer('retention_days'),
  },
  (t) => [unique('hub_storage_namespace_uniq').on(t.hubId, t.namespace)]
)

/**
 * Per-hub IAM credentials for RustFS bucket-scoped access.
 *
 * Each hub gets its own IAM user with a policy limiting access to that hub's
 * buckets only. The secret key is encrypted with the server's HKDF-derived
 * storage credential key (XChaCha20-Poly1305 + LABEL_STORAGE_CREDENTIAL_WRAP)
 * so that only the server process can decrypt it for S3 calls.
 */
export const hubStorageCredentials = pgTable('hub_storage_credentials', {
  hubId: text('hub_id')
    .primaryKey()
    .references(() => hubs.id, { onDelete: 'cascade' }),
  accessKeyId: text('access_key_id').notNull(),
  /** Encrypted secret key — XChaCha20-Poly1305 with server-derived key */
  encryptedSecretKey: text('encrypted_secret_key').notNull(),
  policyName: text('policy_name').notNull(),
  userName: text('user_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  cryptoFormat: cryptoFormatColumn(),
}, (table) => [cryptoFormatCheck('hub_storage_credentials', table.cryptoFormat)])
