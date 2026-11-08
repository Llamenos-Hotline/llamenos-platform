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
   * pickers (#1037). Null only on invites minted before every invite had to
   * name a hub (#2194); redemption refuses those.
   */
  hubId: z.string().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  usedAt: z.string().nullable().optional(),
  usedBy: z.string().nullable().optional(),
})

export type InviteCode = z.infer<typeof inviteResponseSchema>

/** `POST /invites` answers with the invite it minted, wrapped — every client reads `invite`. */
export const createInviteResponseSchema = z.object({
  invite: inviteResponseSchema,
})

export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>

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
  /**
   * Roles the redeemer receives in the invite's hub. Omitted or empty means
   * "whatever the hub's template designates for a new member" — see
   * `resolveTemplateDefaultMemberRoles`. When the template names none either,
   * the invite is refused (400): an invite names the role it grants (#2194),
   * and a member silently acquiring one is what #1446 forbids.
   */
  roleIds: z.array(z.string()).optional().default([]),
  /**
   * The hub to admit the redeemer into. Omitted means the server resolves it:
   * the sole active hub, else the creator's sole hub membership, else 400.
   * A server with no hub at all refuses every invite (409, #2194).
   */
  hubId: z.string().min(1).optional(),
})

/**
 * The request body as a CLIENT writes it — `z.input`, so the fields the schema
 * defaults (`roleIds`) stay optional. Clients import this rather than
 * hand-writing the shape, which is how client and server drift apart.
 */
export type CreateInviteBody = z.input<typeof createInviteBodySchema>
