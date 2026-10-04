/**
 * Erasure expiry worker — polls for pending self-service erasure
 * requests that have passed their executeAt deadline and executes them.
 */
import type { ErasureService } from '../services/erasure'
import type { AuditService } from '../services/audit'
import { getConnectionManager } from './ws-manager'
import { createLogger } from './logger'

const logger = createLogger('lib.erasure-expiry')

/** Check interval: every 5 minutes */
const CHECK_INTERVAL_MS = 5 * 60 * 1000

let intervalId: ReturnType<typeof setInterval> | null = null

interface ErasureExpiryWorkerOpts {
  erasureService: ErasureService
  auditService: AuditService
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
          // Hub-scoped requests are crypto-shreds, not person erasures: they
          // have no userId and a different executor. Until that branch exists
          // they are left pending rather than claimed, so nothing silently
          // treats a hub shred as a no-op person erasure.
          if (request.scope !== 'user' || request.userId === null) continue

          // IMP-2: CAS claim — skip if another worker already claimed it
          const claimed = await opts.erasureService.markExecuting(request.id)
          if (!claimed) continue

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
