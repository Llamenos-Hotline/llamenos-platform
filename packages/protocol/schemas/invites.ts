import { z } from 'zod'
import { pubkeySchema } from './common'

// --- Response schemas ---

export const inviteResponseSchema = z.object({
  code: z.uuid(),
  name: z.string(),
  phone: z.string(),
  roleIds: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  usedAt: z.string().nullable().optional(),
  usedBy: z.string().nullable().optional(),
})

export type InviteCode = z.infer<typeof inviteResponseSchema>

export const inviteValidationResponseSchema = z.object({
  valid: z.boolean(),
  error: z.enum(['not_found', 'already_used', 'expired']).optional(),
  name: z.string().optional(),
  roleIds: z.array(z.string()).optional(),
})

// --- List/wrapper response schemas ---

export const inviteListResponseSchema = z.object({
  invites: z.array(inviteResponseSchema),
})

// --- Input schemas ---

export const redeemInviteBodySchema = z.object({
  code: z.uuid(),
  pubkey: pubkeySchema,
  timestamp: z.number(),
  token: z.string().min(1),
  /** Random nonce the client signed into the auth message (Rust `create_auth_token` always signs one). */
  nonce: z.string().optional(),
})

export const createInviteBodySchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(20),
  roleIds: z.array(z.string()).min(1),
})
