import { z } from 'zod'

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
  /** null for non-system roles — plaintext name stored only in encrypted envelopes */
  name: z.string().nullable(),
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

export const customFieldResponseSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'number', 'select', 'checkbox', 'textarea', 'file', 'location']),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  order: z.number().optional(),
  context: z.string().optional(),
  visibleToUsers: z.boolean().optional(),
})

export const reportTypeResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  fields: z.array(z.string()).optional(),
  isDefault: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

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
  fields: z.array(z.string()).optional(),
})

export const updateReportTypeBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(50).optional(),
  fields: z.array(z.string()).optional(),
  isArchived: z.boolean().optional(),
})

export const ttlOverridesBodySchema = z.record(z.string(), z.number().int().min(0))

export const setupCompleteBodySchema = z.object({
  demoMode: z.boolean().optional(),
})

export const spamSettingsSchema = z.object({
  voiceCaptchaEnabled: z.boolean().optional(),
  rateLimitEnabled: z.boolean().optional(),
  maxCallsPerMinute: z.number().int().min(1).max(100).optional(),
  blockDurationMinutes: z.number().int().min(1).max(1440).optional(),
})

export type SpamSettings = z.infer<typeof spamSettingsSchema>

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
   */
  recordCalls: z.boolean().optional().default(false),
})

export type CallSettings = z.infer<typeof callSettingsSchema>

export const messagingConfigSchema = z.looseObject({
  enabledChannels: z.array(messagingChannelTypeSchema).optional(),
  autoAssignEnabled: z.boolean().optional(),
  maxConcurrentPerUser: z.number().int().min(1).max(20).optional(),
  inactivityTimeout: z.number().int().min(5).max(1440).optional(),
  welcomeMessage: z.string().max(500).optional(),
  awayMessage: z.string().max(500).optional(),
  preferSignalDelivery: z.boolean().optional().default(true),
  smsContentMode: z.enum(['full', 'notification-only']).optional().default('notification-only'),
})

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
})

export const createRoleSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  permissions: z.array(z.string()),
  description: z.string().min(1).max(500),
  encryptedName: z.string().optional(),
  encryptedDescription: z.string().optional(),
  envelopes: z.array(roleEnvelopeSchema).optional(),
})

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).optional(),
})

export const addRoleEnvelopesSchema = z.object({
  envelopes: z.array(roleEnvelopeSchema).min(1),
})

export const webauthnSettingsSchema = z.object({
  requireForAdmins: z.boolean().optional(),
  requireForUsers: z.boolean().optional(),
})

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

export const ivrLanguagesSchema = z.object({
  enabledLanguages: z.array(z.string()),
})

/** Hub-scoped IVR language configuration (ordered list) */
export const hubIvrLanguagesSchema = z.object({
  ivrLanguages: z.array(z.string()),
})

export const setupStateSchema = z.object({
  completed: z.boolean().optional(),
  step: z.string().optional(),
})

// --- List/wrapper response schemas ---

export const customFieldsListResponseSchema = z.object({
  fields: z.array(customFieldResponseSchema),
})

export const roleListResponseSchema = z.object({
  roles: z.array(roleResponseSchema),
})

export const reportTypeListResponseSchema = z.object({
  reportTypes: z.array(reportTypeResponseSchema),
})

export const ivrAudioRecordingSchema = z.object({
  promptType: z.string(),
  language: z.string(),
  size: z.number(),
  uploadedAt: z.string(),
})

export type IvrAudioRecording = z.infer<typeof ivrAudioRecordingSchema>

export const ivrAudioPromptsResponseSchema = z.object({
  prompts: z.array(z.object({
    type: z.string(),
    languages: z.array(z.string()),
  })),
})

export const successResponseSchema = z.object({
  success: z.boolean(),
})

export const permissionsCatalogResponseSchema = z.object({
  permissions: z.array(z.object({
    id: z.string(),
    label: z.string(),
    domain: z.string(),
  })),
  byDomain: z.record(z.string(), z.array(z.object({
    id: z.string(),
    label: z.string(),
  }))),
})

export const migrationNamespaceSchema = z.object({
  name: z.string(),
  status: z.string(),
  recordCount: z.number().int().optional(),
})

export const migrationStatusResponseSchema = z.object({
  namespaces: z.array(migrationNamespaceSchema),
  note: z.string(),
})

export const cleanupMetricsResponseSchema = z.object({
  settings: z.record(z.string(), z.number()),
  identity: z.record(z.string(), z.number()),
  conversation: z.record(z.string(), z.number()),
})

export const ttlOverridesResponseSchema = z.record(z.string(), z.number())
