/**
 * Hub authority chain wire schemas (#2963; wire spec
 * docs/superpowers/specs/2026-11-24-encryption-v2-wire-format.md §5).
 *
 * One append-only, hash-linked, signed chain per hub. These schemas describe
 * only what crosses the wire. Every canonicalisation, hash, signature and
 * validity rule lives in packages/crypto `hub_chain` — the server validates
 * each appended link through `ffi_hub_chain`, and every client verifies the
 * chain it is served through its own crate binding. No host re-implements any
 * of it, so a link `body` is deliberately an open object here: the crate is
 * the one place that decides whether a body is valid for its type (§5.6).
 */
import { z } from 'zod'

const hex32Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be 32 bytes of lowercase hex')
const ed25519SignatureHexSchema = z.string().regex(/^[0-9a-f]{128}$/, 'Must be a 64-byte Ed25519 signature in lowercase hex')
const lowerHexSchema = z.string().regex(/^[0-9a-f]*$/, 'Must be lowercase hex')

/** `{seq, hash}`: a chain head, and the wire shape of a trusted anchor (§5.7). */
export const chainHeadSchema = z.object({
  seq: z.number().int().min(1),
  hash: hex32Schema,
})
export type ChainHead = z.infer<typeof chainHeadSchema>

/** The ten link body types (§5.6). */
export const hubChainBodyTypeSchema = z.enum([
  'genesis',
  'role_grant',
  'role_revoke',
  'group_epoch',
  'connector_enroll',
  'connector_revoke',
  'escrow_set',
  'policy',
  'recovery_group',
  'checkpoint',
])
export type HubChainBodyType = z.infer<typeof hubChainBodyTypeSchema>

/** A link body: `type` plus the fields of that type, validated by the crate only. */
export const hubChainBodySchema = z.looseObject({ type: hubChainBodyTypeSchema })

/** One signed link as stored and served (§5.1). */
export const hubChainLinkSchema = z.object({
  hub: z.string().min(1).max(64),
  seq: z.number().int().min(1),
  prevHash: hex32Schema.nullable(),
  signerUser: hex32Schema,
  signerDevice: hex32Schema,
  signerUserHead: chainHeadSchema,
  body: hubChainBodySchema,
  entryHash: hex32Schema,
  sig: ed25519SignatureHexSchema,
})
export type HubChainLink = z.infer<typeof hubChainLinkSchema>

/** A link before the crate signs it: no `signerDevice`, `entryHash` or `sig`. */
export const unsignedHubLinkSchema = hubChainLinkSchema.omit({ signerDevice: true, entryHash: true, sig: true })
export type UnsignedHubLink = z.infer<typeof unsignedHubLinkSchema>

// --- Chain-derived state (packages/crypto `hub_chain::HubState`) ---

export const hubChainBundleSchema = z.object({
  bundle: z.string(),
  permissions: z.array(z.string()),
  permsHash: hex32Schema,
})

export const hubChainMemberSchema = z.object({
  user: hex32Schema,
  bundles: z.array(z.string()),
  /** The concrete permissions the member's defined bundles grant. */
  permissions: z.array(z.string()),
})

export const hubChainGroupSchema = z.object({
  group: z.string().regex(/^[0-9a-f]{32}$/),
  kind: z.enum(['purpose', 'user', 'connector']),
  subject: z.string(),
  epoch: z.number().int().min(1),
  format: z.number().int(),
  /** The epoch public key of the format's KEM suite, signed into the chain. */
  pk: lowerHexSchema,
  escrow: hex32Schema.optional(),
  reason: z.enum(['create', 'removal', 'schedule', 'device']),
  index: z.object({ version: z.number().int(), commit: hex32Schema }).optional(),
  /** Derived: purpose → the users holding its permissions; user → the subject; connector → the connector. */
  members: z.array(z.string()),
})

