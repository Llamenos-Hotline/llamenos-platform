// --- ECIES Key Envelopes ---
// Canonical types are inferred from Zod schemas in @protocol/schemas/common.
export type { RecipientEnvelope, KeyEnvelope, RecipientKeyEnvelope, FileKeyEnvelope } from '@protocol/schemas/common'

// --- Telephony Provider Config ---
// TelephonyProviderType canonical definition is in @protocol/schemas/settings
export type { TelephonyProviderType } from '@protocol/schemas/settings'
import type { TelephonyProviderType } from '@protocol/schemas/settings'

export const TELEPHONY_PROVIDER_LABELS: Record<TelephonyProviderType, string> = {
  twilio: 'Twilio',
  signalwire: 'SignalWire',
  vonage: 'Vonage',
  plivo: 'Plivo',
  asterisk: 'Asterisk (Self-Hosted)',
  telnyx: 'Telnyx',
  bandwidth: 'Bandwidth',
  freeswitch: 'FreeSWITCH (Self-Hosted)',
}

export interface TelephonyProviderConfig {
  type: TelephonyProviderType
  phoneNumber: string      // E.164 hotline number

  // Twilio / SignalWire
  accountSid?: string
  authToken?: string
  signalwireSpace?: string  // SignalWire only: {space}.signalwire.com

  // Vonage
  apiKey?: string
  apiSecret?: string
  applicationId?: string
  privateKey?: string       // Vonage Application private key (PEM)

  // Plivo
  authId?: string
  // authToken shared with Twilio field

  // Asterisk ARI
  ariUrl?: string           // e.g. https://asterisk.example.com:8089/ari
  ariUsername?: string
  ariPassword?: string
  bridgeCallbackUrl?: string // URL the ARI bridge posts webhooks to
  bridgeSecret?: string      // Separate HMAC secret for bridge<->worker auth (never reuse ariPassword)

  // Telnyx
  connectionId?: string     // Telnyx Call Control App ID
  // apiKey shared with Vonage field

  // Bandwidth
  // accountId shared with Plivo authId field
  // apiToken shared with Plivo authToken field
  bandwidthAppId?: string   // Bandwidth application ID

  // FreeSWITCH (same bridge pattern as Asterisk)
  freeswitchBridgeUrl?: string  // URL the FreeSWITCH bridge posts webhooks to
  freeswitchBridgeSecret?: string // Shared secret for HMAC webhook validation

  // WebRTC (Twilio/SignalWire require extra API keys; Vonage/Plivo use existing creds)
  webrtcEnabled?: boolean
  apiKeySid?: string        // Twilio/SignalWire API Key SID for Access Token generation
  apiKeySecret?: string     // Twilio/SignalWire API Key Secret
  twimlAppSid?: string      // Twilio/SignalWire TwiML App SID for browser calls

  // SIP VoIP (mobile native clients — Linphone SDK, Epic 91)
  sipDomain?: string            // SIP REGISTER domain
  sipUsername?: string          // SIP REGISTER username
  sipPassword?: string          // SIP REGISTER password
  sipEndpointUsername?: string  // Plivo SIP endpoint username
  sipEndpointPassword?: string  // Plivo SIP endpoint password
  spaceUrl?: string             // SignalWire space URL
  asteriskGateway?: string      // Vonage→Asterisk SIP gateway host
  asteriskSipUsername?: string  // Vonage→Asterisk SIP credentials
  asteriskSipPassword?: string  // Vonage→Asterisk SIP credentials
}

// --- Call Preference ---

export type CallPreference = 'phone' | 'browser' | 'both'

/** Which credential fields each provider requires */
export const PROVIDER_REQUIRED_FIELDS: Record<TelephonyProviderType, (keyof TelephonyProviderConfig)[]> = {
  twilio: ['accountSid', 'authToken', 'phoneNumber'],
  signalwire: ['accountSid', 'authToken', 'signalwireSpace', 'phoneNumber'],
  vonage: ['apiKey', 'apiSecret', 'applicationId', 'phoneNumber'],
  plivo: ['authId', 'authToken', 'phoneNumber'],
  asterisk: ['ariUrl', 'ariUsername', 'ariPassword', 'bridgeSecret', 'phoneNumber'],
  telnyx: ['apiKey', 'connectionId', 'phoneNumber'],
  bandwidth: ['authId', 'authToken', 'bandwidthAppId', 'phoneNumber'],
  freeswitch: ['freeswitchBridgeUrl', 'freeswitchBridgeSecret', 'phoneNumber'],
}

