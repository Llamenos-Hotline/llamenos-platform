import { z } from 'zod'
import { pubkeySchema } from './common'

// --- Response schemas ---

export const loginResponseSchema = z.object({
  ok: z.boolean(),
  roles: z.array(z.string()),
})

export const meResponseSchema = z.object({
  pubkey: pubkeySchema,
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  primaryRole: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  name: z.string(),
  transcriptionEnabled: z.boolean(),
  spokenLanguages: z.array(z.string()),
  uiLanguage: z.string(),
  profileCompleted: z.boolean(),
  onBreak: z.boolean(),
  callPreference: z.string(),
  webauthnRequired: z.boolean(),
  webauthnRegistered: z.boolean(),
  adminDecryptionPubkey: z.string().optional(),
  hubEventKeys: z.record(z.string(), z.string()).optional(),
  serverEventKeyHex: z.string().optional(),
  serverEventKeyPrevHex: z.string().optional(),
  eventKeyEpoch: z.number().optional(),
  eventKeyEpochDuration: z.number().optional(),
})

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

export const availabilityBodySchema = z.object({
  onBreak: z.boolean(),
})

export const transcriptionToggleBodySchema = z.object({
  enabled: z.boolean(),
})
