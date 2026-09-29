// Infrastructure types — worker-internal only, never sent to client as wire format.
//
// Entity types that match @protocol/schemas exactly are re-exported below.
// Types with extra storage-only fields (encryptedSecretKey, callerNumber, etc.)
// are defined here as server-internal storage types.

import type { MessagingChannelType, RecipientEnvelope } from '@shared/types'

// ---------------------------------------------------------------------------
// Re-exports of entity types whose schema matches storage shape exactly
// ---------------------------------------------------------------------------
export type { Shift } from '@protocol/schemas/shifts'
export type { BanEntry } from '@protocol/schemas/bans'
export type { AuditLogEntry } from '@protocol/schemas/audit'
export type { EncryptedNote } from '@protocol/schemas/notes'
export type { InviteCode } from '@protocol/schemas/invites'
export type { WebAuthnSettings } from '@protocol/schemas/settings'

// ---------------------------------------------------------------------------
// Platform service interfaces (structural typing)
// ---------------------------------------------------------------------------

/** Blob storage interface (RustFS/S3-compatible). */
export interface BlobStorage {
  put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array | string): Promise<void>
  get(key: string): Promise<{ body: ReadableStream; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>
  delete(key: string): Promise<void>
}

/** Transcription service interface (Whisper). */
export interface TranscriptionService {
  run(model: string, input: { audio: number[] }): Promise<{ text: string }>
}

export interface Env {
  // Transcription (CF: Ai binding, Node: Whisper HTTP client)
  AI: TranscriptionService

  // Blob storage (CF: R2Bucket, Node: S3-compatible storage)
  R2_BUCKET: BlobStorage

  // Hub-scoped storage manager (RustFS with per-hub IAM)
  STORAGE_MANAGER?: import('../lib/storage-manager').StorageManager

  // Storage admin client for IAM operations
  STORAGE_ADMIN?: import('../lib/storage-admin').StorageAdminClient

  // Plain env vars / secrets (same on both platforms)
  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_PHONE_NUMBER: string
  ADMIN_PUBKEY: string
  ADMIN_DECRYPTION_PUBKEY?: string // Separate pubkey for note/hub key encryption (falls back to ADMIN_PUBKEY)
  HOTLINE_NAME: string
  ENVIRONMENT: string
  WEBHOOK_BASE_URL?: string        // Public base URL used for webhook signature verification (prevents Host header spoofing)
  CORS_ALLOWED_ORIGINS?: string   // Comma-separated allowed origins (overrides hardcoded defaults)
  HMAC_SECRET: string
  METRICS_SCRAPE_TOKEN?: string
  E2E_TEST_SECRET?: string
  DEV_RESET_SECRET?: string
  DEV_AUTH_BYPASS?: string           // "true" to skip Ed25519 signature verification (dev only)
  DEV_ROUTES_ENABLED?: string        // "true" to enable /test-* dev routes (dev only)

  // Demo mode (scheduled resets all data on a cron schedule)
  DEMO_MODE?: string              // "true" to enable (blocked in ENVIRONMENT=production)
  DEMO_MODE_CONFIRM?: string      // Must be "DESTROY_ALL_DATA" when DEMO_MODE=true (two-factor confirmation)
  DEMO_RESET_CRON?: string        // Human-readable schedule label (e.g., "every 4 hours")

  // Server secret — hex 32 bytes used for HKDF key derivation (signing, encryption, auth)
  SERVER_SECRET?: string

  // Firehose inference agent seal key (hex 32 bytes — seals agent nsecs at rest)
  FIREHOSE_AGENT_SEAL_KEY?: string

  // Asterisk SIP bridge (optional — only when using Asterisk telephony adapter)
  SIP_BRIDGE_URL?: string         // HTTP base URL of the asterisk-bridge sidecar (e.g. http://asterisk-bridge:3000)

