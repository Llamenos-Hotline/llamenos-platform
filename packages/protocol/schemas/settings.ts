import { z } from 'zod'
import { DEFAULT_HUB_TIMEZONE, ianaTimezoneSchema } from './common'

// --- Inferred types ---

/** The eight supported telephony provider types */
export const telephonyProviderTypeSchema = z.enum([
  'twilio',
  'signalwire',
  'vonage',
  'plivo',
  'asterisk',
  'telnyx',
  'bandwidth',
  'freeswitch',
])
export type TelephonyProviderType = z.infer<typeof telephonyProviderTypeSchema>

/** The five messaging channel types */
export const messagingChannelTypeSchema = z.enum(['sms', 'whatsapp', 'signal', 'rcs', 'telegram'])
export type MessagingChannelType = z.infer<typeof messagingChannelTypeSchema>

/** All channel types including voice and reports */
export const channelTypeSchema = z.enum(['voice', 'sms', 'whatsapp', 'signal', 'rcs', 'telegram', 'reports'])
export type ChannelType = z.infer<typeof channelTypeSchema>

// --- Custom Field Definition (canonical storage type) ---

export const customFieldContextSchema = z.enum(['call-notes', 'conversation-notes', 'reports', 'all'])
export type CustomFieldContext = z.infer<typeof customFieldContextSchema>

export const customFieldDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'select', 'checkbox', 'textarea', 'file', 'location']),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  validation: z.object({
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
  visibleToUsers: z.boolean(),
  editableByUsers: z.boolean(),
  context: customFieldContextSchema,
  maxFileSize: z.number().optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
  maxFiles: z.number().optional(),
  order: z.number(),
  createdAt: z.string(),
})
export type CustomFieldDefinition = z.infer<typeof customFieldDefinitionSchema>

// --- Response schemas ---

export const roleEnvelopeSchema = z.object({
  adminPubkey: z.string(),
  encryptedName: z.string(),
  encryptedDescription: z.string(),
})

export type RoleEnvelope = z.infer<typeof roleEnvelopeSchema>

export const roleResponseSchema = z.object({
  id: z.string(),
  /**
   * Plaintext only for the seeded default roles (public constants). Every
   * custom role is null: a hub role's name is `encryptedName`, sealed under its
   * hub key with `LABEL_HUB_ROLE_ENCRYPT`; a platform role's is in `envelopes`.
   */
  name: z.string().nullable(),
  /** The owning hub; null/absent for a deployment-wide role. */
  hubId: z.string().nullable().optional(),
  /** Equals `id` for every custom role — never a name-derived label. */
  slug: z.string(),
  permissions: z.array(z.string()),
  isDefault: z.boolean(),
  isSystem: z.boolean(),
  description: z.string(),
  encryptedName: z.string().nullable().optional(),
  encryptedDescription: z.string().nullable().optional(),
  envelopes: z.array(roleEnvelopeSchema).optional(),
  assignedUserCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type RoleDefinition = z.infer<typeof roleResponseSchema>

export const reportTypeResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  /** The custom fields a report of this type collects. */
  fields: z.array(customFieldDefinitionSchema),
  isDefault: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ReportTypeResponse = z.infer<typeof reportTypeResponseSchema>

// --- Input schemas ---

export const customFieldsBodySchema = z.object({
  fields: z.array(z.object({
    name: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    type: z.enum(['text', 'number', 'select', 'checkbox', 'textarea', 'file', 'location']),
    required: z.boolean().optional(),
    options: z.array(z.string().max(200)).optional(),
    order: z.number().int().optional(),
    context: z.string().optional(),
    visibleToUsers: z.boolean().optional(),
  })),
})

export const createReportTypeBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  fields: z.array(customFieldDefinitionSchema).optional(),
  isDefault: z.boolean().optional(),
})
export type CreateReportTypeBody = z.input<typeof createReportTypeBodySchema>

export const updateReportTypeBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  fields: z.array(customFieldDefinitionSchema).optional(),
  isDefault: z.boolean().optional(),
  isArchived: z.boolean().optional(),
})
export type UpdateReportTypeBody = z.input<typeof updateReportTypeBodySchema>

