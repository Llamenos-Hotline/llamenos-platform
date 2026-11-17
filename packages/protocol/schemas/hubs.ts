import { z } from 'zod'
import { DEFAULT_HUB_TIMEZONE, ianaTimezoneSchema, pubkeySchema, recipientEnvelopeSchema } from './common'

// --- Response schemas ---

export const hubResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  phoneNumber: z.string().optional(),
  /**
   * IANA zone the hub's shift schedules are written in. A shift's `startTime`,
   * `endTime` and `days` are wall-clock values in THIS zone, and the roster is
   * evaluated in it (DST included). Every hub has one; a hub that never chose is `UTC`.
   */
  timezone: ianaTimezoneSchema,
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

/** One hub-sealed value — `hex(nonce ‖ ct ‖ tag)` under the hub key (PROTOCOL.md §2.7). */
const hubSealedFieldSchema = z.string().min(1).max(65536)

/** A tag's sealed columns. */
export const hubSealedTagSchema = z.object({
  id: z.string().min(1),
  encryptedLabel: hubSealedFieldSchema,
  encryptedCategory: hubSealedFieldSchema.nullable(),
})

/** A team's sealed columns. */
export const hubSealedTeamSchema = z.object({
  id: z.string().min(1),
  encryptedName: hubSealedFieldSchema,
  encryptedDescription: hubSealedFieldSchema.nullable(),
})

/** A hub role's sealed columns (#2780). */
export const hubSealedRoleSchema = z.object({
  id: z.string().min(1),
  encryptedName: hubSealedFieldSchema,
  encryptedDescription: hubSealedFieldSchema.nullable(),
})

/** Every value a hub holds sealed under its key, by table. */
export const hubSealedValuesSchema = z.object({
  tags: z.array(hubSealedTagSchema),
  teams: z.array(hubSealedTeamSchema),
  roles: z.array(hubSealedRoleSchema),
})

export type HubSealedValues = z.infer<typeof hubSealedValuesSchema>

/**
 * `GET /api/hubs/:hubId/key/recipients` — what a key holder needs to distribute
 * the hub key (PROTOCOL.md §2.7), read in one snapshot:
 *
 * - `generation`: the envelope set's version (`hubs.hub_key_generation`). A
 *   `PUT /key` must name it as `expectedGeneration`.
 * - `envelopes`: every wrap the hub holds, for current members. A distributor
 *   re-sends them unchanged and adds wraps only for members who lack one, so
 *   distributing never replaces anyone's access. The caller's own is among them,
 *   which is how it confirms the key it holds is the hub's current one. Empty
 *   means no member holds the key — the one state in which a manager may
 *   generate a new key without taking anyone's access away.
 * - `members`: every member, with the X25519 device key to wrap for (null until
 *   they register one).
 */
export const hubKeyRecipientsResponseSchema = z.object({
  generation: z.number().int().min(0),
  envelopes: z.array(recipientEnvelopeSchema),
  members: z.array(z.object({
    /** The member's Ed25519 user pubkey — the `pubkey` of their envelope. */
    pubkey: pubkeySchema,
    /** The X25519 key of the member's device to wrap for; null until they register one. */
    encryptionPubkey: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })),
  /** Which key the wraps hold (`hubs.hub_key_epoch`): 0 for the first key, +1 per rotation. */
  epoch: z.number().int().min(0),
  /**
   * True when someone who held the current key has since left — departed the
   * hub, was erased, deactivated, or lost their signing key. The key must be
   * rotated (`POST /key/rotate`) before anything else is sealed under it.
   */
  rotationRequired: z.boolean(),
  /**
   * Present exactly when `rotationRequired`: every value the hub holds sealed
   * under its key, which a rotation must re-seal under the new one (the
   * rotation is refused unless it re-seals all of them, unchanged since this
   * read).
   */
  sealed: hubSealedValuesSchema.optional(),
})

/**
 * `GET /api/hubs/:hubId/key/rotation` (any member) — the key epoch and the
 * statement that introduced it. A device holding the previous epoch's key opens
 * `rotation` with that key (`LABEL_HUB_KEY_ROTATION`) before it adopts the new
 * one; the server cannot write a statement that opens, because it has never
 * held a hub key.
 */
export const hubKeyRotationResponseSchema = z.object({
  epoch: z.number().int().min(0),
  rotation: z.string().nullable(),
})

export type HubKeyRotationResponse = z.infer<typeof hubKeyRotationResponseSchema>

/** `PUT /api/hubs/:hubId/key` response: the envelope set's new generation. */
export const hubKeySetResponseSchema = z.object({
  ok: z.boolean(),
  generation: z.number().int().min(1),
})