// --- Custom Fields ---
// Canonical type is inferred from Zod schema in @protocol/schemas/settings
export type { CustomFieldContext, CustomFieldDefinition } from '@protocol/schemas/settings'
import type { CustomFieldContext, CustomFieldDefinition } from '@protocol/schemas/settings'

// --- Encrypted File Upload Types ---

export interface EncryptedFileMetadata {
  originalName: string
  mimeType: string
  size: number
  dimensions?: { width: number; height: number }
  duration?: number
  checksum: string   // SHA-256 of plaintext for integrity verification
}

// FileKeyEnvelope is re-exported from @protocol/schemas/common above
// FileRecord and UploadInit canonical types are in @protocol/schemas/files
export type { FileRecord, UploadInit } from '@protocol/schemas/files'

// Client-side plaintext payload — not a wire format
/** What gets encrypted before storage — replaces plain text */
export interface NotePayload {
  text: string
  fields?: Record<string, string | number | boolean>
}

export const MAX_CUSTOM_FIELDS = 20
export const MAX_SELECT_OPTIONS = 50
export const MAX_FIELD_NAME_LENGTH = 50
export const MAX_FIELD_LABEL_LENGTH = 200
export const MAX_OPTION_LENGTH = 200
export const FIELD_NAME_REGEX = /^[a-zA-Z0-9_]+$/

/** Check if a custom field should appear in a given context */
export function fieldMatchesContext(field: CustomFieldDefinition, context: CustomFieldContext): boolean {
  return field.context === context || field.context === 'all'
}

export const CUSTOM_FIELD_CONTEXT_LABELS: Record<CustomFieldContext, string> = {
  'call-notes': 'Call Notes',
  'conversation-notes': 'Conversation Notes',
  'reports': 'Reports',
  'all': 'All Record Types',
}

// --- Messaging Channel Types ---
// Canonical definitions are in @protocol/schemas/settings
export type { MessagingChannelType, ChannelType } from '@protocol/schemas/settings'
import type { MessagingChannelType, ChannelType } from '@protocol/schemas/settings'

/** Transport security level for each channel */
export type TransportSecurity = 'none' | 'provider-encrypted' | 'e2ee-to-bridge' | 'e2ee'

export const CHANNEL_SECURITY: Record<ChannelType, TransportSecurity> = {
  voice: 'provider-encrypted',
  sms: 'none',
  whatsapp: 'provider-encrypted',
  signal: 'e2ee-to-bridge',
  telegram: 'provider-encrypted',
  rcs: 'provider-encrypted',
  reports: 'e2ee',
}

export const CHANNEL_LABELS: Record<ChannelType, string> = {
  voice: 'Voice Calls',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  telegram: 'Telegram',
  rcs: 'RCS',
  reports: 'Reports',
}

// --- Messaging Configuration ---

export interface SMSConfig {
  // SMS reuses the telephony provider's phone number and credentials
  enabled: boolean
  autoResponse?: string        // auto-reply on first contact
  afterHoursResponse?: string  // auto-reply outside shift hours
}

export interface WhatsAppConfig {
  integrationMode: 'twilio' | 'direct'
  // Direct Meta API fields
  phoneNumberId?: string
  businessAccountId?: string
  accessToken?: string
  verifyToken?: string
  appSecret?: string
  // Twilio mode uses existing telephony provider credentials
  autoResponse?: string
  afterHoursResponse?: string
}

export type SignalTrustMode = 'auto' | 'tofu' | 'manual'

export interface SignalConfig {
  bridgeUrl: string            // e.g., "https://signal-bridge.internal:8080"
  bridgeApiKey: string
  webhookSecret: string
  registeredNumber: string
  trustMode?: SignalTrustMode  // 'auto' = always trust, 'tofu' = trust first contact (default), 'manual' = admin review
  autoResponse?: string
  afterHoursResponse?: string
}