export const ttlOverridesBodySchema = z.record(z.string(), z.number().int().min(0))

export const setupCompleteBodySchema = z.object({
  /** Zone for the default hub created on completion; the setup admin's device zone. */
  timezone: ianaTimezoneSchema.optional().default(DEFAULT_HUB_TIMEZONE),
})

/**
 * What a caller over the hub's per-number call limit gets — one setting, one
 * code path on the server (the operator's Q4 ruling, #2179):
 * - `reject`: the call is refused unanswered;
 * - `message`: the `rateLimited` prompt is played, nothing is recorded, then the call ends;
 * - `voicemail`: the caller is offered voicemail instead of a volunteer.
 * Every one of them is signalled as a `spam` incident, so the hub's
 * `settings:manage-spam` holders can see it happening.
 */
export const overLimitActionSchema = z.enum(['reject', 'message', 'voicemail'])
export type OverLimitAction = z.infer<typeof overLimitActionSchema>

const spamSettingsFields = {
  voiceCaptchaEnabled: z.boolean().optional(),
  rateLimitEnabled: z.boolean().optional(),
  maxCallsPerMinute: z.number().int().min(1).max(100).optional(),
  blockDurationMinutes: z.number().int().min(1).max(1440).optional(),
}

export const spamSettingsSchema = z.object({
  ...spamSettingsFields,
  overLimitAction: overLimitActionSchema.optional().default('message'),
})

export type SpamSettings = z.infer<typeof spamSettingsSchema>

/**
 * What GET/PATCH /settings/spam answer. SpamSettingsService fills every field
 * from DEFAULT_SPAM_SETTINGS, so a reader never sees an absent one — only a
 * writer may omit them (see `spamSettingsPatchSchema`).
 */
export const spamSettingsResponseSchema = z.object({
  voiceCaptchaEnabled: z.boolean(),
  rateLimitEnabled: z.boolean(),
  maxCallsPerMinute: z.number().int().min(1).max(100),
  blockDurationMinutes: z.number().int().min(1).max(1440),
  overLimitAction: overLimitActionSchema,
})
export type SpamSettingsResponse = z.infer<typeof spamSettingsResponseSchema>

/**
 * PATCH /settings/spam body. The same fields WITHOUT their defaults: a PATCH
 * derived from `spamSettingsSchema` would materialise `overLimitAction:
 * 'message'` for every body that omits it, silently resetting a hub's chosen
 * action whenever any other spam toggle is flipped (#1643).
 */
export const spamSettingsPatchSchema = z.object({
  ...spamSettingsFields,
  overLimitAction: overLimitActionSchema.optional(),
})
export type SpamSettingsPatch = z.input<typeof spamSettingsPatchSchema>

export const callSettingsSchema = z.object({
  queueTimeoutSeconds: z.number().int().min(30).max(300).optional(),
  voicemailMaxSeconds: z.number().int().min(30).max(300).optional(),
  /**
   * Record answered calls at the telephony provider. Defaults to OFF: a crisis
   * call must not be written to a third party's disk unless a hub has
   * deliberately opted in. When enabled, the caller is told so in the greeting
   * (`voice.recordingNotice`) before they are ever connected — see #1505.
   *
   * This does NOT gate voicemail. A caller who leaves a message has chosen to
   * leave one; that recording is caller-initiated and always permitted.
   *
   * Deliberately NOT `.optional().default(false)`: this schema is also the PATCH
   * body, and a default would materialise `recordCalls: false` for every client
   * that only changed a timeout — silently turning recording off, or writing a
   * hub override that shadows the platform value (#1643). The default (off) lives
   * in SettingsService's DEFAULT_CALL_SETTINGS, so every read still returns it.
   */
  recordCalls: z.boolean().optional(),
})

export type CallSettings = z.infer<typeof callSettingsSchema>

/**
 * What GET/PATCH /settings/call answer. CallSettingsService fills every field
 * from DEFAULT_CALL_SETTINGS, so a reader never sees an absent one — only a
 * PATCH body may omit them (see `callSettingsSchema`).
 */
