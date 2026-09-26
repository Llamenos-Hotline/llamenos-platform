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

/**
 * Generation of a hub key. Starts at 1 for the first key and only ever moves
 * forward (by exactly one per rotation). The server stores the current
 * generation and refuses any envelope write made against another one — this
 * is the authoritative ordering of key sets, independent of client session
 * timing.
 */
const hubKeyGenerationSchema = z.number().int().min(1)

/** One member's HPKE-wrapped copy of the hub key (LABEL_HUB_KEY_WRAP). */
const hubKeyEnvelopeListSchema = z.array(z.object({
  pubkey: pubkeySchema,
  enc: z.string().min(1),
  ct: z.string().min(1),
})).min(1, 'At least one envelope required')

export const hubKeyEnvelopeResponseSchema = z.object({
  envelope: recipientEnvelopeSchema,
  /** Generation of the key this envelope wraps. */
  generation: hubKeyGenerationSchema,
})

export const rotateHubKeyResponseSchema = z.object({
  /** The generation the hub key now has. */
  generation: hubKeyGenerationSchema,
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

/**
 * Store the envelope set of a hub key (`PUT /hubs/:id/key`), replacing the
 * previous set of that same key.
 *
 * `expectedGeneration` is the hub's current key generation as the writer
 * knows it, and the server refuses (409) the write unless it still is:
 * - `0` — the hub has no key yet; the envelopes wrap its first key, which
 *   becomes generation 1. Refused once the hub has a key, so a second "first
 *   key" can never replace the one data is already sealed under.
 * - `n ≥ 1` — re-distribution of the CURRENT key (generation n) to the current
 *   member set. Refused after a rotation, so a stale key set can never replace
 *   a newer one.
 *
 * A new key for a hub that already has one goes through rotation
 * (`rotateHubKeyBodySchema`), never through this body.
 */
export const hubKeyEnvelopesBodySchema = z.object({
  expectedGeneration: z.number().int().min(0),
  envelopes: hubKeyEnvelopeListSchema,
})

/**
 * Rotate a hub key (`POST /hubs/:id/key/rotate`) — one atomic commit.
 *
 * Carries the envelopes of the NEW key for the remaining members and every
 * hub-key-encrypted record of the hub re-encrypted under that key. The server
 * applies all of it in a single transaction, and only when `fromGeneration`
 * is still the current generation and the record lists cover exactly the
 * hub's tags and teams. Anything else changes nothing, so an interrupted or
 * refused rotation always leaves the hub readable under the old key.
 */
export const rotateHubKeyBodySchema = z.object({
  fromGeneration: hubKeyGenerationSchema,
  envelopes: hubKeyEnvelopeListSchema,
  tags: z.array(z.object({
    id: z.string().min(1),
    encryptedLabel: z.string().min(1),
    encryptedCategory: z.string().min(1).nullable(),
  })),
  teams: z.array(z.object({
    id: z.string().min(1),
    encryptedName: z.string().min(1),
    encryptedDescription: z.string().min(1).nullable(),
  })),
})