export interface RCSConfig {
  agentId: string
  serviceAccountKey: string    // JSON string of Google service account key
  webhookSecret?: string
  fallbackToSms: boolean
  autoResponse?: string
  afterHoursResponse?: string
}

export interface TelegramConfig {
  enabled: boolean
  botToken: string
  webhookSecret?: string
  botUsername?: string
  autoResponse?: string
  afterHoursResponse?: string
}

export interface MessagingConfig {
  enabledChannels: MessagingChannelType[]
  sms: SMSConfig | null
  whatsapp: WhatsAppConfig | null
  signal: SignalConfig | null
  rcs: RCSConfig | null
  telegram: TelegramConfig | null
  autoAssign: boolean               // auto-assign to on-shift users
  inactivityTimeout: number         // minutes before auto-close
  maxConcurrentPerUser: number  // conversation limit per user
  preferSignalDelivery?: boolean
  smsContentMode?: 'full' | 'notification-only'
}

export const DEFAULT_MESSAGING_CONFIG: MessagingConfig = {
  enabledChannels: [],
  sms: null,
  whatsapp: null,
  signal: null,
  rcs: null,
  telegram: null,
  autoAssign: true,
  inactivityTimeout: 60,
  maxConcurrentPerUser: 3,
  preferSignalDelivery: true,
  smsContentMode: 'notification-only',
}

// --- Message Blasts ---
// These are storage-level types with more fields than API response schemas in @protocol/schemas/blasts.
// API response types: Blast, Subscriber, BlastSettings from @protocol/schemas/blasts

export interface Subscriber {
  id: string
  identifierHash: string         // HMAC hash of phone/identifier
  channels: SubscriberChannel[]
  tags: string[]
  language: string               // preferred language code
  subscribedAt: string
  status: 'active' | 'paused' | 'unsubscribed'
  doubleOptInConfirmed: boolean
  preferenceToken: string        // HMAC token for self-service preferences
}

export interface SubscriberChannel {
  type: MessagingChannelType
  verified: boolean
}

export interface Blast {
  id: string
  name: string
  content: BlastContent | MultiBlastContent
  defaultLanguage?: string        // fallback language code (default 'en')
  status: 'draft' | 'scheduled' | 'sending' | 'paused' | 'sent' | 'cancelled'
  targetChannels: MessagingChannelType[]
  targetTags: string[]            // empty = all subscribers
  targetLanguages: string[]       // empty = all languages
  scheduledAt?: string
  sentAt?: string
  completedAt?: string
  cancelledAt?: string
  createdBy: string               // pubkey
  createdAt: string
  updatedAt: string
  stats: BlastStats
}

export interface BlastContent {
  text: string
  mediaUrl?: string
  mediaType?: string
  // Per-channel overrides
  smsText?: string
  whatsappTemplateId?: string
  rcsRichCard?: boolean
}

/** Multi-language blast content: Record<langCode, BlastContent> */
export type MultiBlastContent = Record<string, BlastContent>

/** Type guard: true if content is single-language (has `text` key directly, even if undefined) */
export function isSingleBlastContent(content: BlastContent | MultiBlastContent): content is BlastContent {
  return 'text' in content
}

/**
 * Resolve the appropriate content for a subscriber's language.
 * Fallback chain: subscriberLang -> defaultLang -> 'en' -> first available
 */
export function resolveBlastContent(
  content: BlastContent | MultiBlastContent,
  subscriberLang: string,
  defaultLang = 'en',
): BlastContent {
  if (isSingleBlastContent(content)) return content

  const multi = content as MultiBlastContent
  return (
    multi[subscriberLang] ??
    multi[defaultLang] ??
    multi['en'] ??
    Object.values(multi)[0]
  )
}

export type BlastDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'opted_out' | 'skipped'

export interface BlastDelivery {
  id: string
  blastId: string
  subscriberId: string
  channel: MessagingChannelType
  status: BlastDeliveryStatus
  externalId?: string
  attempts: number
  lastAttemptAt?: string
  nextRetryAt?: string
  deliveredAt?: string
  failedAt?: string
  error?: string
  createdAt: string
}