export const callSettingsResponseSchema = callSettingsSchema.required()
export type CallSettingsResponse = z.infer<typeof callSettingsResponseSchema>

/**
 * Per-channel messaging configuration. The secrets of a channel (`MESSAGING_SECRET_FIELDS`
 * in the worker) are WRITE-ONLY: a PATCH may carry them, a response never does — it carries
 * `<field>Set` saying whether one is stored instead (`redactMessagingConfig`). So on this
 * shape every secret is optional, and each has its response-only `Set` flag.
 */
const channelAutoResponseFields = {
  autoResponse: z.string().optional(),
  afterHoursResponse: z.string().optional(),
}

export const smsChannelConfigSchema = z.looseObject({
  // SMS reuses the telephony provider's phone number and credentials
  enabled: z.boolean(),
  ...channelAutoResponseFields,
})
export type SmsChannelConfig = z.infer<typeof smsChannelConfigSchema>

export const whatsappChannelConfigSchema = z.looseObject({
  integrationMode: z.enum(['twilio', 'direct']),
  // Direct Meta API fields (the twilio mode reuses the telephony provider's credentials)
  phoneNumberId: z.string().optional(),
  businessAccountId: z.string().optional(),
  accessToken: z.string().optional(),
  accessTokenSet: z.boolean().optional(),
  verifyToken: z.string().optional(),
  verifyTokenSet: z.boolean().optional(),
  appSecret: z.string().optional(),
  appSecretSet: z.boolean().optional(),
  ...channelAutoResponseFields,
})
export type WhatsappChannelConfig = z.infer<typeof whatsappChannelConfigSchema>

export const signalTrustModeSchema = z.enum(['auto', 'tofu', 'manual'])
export type SignalTrustMode = z.infer<typeof signalTrustModeSchema>

export const signalChannelConfigSchema = z.looseObject({
  /** e.g. "https://signal-bridge.internal:8080" */
  bridgeUrl: z.string(),
  bridgeApiKey: z.string().optional(),
  bridgeApiKeySet: z.boolean().optional(),
  /** Required for the inbound webhook to be accepted (#2154). */
  webhookSecret: z.string().optional(),
  webhookSecretSet: z.boolean().optional(),
  registeredNumber: z.string(),
  /** 'auto' = always trust, 'tofu' = trust first contact (default), 'manual' = admin review */
  trustMode: signalTrustModeSchema.optional(),
  ...channelAutoResponseFields,
})
export type SignalChannelConfig = z.infer<typeof signalChannelConfigSchema>

export const rcsChannelConfigSchema = z.looseObject({
  agentId: z.string(),
  /** JSON string of a Google service account key. */
  serviceAccountKey: z.string().optional(),
  serviceAccountKeySet: z.boolean().optional(),
  /** Required for the inbound webhook to be accepted (#2154). */
  webhookSecret: z.string().optional(),
  webhookSecretSet: z.boolean().optional(),
  fallbackToSms: z.boolean(),
  ...channelAutoResponseFields,
})
export type RcsChannelConfig = z.infer<typeof rcsChannelConfigSchema>

export const telegramChannelConfigSchema = z.looseObject({
  enabled: z.boolean(),
  botToken: z.string().optional(),
  botTokenSet: z.boolean().optional(),
  /** Sent as setWebhook secret_token; the inbound webhook fails closed without it (#2154). */
  webhookSecret: z.string().optional(),
  webhookSecretSet: z.boolean().optional(),
  botUsername: z.string().optional(),
  ...channelAutoResponseFields,
})
export type TelegramChannelConfig = z.infer<typeof telegramChannelConfigSchema>

export const messagingConfigSchema = z.looseObject({
  enabledChannels: z.array(messagingChannelTypeSchema).optional(),
  sms: smsChannelConfigSchema.nullable().optional(),
  whatsapp: whatsappChannelConfigSchema.nullable().optional(),
  signal: signalChannelConfigSchema.nullable().optional(),
  rcs: rcsChannelConfigSchema.nullable().optional(),
  telegram: telegramChannelConfigSchema.nullable().optional(),
  /** Auto-assign a conversation to an on-shift user. */
  autoAssign: z.boolean().optional(),
  maxConcurrentPerUser: z.number().int().min(1).max(20).optional(),
  inactivityTimeout: z.number().int().min(5).max(1440).optional(),
  welcomeMessage: z.string().max(500).optional(),
  awayMessage: z.string().max(500).optional(),
  preferSignalDelivery: z.boolean().optional().default(true),
  smsContentMode: z.enum(['full', 'notification-only']).optional().default('notification-only'),
})
export type MessagingConfig = z.input<typeof messagingConfigSchema>

