import { z } from 'zod'
import { hubChainLinkSchema } from './hub-chain'
import { DEFAULT_HUB_TIMEZONE, ianaTimezoneSchema, pubkeySchema, recipientEnvelopeSchema } from './common'

// --- Response schemas ---

export const hubResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  /**
   * The hub's primary hotline number (E.164): the first of `phoneNumbers`.
   * Kept for clients that show a single number.
   */
  phoneNumber: z.string().optional(),
  /**
   * Every number the hub answers on (E.164), primary first — the one set inbound
   * routing resolves a call's hub from (`hub_numbers`, #1331). Empty when the
   * hub answers no calls.
   */
  phoneNumbers: z.array(z.string()).optional(),
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

/**
 * The caller's own permissions IN one hub — what the server authorises with
 * inside it (`hubContext`: that hub's role assignment, plus a super-admin's
 * globals). `/auth/me` carries only the account-wide union, which describes no
 * single hub; this is the per-hub answer a client gates its UI on (#1101).
 */
export const hubPermissionsResponseSchema = z.object({
  hubId: z.string(),
  permissions: z.array(z.string()),
})

export const hubKeyEnvelopeResponseSchema = z.object({
  envelope: recipientEnvelopeSchema,
})

/** One hub-sealed value — `hex(nonce ‖ ct ‖ tag)` under the hub key (PROTOCOL.md §2.7). */
const hubSealedFieldSchema = z.string().min(1).max(65536)
/** A hub-sealed column that may be empty (a tag with no category, a team or role with no description). */
const hubSealedNullableFieldSchema = hubSealedFieldSchema.nullable()

/** A tag's sealed columns. */
export const hubSealedTagSchema = z.object({
  id: z.string().min(1),
  encryptedLabel: hubSealedFieldSchema,
  encryptedCategory: hubSealedNullableFieldSchema,
})

/** A team's sealed columns. */
export const hubSealedTeamSchema = z.object({
  id: z.string().min(1),
  encryptedName: hubSealedFieldSchema,
  encryptedDescription: hubSealedNullableFieldSchema,
})

/** A hub role's sealed columns (#2780). */
export const hubSealedRoleSchema = z.object({
  id: z.string().min(1),
  encryptedName: hubSealedFieldSchema,
  encryptedDescription: hubSealedNullableFieldSchema,
})

/** Every value a hub holds sealed under its key, by table. */
export const hubSealedValuesSchema = z.object({
  tags: z.array(hubSealedTagSchema),
  teams: z.array(hubSealedTeamSchema),
  roles: z.array(hubSealedRoleSchema),
})

export type HubSealedValues = z.infer<typeof hubSealedValuesSchema>

/**
 * The statement a rotation leaves behind (PROTOCOL.md §2.7 "Key Rotation"),
 * both parts sealed with the hub-field cipher under `LABEL_HUB_KEY_ROTATION`:
 *
 * - `check`: `{ hubId, epoch }` sealed under the NEW key. A device whose held
 *   key opens it holds the current key.
 * - `proof`: `{ hubId, epoch, check }` sealed under the PREVIOUS key. A device
 *   holding the previous key opens it, and only then adopts the new key — and
 *   only if its new wrap opens to a key that opens `check`. The server cannot
 *   write a proof that opens: it has never held a hub key.
 */
export const hubKeyRotationStatementSchema = z.object({
  proof: z.string().min(1).max(4096),
  check: z.string().min(1).max(4096),
})

export type HubKeyRotationStatement = z.infer<typeof hubKeyRotationStatementSchema>

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
   * The statement that introduced `epoch` (null before the first rotation). A
   * distributor or rotator first confirms the key it holds opens its `check`
   * — that it holds THIS epoch's key — so it never hands out, or re-seals
   * from, a key a rotation already replaced.
   */
  rotation: hubKeyRotationStatementSchema.nullable(),
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
 * statement that introduced it; `rotation` is null until the first rotation.
 */
export const hubKeyRotationResponseSchema = z.object({
  epoch: z.number().int().min(0),
  rotation: hubKeyRotationStatementSchema.nullable(),
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

/**
 * A hub id under the identifier profile (wire spec §2.1): lowercase, 1–64
 * characters, `[0-9a-z-]`, not starting with `-`. The client mints it (a
 * lowercase UUID) because the founder's genesis names it before the hub exists.
 */
export const hubIdSchema = z.string().regex(/^[0-9a-z][0-9a-z-]{0,63}$/, 'Must be a lowercase id of 1-64 characters [0-9a-z-]')

export const createHubBodySchema = z.object({
  /** Minted by the creating client; the genesis names it (#2963). */
  id: hubIdSchema,
  /** The founder's signed new-hub genesis: the hub chain's first link (#2963, wire spec §5.6). */
  genesis: hubChainLinkSchema,
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  description: z.string().max(500).optional(),
  /** The hub's hotline number — shorthand for `phoneNumbers: [phoneNumber]`. */
  phoneNumber: z.string().max(20).optional(),
  /** Every number the hub answers on; E.164, or national format when the server has a default country. */
  phoneNumbers: z.array(z.string().max(20)).max(50).optional(),
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
  /**
   * Set the hub's PRIMARY number: replaces the current primary, keeps the hub's
   * other numbers. An empty string removes the primary. Use `phoneNumbers` to
   * replace the whole declared set.
   */
  phoneNumber: z.string().max(20).optional(),
  /** Replace the whole set of numbers the operator has declared for the hub. Numbers bought through a provider are not affected. */
  phoneNumbers: z.array(z.string().max(20)).max(50).optional(),
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
 * - `rotation`: the statement that lets members' devices accept the new key
 *   (`hubKeyRotationStatementSchema`).
 * - `resealed`: for every value the hub holds sealed under its key, the value
 *   `from` the recipients read and the same plaintext sealed under the new key
 *   `to`. The server refuses the rotation if any value is missing or changed
 *   since — otherwise it would be left sealed under a key nobody holds any more.
 */
export const hubResealedTagSchema = z.object({ from: hubSealedTagSchema, to: hubSealedTagSchema })
export const hubResealedTeamSchema = z.object({ from: hubSealedTeamSchema, to: hubSealedTeamSchema })
export const hubResealedRoleSchema = z.object({ from: hubSealedRoleSchema, to: hubSealedRoleSchema })

/** Every value a hub holds sealed under its key, re-sealed under the new one, by table. */
export const hubResealedValuesSchema = z.object({
  tags: z.array(hubResealedTagSchema),
  teams: z.array(hubResealedTeamSchema),
  roles: z.array(hubResealedRoleSchema),
})

export const hubKeyRotateBodySchema = z.object({
  expectedGeneration: z.number().int().min(0),
  envelopes: z.array(recipientEnvelopeSchema).min(1, 'At least one envelope required'),
  rotation: hubKeyRotationStatementSchema,
  resealed: hubResealedValuesSchema,
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
 * - `shift-overrides`: holders, in the hub, of `shifts:manage-overrides` — the
 *   permission that reads override notes (#2778). Clients seal a note to this
 *   set AND the `admin` set, so an admin can always read it.
 */
export const readerPurposeSchema = z.enum(['admin', 'call-history', 'shift-overrides'])

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

export type HubReadersResponse = z.infer<typeof hubReadersResponseSchema>

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
