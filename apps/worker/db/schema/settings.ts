/**
 * Settings domain tables: system settings, hubs, hub settings/keys,
 * roles, custom fields, entity/relationship/report type definitions,
 * IVR audio, rate limits, captchas, case number sequences.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { cryptoFormatCheck, cryptoFormatColumn } from '../crypto-format'

// ---------------------------------------------------------------------------
// system_settings (singleton, id always = 1)
// ---------------------------------------------------------------------------

export const systemSettings = pgTable('system_settings', {
  id: integer('id').primaryKey().default(1),
  spamSettings: jsonb('spam_settings').notNull().default({}),
  callSettings: jsonb('call_settings').notNull().default({}),
  transcriptionEnabled: boolean('transcription_enabled').default(true),
  allowUserTranscriptionOptOut: boolean(
    'allow_user_transcription_opt_out',
  ).default(false),
  ivrLanguages: text('ivr_languages')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  messagingConfig: jsonb('messaging_config').notNull().default({}),
  setupState: jsonb('setup_state').notNull().default({}),
  webauthnSettings: jsonb('webauthn_settings').notNull().default({}),
  caseManagementEnabled: boolean('case_management_enabled').default(false),
  crossHubSharingEnabled: boolean('cross_hub_sharing_enabled').default(false),
  autoAssignmentSettings: jsonb('auto_assignment_settings')
    .notNull()
    .default({}),
  crossHubSettings: jsonb('cross_hub_settings').notNull().default({}),
  ttlOverrides: jsonb('ttl_overrides').notNull().default({}),
  appliedTemplates: jsonb('applied_templates').notNull().default([]),
  reportCategories: text('report_categories')
    .array()
    .notNull()
    .default(
      sql`'{"Incident Report","Field Observation","Evidence","Other"}'::text[]`,
    ),
  reportTypes: jsonb('report_types').notNull().default([]),
  cmsReportTypes: jsonb('cms_report_types').notNull().default([]),
  ivrAudioMeta: jsonb('ivr_audio_meta').notNull().default([]),
  cleanupMetrics: jsonb('cleanup_metrics').notNull().default({}),
  geocodingConfig: jsonb('geocoding_config').notNull().default({}),
  platformSettings: jsonb('platform_settings').notNull().default({}),
})

// ---------------------------------------------------------------------------
// hubs
// ---------------------------------------------------------------------------

export const hubs = pgTable('hubs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  /**
   * IANA zone the hub's shift schedules are written in (shifts.start_time,
   * end_time and days are wall-clock values in it). 'UTC' is the default and what
   * every hub that existed before this column was implicitly evaluated in, so
   * adding it moves no existing schedule.
   */
  timezone: text('timezone').notNull().default('UTC'),
  createdBy: text('created_by').notNull(),
  /**
   * Generation of the hub key that `hub_keys` currently wraps. 0 = no key yet.
   * It only ever moves forward, and only inside the transaction that replaces
   * the envelopes, so it is the authoritative order of key sets: a write
   * carrying an older generation is refused. That is what stops a replayed
   * envelope write from re-installing a key a shred has destroyed.
   */
  hubKeyGeneration: integer('hub_key_generation').notNull().default(0),
  /**
   * Which hub KEY the wraps hold, as distinct from which envelope SET
   * (`hub_key_generation`, which a plain re-distribution also moves). 0 for the
   * hub's first key; a rotation (`rotateHubKey`, PROTOCOL.md §2.7) moves it on
   * by one, in the same transaction that installs the new key's wraps. A client
   * holding the key of an older epoch knows its key was rotated out.
   */
  hubKeyEpoch: integer('hub_key_epoch').notNull().default(0),
  /**
   * The rotation statement that introduced the current epoch
   * (`hubKeyRotationStatementSchema`, PROTOCOL.md §2.7): `proof` sealed by the
   * rotating device under the PREVIOUS key, `check` under the new one, both
   * under `LABEL_HUB_KEY_ROTATION`. A member's device adopts the new key only
   * once `proof` opens under the key it already holds — so a key the server
   * chose is never adopted. Both null until the first rotation.
   */
  hubKeyRotationProof: text('hub_key_rotation_proof'),
  hubKeyRotationCheck: text('hub_key_rotation_check'),
  /**
   * Set, in the same transaction, whenever someone who held a wrap of the
   * current key stops holding one — a member leaves the hub, is erased, or a
   * re-distribution drops them. While set, the current key is known to anyone
   * who has left, and a manager's device must rotate it (`rotateHubKey`, which
   * clears it). The departed member's wrap is gone by then, so this flag is
   * the only record that a departure happened.
   */
  hubKeyRotationDue: boolean('hub_key_rotation_due').notNull().default(false),
  /**
   * The hub's optional escrow (recovery) key: an X25519 public key, 64 lowercase
   * hex, whose secret the hub's admins hold offline. A member of every reader
   * set of this hub (PROTOCOL §2.4.2, operator decisions D1 and A7). Set and
   * rotated only by members holding `hubs:manage-keys` in this hub's own role
   * assignments. Null when the hub has none.
   */
  escrowPubkey: text('escrow_pubkey'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  cryptoFormat: cryptoFormatColumn(),
}, (table) => [
  cryptoFormatCheck('hubs', table.cryptoFormat),
  // The identifier profile (wire spec §2.1, #2963 `hub-id-profile`): every hub
  // id enters AADs and hub-chain links, and the crate refuses anything outside
  // it rather than normalising, so the database refuses it first.
  check('hubs_id_profile', sql`${table.id} ~ '^[0-9a-z][0-9a-z-]{0,63}$' OR ${table.id} ~ '^[0-9a-f]{1,128}$'`),
])