export const telephonyProviderSchema = z.object({
  type: telephonyProviderTypeSchema,
  // HIGH-W5: Validate Account SID / Project ID format to prevent SSRF via crafted values.
  // Twilio uses AC + 32 hex chars; SignalWire uses UUID project IDs.
  accountSid: z.string().regex(
    /^(AC[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
    'Invalid Account SID / Project ID format (must be Twilio AC+32hex or UUID)',
  ).optional(),
  authToken: z.string().optional(),
  apiKeySid: z.string().optional(),
  apiKeySecret: z.string().optional(),
  phoneNumber: z.string().regex(/^\+\d{7,15}$/).optional(),
  twimlAppSid: z.string().optional(),
  projectId: z.string().optional(),
  spaceUrl: z.url().optional(),
  applicationId: z.string().optional(),
  ariUrl: z.url().optional(),
  ariUsername: z.string().optional(),
  ariPassword: z.string().optional(),
  // Allow extra provider-specific fields
  signalwireSpace: z.string().optional(),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  authId: z.string().optional(),
  // Telnyx: the TeXML application id. PROVIDER_REQUIRED_FIELDS names it for
  // Telnyx, and a z.object() drops keys it does not declare.
  connectionId: z.string().optional(),
})
export type TelephonyProvider = z.input<typeof telephonyProviderSchema>

/**
 * A custom role id. The client mints it for a platform role because the
 * envelopes bind it in their AAD (`{roleId}:name`), so it must exist before the
 * seal. It also becomes the role's slug, which is why it is pinned to a shape
 * that cannot carry a name.
 */
export const customRoleIdSchema = z.string().regex(
  /^role-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'Role id must be role-<uuid>',
)

/**
 * A hub-key-sealed field: hex(nonce_12 ‖ ciphertext ‖ tag_16), the
 * `encrypt_hub_field` wire format. At least the 28 bytes of nonce and tag.
 */
const hubSealedFieldSchema = z.string().regex(/^[0-9a-f]{56,4096}$/, 'Must be a hub-key-sealed hex field')

/**
 * Create a deployment-wide (platform) role. Its name and description travel
 * only inside `envelopes`; the body is strict, so a plaintext `name`, `slug` or
 * `description` is refused rather than silently stored or dropped (#2780).
 */
export const createRoleSchema = z.object({
  id: customRoleIdSchema.optional(),
  permissions: z.array(z.string()),
  envelopes: z.array(roleEnvelopeSchema).optional(),
}).strict()

/** Edit a deployment-wide role. Its name changes through `/roles/:id/envelopes`. */
export const updateRoleSchema = z.object({
  permissions: z.array(z.string()).optional(),
}).strict()

/**
 * Create a hub-owned role under `/hubs/:hubId/settings/roles`. Name and
 * description are sealed client-side under the hub key with
 * `LABEL_HUB_ROLE_ENCRYPT`; the server never sees either in the clear (#2780).
 */
export const createHubRoleSchema = z.object({
  permissions: z.array(z.string()),
  encryptedName: hubSealedFieldSchema,
  encryptedDescription: z.optional(hubSealedFieldSchema),
}).strict()

/**
 * Edit a hub-owned role. Written out rather than derived with `.partial()`:
 * an omitted key leaves its column alone, and `encryptedDescription: null`
 * clears the description. (`z.optional(x)` rather than `x.optional()` on the
 * `encrypted*` keys: `local/no-plaintext-in-encrypted-field` recognises a schema
 * declaration by its `z.` root.)
 */
export const updateHubRoleSchema = z.object({
  permissions: z.array(z.string()).optional(),
  encryptedName: z.optional(hubSealedFieldSchema),
  encryptedDescription: z.optional(z.nullable(hubSealedFieldSchema)),
}).strict()

export type CreateRoleBody = z.infer<typeof createRoleSchema>
export type UpdateRoleBody = z.infer<typeof updateRoleSchema>
export type CreateHubRoleBody = z.infer<typeof createHubRoleSchema>
export type UpdateHubRoleBody = z.infer<typeof updateHubRoleSchema>

export const addRoleEnvelopesSchema = z.object({
  envelopes: z.array(roleEnvelopeSchema).min(1),
})

export const webauthnSettingsSchema = z.object({
  requireForAdmins: z.boolean().optional(),
  requireForUsers: z.boolean().optional(),
})
export type WebauthnSettings = z.input<typeof webauthnSettingsSchema>

/** Strict response type — server always returns both fields */
export const webauthnSettingsResponseSchema = z.object({
  requireForAdmins: z.boolean(),
  requireForUsers: z.boolean(),
})

export type WebAuthnSettings = z.infer<typeof webauthnSettingsResponseSchema>

export const transcriptionSettingsSchema = z.object({
  globalEnabled: z.boolean().optional(),
  allowUserOptOut: z.boolean().optional(),
})
export type TranscriptionSettings = z.input<typeof transcriptionSettingsSchema>

/** What GET/PATCH /settings/transcription answer: both flags always present. */
export const transcriptionSettingsResponseSchema = transcriptionSettingsSchema.required()
export type TranscriptionSettingsResponse = z.infer<typeof transcriptionSettingsResponseSchema>

export const ivrLanguagesSchema = z.object({
  enabledLanguages: z.array(z.string()),
})
export type IvrLanguages = z.input<typeof ivrLanguagesSchema>

/**
 * What the IVR language settings screen reads and gets back from a save.
 *
 * `uncoveredLanguageCount` is how many enabled languages no hub member lists in
 * `spokenLanguages` — a caller who picks one of those reaches nobody who speaks
 * it. It is a COUNT, never the languages or the people: naming who speaks what
 * would turn a staffing aid into a roster disclosure about volunteers.
 */
export const ivrLanguageSettingsSchema = ivrLanguagesSchema.extend({
  uncoveredLanguageCount: z.number().int().nonnegative(),
})
export type IvrLanguageSettings = z.infer<typeof ivrLanguageSettingsSchema>

/** Hub-scoped IVR language configuration (ordered list) */
export const hubIvrLanguagesSchema = z.object({
  ivrLanguages: z.array(z.string()),
})

/**
 * The setup wizard's saved progress (`SetupStateService`). Both GET and PATCH of
 * /settings/setup and PATCH /setup/state speak it: a field missing from here is
 * stripped by the validator, so the wizard's choices would never be stored (and
 * `MessagingConfigService` reads `selectedChannels` back to decide which channels exist).
 */
export const setupStateSchema = z.object({
  completed: z.boolean().optional(),
  step: z.string().optional(),
  completedSteps: z.array(z.string()).optional(),
  pendingChannels: z.array(channelTypeSchema).optional(),
  selectedChannels: z.array(channelTypeSchema).optional(),
})
export type SetupState = z.input<typeof setupStateSchema>

// --- List/wrapper response schemas ---

export const customFieldsListResponseSchema = z.object({
  // `GET`/`PUT /api/settings/custom-fields` return whole stored rows
  // (`services.settings.getCustomFields` / `updateCustomFields` map every column
  // of `customFieldDefinitions`), so the documented shape is the canonical
  // definition. The narrow `customFieldResponseSchema` projection this used to
  // reference described a response the server never sends: clients decoding it
  // silently dropped `editableByUsers`, `validation`, `id`, `createdAt` and the
  // file-upload limits, so it is gone rather than left to drift again.
  fields: z.array(customFieldDefinitionSchema),
})
export type CustomFieldsListResponse = z.infer<typeof customFieldsListResponseSchema>

export const roleListResponseSchema = z.object({
  roles: z.array(roleResponseSchema),
})

export type RoleListResponse = z.infer<typeof roleListResponseSchema>

export const reportTypeListResponseSchema = z.object({
  reportTypes: z.array(reportTypeResponseSchema),
})
export type ReportTypeListResponse = z.infer<typeof reportTypeListResponseSchema>

export const ivrAudioRecordingSchema = z.object({
  promptType: z.string(),
  language: z.string(),
  size: z.number(),
  uploadedAt: z.string(),
})

export type IvrAudioRecording = z.infer<typeof ivrAudioRecordingSchema>

/**
 * `GET /settings/ivr-audio` — the recordings held in one scope (a hub's own, or
 * the platform defaults). It was declared as `{ prompts: [{ type, languages }] }`,
 * a shape the server never sent and no client reads: `{ recordings }` is what
 * `SettingsService.getIvrAudioList` returns and the desktop settings page decodes (#2710).
 */
export const ivrAudioListResponseSchema = z.object({
  recordings: z.array(ivrAudioRecordingSchema),
})

export type IvrAudioListResponse = z.infer<typeof ivrAudioListResponseSchema>

export const successResponseSchema = z.object({
  success: z.boolean(),
})
export type SuccessResponse = z.infer<typeof successResponseSchema>

/**
 * `GET /settings/permissions` — `PERMISSION_CATALOG` and `getPermissionsByDomain()`
 * (packages/shared/permissions.ts) as they are: `permissions` maps each
 * permission to its label; `byDomain` groups the same entries under the
 * permission's domain prefix.
 */
export const permissionsCatalogResponseSchema = z.object({
  permissions: z.record(z.string(), z.string()),
  byDomain: z.record(z.string(), z.array(z.object({
    key: z.string(),
    label: z.string(),
  }))),
})

export type PermissionsCatalogResponse = z.infer<typeof permissionsCatalogResponseSchema>

export const migrationNamespaceSchema = z.object({
  name: z.string(),
  status: z.string(),
  recordCount: z.number().int().optional(),
})

export const migrationStatusResponseSchema = z.object({
  namespaces: z.array(migrationNamespaceSchema),
  note: z.string(),
})
export type MigrationStatusResponse = z.infer<typeof migrationStatusResponseSchema>

/**
 * The periodic-cleanup counters (`CleanupMetrics`, apps/worker/lib/ttl.ts): one
 * number per kind of row swept, plus when the last sweep ran. Declared as a
 * record of numbers it rejected `lastCleanupAt` — an ISO timestamp, or null
 * before the first sweep — so `GET /settings/cleanup-metrics` failed its own
 * schema as soon as a cleanup had run (#2710).
 */
export const cleanupMetricsSchema = z.object({
  captchaChallengesDeleted: z.number(),
  rateLimitEntriesDeleted: z.number(),
  expiredSessionsDeleted: z.number(),
  provisionRoomsDeleted: z.number(),
  expiredInvitesCleaned: z.number(),
  webauthnChallengesDeleted: z.number(),
  staleFileUploadsDeleted: z.number(),
  completedBlastQueuesDeleted: z.number(),
  lastCleanupAt: z.string().nullable(),
})

export const cleanupMetricsResponseSchema = z.object({
  settings: cleanupMetricsSchema,
  identity: z.record(z.string(), z.number()),
  conversation: z.record(z.string(), z.number()),
})

export const ttlOverridesResponseSchema = z.record(z.string(), z.number())

// --- Provider-side recording posture (#1505, #2297) ---

/**
 * One provider-side setting, as READ from the provider. `off` and `on` carry the
 * evidence they were read from; a setting that could not be read is `unknown`
 * with the reason. There is deliberately no way to say "off" without evidence:
 * reporting healthy when the provider could not be asked is the failure mode
 * this exists to prevent.
 */
export const providerSettingReadingSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('off'), evidence: z.string().min(1) }),
  z.object({ state: z.literal('on'), evidence: z.string().min(1) }),
  z.object({ state: z.literal('unknown'), reason: z.string().min(1) }),
])
export type ProviderSettingReading = z.infer<typeof providerSettingReadingSchema>

