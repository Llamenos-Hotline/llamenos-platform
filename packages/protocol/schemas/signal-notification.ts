import { z } from 'zod'

// ---------------------------------------------------------------------------
// Security preferences — per-user alert settings
// ---------------------------------------------------------------------------

export const digestCadenceSchema = z.enum(['off', 'daily', 'weekly'])
export type DigestCadence = z.infer<typeof digestCadenceSchema>

export const notificationChannelSchema = z.enum(['web_push', 'signal'])
export type NotificationChannel = z.infer<typeof notificationChannelSchema>

export const securityPrefsSchema = z.object({
  userPubkey: z.string(),
  notificationChannel: notificationChannelSchema,
  disappearingTimerDays: z.number().int().min(0).max(365),
  digestCadence: digestCadenceSchema,
  alertOnNewDevice: z.boolean(),
  alertOnPasskeyChange: z.boolean(),
  alertOnPinChange: z.boolean(),
  updatedAt: z.string().optional(),
})

export type SecurityPrefs = z.infer<typeof securityPrefsSchema>

export const securityPrefsPatchSchema = z.object({
  notificationChannel: notificationChannelSchema.optional(),
  disappearingTimerDays: z.number().int().min(0).max(365).optional(),
  digestCadence: digestCadenceSchema.optional(),
  alertOnNewDevice: z.boolean().optional(),
  alertOnPasskeyChange: z.boolean().optional(),
  alertOnPinChange: z.boolean().optional(),
})

export type SecurityPrefsPatch = z.infer<typeof securityPrefsPatchSchema>

// ---------------------------------------------------------------------------
// Signal contact registration — sent from the desktop client
// ---------------------------------------------------------------------------

export const signalContactRegistrationSchema = z.object({
  /** HMAC hash of the normalized Signal identifier (phone/username) */
  identifierHash: z.string().min(64).max(64),
  /** Encrypted Signal identifier (ECIES envelope, hex) */
  identifierCiphertext: z.string().min(1),
  /** Per-reader key envelopes wrapping the symmetric key */
  identifierEnvelope: z.array(
    z.object({
      recipientPubkey: z.string(),
      encryptedKey: z.string(),
    })
  ),
  /** Whether the identifier is a phone number (+E.164) or Signal username */
  identifierType: z.enum(['phone', 'username']),
})

export type SignalContactRegistration = z.infer<typeof signalContactRegistrationSchema>

// ---------------------------------------------------------------------------
// Notification payload — app server → signal-notifier sidecar
// ---------------------------------------------------------------------------

export const notificationPayloadSchema = z.object({
  identifierHash: z.string().min(64).max(64),
  message: z.string().min(1).max(2000),
  disappearingTimerSeconds: z.number().int().min(0).optional(),
})

export type NotificationPayload = z.infer<typeof notificationPayloadSchema>

// ---------------------------------------------------------------------------
// Sidecar registration payload — app server → signal-notifier /register
// ---------------------------------------------------------------------------

export const notifierRegisterPayloadSchema = z.object({
  identifierHash: z.string().min(64).max(64),
  plaintextIdentifier: z.string().min(1),
  identifierType: z.enum(['phone', 'username']),
})

export type NotifierRegisterPayload = z.infer<typeof notifierRegisterPayloadSchema>

// ---------------------------------------------------------------------------
// HMAC key response — returned to the client so it can hash locally before sending
// ---------------------------------------------------------------------------

export const hmacKeyResponseSchema = z.object({
  hmacKey: z.string().min(1),
})

export type HmacKeyResponse = z.infer<typeof hmacKeyResponseSchema>

// ---------------------------------------------------------------------------
// Signal identity record — returned by GET /messaging/signal/identities
// ---------------------------------------------------------------------------

export const signalTrustLevelSchema = z.enum(['UNTRUSTED', 'TRUSTED_UNVERIFIED', 'TRUSTED_VERIFIED'])
export type SignalTrustLevel = z.infer<typeof signalTrustLevelSchema>

export const signalIdentityRecordSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  number: z.string(),
  uuid: z.string(),
  fingerprint: z.string(),
  trustLevel: signalTrustLevelSchema,
  verifiedBy: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  keyChangeCount: z.number(),
})

export type SignalIdentityRecord = z.infer<typeof signalIdentityRecordSchema>

// ---------------------------------------------------------------------------
// Signal queue stats — returned by GET /messaging/signal/queue/stats
// ---------------------------------------------------------------------------

export const signalQueueStatsSchema = z.object({
  pending: z.number(),
  processing: z.number(),
  failed: z.number(),
  dead: z.number(),
  sent: z.number(),
})

export type SignalQueueStats = z.infer<typeof signalQueueStatsSchema>

// ---------------------------------------------------------------------------
// Signal contact record — returned by GET /signal-notification/contact
// ---------------------------------------------------------------------------

export const signalContactRecordSchema = z.object({
  identifierHash: z.string(),
  identifierCiphertext: z.string(),
  identifierEnvelope: z.array(
    z.object({
      recipientPubkey: z.string(),
      encryptedKey: z.string(),
    })
  ),
  identifierType: z.enum(['phone', 'username']),
  verifiedAt: z.string().nullable(),
  updatedAt: z.string(),
})

export type SignalContactRecord = z.infer<typeof signalContactRecordSchema>

// ---------------------------------------------------------------------------
// Sidecar registration token response — returned by POST /contact/sidecar-token
// ---------------------------------------------------------------------------

export const sidecarTokenResponseSchema = z.object({
  token: z.string(),
  sidecarUrl: z.string(),
})

export type SidecarTokenResponse = z.infer<typeof sidecarTokenResponseSchema>

// ---------------------------------------------------------------------------
// Digest run request body — POST /signal-notification/digest/run (admin)
// ---------------------------------------------------------------------------

export const digestRunBodySchema = z.object({
  cadence: z.enum(['daily', 'weekly']).optional(),
})

// ---------------------------------------------------------------------------
// Digest run response — returned by POST /digest/run
// ---------------------------------------------------------------------------

export const digestRunResponseSchema = z.object({
  sent: z.number(),
  skipped: z.number(),
  errors: z.number(),
})

export type DigestRunResponse = z.infer<typeof digestRunResponseSchema>

// ---------------------------------------------------------------------------
// Security prefs response — subset for API responses (includes updatedAt as string)
// ---------------------------------------------------------------------------

export const securityPrefsResponseSchema = z.object({
  notificationChannel: notificationChannelSchema,
  disappearingTimerDays: z.number().int(),
  digestCadence: digestCadenceSchema,
  alertOnNewDevice: z.boolean(),
  alertOnPasskeyChange: z.boolean(),
  alertOnPinChange: z.boolean(),
  updatedAt: z.string(),
})
export type SecurityPrefsResponse = z.infer<typeof securityPrefsResponseSchema>