export const hubChainStateSchema = z.object({
  hub: z.string(),
  head: z.object({ seq: z.number().int(), hash: z.string() }),
  founder: hex32Schema,
  /** `1` until the first bundle policy link: the founder holds every permission. */
  bootstrap: z.number().int().min(0).max(1),
  bundles: z.array(hubChainBundleSchema),
  members: z.array(hubChainMemberSchema),
  userHeads: z.array(z.object({ user: hex32Schema, seq: z.number().int(), hash: hex32Schema })),
  groups: z.array(hubChainGroupSchema),
  escrow: z.object({ format: z.number().int(), pk: lowerHexSchema, hash: hex32Schema }).optional(),
  connectors: z.array(z.object({
    connector: z.string(),
    signingPk: hex32Schema,
    format: z.number().int(),
    encryptionPk: lowerHexSchema,
    manifestHash: hex32Schema,
  })),
  rotations: z.array(z.object({ group: z.string(), periodDays: z.number().int() })),
  recoveryGroup: z.object({
    format: z.number().int(),
    groupPk: lowerHexSchema,
    threshold: z.number().int(),
    holders: z.array(hex32Schema),
    commitments: hex32Schema,
    delayHours: z.number().int(),
    emergencyFloorHours: z.number().int(),
  }).optional(),
})
export type HubChainState = z.infer<typeof hubChainStateSchema>

/** An advisory finding on a valid chain (D13): `stale_signer`. */
export const hubChainAlertSchema = z.object({
  kind: z.enum(['stale_signer']),
  seq: z.number().int(),
  user: hex32Schema,
  device: hex32Schema,
})
export type HubChainAlert = z.infer<typeof hubChainAlertSchema>

/** The crate's answer to `verify` (`hub_chain::HubChainVerified`). */
export const hubChainVerifiedSchema = z.object({
  hub: z.string(),
  head: chainHeadSchema,
  state: hubChainStateSchema,
  stateHash: hex32Schema,
  alerts: z.array(hubChainAlertSchema),
})
export type HubChainVerified = z.infer<typeof hubChainVerifiedSchema>

// --- The crate's own shapes, as every host binding passes them ---

/** packages/crypto `sigchain::SigchainLink` — a user-chain link as the crate hashes and signs it. */
export const crateSigchainLinkSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  prevHash: z.string().nullable(),
  entryHash: z.string(),
  signerDeviceId: z.string(),
  signerPubkey: z.string(),
  signature: z.string(),
  timestamp: z.string(),
  payloadJson: z.string(),
})
export type CrateSigchainLink = z.infer<typeof crateSigchainLinkSchema>

/** packages/crypto `sigchain::ActiveDeviceKey`. */
export const activeDeviceKeySchema = z.object({
  devicePubkey: z.string(),
  encryptionPubkey: z.string(),
  format: z.number().int(),
})

/** packages/crypto `sigchain::SigchainVerifiedState`. */
export const sigchainVerifiedStateSchema = z.object({
  userPubkey: z.string(),
  verifiedCount: z.number().int(),
  headSeq: z.number().int(),
  headHash: z.string(),
  activeDevicePubkeys: z.array(z.string()),
  activeDeviceKeys: z.array(activeDeviceKeySchema),
  namedKeys: z.array(z.string()),
})
export type SigchainVerifiedState = z.infer<typeof sigchainVerifiedStateSchema>

/** A trusted anchor for a hub other than the one being verified. */
export const hubAnchorSchema = z.object({ hub: z.string(), head: chainHeadSchema })
export type HubAnchor = z.infer<typeof hubAnchorSchema>

/** packages/crypto `hub_chain::HubChainInput`. */
export const hubChainInputSchema = z.object({
  links: z.array(hubChainLinkSchema),
  userChains: z.array(z.array(crateSigchainLinkSchema)).optional(),
  hubChains: z.array(z.array(hubChainLinkSchema)).optional(),
  anchor: chainHeadSchema.optional(),
  hubAnchors: z.array(hubAnchorSchema).optional(),
})
export type HubChainInput = z.infer<typeof hubChainInputSchema>

// --- Routes: GET/POST /api/hubs/:hubId/chain ---