/**
 * What the provider keeps about a call or message, per provider (#2309): what
 * this server deletes there, and — named, never assumed away — what it cannot.
 * Taken from the provider's own documentation, not read from the account; the
 * `source` says so. A provider whose retention this server has not established
 * says that in `retained`, rather than listing nothing.
 */
export const providerRetentionStatementSchema = z.object({
  /** What this server deletes at the provider, and how. */
  removed: z.array(z.object({ what: z.string().min(1), how: z.string().min(1) })),
  /** What the provider retains that this server cannot remove, and why. */
  retained: z.array(z.object({ what: z.string().min(1), reason: z.string().min(1) })).min(1),
  /** Where these statements come from. */
  source: z.string().min(1),
})
export type ProviderRetentionStatement = z.infer<typeof providerRetentionStatementSchema>

/**
 * What the telephony provider does with caller audio on its own: recording or
 * transcription this server did NOT request. Recordings this server did request
 * (voicemail, opted-in call recording) are listed separately as `heldAtProvider`.
 */
export const providerRecordingPostureSchema = z.object({
  recording: providerSettingReadingSchema,
  transcription: providerSettingReadingSchema,
})
export type ProviderRecordingPosture = z.infer<typeof providerRecordingPostureSchema>

/**
 * Kinds of provider-held artifact the ledger tracks until the provider confirms
 * deletion: a voicemail, an opted-in call recording, or the provider's own log
 * record of a call leg (Twilio/SignalWire call records name the caller's and
 * each rung volunteer's phone number).
 */
