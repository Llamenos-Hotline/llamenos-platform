/**
 * User sigchain + PUK (Per-User Key) wire schemas.
 *
 * The sigchain is the append-only, hash-chained, Ed25519-signed log that
 * authorises a user's devices. The PUK is a random per-user seed, sealed
 * (HPKE, `LABEL_PUK_WRAP_TO_DEVICE`) to every device the sigchain authorises.
 *
 * Every client produces the same state when a user is created
 * (docs/protocol/PROTOCOL.md §2.11 "Identity initialisation"):
 *
 *   seq 1  genesis    payload sigchainGenesisPayload   (signed by the first device)
 *          PUK gen 1 envelope sealed to that device    (POST /api/puk/envelopes)
 *   seq 2  puk_epoch  payload sigchainPukEpochPayload  (binds the PUK public keys)
 *
 * The link hash / signature primitives live in packages/crypto
 * (`sigchain::create_sigchain_link`, `sigchain::verify_sigchain`,
 * `puk::create_initial_puk`); these schemas only describe what goes over the wire.
 */
import { z } from 'zod'

const ed25519HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 32-byte Ed25519 public key in lowercase hex')
const x25519HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Must be a 32-byte X25519 public key in lowercase hex')

/**
 * Sequence number of the genesis link. Matches packages/crypto
 * `verify_sigchain`, which requires the first link to have `seq == 1`.
 */
export const SIGCHAIN_GENESIS_SEQ = 1

/** Link types the generic append route accepts (recovery links use their own route). */
export const sigchainLinkTypeSchema = z.enum(['genesis', 'device_add', 'device_remove', 'key_rotate', 'puk_epoch'])
export type SigchainLinkType = z.infer<typeof sigchainLinkTypeSchema>

/**
 * `payload.type` each link type must carry. The Rust verifier keys its device-set
 * semantics off `payload.type`, so the server's `linkType` column must agree with it.
 */
export const SIGCHAIN_PAYLOAD_TYPE_FOR_LINK: Record<SigchainLinkType, string> = {
  genesis: 'user_init',
  device_add: 'device_add',
  device_remove: 'device_remove',
  key_rotate: 'key_rotate',
  puk_epoch: 'puk_epoch',
}

// --- Link payloads (hashed + signed; see packages/crypto/src/sigchain.rs) ---

/** Genesis (seq 1): the user's first device, self-signed. */
export const sigchainGenesisPayloadSchema = z.object({
  type: z.literal('user_init'),
  /** Client-generated device ID (DeviceKeyState.deviceId) — also the PUK envelope address. */
  deviceId: z.string().min(1),
  /** The device's Ed25519 signing key — equals the link's signerPubkey and the user's pubkey. */
  devicePubkey: ed25519HexSchema,
  /** The device's X25519 key — the HPKE recipient for this device's PUK envelope. */
  deviceEncryptionPubkey: x25519HexSchema,
})
export type SigchainGenesisPayload = z.infer<typeof sigchainGenesisPayloadSchema>

/** device_add: an already-authorised device authorises a new one. */
export const sigchainDeviceAddPayloadSchema = z.object({
  type: z.literal('device_add'),
  deviceId: z.string().min(1),
  devicePubkey: ed25519HexSchema,
  deviceEncryptionPubkey: x25519HexSchema,
})
export type SigchainDeviceAddPayload = z.infer<typeof sigchainDeviceAddPayloadSchema>

/** device_remove: de-authorise a device (triggers PUK rotation). */
export const sigchainDeviceRemovePayloadSchema = z.object({
  type: z.literal('device_remove'),
  deviceId: z.string().min(1),
  devicePubkey: ed25519HexSchema,
})
export type SigchainDeviceRemovePayload = z.infer<typeof sigchainDeviceRemovePayloadSchema>

/**
 * puk_epoch: binds a PUK generation's public keys into the signed chain, so any
 * verifier can check a PUK seed it unwrapped (or a key it wraps to the PUK)
 * against keys the user's device actually signed.
 */
export const sigchainPukEpochPayloadSchema = z.object({
  type: z.literal('puk_epoch'),
  generation: z.number().int().min(1),
  /** Ed25519 public key derived from the PUK seed (LABEL_PUK_SIGN). */
  signPubkey: ed25519HexSchema,
  /** X25519 public key derived from the PUK seed (LABEL_PUK_DH). */
  dhPubkey: x25519HexSchema,
})
export type SigchainPukEpochPayload = z.infer<typeof sigchainPukEpochPayloadSchema>