export type HubKeyEnvelopeResponse = z.infer<typeof hubKeyEnvelopeResponseSchema>
export type HubKeyRecipientsResponse = z.infer<typeof hubKeyRecipientsResponseSchema>
export type HubKeySetResponse = z.infer<typeof hubKeySetResponseSchema>

// --- Input schemas ---

export const createHubBodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  description: z.string().max(500).optional(),
  phoneNumber: z.string().max(20).optional(),
  /** Defaults from the creating admin's device on the client; `UTC` when a client sends none. */
  timezone: ianaTimezoneSchema.optional().default(DEFAULT_HUB_TIMEZONE),
})

/**
 * PATCH body. Declared field by field and deliberately carrying NO `.default()`:
 * a default here would materialise on every request that omits the key, and a
 * PATCH omitting `timezone` would silently reset the hub to UTC — moving its
 * whole shift roster by hours (#1643's failure class). Never derive this from
 * `createHubBodySchema.partial()`; `.partial()` keeps the inner default.
 */
export const updateHubBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  description: z.string().max(500).optional(),
  phoneNumber: z.string().max(20).optional(),
  timezone: ianaTimezoneSchema.optional(),
  status: z.enum(['active', 'archived']).optional(),
})

export const addHubMemberBodySchema = z.object({
  pubkey: pubkeySchema,
  roleIds: z.array(z.string()).min(1, 'At least one role required'),
})

/**
 * Replace a hub's key envelopes. `expectedGeneration` is required: it is the
 * generation the writer read (from `GET /key/recipients`), and the write is
 * refused with 409 if the set moved on since — another manager installed a key
 * or re-wrapped, or the hub was shredded. Without it two managers generating a
 * first key at once would each install their own, and the loser's members
 * would be left holding a key nothing else is sealed under.
 */
export const hubKeyEnvelopesBodySchema = z.object({
  envelopes: z.array(z.object({
    pubkey: pubkeySchema,
    enc: z.string().min(1),
    ct: z.string().min(1),
  })).min(1, 'At least one envelope required'),
  expectedGeneration: z.number().int().min(0),
})

export type HubKeyEnvelopesBody = z.infer<typeof hubKeyEnvelopesBodySchema>

/**
 * `POST /api/hubs/:hubId/key/rotate` — replace the hub's key with a fresh one
 * (PROTOCOL.md §2.7 "Key Rotation"). Atomic with:
 *
 * - `envelopes`: a wrap of the NEW key for exactly the hub's current members
 *   that have a device key — no one else (a departed member is refused), and
 *   no one missing (so no admin's access is dropped).
 * - `rotation`: the statement sealed under the OLD key that lets members'
 *   devices accept the new one (see `hubKeyRotationResponseSchema`).
 * - `resealed`: for every value the hub holds sealed under its key, the value
 *   `from` the recipients read and the same plaintext sealed under the new key
 *   `to`. The server refuses the rotation if any value is missing or changed
 *   since — otherwise it would be left sealed under a key nobody holds any more.
 */
export const hubKeyRotateBodySchema = z.object({
  expectedGeneration: z.number().int().min(0),
  envelopes: hubKeyEnvelopesBodySchema.shape.envelopes,
  rotation: z.string().min(1).max(8192),
  resealed: z.object({
    tags: z.array(z.object({ from: hubSealedTagSchema, to: hubSealedTagSchema })),
    teams: z.array(z.object({ from: hubSealedTeamSchema, to: hubSealedTeamSchema })),
    roles: z.array(z.object({ from: hubSealedRoleSchema, to: hubSealedRoleSchema })),
  }),
})

export type HubKeyRotateBody = z.infer<typeof hubKeyRotateBodySchema>

/** `POST /api/hubs/:hubId/key/rotate` response. */
export const hubKeyRotateResponseSchema = z.object({
  generation: z.number().int().min(1),
  epoch: z.number().int().min(1),
})

export type HubKeyRotateResponse = z.infer<typeof hubKeyRotateResponseSchema>

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

/**
 * Purposes whose reader is the record's own SUBJECT (PROTOCOL §2.4.2, "Subject
 * readers"), mapped to permissions in `SUBJECT_READER_PURPOSE_PERMISSIONS`
 * (packages/shared/permissions.ts). Server-internal: never accepted by
 * `GET /hubs/:hubId/readers`, whose answer is every holder — for these purposes
 * that would be every member's device, not the one subject's.
 *
 * - `call-history-own`: the volunteer who answered a call, when they hold
 *   `calls:read-own-history` in the call's hub (#1342, D3).
 */
export const subjectReaderPurposeSchema = z.enum(['call-history-own'])

export type SubjectReaderPurpose = z.infer<typeof subjectReaderPurposeSchema>

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
