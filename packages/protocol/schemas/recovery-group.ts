import { z } from 'zod'

export const recoverySessionStatusSchema = z.enum([
  'pending',
  'verified',
  'active',
  'completed',
  'expired',
  'cancelled',
])
export type RecoverySessionStatus = z.infer<typeof recoverySessionStatusSchema>

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`))

/**
 * One holder's entry in an enroll/rotate body.
 *
 * `livenessPublicKey` is the Ed25519 public key the enrolling client derived
 * from THIS holder's Shamir share (`recovery_liveness::liveness_public_key` in
 * `packages/crypto`, #2782). It is the server's only way to check a liveness
 * proof without holding the share: the share commitment is a hash and can only
 * be checked by someone holding the share itself.
 */
export const recoveryShareEnvelopeSchema = z.object({
  holderPubkey: z.string(),
  shareEnvelope: z.string(),
  livenessPublicKey: hex(32),
})
export type RecoveryShareEnvelope = z.infer<typeof recoveryShareEnvelopeSchema>

export const recoveryGroupEnrollSchema = z.object({
  hubId: z.string().uuid(),
  threshold: z.number().int().min(2).max(5),
  totalShares: z.number().int().min(3).max(5),
  groupPublicKey: z.string(),
  shareEnvelopes: z.array(recoveryShareEnvelopeSchema),
  shareCommitments: z.array(z.string()),
  duressCommitments: z.array(z.string().nullable()).optional(),
  sigchainLinkHash: z.string(),
  delayHours: z.number().int().min(4).max(168).optional().default(24),
  emergencyFloorHours: z.number().int().min(1).max(24).optional().default(4),
})
export type RecoveryGroupEnroll = z.infer<typeof recoveryGroupEnrollSchema>

const shareHolderLivenessSchema = z.object({
  holderPubkey: z.string(),
  /** When this holder last demonstrated possession of their share (a verified liveness proof). Null if never, or since a failed proof. */
  lastLivenessProof: z.string().nullable(),
  /** When this holder last submitted a liveness proof that did NOT verify. A failure clears `lastLivenessProof`. */
  lastLivenessFailure: z.string().nullable(),
  createdAt: z.string(),
})

export const recoveryGroupInfoSchema = z.object({
  hubId: z.string(),
  groupPublicKey: z.string(),
  threshold: z.number(),
  totalShares: z.number(),
  shareCommitments: z.array(z.string()),
  duressCommitments: z.array(z.string().nullable()).nullable(),
  sigchainLinkHash: z.string(),
  delayHours: z.number(),
  emergencyFloorHours: z.number(),
  createdAt: z.string(),
  rotatedAt: z.string().nullable(),
  shareHolderLiveness: z.array(shareHolderLivenessSchema),
})
export type RecoveryGroupInfo = z.infer<typeof recoveryGroupInfoSchema>

export const recoveryInitiateSchema = z.object({
  hubId: z.string().uuid(),
  userIdentifier: z.string().min(1),
  newDevicePubkey: z.string(),
})
export type RecoveryInitiate = z.infer<typeof recoveryInitiateSchema>

export const recoveryInitiateResponseSchema = z.object({
  sessionId: z.string().uuid(),
  verificationSent: z.boolean(),
})
export type RecoveryInitiateResponse = z.infer<typeof recoveryInitiateResponseSchema>

export const recoveryInitiateVerifySchema = z.object({
  sessionId: z.string().uuid(),
  verificationCode: z.string().min(4).max(8),
})
export type RecoveryInitiateVerify = z.infer<typeof recoveryInitiateVerifySchema>

export const recoveryInitiateVerifyResponseSchema = z.object({
  ok: z.boolean(),
  expiresAt: z.string(),
})
export type RecoveryInitiateVerifyResponse = z.infer<typeof recoveryInitiateVerifyResponseSchema>

export const recoveryContributeSchema = z.object({
  encryptedShare: z.string(),
  contributorSignature: z.string(),
})
export type RecoveryContribute = z.infer<typeof recoveryContributeSchema>

export const recoveryContributeResponseSchema = z.object({
  ok: z.boolean(),
  status: recoverySessionStatusSchema,
  contributionCount: z.number(),
})
export type RecoveryContributeResponse = z.infer<typeof recoveryContributeResponseSchema>

const sessionContributionSchema = z.object({
  contributorPubkey: z.string(),
  encryptedShare: z.string().nullable(),
  contributorSignature: z.string().nullable(),
  contributedAt: z.string(),
})

export const recoverySessionStatusResponseSchema = z.object({
  sessionId: z.string(),
  hubId: z.string(),
  userPubkey: z.string(),
  newDevicePubkey: z.string(),
  status: recoverySessionStatusSchema,
  signalVerified: z.boolean(),
  contributionCount: z.number(),
  threshold: z.number(),
  delayRemainingMs: z.number(),
  expiresAt: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  emergencyOverride: z.object({
    justification: z.string(),
    approverPubkey: z.string(),
    approverSignature: z.string(),
  }).nullable(),
  contributions: z.array(sessionContributionSchema),
})
export type RecoverySessionStatusResponse = z.infer<typeof recoverySessionStatusResponseSchema>

export const userRecoveryEnvelopeSchema = z.object({
  hubId: z.string().uuid(),
  envelope: z.string(),
})
export type UserRecoveryEnvelope = z.infer<typeof userRecoveryEnvelopeSchema>

/**
 * `POST /api/recovery-group/shares/liveness/challenge` — ask for a fresh,
 * single-use challenge to prove possession of this hub's share against.
 * The holder is the authenticated caller; issuing a new challenge replaces any
 * outstanding one.
 */
export const shareLivenessChallengeRequestSchema = z.object({
  hubId: z.string().uuid(),
})
export type ShareLivenessChallengeRequest = z.infer<typeof shareLivenessChallengeRequestSchema>

export const shareLivenessChallengeResponseSchema = z.object({
  /** 32 random bytes, hex. Valid once, until `expiresAt`. */
  challenge: hex(32),
  expiresAt: z.string(),
})
export type ShareLivenessChallengeResponse = z.infer<typeof shareLivenessChallengeResponseSchema>

/**
 * `POST /api/recovery-group/shares/liveness` — a liveness proof (#2782).
 *
 * `proof` is the 64-byte Ed25519 signature (hex) produced by
 * `recovery_liveness::sign_liveness_proof` with the key derived from the
 * holder's share, over (hubId, holder pubkey, challenge). The server verifies
 * it against the holder's enrolled `livenessPublicKey` and consumes the
 * challenge; the share itself never leaves the device.
 */
export const shareLivenessProofSchema = z.object({
  hubId: z.string().uuid(),
  challenge: hex(32),
  proof: hex(64),
})
export type ShareLivenessProof = z.infer<typeof shareLivenessProofSchema>

export const shareLivenessProofResponseSchema = z.object({
  ok: z.boolean(),
  verifiedAt: z.string(),
})
export type ShareLivenessProofResponse = z.infer<typeof shareLivenessProofResponseSchema>

/**
 * `GET /api/recovery-group/shares/my` — the calling holder's own share.
 *
 * The holder is NEVER a parameter: the server takes it from the authenticated
 * pubkey, so the only thing the caller chooses is which hub's share to read.
 */
export const myShareEnvelopeQuerySchema = z.object({
  hubId: z.string().uuid(),
})
export type MyShareEnvelopeQuery = z.infer<typeof myShareEnvelopeQuerySchema>

export const myShareEnvelopeResponseSchema = z.object({
  hubId: z.string(),
  /** HPKE envelope (label `LABEL_RECOVERY_GROUP_SHARE_WRAP`) sealing this holder's Shamir share to their own key. */
  shareEnvelope: z.string(),
})
export type MyShareEnvelopeResponse = z.infer<typeof myShareEnvelopeResponseSchema>

export const recoveryCancelResponseSchema = z.object({
  ok: z.boolean(),
})
export type RecoveryCancelResponse = z.infer<typeof recoveryCancelResponseSchema>

export const recoveryEmergencyOverrideSchema = z.object({
  approverPubkey: z.string(),
  justification: z.string().min(1),
  signature: z.string(),
})
export type RecoveryEmergencyOverride = z.infer<typeof recoveryEmergencyOverrideSchema>
