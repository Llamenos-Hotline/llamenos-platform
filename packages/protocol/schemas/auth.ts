import { z } from 'zod'
import { hexBytes, pubkeySchema } from './common'

// --- Response schemas ---

export const loginResponseSchema = z.object({
  ok: z.boolean(),
  roles: z.array(z.string()),
})
export type LoginResponse = z.infer<typeof loginResponseSchema>

/**
 * One relay-event key (spec D9, #2999): it opens the frames of `hubId` for one
 * epoch (UTC day). A member is handed keys only for hubs it belongs to.
 */
export const relayEventKeySchema = z.object({
  hubId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  keyHex: hexBytes(32),
})
export type RelayEventKey = z.infer<typeof relayEventKeySchema>

export const meResponseSchema = z.object({
  pubkey: pubkeySchema,
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  // `name` is null for every custom role: its name is sealed (`encryptedName`) and
  // the server holds no plaintext — same as `roleResponseSchema.name` (#2710).
  primaryRole: z.object({ id: z.string(), name: z.string().nullable(), slug: z.string() }).nullable(),
  name: z.string(),
  transcriptionEnabled: z.boolean(),
  spokenLanguages: z.array(z.string()),
  uiLanguage: z.string(),
  profileCompleted: z.boolean(),
  onBreak: z.boolean(),
  callPreference: z.enum(['phone', 'browser', 'both']),
  webauthnRequired: z.boolean(),
  webauthnRegistered: z.boolean(),
  adminDecryptionPubkey: z.string().optional(),
  /** Current and previous epoch keys for every active hub the user belongs to. */
  serverEventKeys: z.array(relayEventKeySchema),
  /** The current epoch. */
  eventKeyEpoch: z.number().int().nonnegative(),
  /** Seconds per epoch. */
  eventKeyEpochDuration: z.number().int().positive(),
})
export type MeResponse = z.infer<typeof meResponseSchema>

// --- Input schemas ---

export const loginBodySchema = z.object({
  pubkey: pubkeySchema,
  timestamp: z.number(),
  token: z.string().min(1),
  nonce: z.string().optional(),
})

export const bootstrapBodySchema = z.object({
  pubkey: pubkeySchema,
  timestamp: z.number(),
  token: z.string().min(1),
  nonce: z.string().optional(),
})

export const profileUpdateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().max(20).optional(),
  spokenLanguages: z.array(z.string().max(5)).optional(),
  uiLanguage: z.string().max(5).optional(),
  profileCompleted: z.boolean().optional(),
  callPreference: z.enum(['phone', 'browser', 'both']).optional(),
  specializations: z.array(z.string().max(100)).optional(), // Epic 340
})
export type ProfileUpdateBody = z.input<typeof profileUpdateBodySchema>

export const availabilityBodySchema = z.object({
  onBreak: z.boolean(),
})

export const transcriptionToggleBodySchema = z.object({
  enabled: z.boolean(),
})
