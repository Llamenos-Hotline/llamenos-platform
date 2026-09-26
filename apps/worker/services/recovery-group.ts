import { eq, and, sql, desc } from 'drizzle-orm'
import { ed25519Verify } from '@llamenos/crypto/ffi'
import { hexToBytes, utf8ToBytes } from '@shared/encoding'
import type { Database } from '../db'
import {
  hubRecoveryGroups,
  hubRecoveryGroupShares,
  userRecoveryEnvelopes,
  recoverySessions,
  recoverySessionContributions,
  sigchainLinks,
} from '../db/schema'
import { createLogger } from '../lib/logger'
import type { AuditService } from './audit'
import { computeEntryHash } from './crypto-keys'
import { SIGCHAIN_GENESIS_SEQ } from '@protocol/schemas/sigchain'

const logger = createLogger('service.recovery-group')

const MAX_VERIFICATION_ATTEMPTS = 5
const VERIFICATION_CODE_LENGTH = 6

export class RecoveryGroupError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 | 500 = 500,
  ) {
    super(message)
    this.name = 'RecoveryGroupError'
  }
}

export interface SigchainLinkInsert {
  id: string
  userPubkey: string
  seqNo: number
  linkType: string
  payload: unknown
  signature: string
  prevHash: string
  hash: string
  signerDeviceId: string
  signerPubkey: string
  createdAt: string
}

export class RecoveryGroupService {
  constructor(
    private readonly db: Database,
    private readonly audit?: AuditService,
  ) {}

  async enrollHub(params: {
    hubId: string
    threshold: number
    totalShares: number
    groupPublicKey: string
    shareEnvelopes: Array<{ holderPubkey: string; shareEnvelope: string }>
    shareCommitments: string[]
    duressCommitments?: Array<string | null>
    sigchainLinkHash: string
    delayHours?: number
    emergencyFloorHours?: number
  }): Promise<void> {
    const {
      hubId,
      threshold,
      totalShares,
      groupPublicKey,
      shareEnvelopes,
      shareCommitments,
      duressCommitments,
      sigchainLinkHash,
      delayHours = 24,
      emergencyFloorHours = 4,
    } = params

    if (shareEnvelopes.length !== totalShares) {
      throw new RecoveryGroupError(
        `Expected ${totalShares} share envelopes, got ${shareEnvelopes.length}`,
        400,
      )
    }
    if (shareCommitments.length !== totalShares) {
      throw new RecoveryGroupError(
        `Expected ${totalShares} share commitments, got ${shareCommitments.length}`,
        400,
      )
    }
    if (threshold > totalShares) {
      throw new RecoveryGroupError(
        'Threshold cannot exceed totalShares',
        400,
      )
    }
    if (emergencyFloorHours > delayHours) {
      throw new RecoveryGroupError(
        'Emergency floor cannot exceed delay hours',
        400,
      )
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(hubRecoveryGroups).where(eq(hubRecoveryGroups.hubId, hubId))

      await tx.insert(hubRecoveryGroups).values({
        hubId,
        groupPublicKey,
        threshold,
        totalShares,
        shareCommitments,
        duressCommitments: duressCommitments ?? null,
        sigchainLinkHash,
        delayHours,
        emergencyFloorHours,
        rotatedAt: null,
      })

      if (shareEnvelopes.length > 0) {
        await tx.insert(hubRecoveryGroupShares).values(
          shareEnvelopes.map((se) => ({
            hubId,
            holderPubkey: se.holderPubkey,
            shareEnvelope: se.shareEnvelope,
          })),
        )
      }
    })

