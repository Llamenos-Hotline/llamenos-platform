/**
 * Erasure expiry worker — polls for pending erasure (user-scope) and hub
 * shred (hub-scope) requests that have passed their execute_at deadline and
 * executes them. The deadline is compared with the DATABASE clock, so a
 * worker whose wall clock is ahead can never execute a request early.
 */
import type { ErasureService } from '../services/erasure'
import type { AuditService } from '../services/audit'
import type { HubShredService } from '../services/hub-shred'
import { getConnectionManager } from './ws-manager'
import { createLogger } from './logger'

const logger = createLogger('lib.erasure-expiry')

/** Check interval: every 5 minutes */
const CHECK_INTERVAL_MS = 5 * 60 * 1000

let intervalId: ReturnType<typeof setInterval> | null = null

interface ErasureExpiryWorkerOpts {
  erasureService: ErasureService
  auditService: AuditService
  /** Required to execute hub-scope (crypto-shred) requests. */
  hubShred?: HubShredService
}

type ExpiredRequest = Awaited<ReturnType<ErasureService['getExpiredPendingRequests']>>[number]

/**
 * Claim and execute one expired request. Throws on execution failure (the
 * caller marks the request failed); returns silently when another worker won
 * the CAS claim.
 */
export async function processExpiredRequest(
  request: ExpiredRequest,
  opts: ErasureExpiryWorkerOpts,
): Promise<void> {
  if (request.scope === 'hub' || request.userId === null) {
    // Hub-scoped requests are crypto-shreds, not person erasures: they have
    // no userId and a different executor. Without a shred service they are
    // left pending rather than silently treated as a no-op person erasure.
    if (request.scope !== 'hub' || !request.hubId) return
    if (!opts.hubShred) return

    // IMP-2: CAS claim — skip if another worker already claimed it
    const claimed = await opts.erasureService.markExecuting(request.id)
    if (!claimed) return

    // A co-approved force override already carries the second pair of eyes;
    // anything else must respect platform retention floors. A refusal throws
    // (marking the request failed) and leaves the hub shred_pending — a
    // refused shred is never reported as shredded.
    if (!request.emergencyOverride) {
      const block = await opts.erasureService.hubShredRetentionBlock(request.hubId)
      if (block) {
        throw new Error(`Hub shred refused by retention floor: ${block}`)
      }
    }

    await opts.hubShred.execute(request.hubId, 'system', opts.auditService)
    await opts.erasureService.markCompleted(request.id)

    logger.info('Hub shred executed', { requestId: request.id, hubId: request.hubId })
    return
  }

  // IMP-2: CAS claim — skip if another worker already claimed it
  const claimed = await opts.erasureService.markExecuting(request.id)
  if (!claimed) return

  const userId = request.userId

  const { reEncryptionJobIds } =
    await opts.erasureService.executeErasure(
      userId,
      'system',
      request.justification ?? 'Self-service erasure delay expired',
      opts.auditService,
    )

  const wsManager = getConnectionManager()
  if (wsManager) {
    wsManager.sendSignedWipeToUser(userId, {
      type: 'device:wipe',
      targetUserId: userId,
      reason: 'user-erasure',
      timestamp: new Date().toISOString(),
    })
    wsManager.terminateUser(userId)
  }

  logger.info('Erasure executed', {
    requestId: request.id,
    userId: request.userId,
    reEncryptionJobs: reEncryptionJobIds.length,
  })
}

export function startErasureExpiryWorker(opts: ErasureExpiryWorkerOpts): void {
  if (intervalId) return

  logger.info('Started erasure expiry worker')

  const check = async () => {
    try {
      const expired = await opts.erasureService.getExpiredPendingRequests()
      if (expired.length === 0) return

      logger.info('Processing expired erasure requests', {
        count: expired.length,
      })

      for (const request of expired) {
        try {
          await processExpiredRequest(request, opts)
        } catch (err) {
          logger.error('Erasure execution failed', {
            requestId: request.id,
            error: err,
          })
          await opts.erasureService.markFailed(request.id)
        }
      }
    } catch (err) {
      logger.error('Erasure expiry check failed', { error: err })
    }
  }

  check()

  intervalId = setInterval(check, CHECK_INTERVAL_MS)
}

export function stopErasureExpiryWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped erasure expiry worker')
  }
}