export const heldProviderArtifactKindSchema = z.enum(['voicemail', 'call', 'call-log'])

/** A recording this server knows the provider holds, until the provider confirms it deleted it. */
export const heldProviderRecordingSchema = z.object({
  callId: z.string(),
  kind: heldProviderArtifactKindSchema,
  /**
   * False when the provider reported the recording without a handle: the audio
   * is held there and this server cannot delete it — it must be removed at the
   * provider directly. Never resolved by a retry.
   */
  addressable: z.boolean(),
  createdAt: z.string(),
  deleteAttempts: z.number().int(),
  lastAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
})
export type HeldProviderRecording = z.infer<typeof heldProviderRecordingSchema>

export const recordingPostureResponseSchema = providerRecordingPostureSchema.extend({
  /** The provider type the posture was read from, or 'mock' for the test provider. */
  provider: z.string(),
  heldAtProvider: z.array(heldProviderRecordingSchema),
  /** What the provider keeps about calls beyond recordings, and what of it this server removes (#2309). */
  retention: providerRetentionStatementSchema,
})
export type RecordingPostureResponse = z.infer<typeof recordingPostureResponseSchema>

// --- Provider-side recording posture: enforcement (#2309) ---

/**
 * One provider-side setting this server tried to turn off. `disabled` means the
 * provider accepted the change; `already-off` means it was read as off. Both
 * carry evidence. A setting the provider's API cannot change is `not-settable`
 * with the reason; a write the provider refused is `failed` — neither is ever
 * reported as off.
 */