    logger.info('Recovery group enrolled', { hubId, threshold, totalShares })
  }

  /**
   * Atomically rotate a hub's recovery group (D13): replace the group keypair,
   * per-holder share envelopes, AND re-wrap every existing user recovery
   * envelope for the new group public key — all in a single transaction.
   *
   * Zero-knowledge-preserving by construction: unlike a server-side re-wrap
   * (which would require the server to briefly hold the old group's private
   * key), the caller performs the HPKE open/reseal client-side and submits
   * only the resulting ciphertext — the server never sees plaintext PUK
   * seeds or private key material, exactly like `enrollHub`'s share
   * envelopes today.
   *
   * A departed share holder is excluded by simply omitting them from
   * `shareEnvelopes`/`shareCommitments` — after rotation their old share
   * (even if retained) is cryptographically useless: it corresponds to a
   * private key that no longer HPKE-decrypts anything, since every user
   * envelope is re-wrapped under the brand-new group public key in the same
   * transaction.
   *
   * Requires an existing group for the hub — use `enrollHub` for the initial
   * configuration. Requires a re-wrapped envelope for every user who
   * currently has one for this hub; a partial re-wrap would silently strand
   * the omitted user's recovery capability under a now-deleted key.
   */
  async rotateGroup(params: {
    hubId: string
    rotatedBy: string
    threshold: number
    totalShares: number
    groupPublicKey: string
    shareEnvelopes: Array<{ holderPubkey: string; shareEnvelope: string }>
    shareCommitments: string[]
    duressCommitments?: Array<string | null>
    sigchainLinkHash: string
    delayHours?: number
    emergencyFloorHours?: number
    rewrappedUserEnvelopes: Array<{ userPubkey: string; envelope: string }>
  }): Promise<void> {
    const {
      hubId,
      rotatedBy,
      threshold,
      totalShares,
      groupPublicKey,
      shareEnvelopes,
      shareCommitments,
      duressCommitments,
      sigchainLinkHash,
      delayHours = 24,
      emergencyFloorHours = 4,
      rewrappedUserEnvelopes,
    } = params

    if (shareEnvelopes.length !== totalShares) {
      throw new RecoveryGroupError(
        `Expected ${totalShares} share envelopes, got ${shareEnvelopes.length}`,
        400,
      )
    }
    if (shareCommitments.length !== totalShares) {
      throw new RecoveryGroupError(
        `Expected ${totalShares} share commitments, got ${shareCommitments.length}`,
        400,
      )
    }
    if (threshold > totalShares) {
      throw new RecoveryGroupError(
        'Threshold cannot exceed totalShares',
        400,
      )
    }
    if (emergencyFloorHours > delayHours) {
      throw new RecoveryGroupError(
        'Emergency floor cannot exceed delay hours',
        400,
      )
    }

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ hubId: hubRecoveryGroups.hubId })
        .from(hubRecoveryGroups)
        .where(eq(hubRecoveryGroups.hubId, hubId))
        .limit(1)

      if (existing.length === 0) {
        throw new RecoveryGroupError(
          'No recovery group configured for this hub — use enroll for initial setup',
          404,
        )
      }

      // D13 step 3c: every currently-enveloped user must be re-wrapped in
      // this same transaction, or they would be left pointing at ciphertext
      // for a group key the transaction is about to delete.
      const currentEnvelopes = await tx
        .select({ userPubkey: userRecoveryEnvelopes.userPubkey })
        .from(userRecoveryEnvelopes)
        .where(eq(userRecoveryEnvelopes.hubId, hubId))

      const currentUserPubkeys = new Set(currentEnvelopes.map((e) => e.userPubkey))
      const rewrappedUserPubkeys = new Set(rewrappedUserEnvelopes.map((e) => e.userPubkey))

      if (currentUserPubkeys.size !== rewrappedUserPubkeys.size ||
          [...currentUserPubkeys].some((pk) => !rewrappedUserPubkeys.has(pk))) {
        throw new RecoveryGroupError(
          'rewrappedUserEnvelopes must re-wrap exactly the set of users currently enrolled for this hub',
          409,
        )
      }

      // Atomic: delete old group (cascades to old shares), insert new group + shares.
      await tx.delete(hubRecoveryGroups).where(eq(hubRecoveryGroups.hubId, hubId))

      await tx.insert(hubRecoveryGroups).values({
        hubId,
        groupPublicKey,
        threshold,
        totalShares,
        shareCommitments,
        duressCommitments: duressCommitments ?? null,
        sigchainLinkHash,
        delayHours,
        emergencyFloorHours,
        rotatedAt: new Date(),
      })

      if (shareEnvelopes.length > 0) {
        await tx.insert(hubRecoveryGroupShares).values(
          shareEnvelopes.map((se) => ({
            hubId,
            holderPubkey: se.holderPubkey,
            shareEnvelope: se.shareEnvelope,
          })),
        )
      }

      for (const { userPubkey, envelope } of rewrappedUserEnvelopes) {
        await tx
          .update(userRecoveryEnvelopes)
          .set({ envelope, updatedAt: new Date() })
          .where(
            and(
              eq(userRecoveryEnvelopes.userPubkey, userPubkey),
              eq(userRecoveryEnvelopes.hubId, hubId),
            ),
          )
      }
    })

    if (this.audit) {
      await this.audit.log(
        'recoveryGroupRotated',
        rotatedBy,
        { hubId, threshold, totalShares, rewrappedCount: rewrappedUserEnvelopes.length },
        hubId,
      )
    }

    logger.info('Recovery group rotated', {
      hubId,
      threshold,
      totalShares,
      rewrappedCount: rewrappedUserEnvelopes.length,
    })
  }

  async getGroup(hubId: string) {
    const group = await this.db
      .select()
      .from(hubRecoveryGroups)
      .where(eq(hubRecoveryGroups.hubId, hubId))
      .limit(1)

    if (group.length === 0) {
      throw new RecoveryGroupError('No recovery group configured for this hub', 404)
    }

    const shares = await this.db
      .select({
        holderPubkey: hubRecoveryGroupShares.holderPubkey,
        lastLivenessProof: hubRecoveryGroupShares.lastLivenessProof,
        createdAt: hubRecoveryGroupShares.createdAt,
      })
      .from(hubRecoveryGroupShares)
      .where(eq(hubRecoveryGroupShares.hubId, hubId))

    const g = group[0]
    return {
      hubId: g.hubId,
      groupPublicKey: g.groupPublicKey,
      threshold: g.threshold,
      totalShares: g.totalShares,
      shareCommitments: g.shareCommitments as string[],
      duressCommitments: g.duressCommitments as Array<string | null> | null,
      sigchainLinkHash: g.sigchainLinkHash,
      delayHours: g.delayHours,
      emergencyFloorHours: g.emergencyFloorHours,
      createdAt: g.createdAt.toISOString(),
      rotatedAt: g.rotatedAt?.toISOString() ?? null,
      shareHolderLiveness: shares.map((s) => ({
        holderPubkey: s.holderPubkey,
        lastLivenessProof: s.lastLivenessProof?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
      })),
    }
  }

  async initiateRecovery(params: {
    hubId: string
    userIdentifier: string
    newDevicePubkey: string
    signalNotifierFn: (identifierHash: string, code: string) => Promise<boolean>
    hmacSecret: string
  }): Promise<{ sessionId: string; verificationSent: boolean }> {
    const { hubId, userIdentifier, newDevicePubkey, signalNotifierFn, hmacSecret } = params

    const { createHmac } = await import('node:crypto')
    const identifierHash = createHmac('sha256', hmacSecret)
      .update(userIdentifier.toLowerCase().trim())
      .digest('hex')

    const sessionId = crypto.randomUUID()

    const group = await this.db
      .select({ hubId: hubRecoveryGroups.hubId, delayHours: hubRecoveryGroups.delayHours })
      .from(hubRecoveryGroups)
      .where(eq(hubRecoveryGroups.hubId, hubId))
      .limit(1)

    if (group.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { sessionId, verificationSent: true }
    }

    const { userSignalContacts } = await import('../db/schema')
    const contact = await this.db
      .select({
        userPubkey: userSignalContacts.userPubkey,
        identifierHash: userSignalContacts.identifierHash,
      })
      .from(userSignalContacts)
      .where(eq(userSignalContacts.identifierHash, identifierHash))
      .limit(1)

    if (contact.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { sessionId, verificationSent: true }
    }

    const userPubkey = contact[0].userPubkey

    const code = generateVerificationCode()
    const codeHash = createHmac('sha256', hmacSecret)
      .update(code)
      .digest('hex')

    const delayMs = group[0].delayHours * 60 * 60 * 1000
    const expiresAt = new Date(Date.now() + delayMs)

    await this.db.insert(recoverySessions).values({
      sessionId,
      hubId,
      userPubkey,
      newDevicePubkey,
      status: 'pending',
      verificationCodeHash: codeHash,
      expiresAt,
    })

    let verificationSent = false
    try {
      verificationSent = await signalNotifierFn(contact[0].identifierHash, code)
    } catch (err) {
      logger.error('Failed to send Signal verification', { err, sessionId })
    }

    logger.info('Recovery session initiated', { sessionId, hubId })
    return { sessionId, verificationSent }
  }

  async verifyInitiation(params: {
    sessionId: string
    verificationCode: string
    hmacSecret: string
  }): Promise<{ ok: boolean; expiresAt: string }> {
    const { sessionId, verificationCode, hmacSecret } = params

    const sessions = await this.db
      .select()
      .from(recoverySessions)
      .where(eq(recoverySessions.sessionId, sessionId))
      .limit(1)

    if (sessions.length === 0) {
      throw new RecoveryGroupError('Session not found', 404)
    }

    const session = sessions[0]

    if (session.status !== 'pending') {
      throw new RecoveryGroupError('Session is not in pending state', 400)
    }

    if (new Date() > session.expiresAt) {
      await this.db
        .update(recoverySessions)
        .set({ status: 'expired' })
        .where(eq(recoverySessions.sessionId, sessionId))
      throw new RecoveryGroupError('Session has expired', 400)
    }

    if (session.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      await this.db
        .update(recoverySessions)
        .set({ status: 'expired' })
        .where(eq(recoverySessions.sessionId, sessionId))
      throw new RecoveryGroupError('Too many verification attempts — session expired', 400)
    }

    const { createHmac } = await import('node:crypto')
    const codeHash = createHmac('sha256', hmacSecret)
      .update(verificationCode)
      .digest('hex')

    if (codeHash !== session.verificationCodeHash) {
      await this.db
        .update(recoverySessions)
        .set({
          verificationAttempts: session.verificationAttempts + 1,
        })
        .where(eq(recoverySessions.sessionId, sessionId))
      throw new RecoveryGroupError('Invalid verification code', 400)
    }

    const group = await this.db
      .select({ delayHours: hubRecoveryGroups.delayHours })
      .from(hubRecoveryGroups)
      .where(eq(hubRecoveryGroups.hubId, session.hubId))
      .limit(1)

    const delayMs = (group[0]?.delayHours ?? 24) * 60 * 60 * 1000
    const expiresAt = new Date(Date.now() + delayMs)

    await this.db
      .update(recoverySessions)
      .set({
        status: 'verified',
        signalVerified: true,
        expiresAt,
      })
      .where(eq(recoverySessions.sessionId, sessionId))

    logger.info('Recovery session verified', { sessionId })
    return { ok: true, expiresAt: expiresAt.toISOString() }
  }

  async contributeShare(params: {
    sessionId: string
    contributorPubkey: string
    encryptedShare: string
    contributorSignature: string
  }): Promise<{ ok: boolean; status: string; contributionCount: number }> {
    const { sessionId, contributorPubkey, encryptedShare, contributorSignature } = params

    const sessions = await this.db
      .select()
      .from(recoverySessions)
      .where(eq(recoverySessions.sessionId, sessionId))
      .limit(1)

    if (sessions.length === 0) {
      throw new RecoveryGroupError('Session not found', 404)
    }

    const session = sessions[0]

    if (session.status !== 'verified' && session.status !== 'active') {
      throw new RecoveryGroupError(
        `Session is in '${session.status}' state — contributions only accepted in 'verified' or 'active' state`,
        400,
      )
    }

    const holders = await this.db
      .select({ holderPubkey: hubRecoveryGroupShares.holderPubkey })
      .from(hubRecoveryGroupShares)
      .where(eq(hubRecoveryGroupShares.hubId, session.hubId))

    const isHolder = holders.some((h) => h.holderPubkey === contributorPubkey)
    if (!isHolder) {
      throw new RecoveryGroupError('Contributor is not a share holder for this hub', 403)
    }

    let contributionCount = 0
    let newStatus = session.status

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ contributorPubkey: recoverySessionContributions.contributorPubkey })
        .from(recoverySessionContributions)
        .where(
          and(
            eq(recoverySessionContributions.sessionId, sessionId),
            eq(recoverySessionContributions.contributorPubkey, contributorPubkey),
          ),
        )
        .limit(1)

      if (existing.length > 0) {
        throw new RecoveryGroupError('Duplicate contribution — already submitted', 409)
      }

      await tx.insert(recoverySessionContributions).values({
        sessionId,
        contributorPubkey,
        encryptedShare,
        contributorSignature,
      })

      const countResult = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(recoverySessionContributions)
        .where(eq(recoverySessionContributions.sessionId, sessionId))

      contributionCount = countResult[0]?.count ?? 0

      const group = await tx
        .select({ threshold: hubRecoveryGroups.threshold })
        .from(hubRecoveryGroups)
        .where(eq(hubRecoveryGroups.hubId, session.hubId))
        .limit(1)

      const threshold = group[0]?.threshold ?? 2

      if (contributionCount >= threshold && session.status === 'verified') {
        newStatus = 'active'
        await tx
          .update(recoverySessions)
          .set({ status: 'active' })
          .where(eq(recoverySessions.sessionId, sessionId))
      }
    })

    logger.info('Share contribution received', {
      sessionId,
      contributorPubkey,
      contributionCount,
      newStatus,
    })

    return { ok: true, status: newStatus, contributionCount }
  }

  async getSession(sessionId: string) {
    const sessions = await this.db
      .select()
      .from(recoverySessions)
      .where(eq(recoverySessions.sessionId, sessionId))
      .limit(1)

    if (sessions.length === 0) {
      throw new RecoveryGroupError('Session not found', 404)
    }

    const session = sessions[0]

    const contributions = await this.db
      .select()
      .from(recoverySessionContributions)
      .where(eq(recoverySessionContributions.sessionId, sessionId))

    const group = await this.db
      .select({ threshold: hubRecoveryGroups.threshold })
      .from(hubRecoveryGroups)
      .where(eq(hubRecoveryGroups.hubId, session.hubId))
      .limit(1)

    const threshold = group[0]?.threshold ?? 2

    const now = Date.now()
    const expiresMs = session.expiresAt.getTime()
    const delayRemainingMs = Math.max(0, expiresMs - now)

    const releaseContributions = delayRemainingMs === 0 &&
      (session.status === 'active' || session.status === 'completed')

    return {
      sessionId: session.sessionId,
      hubId: session.hubId,
      userPubkey: session.userPubkey,
      newDevicePubkey: session.newDevicePubkey,
      status: session.status,
      signalVerified: session.signalVerified,
      contributionCount: contributions.length,
      threshold,
      delayRemainingMs,
      expiresAt: session.expiresAt.toISOString(),
      createdAt: session.createdAt.toISOString(),
      completedAt: session.completedAt?.toISOString() ?? null,
      cancelledAt: session.cancelledAt?.toISOString() ?? null,
      cancelledBy: session.cancelledBy ?? null,
      emergencyOverride: session.emergencyOverride as {
        justification: string
        approverPubkey: string
        approverSignature: string
      } | null,
      contributions: contributions.map((c) => ({
        contributorPubkey: c.contributorPubkey,
        encryptedShare: releaseContributions ? c.encryptedShare : null,
        contributorSignature: releaseContributions ? c.contributorSignature : null,
        contributedAt: c.contributedAt.toISOString(),
      })),
    }
  }

  async listSessions(hubId: string) {
    const sessions = await this.db
      .select()
      .from(recoverySessions)
      .where(eq(recoverySessions.hubId, hubId))
      .orderBy(recoverySessions.createdAt)

    return sessions.map((s) => ({
      sessionId: s.sessionId,
      hubId: s.hubId,
      userPubkey: s.userPubkey,
      newDevicePubkey: s.newDevicePubkey,
      status: s.status,
      signalVerified: s.signalVerified,
      expiresAt: s.expiresAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
      cancelledAt: s.cancelledAt?.toISOString() ?? null,
      cancelledBy: s.cancelledBy ?? null,
    }))
  }

  async cancelSession(params: {
    sessionId: string
    cancelledBy: string
    callerPubkey: string
    hasManagePermission: boolean
  }): Promise<void> {
    const { sessionId, cancelledBy, callerPubkey, hasManagePermission } = params

    const sessions = await this.db
      .select()
      .from(recoverySessions)
      .where(eq(recoverySessions.sessionId, sessionId))
      .limit(1)

    if (sessions.length === 0) {
      throw new RecoveryGroupError('Session not found', 404)
    }

    const session = sessions[0]

    if (!['pending', 'verified', 'active'].includes(session.status)) {
      throw new RecoveryGroupError(
        `Cannot cancel session in '${session.status}' state`,
        400,
      )
    }

    const isRecoveringUser = callerPubkey === session.userPubkey
    if (!isRecoveringUser && !hasManagePermission) {
      throw new RecoveryGroupError(
        'Only the recovering user or a recovery manager can cancel',
        403,
      )
    }

    await this.db
      .update(recoverySessions)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy,
      })
      .where(eq(recoverySessions.sessionId, sessionId))

    logger.info('Recovery session cancelled', { sessionId, cancelledBy })
  }

  /**
   * Complete a recovery session (Phase 4, spec step 7): append a
   * self-authorizing `recovery-device-add` sigchain link for the recovering
   * user, then transition the session to `completed`.
   *
   * This link type is special: it is NOT verified against the account's
   * (lost) identity key like every other link type — it is signed by the
   * NEW device's own key (`session.newDevicePubkey`), which is the only
   * signing capability the recovering device actually possesses. The link
   * is still appended to the account's existing sigchain (`session.userPubkey`
   * never changes), so `userPubkey` remains the stable identifier used
   * everywhere else in the system. Verifiers accept this self-signed link
   * only because the payload's evidence — the session ID and the set of
   * contributing share holder pubkeys — can be independently checked
   * against `recovery_session_contributions`, and because the server only
   * accepts it once the session already reached `active` (≥ K contributions)
   * and its post-verification delay has elapsed.
   */
  async completeRecovery(params: {
    sessionId: string
    sigchainSeqNo: number
    sigchainPayload: Record<string, unknown>
    signature: string
    prevHash: string
    hash: string
    signerDeviceId: string
    timestamp: string
  }): Promise<{ sigchainLink: SigchainLinkInsert }> {
    const { sessionId, sigchainSeqNo, sigchainPayload, signature, prevHash, hash, signerDeviceId, timestamp } = params

    const sessions = await this.db
      .select()
      .from(recoverySessions)
      .where(eq(recoverySessions.sessionId, sessionId))
      .limit(1)

    if (sessions.length === 0) {
      throw new RecoveryGroupError('Session not found', 404)
    }

    const session = sessions[0]

    if (session.status !== 'active') {
      throw new RecoveryGroupError(
        `Cannot complete session in '${session.status}' state`,
        400,
      )
    }

    if (new Date() < session.expiresAt) {
      throw new RecoveryGroupError(
        'Recovery delay period has not elapsed',
        403,
      )
    }

    const contributions = await this.db
      .select({ contributorPubkey: recoverySessionContributions.contributorPubkey })
      .from(recoverySessionContributions)
      .where(eq(recoverySessionContributions.sessionId, sessionId))

    const group = await this.db
      .select({ threshold: hubRecoveryGroups.threshold })
      .from(hubRecoveryGroups)
      .where(eq(hubRecoveryGroups.hubId, session.hubId))
      .limit(1)

    const threshold = group[0]?.threshold ?? 2
    if (contributions.length < threshold) {
      throw new RecoveryGroupError('Threshold contributions not met', 400)
    }
    const contributorPubkeys = new Set(contributions.map((c) => c.contributorPubkey))

    // Bind the self-signed payload to verifiable evidence — the session it
    // claims to complete, and a set of ≥ threshold pubkeys that actually
    // contributed. A client cannot fabricate evidence the server doesn't
    // already have a record of.
    if (sigchainPayload.sessionId !== sessionId) {
      throw new RecoveryGroupError('Sigchain payload sessionId mismatch', 400)
    }
    const evidence = sigchainPayload.contributingHolderPubkeys
    if (
      !Array.isArray(evidence) ||
      evidence.length < threshold ||
      !evidence.every((pk) => typeof pk === 'string' && contributorPubkeys.has(pk))
    ) {
      throw new RecoveryGroupError(
        'Sigchain payload must list at least `threshold` verified contributing share holders',
        400,
      )
    }

    // Self-authorizing signature: verified against the NEW device's own key,
    // not the account's identity key — the account's identity key is exactly
    // what was lost and is why recovery was needed.
    let signatureValid: boolean
    try {
      signatureValid = ed25519Verify(
        hexToBytes(session.newDevicePubkey),
        hexToBytes(hash),
        hexToBytes(signature),
      )
    } catch {
      signatureValid = false
    }
    if (!signatureValid) {
      throw new RecoveryGroupError('Invalid recovery-device-add signature', 403)
    }

    let insertedLink!: SigchainLinkInsert

    await this.db.transaction(async (tx) => {
      const [currentHead] = await tx
        .select({ seqNo: sigchainLinks.seqNo, hash: sigchainLinks.hash })
        .from(sigchainLinks)
        .where(eq(sigchainLinks.userPubkey, session.userPubkey))
        .orderBy(desc(sigchainLinks.seqNo))
        .limit(1)

      const expectedSeqNo = currentHead === undefined ? SIGCHAIN_GENESIS_SEQ : currentHead.seqNo + 1
      const expectedPrevHash = currentHead?.hash ?? ''

      if (sigchainSeqNo !== expectedSeqNo) {
        throw new RecoveryGroupError(
          `sigchain sequence mismatch: expected ${expectedSeqNo}, got ${sigchainSeqNo}`,
          409,
        )
      }
      if (prevHash !== expectedPrevHash) {
        throw new RecoveryGroupError(
          'sigchain prevHash mismatch: does not match current chain head',
          409,
        )
      }

      const recomputedHash = computeEntryHash(
        sigchainSeqNo,
        prevHash === '' ? null : prevHash,
        timestamp,
        signerDeviceId,
        session.newDevicePubkey,
        sigchainPayload,
      )
      if (recomputedHash !== hash.toLowerCase()) {
        throw new RecoveryGroupError(
          'sigchain hash mismatch: recomputed hash does not match claimed hash',
          400,
        )
      }

      const [inserted] = await tx
        .insert(sigchainLinks)
        .values({
          userPubkey: session.userPubkey,
          seqNo: sigchainSeqNo,
          linkType: 'recovery-device-add',
          payload: sigchainPayload,
          signature,
          prevHash,
          hash,
          signerDeviceId,
          signerPubkey: session.newDevicePubkey,
          linkTimestamp: timestamp,
        })
        .returning()

      insertedLink = {
        id: inserted.id,
        userPubkey: inserted.userPubkey,
        seqNo: inserted.seqNo,
        linkType: inserted.linkType,
        payload: inserted.payload,
        signature: inserted.signature,
        prevHash: inserted.prevHash,
        hash: inserted.hash,
        signerDeviceId: inserted.signerDeviceId,
        signerPubkey: inserted.signerPubkey,
        createdAt: inserted.createdAt.toISOString(),
      }

      await tx
        .update(recoverySessions)
        .set({
          status: 'completed',
          completedAt: new Date(),
        })
        .where(eq(recoverySessions.sessionId, sessionId))
    })

    if (this.audit) {
      await this.audit.log(
        'recoveryCompleted',
        session.userPubkey,
        { sessionId, hubId: session.hubId, newDevicePubkey: session.newDevicePubkey },
        session.hubId,
      )
    }

    logger.info('Recovery session completed — device authorized via sigchain', {
      sessionId,
      hubId: session.hubId,
      newDevicePubkey: session.newDevicePubkey,
    })

    return { sigchainLink: insertedLink }
  }

  async putUserEnvelope(params: {
    userPubkey: string
    hubId: string
    envelope: string
  }): Promise<void> {
    const { userPubkey, hubId, envelope } = params

    await this.db
      .insert(userRecoveryEnvelopes)
      .values({
        userPubkey,
        hubId,
        envelope,
      })
      .onConflictDoUpdate({
        target: [userRecoveryEnvelopes.userPubkey, userRecoveryEnvelopes.hubId],
        set: {
          envelope,
          updatedAt: new Date(),
        },
      })

    logger.info('User recovery envelope upserted', { userPubkey, hubId })
  }

  async getUserEnvelope(sessionId: string, hubId: string): Promise<string | null> {
    const sessions = await this.db
      .select()
      .from(recoverySessions)
      .where(eq(recoverySessions.sessionId, sessionId))
      .limit(1)

    if (sessions.length === 0) {
      throw new RecoveryGroupError('Session not found', 404)
    }

    const session = sessions[0]

    // The caller-supplied `hubId` (a public route param — this endpoint is
    // unauthenticated and session-scoped, not hubRoles-scoped) must match
    // the session's own hub. Without this, a caller holding a valid session
    // for hub A could substitute hub B in the path and fetch that same
    // recovering user's hub-B envelope early, before any hub-B session of
    // their own reached this release gate. Same error as the unmet-gate
    // case below so the two are not distinguishable.
    if (session.hubId !== hubId) {
      throw new RecoveryGroupError(
        'Recovery envelope is not yet available for this session',
        403,
      )
    }

    // Same release gate as `getSession`'s contribution ciphertext: the
    // delay must have elapsed and the session must have reached `active`
    // (threshold met) or later. Gating on `completed` alone was backwards —
    // the recovering device needs this envelope's ciphertext to reconstruct
    // the PUK seed and complete the ceremony (which is what transitions the
    // session to `completed` in the first place).
    const delayElapsed = Date.now() >= session.expiresAt.getTime()
    const released = delayElapsed && (session.status === 'active' || session.status === 'completed')
    if (!released) {
      throw new RecoveryGroupError(
        'Recovery envelope is not yet available for this session',
        403,
      )
    }

    const envelope = await this.db
      .select({ envelope: userRecoveryEnvelopes.envelope })
      .from(userRecoveryEnvelopes)
      .where(
        and(
          eq(userRecoveryEnvelopes.userPubkey, session.userPubkey),
          eq(userRecoveryEnvelopes.hubId, hubId),
        ),
      )
      .limit(1)

    return envelope[0]?.envelope ?? null
  }

  async submitLivenessProof(params: {
    hubId: string
    holderPubkey: string
    proof: string
  }): Promise<void> {
    const { hubId, holderPubkey } = params

    const holders = await this.db
      .select({ holderPubkey: hubRecoveryGroupShares.holderPubkey })
      .from(hubRecoveryGroupShares)
      .where(
        and(
          eq(hubRecoveryGroupShares.hubId, hubId),
          eq(hubRecoveryGroupShares.holderPubkey, holderPubkey),
        ),
      )
      .limit(1)

    if (holders.length === 0) {
      throw new RecoveryGroupError('Not a share holder for this hub', 403)
    }

    await this.db
      .update(hubRecoveryGroupShares)
      .set({ lastLivenessProof: new Date() })
      .where(
        and(
          eq(hubRecoveryGroupShares.hubId, hubId),
          eq(hubRecoveryGroupShares.holderPubkey, holderPubkey),
        ),
      )

    logger.info('Share liveness proof submitted', { hubId, holderPubkey })
  }

  async applyEmergencyOverride(params: {
    sessionId: string
    approverPubkey: string
    justification: string
    signature: string
  }): Promise<void> {
    const { sessionId, approverPubkey, justification, signature } = params

    const sessions = await this.db
      .select()
      .from(recoverySessions)
      .where(eq(recoverySessions.sessionId, sessionId))
      .limit(1)

    if (sessions.length === 0) {
      throw new RecoveryGroupError('Session not found', 404)
    }

    const session = sessions[0]

    if (session.status !== 'verified' && session.status !== 'active') {
      throw new RecoveryGroupError(
        `Cannot apply emergency override to session in '${session.status}' state`,
        400,
      )
    }

    if (approverPubkey === session.userPubkey) {
      throw new RecoveryGroupError('Approver cannot be the recovering user', 403)
    }

    // Verify the approver's Ed25519 signature over the sessionId
    let signatureValid: boolean
    try {
      signatureValid = ed25519Verify(
        hexToBytes(approverPubkey),
        utf8ToBytes(sessionId),
        hexToBytes(signature),
      )
    } catch {
      signatureValid = false
    }
    if (!signatureValid) {
      throw new RecoveryGroupError('Invalid approver signature', 403)
    }

    const group = await this.db
      .select({ emergencyFloorHours: hubRecoveryGroups.emergencyFloorHours })
      .from(hubRecoveryGroups)
      .where(eq(hubRecoveryGroups.hubId, session.hubId))
      .limit(1)

    const emergencyFloorHours = group[0]?.emergencyFloorHours ?? 4
    const expiresAt = new Date(Date.now() + emergencyFloorHours * 60 * 60 * 1000)

    await this.db
      .update(recoverySessions)
      .set({
        status: 'active',
        signalVerified: true,
        expiresAt,
        emergencyOverride: {
          justification,
          approverPubkey,
          approverSignature: signature,
        },
      })
      .where(eq(recoverySessions.sessionId, sessionId))

    logger.info('Emergency override applied', { sessionId, approverPubkey })
  }

  /**
   * TEST-ONLY: directly create a recovery session in an arbitrary status,
   * bypassing the Signal verification ceremony (Phase 1). Exists solely so
   * BDD tests can exercise the contribution/completion flow without a live
   * signal-notifier sidecar or a way to intercept the out-of-band
   * verification code. Only reachable through the ENVIRONMENT=development
   * + X-Test-Secret-gated dev route in routes/dev.ts — never wired to any
   * authenticated or public production route.
   */
  async seedSessionForTesting(params: {
    hubId: string
    userPubkey: string
    newDevicePubkey: string
    status: 'pending' | 'verified' | 'active' | 'completed' | 'expired' | 'cancelled'
    expiresInMs: number
  }): Promise<{ sessionId: string }> {
    const { hubId, userPubkey, newDevicePubkey, status, expiresInMs } = params
    const [inserted] = await this.db
      .insert(recoverySessions)
      .values({
        hubId,
        userPubkey,
        newDevicePubkey,
        status,
        signalVerified: status !== 'pending',
        expiresAt: new Date(Date.now() + expiresInMs),
      })
      .returning({ sessionId: recoverySessions.sessionId })

    return { sessionId: inserted.sessionId }
  }
}

function generateVerificationCode(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  const num = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0
  return String(num % 1_000_000).padStart(VERIFICATION_CODE_LENGTH, '0')
}
