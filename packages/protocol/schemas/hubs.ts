import { z } from 'zod'
import { pubkeySchema, recipientEnvelopeSchema } from './common'

// --- Response schemas ---

export const hubResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  phoneNumber: z.string().optional(),
  status: z.enum(['active', 'suspended', 'archived']),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Hub = z.infer<typeof hubResponseSchema>

export const hubMemberResponseSchema = z.object({
  pubkey: pubkeySchema,
  name: z.string(),
  roles: z.array(z.string()),
  joinedAt: z.string().optional(),
})

// --- List/wrapper response schemas ---

export const hubListResponseSchema = z.object({
  hubs: z.array(hubResponseSchema),
})

export const hubDetailResponseSchema = z.object({
  hub: hubResponseSchema,
})

export const hubKeyEnvelopeResponseSchema = z.object({
  envelope: recipientEnvelopeSchema,
})

// --- Input schemas ---

export const createHubBodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  description: z.string().max(500).optional(),
  phoneNumber: z.string().max(20).optional(),
})

export const updateHubBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  description: z.string().max(500).optional(),
  phoneNumber: z.string().max(20).optional(),
  status: z.enum(['active', 'archived']).optional(),
})

export const addHubMemberBodySchema = z.object({
  pubkey: pubkeySchema,
  roleIds: z.array(z.string()).min(1, 'At least one role required'),
})

export const hubKeyEnvelopesBodySchema = z.object({
  envelopes: z.array(z.object({
    pubkey: pubkeySchema,
    enc: z.string().min(1),
    ct: z.string().min(1),
  })).min(1, 'At least one envelope required'),
})

// --- Reader sets (PROTOCOL §2.4.2; operator decisions D1, D2, A7) ---

/**
 * Why a client is sealing, mapped server-side to a fixed set of permissions
 * (`READER_PURPOSE_PERMISSIONS` in packages/shared/permissions.ts). A closed
 * enum, never a free permission string: the client names a purpose, and the
 * server alone decides which permissions make someone a reader of it.
 *
 * - `admin`: holders, in the hub, of the admin minimum (D1).
 * - `call-history`: holders, in the hub, of `calls:read-history` (D2).
 */
export const readerPurposeSchema = z.enum(['admin', 'call-history'])

export type ReaderPurpose = z.infer<typeof readerPurposeSchema>

/** `GET /api/hubs/:hubId/readers?purpose=` query. */
export const hubReadersQuerySchema = z.object({
  purpose: readerPurposeSchema,
})

/**
 * The hub's reader set for one purpose: every X25519 recipient key a client
 * must seal that purpose's content to. Device keys of every holder of the
 * purpose's permissions in this hub (from the hub's own role assignments only;
 * a global super-admin is never a member of it), plus the hub's escrow key
 * when one is set. Never an Ed25519 identity key.
 */
export const hubReadersResponseSchema = z.object({
  hubId: z.string(),
  purpose: readerPurposeSchema,
  recipients: z.array(pubkeySchema),
})

/**
 * The hub's optional escrow (recovery) key: an X25519 public key whose secret
 * the hub's admins hold offline. A member of every purpose's reader set (A7).
 * Absent when the hub has none.
 */
export const hubEscrowKeyResponseSchema = z.object({
  escrowPubkey: pubkeySchema.optional(),
})

/** `PUT /api/hubs/:hubId/escrow-key` body: install or rotate the escrow key. */
export const setHubEscrowKeyBodySchema = z.object({
  escrowPubkey: pubkeySchema,
})