// ---------------------------------------------------------------------------
// hub_settings
// ---------------------------------------------------------------------------

export const hubSettings = pgTable('hub_settings', {
  hubId: text('hub_id')
    .primaryKey()
    .references(() => hubs.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull().default({}),
})

// ---------------------------------------------------------------------------
// hub_keys (composite PK: hub_id + recipient_pubkey)
// ---------------------------------------------------------------------------

export const hubKeys = pgTable(
  'hub_keys',
  {
    hubId: text('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
    recipientPubkey: text('recipient_pubkey').notNull(),
    enc: text('enc').notNull(),
    ct: text('ct').notNull(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (t) => [cryptoFormatCheck('hub_keys', t.cryptoFormat), primaryKey({ columns: [t.hubId, t.recipientPubkey] })],
)

/**
 * Role definitions — permission bundles.
 *
 * Role vocabulary ("Legal observer", "Jail support coordinator") describes
 * what an organisation does and who does it, so it is sensitive and never
 * stored in the clear (#2780). Only the seeded defaults (`is_default`) carry a
 * plaintext `name`/`description`, because theirs are public constants shipped
 * in `packages/shared/permissions.ts`. `RolesService` writes no other
 * plaintext; the database CHECK enforcing it lands in the release after this
 * code (#2787), because the release being replaced still writes plaintext
 * names (see docs/runbooks/migrations.md, "Add … CHECK … constraints").
 *
 * - `hub_id` NULL: deployment-wide — the seeded defaults, and platform roles,
 *   whose name/description live only in `platform_role_envelopes`.
 * - `hub_id` set: owned by that hub — name/description sealed under the hub key
 *   (`LABEL_HUB_ROLE_ENCRYPT`) in `encrypted_name`/`encrypted_description`,
 *   assignable only inside that hub, and deleted with it.
 *
 * `slug` equals `id` for every custom role: a typed or name-derived slug is a
 * plaintext copy of the name.
 */
export const roles = pgTable('roles', {
  id: text('id').primaryKey(),
  name: text('name'),
  hubId: text('hub_id').references(() => hubs.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  permissions: text('permissions')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  isDefault: boolean('is_default').default(false),
  isSystem: boolean('is_system').default(false),
  description: text('description').notNull().default(''),
  encryptedName: text('encrypted_name'),
  encryptedDescription: text('encrypted_description'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  cryptoFormat: cryptoFormatColumn(),
}, (t) => [
  cryptoFormatCheck('roles', t.cryptoFormat),
  check(
    'roles_hub_role_is_sealed',
    sql`${t.hubId} IS NULL OR ${t.encryptedName} IS NOT NULL`,
  ),
  // #2787: the database refuses what RolesService already never writes (#2780).
  // Only a seeded default carries a plaintext name; a custom role has none.
  check(
    'roles_custom_role_has_no_plaintext',
    sql`${t.isDefault} IS TRUE OR (${t.name} IS NULL AND ${t.description} = '' AND ${t.slug} = ${t.id})`,
  ),
  index('roles_hub_id_idx').on(t.hubId),
])

export const platformRoleEnvelopes = pgTable(
  'platform_role_envelopes',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    adminPubkey: text('admin_pubkey').notNull(),
    encryptedName: text('encrypted_name').notNull(),
    encryptedDescription: text('encrypted_description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    cryptoFormat: cryptoFormatColumn(),
  },
  (table) => [cryptoFormatCheck('platform_role_envelopes', table.cryptoFormat), unique().on(table.roleId, table.adminPubkey)],
)

// ---------------------------------------------------------------------------
// custom_field_definitions
// ---------------------------------------------------------------------------

export const customFieldDefinitions = pgTable('custom_field_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  label: text('label').notNull(),
  fieldType: text('field_type').notNull(),
  required: boolean('required').default(false),
  options: text('options').array().notNull().default(sql`'{}'::text[]`),
  validation: jsonb('validation'),
  visibleToUsers: boolean('visible_to_users').default(true),
  editableByUsers: boolean('editable_by_users').default(true),
  context: text('context').notNull().default('all'),
  maxFileSize: integer('max_file_size'),
  allowedMimeTypes: text('allowed_mime_types').array().notNull().default(sql`'{}'::text[]`),
  maxFiles: integer('max_files').default(1),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// entity_type_definitions
// ---------------------------------------------------------------------------

export const entityTypeDefinitions = pgTable('entity_type_definitions', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull().default(''),
  name: text('name').notNull(),
  label: text('label').notNull(),
  labelPlural: text('label_plural').notNull().default(''),
  description: text('description').notNull().default(''),
  icon: text('icon'),
  color: text('color'),
  category: text('category').notNull().default('case'),
  templateId: text('template_id'),
  templateVersion: text('template_version'),
  fields: jsonb('fields').notNull().default([]),
  statuses: jsonb('statuses').notNull().default([]),
  defaultStatus: text('default_status').notNull().default(''),
  closedStatuses: text('closed_statuses')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  severities: jsonb('severities'),
  defaultSeverity: text('default_severity'),
  categories: jsonb('categories'),
  contactRoles: jsonb('contact_roles'),
  numberPrefix: text('number_prefix'),
  numberingEnabled: boolean('numbering_enabled').default(false),
  defaultAccessLevel: text('default_access_level')
    .notNull()
    .default('assigned'),
  piiFields: text('pii_fields')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  allowSubRecords: boolean('allow_sub_records').default(false),
  allowFileAttachments: boolean('allow_file_attachments').default(true),
  allowInteractionLinks: boolean('allow_interaction_links').default(true),
  showInNavigation: boolean('show_in_navigation').default(true),
  showInDashboard: boolean('show_in_dashboard').default(true),
  accessRoles: text('access_roles').array().notNull().default(sql`'{}'::text[]`),
  editRoles: text('edit_roles').array().notNull().default(sql`'{}'::text[]`),
  autoAssign: boolean('auto_assign').default(false),
  autoAssignThreshold: integer('auto_assign_threshold').default(30),
  requiredSpecializations: text('required_specializations')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  notifyContactsOnStatusChange: boolean('notify_contacts_on_status_change')
    .notNull()
    .default(false),
  isArchived: boolean('is_archived').default(false),
  isSystem: boolean('is_system').default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// relationship_type_definitions
// ---------------------------------------------------------------------------

export const relationshipTypeDefinitions = pgTable(
  'relationship_type_definitions',
  {
    id: text('id').primaryKey(),
    hubId: text('hub_id').notNull().default(''),
    sourceEntityTypeId: text('source_entity_type_id'),
    targetEntityTypeId: text('target_entity_type_id'),
    cardinality: text('cardinality').notNull().default('M:N'),
    label: text('label').notNull(),
    reverseLabel: text('reverse_label').notNull().default(''),
    sourceLabel: text('source_label').notNull().default(''),
    targetLabel: text('target_label').notNull().default(''),
    roles: jsonb('roles'),
    defaultRole: text('default_role'),
    joinFields: jsonb('join_fields'),
    cascadeDelete: boolean('cascade_delete').default(false),
    required: boolean('required').default(false),
    templateId: text('template_id'),
    isSystem: boolean('is_system').default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
)

// ---------------------------------------------------------------------------
// report_type_definitions
// ---------------------------------------------------------------------------

export const reportTypeDefinitions = pgTable('report_type_definitions', {
  id: text('id').primaryKey(),
  hubId: text('hub_id').notNull().default(''),
  name: text('name').notNull(),
  label: text('label').notNull(),
  labelPlural: text('label_plural').notNull().default(''),
  description: text('description').notNull().default(''),
  icon: text('icon'),
  color: text('color'),
  fields: jsonb('fields').notNull().default([]),
  statuses: jsonb('statuses').notNull().default([]),
  defaultStatus: text('default_status').notNull().default(''),
  closedStatuses: text('closed_statuses')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  allowCaseConversion: boolean('allow_case_conversion').default(false),
  mobileOptimized: boolean('mobile_optimized').default(false),
  templateId: text('template_id'),
  isArchived: boolean('is_archived').default(false),
  isSystem: boolean('is_system').default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// ivr_audio (composite PK: hub_id + prompt_type + language)
//
// hub_id '' is the platform default recording; any other value is that hub's
// own. A call in hub H hears H's recording, then the platform default, then
// generated speech. '' rather than NULL because a primary key column cannot be
// NULL (the same sentinel entity_type_definitions.hub_id uses).
// ---------------------------------------------------------------------------

export const ivrAudio = pgTable(
  'ivr_audio',
  {
    hubId: text('hub_id').notNull().default(''),
    promptType: text('prompt_type').notNull(),
    language: text('language').notNull(),
    audio: text('audio').notNull(),
    size: integer('size').notNull().default(0),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.hubId, t.promptType, t.language] })],
)

// ---------------------------------------------------------------------------
// rate_limits
// ---------------------------------------------------------------------------

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  timestamps: jsonb('timestamps').notNull().default([]),
})

// ---------------------------------------------------------------------------
// api_rate_limits — fixed-window counters for API rate limiting (Epic A / C03)
// ---------------------------------------------------------------------------

export const apiRateLimits = pgTable('api_rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull().default(1),
  windowStart: timestamp('window_start', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// captchas
// ---------------------------------------------------------------------------

export const captchas = pgTable('captchas', {
  callSid: text('call_sid').primaryKey(),
  expected: text('expected').notNull(),
  /** Wrong or empty submissions so far; the challenge ends at `CAPTCHA_MAX_ATTEMPTS`. */
  attempts: integer('attempts').notNull().default(0),
  /** "Press star to hear the numbers again" uses so far; free up to `CAPTCHA_MAX_REPEATS`. */
  repeats: integer('repeats').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// case_number_sequences (composite PK: hub_id + prefix + year)
// ---------------------------------------------------------------------------

export const caseNumberSequences = pgTable(
  'case_number_sequences',
  {
    hubId: text('hub_id').notNull().default(''),
    prefix: text('prefix').notNull(),
    year: integer('year').notNull(),
    nextValue: integer('next_value').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.hubId, t.prefix, t.year] })],
)