  // Signal notifier sidecar (signal notification service)
  SIGNAL_NOTIFIER_URL?: string         // HTTP base URL of the signal-notifier sidecar (canonical)
  SIGNAL_NOTIFIER_BEARER_TOKEN?: string // Shared bearer token for server→sidecar API auth (canonical)
  /** @deprecated Use SIGNAL_NOTIFIER_URL */
  NOTIFIER_URL?: string
  /** @deprecated Use SIGNAL_NOTIFIER_BEARER_TOKEN */
  NOTIFIER_API_KEY?: string
  NOTIFIER_TOKEN_SECRET?: string  // HMAC secret for signing client registration tokens (falls back to HMAC_SECRET)

  // GlitchTip/Sentry DSN for client-side crash reporting (Epic 293)
  GLITCHTIP_DSN?: string

  // Certificate pinning — comma-separated base64 SHA-256 SPKI hashes for pin override.
  // Defaults to Let's Encrypt ISRG Root X1 + X2 if not set.
  CERT_PIN_HASHES?: string

  // Push notifications (Epic 86) — APNs (iOS)
  APNS_KEY_P8?: string       // Apple Push Notification auth key (PEM format)
  APNS_KEY_ID?: string       // Key ID from Apple Developer Portal
  APNS_TEAM_ID?: string      // Apple Developer Team ID
  APNS_BUNDLE_ID?: string    // APNs topic / iOS bundle identifier override (Issue #724).
                             // Defaults to org.llamenos.hotline (see lib/apns-topic.ts) —
                             // must match PRODUCT_BUNDLE_IDENTIFIER in apps/ios/project.yml.

  // Push notifications (Epic 86) — ntfy/UnifiedPush (Android)
  NTFY_URL?: string           // Self-hosted ntfy instance URL (e.g. http://ntfy:80)
  NTFY_AUTH_TOKEN?: string    // Bearer token for ntfy authentication
  NTFY_PUBLIC_URL?: string    // Device-facing URL of the same broker (e.g. https://push.example.org) when NTFY_URL is an internal address
  NTFY_ALLOWED_ORIGINS?: string // Comma-separated extra operator-approved UnifiedPush relay origins (never sent NTFY_AUTH_TOKEN)

  // Connection manager for WebSocket relay (initialized in server bootstrap)
  WS_MANAGER?: import('../lib/ws-manager').ConnectionManager
}

// ---------------------------------------------------------------------------
// Push Notification Types (Epic 86)
// ---------------------------------------------------------------------------

export interface DeviceRecord {
  platform: 'ios' | 'android'
  pushToken: string
  wakeKeyPublic: string      // X25519 pubkey (hex) for wake-tier HPKE
  /**
   * X25519 pubkey (hex) for full-tier HPKE and every other envelope sealed to
   * this device. Null when the client has not published one — in that case the
   * device gets no full-tier payload. It is NEVER substituted with the user's
   * Ed25519 auth pubkey, which is not an HPKE recipient (#1021).
   */
  x25519Pubkey: string | null
  registeredAt: string
  lastSeenAt: string
}

export type PushNotificationType = 'message' | 'voicemail' | 'shift_reminder' | 'assignment'

/** Wake-tier payload — decryptable without PIN (minimal metadata) */
export interface WakePayload {
  hubId: string          // identifies which hub this push belongs to
  type: PushNotificationType
  conversationId?: string
  channelType?: string
  callId?: string
  shiftId?: string
  startsAt?: string
}

/** Full-tier payload — decryptable only with volunteer's device key */
export interface FullPushPayload extends WakePayload {
  senderLast4?: string
  previewText?: string
  duration?: number
  callerLast4?: string
  shiftName?: string
  role?: string
}

// ---------------------------------------------------------------------------
// Storage-level entity types (extra fields beyond API response schemas)
// ---------------------------------------------------------------------------

/**
 * Server-internal User record — includes storage-only fields
 * (encryptedSecretKey, hubRoles) not present in the API response schema.
 * See @protocol/schemas/users for the API response type.
 */
