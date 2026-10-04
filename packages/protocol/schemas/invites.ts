import { z } from 'zod'
import { pubkeySchema } from './common'

// --- Response schemas ---

export const inviteResponseSchema = z.object({
  code: z.uuid(),
  name: z.string(),
  phone: z.string(),
  roleIds: z.array(z.string()),
  /**
   * The hub the invite admits the redeemer into. Redemption writes a
   * `hubRoles` entry for it, which is what makes the redeemed volunteer
   * visible to the operator and selectable in the shift and ring-group
   * pickers (#1037). Null only on invites created before invites were
   * hub-scoped.
   */
  hubId: z.string().nullable().optional(),
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
})

export const createInviteBodySchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(20),
  /**
   * Roles the redeemer receives, both globally and in the invite's hub.
   * Omitted or empty means "whatever the hub's template designates for a new
   * member" — see `resolveTemplateDefaultMemberRoles`. A template that names
   * none grants none, which is deliberate: the operator then assigns a role
   * explicitly rather than a new member silently acquiring one (#1446).
   */
  roleIds: z.array(z.string()).optional().default([]),
  /**
   * The hub to admit the redeemer into. Omitted means the server resolves it:
   * the sole active hub, else the creator's sole hub membership, else 400.
   */
  hubId: z.string().min(1).optional(),
})

/**
 * The request body as a CLIENT writes it — `z.input`, so the fields the schema
 * defaults (`roleIds`) stay optional. Clients import this rather than
 * hand-writing the shape, which is how client and server drift apart.
 */
export type CreateInviteBody = z.input<typeof createInviteBodySchema>
