/**
 * ErasureService — manages account erasure lifecycle.
 *
 * Handles self-service erasure requests (with configurable delay),
 * admin immediate erasure, cryptographic cascade execution,
 * and re-encryption job queuing.
 */
import { eq, and, sql, desc, count, type SQL } from 'drizzle-orm'
import type { Database } from '../db'
import {
  erasureRequests,
  erasureConfig,
  reEncryptionJobs,
  auditUserKeys,
  users,
  auditLog,
  webauthnCredentials,
  provisionRooms,
  pukEnvelopes,
  sessions,
  devices,
  hubKeys,
  hubs,
  retentionPlatformFloors,
} from '../db/schema'
import { ServiceError } from './settings'
import { createLogger } from '../lib/logger'
import type { AuditService } from './audit'
import type { IdentityService } from './identity'
import { ed25519Verify } from '@llamenos/crypto/ffi'
import { hexToBytes, utf8ToBytes } from '@shared/encoding'
import { LABEL_ERASURE_OVERRIDE_SIG } from '@shared/crypto-labels'

const logger = createLogger('services.erasure')

// Emergency override minimum floor — hard-coded, not configurable
const EMERGENCY_MIN_HOURS = 4

// Per-hub erasure config defaults, applied until an admin saves a config row
export const DEFAULT_ERASURE_DELAY_HOURS = 72
export const DEFAULT_EMERGENCY_OVERRIDE_ENABLED = true
/** The undo window before a hub crypto-shred executes, when no config row exists. */
export const DEFAULT_HUB_SHRED_DELAY_HOURS = 48

/**
 * SQL predicate: `column` (a jsonb array of HPKE envelopes) holds an envelope
 * addressed to `pubkey`.
 *
 * Compares the pubkey as a text parameter, read out of each array element with
 * `->>`. The obvious-looking `column @> ${JSON.stringify([{ pubkey }])}::jsonb`
 * does NOT work: binding a JS *string* to a jsonb parameter position reaches
 * Postgres double-encoded — a jsonb *string scalar*, not an array — so the
 * containment matched nothing. Here that meant the gating COUNT came back 0 and
 * all three envelope-stripping UPDATEs touched 0 rows, so a removed or erased
 * user kept every envelope (and so the ability to decrypt the content) while
 * the job reported success. `identity.ts` carries the same warning for the same
 * reason; this is the corrected form.
 */