export interface BlastStats {
  totalRecipients: number
  sent: number
  delivered: number
  failed: number
  optedOut: number
}

export interface BlastSettings {
  subscribeKeyword: string        // default: "JOIN"
  unsubscribeKeyword: string      // default: "STOP"
  confirmationMessage: string
  unsubscribeMessage: string
  doubleOptIn: boolean
  optOutFooter: string            // appended to every blast message
  maxBlastsPerDay: number
  rateLimitPerSecond: number      // global fallback sending rate
  rateLimits: Record<MessagingChannelType, number>  // per-channel rates
}

export const DEFAULT_BLAST_SETTINGS: BlastSettings = {
  subscribeKeyword: 'JOIN',
  unsubscribeKeyword: 'STOP',
  confirmationMessage: 'You have been subscribed. Reply STOP to unsubscribe.',
  unsubscribeMessage: 'You have been unsubscribed. Reply JOIN to resubscribe.',
  doubleOptIn: false,
  optOutFooter: '\nReply STOP to unsubscribe.',
  maxBlastsPerDay: 10,
  rateLimitPerSecond: 10,
  rateLimits: { sms: 10, whatsapp: 25, signal: 15, rcs: 10, telegram: 20 },
}

// --- Setup State ---

export interface SetupState {
  setupCompleted: boolean
  completedSteps: string[]
  pendingChannels: ChannelType[]
  selectedChannels: ChannelType[]
}

export const DEFAULT_SETUP_STATE: SetupState = {
  setupCompleted: false,
  completedSteps: [],
  pendingChannels: [],
  selectedChannels: [],
}

// --- Enabled Channels (computed from settings) ---

export interface EnabledChannels {
  voice: boolean
  sms: boolean
  whatsapp: boolean
  signal: boolean
  telegram: boolean
  rcs: boolean
  reports: boolean
}

// --- Report Types ---
// Storage type with fields: CustomFieldDefinition[] — richer than the API response schema in @protocol/schemas/settings

export interface ReportType {
  id: string               // UUID
  name: string             // Display name (e.g., "Incident Report")
  description: string      // Brief description of when to use this type
  icon?: string            // Optional lucide icon name (e.g., "alert-triangle")
  fields: CustomFieldDefinition[]  // Fields specific to this report type
  isDefault?: boolean      // Whether this is the pre-selected type
  isArchived?: boolean     // Soft-deleted (hidden from selectors, existing reports keep reference)
  createdAt: string
  updatedAt: string
}

export const MAX_REPORT_TYPES = 50
export const MAX_REPORT_TYPE_NAME_LENGTH = 100
export const MAX_REPORT_TYPE_DESCRIPTION_LENGTH = 500

export const DEFAULT_REPORT_TYPES: Omit<ReportType, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Incident Report',
    description: 'Document a specific incident or event that occurred.',
    icon: 'alert-triangle',
    fields: [],
    isDefault: true,
  },
  {
    name: 'Field Observation',
    description: 'Record observations from the field or community.',
    icon: 'eye',
    fields: [],
  },
  {
    name: 'Evidence',
    description: 'Submit evidence documentation (photos, files, recordings).',
    icon: 'camera',
    fields: [],
  },
  {
    name: 'Other',
    description: 'General report that does not fit other categories.',
    icon: 'file-text',
    fields: [],
  },
]

// --- Entity Schema Types (CMS — Epic 315) ---
export type { EntityTypeDefinition, EntityFieldDefinition, RelationshipTypeDefinition, EnumOption, EntityCategory } from '@protocol/schemas/entity-schema'

export const MAX_ENTITY_TYPES = 50
export const MAX_ENTITY_FIELDS = 100
export const MAX_RELATIONSHIP_TYPES = 100
export const MAX_ENUM_OPTIONS = 50
export const MAX_FIELD_SECTIONS = 20

export const ENTITY_CATEGORY_LABELS: Record<string, string> = {
  contact: 'Contact',
  case: 'Case',
  event: 'Event',
  custom: 'Custom Record',
}

// --- Hub Types ---
// Canonical Hub type is in @protocol/schemas/hubs
export type { Hub } from '@protocol/schemas/hubs'

export interface HubRoleAssignment {
  hubId: string
  roleIds: string[]
}