// --- Routes: /api/users/:targetPubkey/sigchain ---

export const appendSigchainLinkBodySchema = z.object({
  seqNo: z.number().int().min(SIGCHAIN_GENESIS_SEQ),
  linkType: sigchainLinkTypeSchema,
  /** The payload object whose canonical JSON was hashed (see PROTOCOL.md §2.11). */
  payload: z.record(z.string(), z.unknown()),
  /** Ed25519 signature over the entry hash, hex. */
  signature: z.string().regex(/^[0-9a-f]{128}$/i, 'Must be 64-byte Ed25519 signature in hex'),
  /** Entry hash of the previous link (hex). Empty string for genesis. */
  prevHash: z.string().regex(/^([0-9a-f]{64}|)$/i, 'Must be SHA-256 hex or empty string'),
  /** SHA-256 entry hash of this link's canonical form (hex). Server recomputes and verifies. */
  hash: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be SHA-256 hex'),
  /** Device ID of the signing device. */
  signerDeviceId: z.string().min(1),
  /** Ed25519 pubkey of the signing device (hex). */
  signerPubkey: z.string().regex(/^[0-9a-f]{64}$/i, 'Must be 32-byte Ed25519 pubkey in hex'),
  /** ISO-8601 timestamp of link creation — part of the hashed canonical form. */
  timestamp: z.string().min(1),
})
export type AppendSigchainLinkBody = z.infer<typeof appendSigchainLinkBodySchema>

export const sigchainLinkSchema = z.object({
  id: z.string(),
  userPubkey: z.string(),
  seqNo: z.number().int(),
  linkType: z.string(),
  payload: z.unknown(),
  signature: z.string(),
  prevHash: z.string(),
  hash: z.string(),
  signerDeviceId: z.string(),
  signerPubkey: z.string(),
  /** Client-supplied link timestamp — needed to recompute the entry hash. */
  timestamp: z.string(),
  createdAt: z.string(),
})
export type SigchainLinkRecord = z.infer<typeof sigchainLinkSchema>

export const sigchainResponseSchema = z.object({
  links: z.array(sigchainLinkSchema),
})
export type SigchainResponse = z.infer<typeof sigchainResponseSchema>

// --- Routes: /api/puk/envelopes ---

/**
 * HPKE envelope v3 as produced by packages/crypto `hpke_envelope::HpkeEnvelope`
 * (`puk::create_initial_puk`, `puk::rotate_puk`). Opened with
 * `LABEL_PUK_WRAP_TO_DEVICE` and AAD `"<LABEL_PUK_WRAP_TO_DEVICE>:<deviceId>"`.
 */
export const pukHpkeEnvelopeSchema = z.object({
  /** Envelope version — packages/crypto only produces and accepts v3. */
  v: z.number().int().min(3).max(3),
  labelId: z.number().int().nonnegative(),
  enc: z.string().min(1).max(128),
  ct: z.string().min(1).max(512),
})
export type PukHpkeEnvelope = z.infer<typeof pukHpkeEnvelopeSchema>

export const pukEnvelopeItemSchema = z.object({
  /** Sigchain device ID (genesis `deviceId` / device_add `deviceId`) the envelope is sealed to. */
  deviceId: z.string().min(1),
  generation: z.number().int().min(1),
  envelope: pukHpkeEnvelopeSchema,
})
export type PukEnvelopeItem = z.infer<typeof pukEnvelopeItemSchema>

export const distributePukEnvelopesBodySchema = z.object({
  envelopes: z.array(pukEnvelopeItemSchema).min(1, 'At least one envelope required'),
})
export type DistributePukEnvelopesBody = z.infer<typeof distributePukEnvelopesBodySchema>

export const pukEnvelopeResponseSchema = z.object({
  id: z.string(),
  userPubkey: z.string(),
  deviceId: z.string(),
  generation: z.number().int(),
  envelope: pukHpkeEnvelopeSchema,
  createdAt: z.string(),
})
export type PukEnvelopeResponse = z.infer<typeof pukEnvelopeResponseSchema>

export const distributePukEnvelopesResponseSchema = z.object({
  distributed: z.number().int(),
  envelopes: z.array(pukEnvelopeResponseSchema),
})
export type DistributePukEnvelopesResponse = z.infer<typeof distributePukEnvelopesResponseSchema>
