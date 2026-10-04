import { z } from 'zod'

// Hex-encoded Ed25519 public key (32 bytes = 64 hex chars)
const ed25519PubkeySchema = z.string().regex(/^[0-9a-f]{64}$/i, 'Must be 32-byte Ed25519 public key in hex')

// Hex-encoded X25519 public key (32 bytes = 64 hex chars)
const x25519PubkeySchema = z.string().regex(/^[0-9a-f]{64}$/i, 'Must be 32-byte X25519 public key in hex')

// --- Input schemas ---

export const registerDeviceBodySchema = z
  .object({
    // #1548 groundwork: desktop devices register to publish their X25519 identity
    // key; they have no push channel, so pushToken/wakeKeyPublic are desktop-only-optional.
    platform: z.enum(['ios', 'android', 'desktop']),
    pushToken: z.string().min(1, 'pushToken is required').optional(),
    wakeKeyPublic: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'Must be 32-byte X25519 public key in hex')
      .optional(),
    ed25519Pubkey: ed25519PubkeySchema.optional(),
    x25519Pubkey: x25519PubkeySchema.optional(),
    deviceName: z.string().max(100).optional(),
    deviceModel: z.string().max(100).optional(),
    osVersion: z.string().max(50).optional(),
    appVersion: z.string().max(50).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.platform === 'desktop') {
      // The whole point of a desktop registration is uploading its X25519 key —
      // a desktop row without it is useless to E2EE message fan-out.
      if (!val.x25519Pubkey) {
        ctx.addIssue({
          code: 'custom',
          path: ['x25519Pubkey'],
          message: 'x25519Pubkey is required for desktop registrations',
        })
      }
      return
    }
    // Mobile behavior unchanged: push token and wake key are mandatory.
    if (!val.pushToken) {
      ctx.addIssue({
        code: 'custom',
        path: ['pushToken'],
        message: 'pushToken is required',
      })
    }
    if (!val.wakeKeyPublic) {
      ctx.addIssue({
        code: 'custom',
        path: ['wakeKeyPublic'],
        message: 'wakeKeyPublic is required',
      })
    }
  })

export const voipTokenBodySchema = z.object({
  platform: z.enum(['ios', 'android']),
  voipToken: z.string().min(1, 'voipToken is required'),
})

export const clearPushTokenBodySchema = z.object({
  pushToken: z.string().min(1, 'pushToken is required'),
})

export const renameDeviceBodySchema = z.object({
  deviceName: z.string().min(1).max(100),
})

export const revokeDeviceBodySchema = z.object({
  confirm: z.boolean(),
  signature: z.string().regex(/^[0-9a-f]{128}$/i).optional(),
  sigchainHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  sigchainSeqNo: z.number().int().nonnegative().optional(),
  sigchainPrevHash: z.string().regex(/^([0-9a-f]{64}|)$/i).optional(),
})

export const verifyDeviceBodySchema = z.object({
  signedAuditEntry: z.string().min(1),
})

// --- Response schemas ---

export const deviceResponseSchema = z.object({
  id: z.string(),
  platform: z.string(),
  wakeKeyPublic: z.string().nullable(),
  ed25519Pubkey: z.string().nullable(),
  x25519Pubkey: z.string().nullable(),
  registeredAt: z.string(),
  lastSeenAt: z.string().nullable(),
})

export const deviceListResponseSchema = z.object({
  devices: z.array(deviceResponseSchema),
})

export const deviceDetailResponseSchema = z.object({
  id: z.string(),
  platform: z.string(),
  deviceName: z.string().nullable(),
  deviceModel: z.string().nullable(),
  osVersion: z.string().nullable(),
  appVersion: z.string().nullable(),
  ed25519Pubkey: z.string().nullable(),
  x25519Pubkey: z.string().nullable(),
  registeredAt: z.string(),
  lastSeenAt: z.string().nullable(),
  lastIpHash: z.string().nullable(),
  isCurrent: z.boolean(),
})

export const deviceDetailListResponseSchema = z.object({
  devices: z.array(deviceDetailResponseSchema),
})

export const renameDeviceResponseSchema = z.object({
  id: z.string(),
  deviceName: z.string(),
})

export const revokeDeviceResponseSchema = z.object({
  revoked: z.boolean(),
  deviceId: z.string(),
  hubIdsRequiringKeyRotation: z.array(z.string()),
  pukRotationNeeded: z.boolean().optional(),
})

export const verifyDeviceResponseSchema = z.object({
  verified: z.boolean(),
  verificationId: z.string(),
})

export const securityEventTypeSchema = z.enum([
  'device_register',
  'device_remove',
  'device_rename',
  'session_create',
  'session_terminate',
  'session_terminate_all',
  'account_lockdown',
  'account_lockdown_complete',
  'webauthn_register',
  'webauthn_authenticate',
  'webauthn_remove',
  'sigchain_append',
  'puk_rotate',
  'hub_key_rotate',
  'device_fingerprint_verified',
  'passkey_rename',
  'login_failed',
])

export const securityEventSchema = z.object({
  id: z.string(),
  eventType: securityEventTypeSchema,
  deviceId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  ipHash: z.string().nullable(),
  createdAt: z.string(),
})

export const securityEventListResponseSchema = z.object({
  events: z.array(securityEventSchema),
  total: z.number(),
})

export const sessionResponseSchema = z.object({
  id: z.string(),
  deviceId: z.string().nullable(),
  platform: z.string().nullable(),
  userAgent: z.string().nullable(),
  ipHash: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  isCurrent: z.boolean(),
})

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionResponseSchema),
})

export const terminateSessionsResponseSchema = z.object({
  terminated: z.number(),
})

export const lockdownResponseSchema = z.object({
  sessionsTerminated: z.number(),
  hubIds: z.array(z.string()),
})

export const lockdownCompleteBodySchema = z.object({
  pukRotated: z.boolean(),
  hubKeysRotated: z.array(z.string()),
  hubKeysFailed: z.array(z.string()).optional().default([]),
})

export const adminDeviceOverviewEntrySchema = z.object({
  userPubkey: z.string(),
  displayName: z.string().nullable(),
  deviceCount: z.number(),
  lastSeenAt: z.string().nullable(),
  verified: z.boolean(),
  devices: z.array(deviceDetailResponseSchema),
})

export const adminDeviceOverviewResponseSchema = z.object({
  entries: z.array(adminDeviceOverviewEntrySchema),
  total: z.number(),
})

export const listSecurityEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

export const adminDeviceOverviewQuerySchema = z.object({
  hubId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})