/** Fetch forward: links with `seq >= from`, at most `limit`, in seq order. */
export const hubChainQuerySchema = z.object({
  from: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
})

export const hubChainResponseSchema = z.object({
  hubId: z.string(),
  links: z.array(hubChainLinkSchema),
  /** The head the server holds, or `null` for a hub with no chain. */
  head: chainHeadSchema.nullable(),
  /** More links follow the last one returned: fetch again from its seq + 1. */
  hasMore: z.boolean(),
})
export type HubChainResponse = z.infer<typeof hubChainResponseSchema>

/** Append one link. The link's `prevHash` and `seq` are its compare-and-set against the head. */
export const appendHubChainLinkBodySchema = z.object({
  link: hubChainLinkSchema,
})
export type AppendHubChainLinkBody = z.infer<typeof appendHubChainLinkBodySchema>

export const appendHubChainLinkResponseSchema = z.object({
  head: chainHeadSchema,
})
export type AppendHubChainLinkResponse = z.infer<typeof appendHubChainLinkResponseSchema>

/**
 * The append lost a race (409): another link took this seq. Re-read the chain,
 * re-evaluate authority against the new head, re-sign and retry (§5.1).
 */
export const hubChainConflictResponseSchema = z.object({
  error: z.string(),
  code: z.literal('chain_head_moved'),
  head: chainHeadSchema.nullable(),
})

/** A link the crate refused (400), by its closed rejection code. */
export const hubChainRejectedResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
})

/**
 * What a founder signs into a new hub's chain (#2963): the bundles its genesis
 * gives the founder — the catalog's founder role, chosen by permission — each
 * with the concrete permissions its `policy {kind: bundle}` link commits.
 */
export const hubFoundingBundleSchema = z.object({ bundle: z.string(), permissions: z.array(z.string()) })
export type HubFoundingBundle = z.infer<typeof hubFoundingBundleSchema>

export const hubFoundingResponseSchema = z.object({
  bundles: z.array(hubFoundingBundleSchema),
})
export type HubFoundingResponse = z.infer<typeof hubFoundingResponseSchema>

// --- Recovery approvals (D14, §5.8) ---

/** One share holder's approval of a recovery, signed through the crate. */
export const recoveryApprovalSchema = z.object({
  type: z.literal('recovery_approval'),
  hub: z.string(),
  hubHead: chainHeadSchema,
  subjectUser: hex32Schema,
  newSigningPk: hex32Schema,
  newEncryptionPk: lowerHexSchema,
  session: z.string(),
  holderUser: hex32Schema,
  holderDevice: hex32Schema,
  sig: ed25519SignatureHexSchema,
})
export type RecoveryApproval = z.infer<typeof recoveryApprovalSchema>

export const unsignedRecoveryApprovalSchema = recoveryApprovalSchema.omit({ type: true, holderDevice: true, sig: true })
export type UnsignedRecoveryApproval = z.infer<typeof unsignedRecoveryApprovalSchema>

/**
 * The request and answer of each `hub_chain::call` op — the one JSON entry
 * point every host binding exposes (server `ffi_hub_chain`, desktop
 * `hub_chain_call`, mobile `mobileHubChain`).
 */
export interface HubChainOps {
  verify: { request: HubChainInput; answer: HubChainVerified }
  signingMessage: { request: { unsigned: UnsignedHubLink; signerDevice: string }; answer: { entryHash: string; message: string } }
  assemble: { request: { unsigned: UnsignedHubLink; signerDevice: string; sig: string }; answer: HubChainLink }
  permsHash: { request: { permissions: string[] }; answer: { permsHash: string } }
  verifySigchain: {
    request: { links: CrateSigchainLink[]; userChains?: CrateSigchainLink[][]; hubChains?: HubChainLink[][]; hubAnchors?: HubAnchor[] }
    answer: SigchainVerifiedState
  }
  approvalMessage: { request: { approval: UnsignedRecoveryApproval; holderDevice: string }; answer: { message: string } }
}
