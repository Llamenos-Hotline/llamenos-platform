/**
 * Audit chain verification worker — periodically walks every audit hash chain
 * and raises an admin-visible security event when one fails to verify.
 *
 * The hash chain (Epic 77) only protects anything if somebody checks it. A
 * failure is recorded as an `audit_chain_broken` security event (no user
 * attached — it is about the server's own log) and logged at error level.
 */
import type { AuditService } from '../services/audit'
import type { IdentityService } from '../services/identity'
import { createLogger } from './logger'
import { trackWorkerTick, WORKER_TICK_INTERVAL_MS } from '../metrics/worker-liveness'

const logger = createLogger('lib.audit-chain-verify')

/** Verify every chain hourly. */
export const AUDIT_VERIFY_INTERVAL_MS = WORKER_TICK_INTERVAL_MS['audit-chain-verify']
/** First pass shortly after boot, so a tampered log is flagged without waiting an hour. */
const INITIAL_DELAY_MS = 60 * 1000

export const AUDIT_CHAIN_BROKEN_EVENT = 'audit_chain_broken'

interface AuditChainVerifyWorkerOpts {
  auditService: AuditService
  identityService: IdentityService
}

let intervalId: ReturnType<typeof setInterval> | null = null
let initialTimeoutId: ReturnType<typeof setTimeout> | null = null

/**
 * Broken entry already reported per chain, so an unchanged break raises one
 * event rather than one per run. A different broken entry (or a break after a
 * clean run) is reported again.
 */
const reportedBreaks = new Map<string, string>()

/**
 * Verify every chain once. Returns the number of chains that failed.
 * Exported for tests; the scheduler calls it through the worker below.
 */
export async function verifyAllAuditChains(opts: AuditChainVerifyWorkerOpts): Promise<number> {
  const chains = await opts.auditService.listChainHubIds()
  let failed = 0

  for (const hubId of chains) {
    const chainKey = hubId ?? 'platform'
    try {
      const result = await opts.auditService.verifyFullChain(hubId ?? undefined)
      if (result.valid) {
        reportedBreaks.delete(chainKey)
        continue
      }

      failed++
      const broken = result.firstBrokenEntry
      const brokenId = broken?.id ?? 'unknown'
      logger.error('Audit hash chain failed verification', {
        chain: chainKey,
        entryId: brokenId,
        reason: broken?.reason,
        seqIndex: broken?.seqIndex,
      })

      if (reportedBreaks.get(chainKey) === brokenId) continue
      await opts.identityService.emitSecurityEvent(null, AUDIT_CHAIN_BROKEN_EVENT, null, {
        hubId,
        entryId: brokenId,
        seqIndex: broken?.seqIndex,
        reason: broken?.reason,
        totalEntries: result.totalEntries,
        checkedEntries: result.checkedEntries,
      })
      reportedBreaks.set(chainKey, brokenId)
    } catch (err) {
      logger.error('Audit chain verification errored', { chain: chainKey, error: err })
    }
  }

  return failed
}

export function startAuditChainVerifyWorker(opts: AuditChainVerifyWorkerOpts): void {
  if (intervalId) return

  logger.info('Started audit chain verify worker')

  const run = () => {
    trackWorkerTick('audit-chain-verify', () => verifyAllAuditChains(opts)).catch((err) => {
      logger.error('Audit chain verification run failed', { error: err })
    })
  }

  initialTimeoutId = setTimeout(run, INITIAL_DELAY_MS)
  intervalId = setInterval(run, AUDIT_VERIFY_INTERVAL_MS)
}

export function stopAuditChainVerifyWorker(): void {
  if (initialTimeoutId) {
    clearTimeout(initialTimeoutId)
    initialTimeoutId = null
  }
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped audit chain verify worker')
  }
  reportedBreaks.clear()
}