export interface User {
  pubkey: string
  name: string
  phone: string
  roles: string[]            // Global role IDs (e.g., ['role-super-admin', 'role-volunteer'])
  hubRoles?: { hubId: string; roleIds: string[] }[]  // Per-hub role assignments
  active: boolean
  createdAt: string
  encryptedSecretKey: string // Admin-encrypted copy of the volunteer's signing seed
  transcriptionEnabled: boolean
  spokenLanguages: string[]  // Languages volunteer can take calls in (e.g. ['en', 'es'])
  uiLanguage: string         // Preferred UI language
  profileCompleted: boolean  // Whether first-login setup is done
  onBreak: boolean           // Temporarily unavailable (still on shift)
  callPreference: 'phone' | 'browser' | 'both'  // How to receive calls (default: 'phone')
  // Messaging channel capabilities (Epic 68)
  supportedMessagingChannels?: MessagingChannelType[]  // SMS, WhatsApp, Signal, RCS (empty = all)
  messagingEnabled?: boolean  // Whether volunteer can handle messaging conversations
  // Volunteer profile extensions (Epic 340)
  specializations?: string[]        // e.g., ["immigration", "domestic_violence", "legal_observer"]
  maxCaseAssignments?: number       // Capacity limit (0 = unlimited, default: 0)
  teamId?: string                   // Primary team assignment (e.g., "team-alpha")
  supervisorPubkey?: string         // Who reviews this volunteer's cases
}

/**
 * Server-internal CallRecord — callerNumber is required (routing data).
 * The API response schema (callRecordResponseSchema) has callerNumber optional
 * because it's added client-side after decryption.
 */
export interface CallRecord {
  id: string
  callerNumber: string
  callerLast4?: string
  answeredBy: string | null
  startedAt: string
  endedAt?: string
  duration?: number
  status: 'ringing' | 'in-progress' | 'completed' | 'unanswered'
  hasTranscription: boolean
  hasVoicemail: boolean
  recordingSid?: string
  hasRecording?: boolean
}

/**
 * Server-internal SpamSettings — all fields required (stored state).
 * The schema (spamSettingsSchema) uses optional fields for partial updates.
 */
export interface SpamSettings {
  voiceCaptchaEnabled: boolean
  rateLimitEnabled: boolean
  maxCallsPerMinute: number
  blockDurationMinutes: number
}

/**
 * Server-internal CallSettings — all fields required (stored state).
 * The schema (callSettingsSchema) uses optional fields for partial updates.
 */
export interface CallSettings {
  queueTimeoutSeconds: number   // 30-300, default 90
  voicemailMaxSeconds: number   // 30-300, default 120
}

/**
 * Server-internal WebAuthnCredential — full storage record.
 * The API response schema strips some fields.
 */
export interface WebAuthnCredential {
  id: string              // Base64URL credential ID
  publicKey: string       // Base64URL public key bytes
  counter: number         // Signature counter (clone detection)
  transports: string[]    // ['internal', 'hybrid', etc.]
  backedUp: boolean       // Cloud-synced passkey
  label: string           // User-assigned name ("My Phone")
  createdAt: string
  lastUsedAt: string
}

export interface ServerSession {
  token: string           // Random 256-bit hex
  pubkey: string          // Which user
  createdAt: string
  expiresAt: string       // 8-hour expiry
  /** Set when the session token was rotated during renewal. Client should store this as the new token. */
  newToken?: string
}

export interface AuthPayload {
  pubkey: string
  timestamp: number
  token: string
  /** Optional random nonce to prevent replay collisions in parallel requests */
  nonce?: string
}

// ---------------------------------------------------------------------------
// Encrypted call record history (Epic 77) — server-internal only
// ---------------------------------------------------------------------------

/**
 * Encrypted call record for history storage (Epic 77).
 *
 * Active calls remain as plaintext CallRecord (routing necessity).
 * When a call completes, sensitive metadata (answeredBy, full callerNumber)
 * is encrypted into an envelope and stored per-record as `callrecord:${id}`.
 *
 * Plaintext fields: callerLast4, timestamp, duration, status, hasTranscription, hasVoicemail
 * Encrypted fields: answeredBy, callerNumber (original hash), outcome details
 */
export interface EncryptedCallRecord {
  id: string
  callerLast4?: string           // For display (not sensitive)
  startedAt: string              // Needed for ordering/pagination
  endedAt?: string               // Needed for duration display
  duration?: number              // Acceptable trade-off (no PII)
  status: 'completed' | 'unanswered'
  hasTranscription: boolean
  hasVoicemail: boolean
  hasRecording?: boolean
  recordingSid?: string          // Twilio ID (not PII, server needs to update post-encryption)