function hasEnvelopeFor(column: SQL, pubkey: string): SQL {
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${column}) AS envelope WHERE envelope->>'pubkey' = ${pubkey})`
}

const ADMIN_ROLES = ['role-super-admin', 'role-admin', 'role-hub-admin'] as const

/**
 * Blob-envelope-mirror deletion, injected by the service registry. The hub
 * shred leaves queued scope='hub' marker jobs in re_encryption_jobs when a
 * crash lands between the database commit and the object-store deletion; the
 * retry path here finishes those rather than losing the mirrors silently.
 */
export interface BlobMirrorDeleter {
  deleteEnvelopeMirrors(fileIds: string[]): Promise<void>
}

export class ErasureService {
  constructor(
    protected db: Database,
    private readonly identity?: Pick<IdentityService, 'getUserInternal'>,
    private readonly blobMirrors?: BlobMirrorDeleter,
  ) {}

  // ---------------------------------------------------------------------------
  // Erasure Config (per-hub)
  // ---------------------------------------------------------------------------

  async getConfig(hubId: string): Promise<{
    hubId: string
    delayHours: number
    hubShredDelayHours: number
    emergencyOverrideEnabled: boolean
    updatedAt: Date
    updatedBy: string
  } | null> {
    const [row] = await this.db
      .select()
      .from(erasureConfig)
      .where(eq(erasureConfig.hubId, hubId))
      .limit(1)
    return row ?? null
  }

  /**
   * The config that is actually in force for a hub: the saved row, or the
   * defaults when no admin has saved one yet (updatedAt/updatedBy null).
   */
  async getEffectiveConfig(hubId: string): Promise<{
    hubId: string
    delayHours: number
    hubShredDelayHours: number
    emergencyOverrideEnabled: boolean
    updatedAt: Date | null
    updatedBy: string | null
  }> {
    const row = await this.getConfig(hubId)
    return row ?? {
      hubId,
      delayHours: DEFAULT_ERASURE_DELAY_HOURS,
      hubShredDelayHours: DEFAULT_HUB_SHRED_DELAY_HOURS,
      emergencyOverrideEnabled: DEFAULT_EMERGENCY_OVERRIDE_ENABLED,
      updatedAt: null,
      updatedBy: null,
    }
  }

  async upsertConfig(
    hubId: string,
    updates: { delayHours?: number; emergencyOverrideEnabled?: boolean },
    updatedBy: string,
    platformMinDelayHours: number,
  ): Promise<void> {
    if (updates.delayHours !== undefined) {
      if (updates.delayHours < 24 || updates.delayHours > 168) {
        throw new ServiceError(400, 'delayHours must be between 24 and 168')
      }
      if (updates.delayHours < platformMinDelayHours) {
        throw new ServiceError(
          400,
          `delayHours cannot be less than platform floor (${platformMinDelayHours}h)`,
        )
      }
    }

    const existing = await this.getConfig(hubId)
    if (existing) {
      await this.db
        .update(erasureConfig)
        .set({
          ...(updates.delayHours !== undefined && {
            delayHours: updates.delayHours,
          }),
          ...(updates.emergencyOverrideEnabled !== undefined && {
            emergencyOverrideEnabled: updates.emergencyOverrideEnabled,
          }),
          updatedAt: new Date(),
          updatedBy,
        })
        .where(eq(erasureConfig.hubId, hubId))
    } else {
      await this.db.insert(erasureConfig).values({
        hubId,
        delayHours: updates.delayHours ?? DEFAULT_ERASURE_DELAY_HOURS,
        emergencyOverrideEnabled: updates.emergencyOverrideEnabled ?? DEFAULT_EMERGENCY_OVERRIDE_ENABLED,
        updatedAt: new Date(),
        updatedBy,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Erasure Request Lifecycle
  // ---------------------------------------------------------------------------

  async getMyRequest(userId: string): Promise<typeof erasureRequests.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(erasureRequests)
      .where(
        and(
          eq(erasureRequests.userId, userId),
          eq(erasureRequests.status, 'pending'),
        ),
      )
      .limit(1)
    return row ?? null
  }

  async createSelfRequest(
    userId: string,
    hubId: string,
    justification?: string,
    emergency?: {
      coApproverPubkey: string
      coApproverSignature: string
      timestamp: string
    },
  ): Promise<typeof erasureRequests.$inferSelect> {
    // Check for existing pending request
    const existing = await this.getMyRequest(userId)
    if (existing) {
      throw new ServiceError(409, 'Erasure request already pending')
    }

    // Get hub config for delay
    const config = await this.getConfig(hubId)
    const delayHours = config?.delayHours ?? DEFAULT_ERASURE_DELAY_HOURS

    let effectiveDelayHours = delayHours
    let isEmergency = false

    if (emergency) {
      await this.verifyCoApproval(userId, userId, emergency, config)
      effectiveDelayHours = EMERGENCY_MIN_HOURS
      isEmergency = true
    }

    const executeAt = new Date(Date.now() + effectiveDelayHours * 60 * 60 * 1000)

    const [row] = await this.db
      .insert(erasureRequests)
      .values({
        userId,
        status: 'pending',
        requestedBy: userId,
        requestedAt: new Date(),
        executeAt,
        justification: justification ?? null,
        emergencyOverride: isEmergency,
        coApproverPubkey: emergency?.coApproverPubkey ?? null,
        coApproverSignature: emergency?.coApproverSignature ?? null,
      })
      .returning()

    return row
  }

  async cancelSelfRequest(userId: string): Promise<void> {
    const existing = await this.getMyRequest(userId)
    if (!existing) {
      throw new ServiceError(404, 'No pending erasure request found')
    }

    await this.db
      .update(erasureRequests)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
      })
      .where(eq(erasureRequests.id, existing.id))
  }

  /**
   * One implementation of co-approval verification, two callers: a person's
   * erasure and a hub crypto-shred. The force override skips the WAIT, never
   * the second pair of eyes (spec §14.1). `signSubject` is what the signature
   * covers (the user id, or the hub id for a shred); `requester` is who asked
   * — the co-approver must never be the same party.
   */
  private async verifyCoApproval(
    signSubject: string,
    requester: string,
    emergency: {
      coApproverPubkey: string
      coApproverSignature: string
      timestamp: string
    },
    config: { emergencyOverrideEnabled: boolean } | null,
  ): Promise<void> {
    if (config && !config.emergencyOverrideEnabled) {
      throw new ServiceError(403, 'Emergency override is disabled for this hub')
    }
    if (emergency.coApproverPubkey === requester) {
      throw new ServiceError(400, 'Co-approver cannot be the same user as the requester')
    }

    // Verify co-approver Ed25519 signature over canonical message
    // Message: LABEL:signSubject:timestamp
    const sigMessage = utf8ToBytes(
      `${LABEL_ERASURE_OVERRIDE_SIG}:${signSubject}:${emergency.timestamp}`,
    )
    let sigValid = false
    try {
      sigValid = ed25519Verify(
        hexToBytes(emergency.coApproverPubkey),
        sigMessage,
        hexToBytes(emergency.coApproverSignature),
      )
    } catch {
      // invalid hex or malformed key — treat as verification failure
    }
    if (!sigValid) {
      throw new ServiceError(400, 'Co-approver signature verification failed')
    }

    // H01: Verify co-approver is a registered admin device
    const coApproverUser = await this.identity?.getUserInternal(emergency.coApproverPubkey) ?? null
    const isAdmin = coApproverUser?.roles.some(r => (ADMIN_ROLES as readonly string[]).includes(r)) ?? false
    if (!isAdmin) {
      throw new ServiceError(403, 'Co-approver must be a registered admin device')
    }
  }

  // ---------------------------------------------------------------------------
  // Hub shred request lifecycle
  // ---------------------------------------------------------------------------

  async getPendingHubShred(
    hubId: string,
  ): Promise<typeof erasureRequests.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(erasureRequests)
      .where(
        and(
          eq(erasureRequests.scope, 'hub'),
          eq(erasureRequests.hubId, hubId),
          eq(erasureRequests.status, 'pending'),
        ),
      )
      .limit(1)
    return row ?? null
  }

  /**
   * Schedule a hub crypto-shred. `executeAt` is written in SQL so the DATABASE
   * clock decides when the window has elapsed — never setTimeout, never a
   * faked Date on the app side. A verified emergency override executes
   * immediately (NOW()), skipping the wait but not the second approver.
   */
  async createHubShredRequest(
    hubId: string,
    requestedBy: string,
    justification?: string,
    emergency?: {
      coApproverPubkey: string
      coApproverSignature: string
      timestamp: string
    },
  ): Promise<typeof erasureRequests.$inferSelect> {
    const [hub] = await this.db.select().from(hubs).where(eq(hubs.id, hubId))
    if (!hub) {
      throw new ServiceError(404, 'Hub not found')
    }
    const existing = await this.getPendingHubShred(hubId)
    if (existing) {
      throw new ServiceError(409, 'A shred request is already pending for this hub')
    }

    const config = await this.getConfig(hubId)
    let isEmergency = false
    if (emergency) {
      await this.verifyCoApproval(hubId, requestedBy, emergency, config)
      isEmergency = true
    }

    const hours = config?.hubShredDelayHours ?? DEFAULT_HUB_SHRED_DELAY_HOURS
    const executeAt = isEmergency
      ? sql`NOW()`
      : sql`NOW() + (${hours} || ' hours')::interval`

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(erasureRequests)
        .values({
          scope: 'hub',
          hubId,
          userId: null,
          previousStatus: hub.status,
          status: 'pending',
          requestedBy,
          requestedAt: new Date(),
          executeAt,
          justification: justification ?? null,
          emergencyOverride: isEmergency,
          coApproverPubkey: emergency?.coApproverPubkey ?? null,
          coApproverSignature: emergency?.coApproverSignature ?? null,
        })
        .returning()

      // The hub is frozen for writes the moment the shred is scheduled. The
      // prior status is recorded on the request so a cancel inside the window
      // restores exactly what was there rather than guessing 'active'.
      await tx
        .update(hubs)
        .set({ status: 'shred_pending', updatedAt: new Date() })
        .where(eq(hubs.id, hubId))

      return row!
    })
  }

  async cancelHubShredRequest(hubId: string): Promise<void> {
    const existing = await this.getPendingHubShred(hubId)
    if (!existing) {
      throw new ServiceError(404, 'No pending shred request for this hub')
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(erasureRequests)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(erasureRequests.id, existing.id))
      await tx
        .update(hubs)
        .set({
          status: existing.previousStatus ?? 'active',
          updatedAt: new Date(),
        })
        .where(eq(hubs.id, hubId))
    })
  }

  /**
   * A hub shred may not destroy rows a platform retention floor still covers.
   * Returns the first blocking category, or null when the shred may proceed.
   * audit_log is exempt: a shred never deletes an audit row.
   */
  async hubShredRetentionBlock(hubId: string): Promise<string | null> {
    const floors = await this.db.select().from(retentionPlatformFloors)
    for (const floor of floors) {
      let count: number
      if (floor.category === 'call_records') {
        const rows = await this.db.execute<{ cnt: string }>(sql`
          SELECT COUNT(*) AS cnt FROM call_records
          WHERE hub_id = ${hubId}
            AND started_at > NOW() - (${floor.minRetentionDays} || ' days')::interval
        `)
        count = Number(rows[0]!.cnt)
      } else if (floor.category === 'notes') {
        const rows = await this.db.execute<{ cnt: string }>(sql`
          SELECT COUNT(*) AS cnt FROM notes
          WHERE hub_id = ${hubId}
            AND created_at > NOW() - (${floor.minRetentionDays} || ' days')::interval
        `)
        count = Number(rows[0]!.cnt)
      } else if (floor.category === 'messages') {
        const rows = await this.db.execute<{ cnt: string }>(sql`
          SELECT COUNT(*) AS cnt FROM messages m
          JOIN conversations c ON m.conversation_id = c.id
          WHERE c.hub_id = ${hubId}
            AND m.created_at > NOW() - (${floor.minRetentionDays} || ' days')::interval
        `)
        count = Number(rows[0]!.cnt)
      } else {
        continue // audit_log rows survive a shred — a floor cannot block it
      }
      if (count > 0) return floor.category
    }
    return null
  }

  async listRequests(
    filters: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<{
    requests: (typeof erasureRequests.$inferSelect)[]
    total: number
  }> {
    const { status, limit = 50, offset = 0 } = filters
    const conditions = status ? [eq(erasureRequests.status, status)] : []
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(erasureRequests)
        .where(where)
        .orderBy(desc(erasureRequests.requestedAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(erasureRequests)
        .where(where),
    ])

    return { requests: rows, total: Number(total) }
  }

  // ---------------------------------------------------------------------------
  // Erasure Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute the full cryptographic cascade for a user erasure.
   *
   * Phase 1 (revocation) and Phase 3 (crypto-shredding) happen here.
   * Phase 2 (server-side cleanup) is also transactional.
   * Phase 4 (re-encryption) is queued as a background job.
   */
  async executeErasure(
    userId: string,
    executedBy: string,
    justification: string,
    auditService: AuditService,
  ): Promise<{ reEncryptionJobIds: string[] }> {
    // CRIT-5: Fetch hub memberships BEFORE the transaction so we still have
    // hub_keys rows available. hub_keys are deleted inside the transaction.
    const hubMembershipsRows = await this.db.execute(sql`
      SELECT DISTINCT hub_id FROM hub_keys WHERE recipient_pubkey = ${userId}
      UNION
      SELECT DISTINCT hub_id FROM notes WHERE author_pubkey = ${userId}
    `)

    const reEncryptionJobIds: string[] = []

    await this.db.transaction(async (tx) => {
      // Phase 2: Server-side cleanup

      // Delete WebAuthn credentials
      await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.pubkey, userId))

      // Delete provision rooms where user is a participant
      await tx.delete(provisionRooms).where(eq(provisionRooms.primaryPubkey, userId))

      // Remove user from shift schedules (text[] — remove the departed user)
      await tx.execute(sql`
        UPDATE shifts
        SET user_pubkeys = array_remove(user_pubkeys, ${userId})
        WHERE ${userId} = ANY(user_pubkeys)
      `)

      // Delete sessions
      await tx.delete(sessions).where(eq(sessions.pubkey, userId))

      // Delete PUK envelopes addressed to the user
      await tx.delete(pukEnvelopes).where(eq(pukEnvelopes.userPubkey, userId))

      // Delete hub key envelopes addressed to the user
      await tx.delete(hubKeys).where(eq(hubKeys.recipientPubkey, userId))

      // Delete devices
      await tx.delete(devices).where(eq(devices.pubkey, userId))

      // Anonymize user row
      await tx
        .update(users)
        .set({
          status: 'erased',
          displayName: null,
          phone: null,
          active: false,
          encryptedSecretKey: '',
          availability: 'unavailable',
          updatedAt: new Date(),
        })
        .where(eq(users.pubkey, userId))

      // Phase 3: Crypto-shredding

      // Destroy per-user audit envelope key
      await tx.delete(auditUserKeys).where(eq(auditUserKeys.userPubkey, userId))

      // Replace actorPubkey with [erased] on audit entries and mark erasedAt
      await tx
        .update(auditLog)
        .set({
          actorPubkey: '[erased]',
          erasedAt: new Date(),
        })
        .where(eq(auditLog.actorPubkey, userId))

      // Scrub plaintext details on pre-EP08 audit entries
      await tx.execute(sql`
        UPDATE audit_log
        SET details = NULL, erased_at = NOW()
        WHERE actor_pubkey = '[erased]'
        AND erased_at IS NOT NULL
        AND details IS NOT NULL
        AND jsonb_typeof(details) != 'null'
      `)

      // RACE-10: Phase 4 — re-encryption job inserts INSIDE transaction.
      // If the process crashes after Phase 2+3 but before Phase 4, jobs would
      // be lost. Moving them inside ensures atomicity.
      for (const row of hubMembershipsRows as { hub_id: string }[]) {
        if (!row.hub_id) continue
        const [job] = await tx
          .insert(reEncryptionJobs)
          .values({
            userId,
            hubId: row.hub_id,
            status: 'queued',
          })
          .returning()
        reEncryptionJobIds.push(job.id)
      }

      // Update erasure request status INSIDE transaction
      await tx
        .update(erasureRequests)
        .set({
          status: 'completed',
          executedAt: new Date(),
        })
        .where(
          and(
            eq(erasureRequests.userId, userId),
            eq(erasureRequests.status, 'executing'),
          ),
        )

      // CRIT-1: Audit log recorded INSIDE transaction — only committed if erasure succeeds
      await auditService.log('userErasureExecuted', executedBy, {
        targetUserId: userId,
        justification,
      })
    })

    return { reEncryptionJobIds }
  }

  // ---------------------------------------------------------------------------
  // Pending erasure execution (called by scheduler)
  // ---------------------------------------------------------------------------

  async getExpiredPendingRequests(): Promise<(typeof erasureRequests.$inferSelect)[]> {
    return this.db
      .select()
      .from(erasureRequests)
      .where(
        and(
          eq(erasureRequests.status, 'pending'),
          // The database clock decides — both scopes — so a worker whose wall
          // clock is ahead can never execute a request a second early.
          sql`execute_at < NOW()`,
        ),
      )
  }

  /**
   * Atomically claim a pending request for execution.
   * Returns true if this caller won the race; false if already claimed by another worker.
   */
  async markExecuting(requestId: string): Promise<boolean> {
    const rows = await this.db
      .update(erasureRequests)
      .set({ status: 'executing' })
      .where(and(eq(erasureRequests.id, requestId), eq(erasureRequests.status, 'pending')))
      .returning({ id: erasureRequests.id })
    return rows.length > 0
  }

  async markFailed(requestId: string): Promise<void> {
    await this.db
      .update(erasureRequests)
      .set({ status: 'failed' })
      .where(eq(erasureRequests.id, requestId))
  }

  async markCompleted(requestId: string): Promise<void> {
    await this.db
      .update(erasureRequests)
      .set({ status: 'completed', executedAt: new Date() })
      .where(eq(erasureRequests.id, requestId))
  }

  // ---------------------------------------------------------------------------
  // Re-encryption jobs
  // ---------------------------------------------------------------------------

  async listReEncryptionJobs(
    userId?: string,
  ): Promise<(typeof reEncryptionJobs.$inferSelect)[]> {
    const condition = userId
      ? eq(reEncryptionJobs.userId, userId)
      : undefined
    return this.db
      .select()
      .from(reEncryptionJobs)
      .where(condition)
      .orderBy(desc(reEncryptionJobs.createdAt))
  }

  async getQueuedReEncryptionJobs(): Promise<(typeof reEncryptionJobs.$inferSelect)[]> {
    return this.db
      .select()
      .from(reEncryptionJobs)
      .where(eq(reEncryptionJobs.status, 'queued'))
      .limit(10)
  }

  async updateReEncryptionJobProgress(
    jobId: string,
    processedEnvelopes: number,
    totalEnvelopes: number,
  ): Promise<void> {
    await this.db
      .update(reEncryptionJobs)
      .set({
        processedEnvelopes,
        totalEnvelopes,
        status: processedEnvelopes >= totalEnvelopes ? 'completed' : 'running',
        startedAt: sql`COALESCE(started_at, NOW())`,
        completedAt:
          processedEnvelopes >= totalEnvelopes ? new Date() : undefined,
      })
      .where(eq(reEncryptionJobs.id, jobId))
  }

  /**
   * Process a single re-encryption job: remove departed user's envelope copies.
   */
  async processReEncryptionJob(jobId: string): Promise<void> {
    const [job] = await this.db
      .select()
      .from(reEncryptionJobs)
      .where(eq(reEncryptionJobs.id, jobId))
      .limit(1)

    if (!job || job.status === 'completed') return

    // Scope='hub' rows are blob-envelope-mirror markers left by the hub shred,
    // not per-user envelope strips. The file rows survive a shred (only their
    // envelopes go), so the ids are re-derivable here and a crash between the
    // shred commit and the mirror deletion is retried, not lost.
    if (job.scope === 'hub') {
      if (this.blobMirrors) {
        const fileRows = await this.db.execute<{ id: string }>(sql`
          SELECT f.id FROM files f
          JOIN conversations c ON f.conversation_id = c.id
          WHERE c.hub_id = ${job.hubId}
        `)
        const fileIds = fileRows.map(r => r.id)
        if (fileIds.length > 0) {
          await this.blobMirrors.deleteEnvelopeMirrors(fileIds)
        }
      } else {
        logger.error('Hub mirror marker queued but no blob mirror deleter injected', {
          jobId: job.id,
          hubId: job.hubId,
        })
      }
      await this.db
        .update(reEncryptionJobs)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(reEncryptionJobs.id, jobId))
      return
    }

    // A user-scope job whose hub has been shredded has nothing left to strip:
    // the shred already destroyed every envelope. Complete, never stall.
    const [hub] = await this.db.execute<{ status: string }>(
      sql`SELECT status FROM hubs WHERE id = ${job.hubId}`,
    )
    if (hub?.status === 'shredded') {
      await this.db
        .update(reEncryptionJobs)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(reEncryptionJobs.id, jobId))
      return
    }

    // A user-scope job with no user is unprocessable: every predicate below
    // would compare against NULL, match nothing, and the job would report
    // completion having stripped no envelopes — the exact silent success this
    // whole path is being fixed for. Leave it queued and say so.
    if (job.userId === null) {
      logger.error('User-scope re-encryption job has no user — not processing', {
        jobId: job.id,
        hubId: job.hubId,
      })
      return
    }

    const userPubkey = job.userId
    const hubId = job.hubId

    const noteCount = await this.db.execute(sql`
      SELECT COUNT(*) as cnt FROM notes
      WHERE hub_id = ${hubId}
      AND (
        ${hasEnvelopeFor(sql`admin_envelopes`, userPubkey)}
        OR author_envelope->>'pubkey' = ${userPubkey}
      )
    `)

    const replyCount = await this.db.execute(sql`
      SELECT COUNT(*) as cnt FROM note_replies nr
      JOIN notes n ON nr.note_id = n.id
      WHERE n.hub_id = ${hubId}
      AND ${hasEnvelopeFor(sql`nr.reader_envelopes`, userPubkey)}
    `)

    const messageCount = await this.db.execute(sql`
      SELECT COUNT(*) as cnt FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.hub_id = ${hubId}
      AND ${hasEnvelopeFor(sql`m.reader_envelopes`, userPubkey)}
    `)

    const total =
      Number((noteCount[0] as { cnt: string }).cnt) +
      Number((replyCount[0] as { cnt: string }).cnt) +
      Number((messageCount[0] as { cnt: string }).cnt)

    await this.updateReEncryptionJobProgress(jobId, 0, total)

    if (total === 0) {
      return
    }

    let processed = 0

    await this.db.execute(sql`
      UPDATE notes
      SET admin_envelopes = (
        SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(admin_envelopes) elem
        WHERE elem->>'pubkey' != ${userPubkey}
      )
      WHERE hub_id = ${hubId}
      AND ${hasEnvelopeFor(sql`admin_envelopes`, userPubkey)}
    `)
    processed += Number((noteCount[0] as { cnt: string }).cnt)
    await this.updateReEncryptionJobProgress(jobId, processed, total)

    await this.db.execute(sql`
      UPDATE note_replies
      SET reader_envelopes = (
        SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(reader_envelopes) elem
        WHERE elem->>'pubkey' != ${userPubkey}
      )
      WHERE note_id IN (SELECT id FROM notes WHERE hub_id = ${hubId})
      AND ${hasEnvelopeFor(sql`reader_envelopes`, userPubkey)}
    `)
    processed += Number((replyCount[0] as { cnt: string }).cnt)
    await this.updateReEncryptionJobProgress(jobId, processed, total)

    await this.db.execute(sql`
      UPDATE messages
      SET reader_envelopes = (
        SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(reader_envelopes) elem
        WHERE elem->>'pubkey' != ${userPubkey}
      )
      WHERE conversation_id IN (
        SELECT id FROM conversations WHERE hub_id = ${hubId}
      )
      AND ${hasEnvelopeFor(sql`reader_envelopes`, userPubkey)}
    `)
    processed += Number((messageCount[0] as { cnt: string }).cnt)
    await this.updateReEncryptionJobProgress(jobId, processed, total)
  }

  // ---------------------------------------------------------------------------
  // Audit user key management
  // ---------------------------------------------------------------------------

  async getAuditUserKey(
    userPubkey: string,
  ): Promise<typeof auditUserKeys.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(auditUserKeys)
      .where(eq(auditUserKeys.userPubkey, userPubkey))
      .limit(1)
    return row ?? null
  }

  async upsertAuditUserKey(
    userPubkey: string,
    encryptedKey: string,
    adminEnvelopes: unknown[],
  ): Promise<void> {
    await this.db
      .insert(auditUserKeys)
      .values({
        userPubkey,
        encryptedKey,
        adminEnvelopes,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: auditUserKeys.userPubkey,
        set: {
          encryptedKey,
          adminEnvelopes,
        },
      })
  }
}
