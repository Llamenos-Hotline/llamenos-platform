import { sql } from 'drizzle-orm'
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { hubs } from './settings'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

export const providerConfigs = pgTable('provider_configs', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').references(() => hubs.id, { onDelete: 'cascade' }),
  providerType: text('provider_type').notNull(),
  credentials: text('credentials'),
  status: text('status').notNull().default('disconnected'),
  capabilities: text('capabilities')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  phoneNumbers: text('phone_numbers')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  error: text('error'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  cryptoFormat: cryptoFormatColumn(),
}, (table) => [cryptoFormatCheck('provider_configs', table.cryptoFormat)])

export const oauthStates = pgTable('oauth_states', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  hubId: text('hub_id').references(() => hubs.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),
  redirectUrl: text('redirect_url').notNull(),
  callbackScheme: text('callback_scheme'),
  error: text('error'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const signalRegistrations = pgTable('signal_registrations', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull().references(() => hubs.id, { onDelete: 'cascade' }),
  bridgeUrl: text('bridge_url'),
  /** Encrypted phone number (PII — use encryptCredentials/decryptCredentials). */
  phoneNumber: text('phone_number').notNull(),
  method: text('method').notNull(),
  status: text('status').notNull().default('pending'),
  /** Number of failed verification attempts (enforces 3-attempt limit). */
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const a2pRegistrations = pgTable('a2p_registrations', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull().references(() => hubs.id, { onDelete: 'cascade' }),
  providerType: text('provider_type').notNull(),
  brandStatus: text('brand_status').notNull().default('not_submitted'),
  campaignStatus: text('campaign_status').notNull().default('not_submitted'),
  /** Encrypted brand SID from provider (PII/sensitive). */
  brandSid: text('brand_sid'),
  /** Encrypted campaign SID from provider (PII/sensitive). */
  campaignSid: text('campaign_sid'),
  /** Error or rejection reason from provider. */
  error: text('error'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// provider_templates — super-admin-managed provider configuration templates
// ---------------------------------------------------------------------------

export const providerTemplates = pgTable(
  'provider_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    providerType: text('provider_type').notNull(),
    defaultChannels: text('default_channels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    credentialHints: jsonb('credential_hints').notNull().default({}),
    recommendedSettings: jsonb('recommended_settings').notNull().default({}),
    allowSubAccounts: boolean('allow_sub_accounts').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique('provider_templates_slug_unique').on(t.slug)],
)

// ---------------------------------------------------------------------------
// hub_onboarding_state — tracks per-hub provider onboarding progress
// ---------------------------------------------------------------------------

export const hubOnboardingState = pgTable('hub_onboarding_state', {
  hubId: text('hub_id')
    .primaryKey()
    .references(() => hubs.id, { onDelete: 'cascade' }),
  templateId: text('template_id'),
  currentStep: text('current_step').notNull().default('template_selection'),
  completedSteps: text('completed_steps')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  channelConfig: jsonb('channel_config').notNull().default({}),
  isComplete: boolean('is_complete').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})