  // Envelope-pattern encryption for admin(s)
  encryptedContent: string       // hex: nonce(12) + ciphertext + tag(16) (AES-256-GCM)
  adminEnvelopes: RecipientEnvelope[]  // Per-record key wrapped for each admin
}

/**
 * Plaintext inside EncryptedCallRecord.encryptedContent.
 * Only visible after admin decryption.
 */
export interface CallRecordMetadata {
  answeredBy: string | null      // Volunteer pubkey
  callerNumber: string           // HMAC-hashed phone number
}

// ---------------------------------------------------------------------------
// Conversation / Messaging — server-internal storage types
// ---------------------------------------------------------------------------

export type ConversationStatus = 'active' | 'waiting' | 'closed'

/**
 * Server-internal Conversation record — lastMessageAt required, metadata has
 * customFieldValues. The API schema has some fields optional.
 */
export interface Conversation {
  id: string
  channelType: MessagingChannelType | 'web'
  contactIdentifierHash: string   // hashed phone/ID
  contactLast4?: string           // last 4 digits (admin-only, like callerLast4)
  assignedTo?: string             // volunteer pubkey
  status: ConversationStatus
  createdAt: string
  updatedAt: string
  lastMessageAt: string
  messageCount: number
  metadata?: {
    linkedCallId?: string         // if conversation started from a call
    reportId?: string             // if conversation is a report thread
    type?: 'report'               // report conversations
    reportTitle?: string          // encrypted
    reportCategory?: string
    customFieldValues?: string    // encrypted JSON of custom field values
  }
}

export type MessageDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

/**
 * Encrypted message using the envelope pattern (Epic 74).
 *
 * Single ciphertext encrypted with a random per-message symmetric key.
 * The key is HPKE-wrapped separately for each authorized reader.
 * Domain separation label: 'llamenos:message'.
 */
export interface EncryptedMessage {
  id: string
  conversationId: string
  direction: 'inbound' | 'outbound'
  authorPubkey: string             // volunteer pubkey or 'system:inbound'
  encryptedContent: string         // hex: nonce(12) + ciphertext + tag(16) (AES-256-GCM)
  // Per-reader key envelopes (HPKE-wrapped message key)
  readerEnvelopes: RecipientEnvelope[]
  hasAttachments: boolean
  attachmentIds?: string[]         // references to R2 encrypted blobs
  createdAt: string
  externalId?: string              // provider's message ID
  // Delivery status tracking (Epic 71)
  status?: MessageDeliveryStatus   // delivery status (default: 'pending' for outbound)
  deliveredAt?: string             // ISO timestamp when delivered
  readAt?: string                  // ISO timestamp when read (if supported)
  failureReason?: string           // error message for failed messages
  retryCount?: number              // number of retry attempts
}

/** @deprecated Use RecipientEnvelope from @shared/types instead. */
export type MessageKeyEnvelope = RecipientEnvelope

// ---------------------------------------------------------------------------
// Blast Delivery — server-internal delivery tracking (DB-backed)
// ---------------------------------------------------------------------------

/** Max retry attempts before marking delivery as permanently failed */
export const BLAST_MAX_RETRIES = 3

/** Base backoff in milliseconds — actual delay = base * 2^(attempt-1) */
export const BLAST_RETRY_BACKOFF_BASE_MS = 30_000

// ---------------------------------------------------------------------------
// Hono typed context
// ---------------------------------------------------------------------------

export type AppEnv = {
  Bindings: Env
  Variables: {
    pubkey: string
    user: User
    /** Effective permissions resolved from all roles */
    permissions: string[]
    /** All role definitions (loaded once per request) */
    allRoles: import('@shared/permissions').Role[]
    /** Current hub ID (set by hub middleware for hub-scoped routes) */
    hubId?: string
    /** Hub-scoped permissions (resolved for the current hub) */
    hubPermissions?: string[]
    /** Unique request ID for correlation (set by request-id middleware) */
    requestId: string
    /** Current session token (set by auth middleware for session-based auth) */
    sessionToken?: string
    /** Service registry — replaces DO stubs */
    services: import('../services').Services
  }
}