export const providerSettingEnforcementSchema = z.discriminatedUnion('outcome', [
  z.object({ setting: z.enum(['recording', 'transcription']), target: z.string().min(1), outcome: z.literal('disabled'), evidence: z.string().min(1) }),
  z.object({ setting: z.enum(['recording', 'transcription']), target: z.string().min(1), outcome: z.literal('already-off'), evidence: z.string().min(1) }),
  z.object({ setting: z.enum(['recording', 'transcription']), target: z.string().min(1), outcome: z.literal('not-settable'), reason: z.string().min(1) }),
  z.object({ setting: z.enum(['recording', 'transcription']), target: z.string().min(1), outcome: z.literal('failed'), reason: z.string().min(1) }),
])
export type ProviderSettingEnforcement = z.infer<typeof providerSettingEnforcementSchema>

/**
 * `POST .../recording-posture/enforce`: every change attempted, then the
 * posture as re-read afterwards — the re-read, not the write, is the evidence
 * that a setting is now off.
 */
export const recordingPostureEnforcementResponseSchema = z.object({
  actions: z.array(providerSettingEnforcementSchema).min(1),
  posture: recordingPostureResponseSchema,
})
export type RecordingPostureEnforcementResponse = z.infer<typeof recordingPostureEnforcementResponseSchema>
