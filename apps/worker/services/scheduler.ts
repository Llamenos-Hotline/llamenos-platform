/**
 * TaskScheduler — periodic background task runner.
 *
 * Manages the blast delivery worker and scheduled blast poller.
 * Started at server boot; stopped on graceful shutdown.
 */
import type { Database } from '../db'
import type { BlastsService } from './blasts'
import type { SettingsService } from './settings'
import {
  startBlastWorker,
  stopBlastWorker,
  type AdapterResolver,
  type BlastProgressCallback,
  type BlastStatusCallback,
} from '../lib/blast-delivery-worker'
import {
  startScheduledBlastPoller,
  stopScheduledBlastPoller,
} from '../lib/blast-scheduled-poller'
import {
  startRetentionPurgeWorker,
  stopRetentionPurgeWorker,
} from '../lib/retention-purge-worker'
import {
  startErasureExpiryWorker,
  stopErasureExpiryWorker,
} from '../lib/erasure-expiry-worker'
import {
  startReEncryptionWorker,
  stopReEncryptionWorker,
} from '../lib/re-encryption-worker'
import {
  startAuditChainVerifyWorker,
  stopAuditChainVerifyWorker,
} from '../lib/audit-chain-verify-worker'
import {
  startPeriodicCleanupWorker,
  stopPeriodicCleanupWorker,
} from '../lib/periodic-cleanup-worker'
import {
  startSignalQueueDrainWorker,
  stopSignalQueueDrainWorker,
  createSignalQueueDrainOpts,
} from '../lib/signal-queue-drain-worker'
import type { RetentionService } from './retention'
import type { ErasureService } from './erasure'
import type { AuditService } from './audit'
import type { IdentityService } from './identity'
import type { HubShredService } from './hub-shred'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.scheduler')

/**
 * Every background worker the scheduler is responsible for starting.
 * `start()` asserts it started all of these before returning — see the
 * assertion at the bottom of `start()`. Add a new worker here FIRST, then
 * wire it in `start()`/`stop()`: the assertion will fail loudly instead of
 * silently never starting it, which is exactly how the retention, erasure,
 * identity-cleanup and Signal-drain workers went unnoticed (issue #1127).
 */
export const SCHEDULER_WORKER_NAMES = [
  'blast-delivery',
  'scheduled-blast-poller',
  'retention-purge',
  'audit-chain-verify',
  'erasure-expiry',
  're-encryption',
  'periodic-cleanup',
  'signal-queue-drain',
] as const

export type SchedulerWorkerName = (typeof SCHEDULER_WORKER_NAMES)[number]

/**
 * The service-registry half of the scheduler's dependencies.
 *
 * Every field is REQUIRED, and `schedulerServiceDeps()` (services/index.ts) is
 * the only thing that builds it. That is deliberate: these fields used to be
 * optional and each worker was gated on `if (deps.x)`, so the entrypoint could
 * omit one and nothing — not tsc, not a test, not a log line — would say so.
 * Three workers were dead on every deployment for that reason (#1127, #1566).
 * An omission here is now a compile error at the call site.
 */
export type TaskSchedulerServiceDeps = {
  blastsService: BlastsService
  settingsService: SettingsService
  retentionService: RetentionService
  auditService: AuditService
  erasureService: ErasureService
  identityService: IdentityService
  hubShred: HubShredService
}

export interface TaskSchedulerDeps extends TaskSchedulerServiceDeps {
  resolveAdapter: AdapterResolver
  resolveIdentifier: (subscriberId: string) => Promise<string | null>
  onBlastProgress?: BlastProgressCallback
  onBlastStatusChange?: BlastStatusCallback
}

export class TaskScheduler {
  private started = false
  private startedWorkers: SchedulerWorkerName[] = []

  constructor(protected db: Database) {}

  /**
   * Names of workers started by the most recent `start()` call. Empty
   * before the first `start()` or after `stop()`. Exists so a test (and,
   * at boot, a human reading logs) can assert every worker the scheduler
   * knows about actually started — see SCHEDULER_WORKER_NAMES.
   */
  getStartedWorkers(): readonly SchedulerWorkerName[] {
    return this.startedWorkers
  }

  /**
   * Start all background task workers.
   * Call this after all services are initialized.
   */
  start(deps: TaskSchedulerDeps): void {
    if (this.started) return
    this.started = true

    const started: SchedulerWorkerName[] = []

    // No `if (deps.x)` gates: every dependency is required, so a worker that
    // is listed here always runs. A missing one cannot reach this method.
    startBlastWorker({
      blastsService: deps.blastsService,
      settingsService: deps.settingsService,
      resolveAdapter: deps.resolveAdapter,
      resolveIdentifier: deps.resolveIdentifier,
      onProgress: deps.onBlastProgress,
      onStatusChange: deps.onBlastStatusChange,
    })
    started.push('blast-delivery')

    startScheduledBlastPoller(deps.blastsService)
    started.push('scheduled-blast-poller')

    startRetentionPurgeWorker({
      retentionService: deps.retentionService,
      auditService: deps.auditService,
      settingsService: deps.settingsService,
    })
    started.push('retention-purge')

    startAuditChainVerifyWorker({
      auditService: deps.auditService,
      identityService: deps.identityService,
    })
    started.push('audit-chain-verify')

    startErasureExpiryWorker({
      erasureService: deps.erasureService,
      auditService: deps.auditService,
      hubShred: deps.hubShred,
    })
    started.push('erasure-expiry')

    startReEncryptionWorker({
      erasureService: deps.erasureService,
    })
    started.push('re-encryption')

    // Periodic cleanup: IdentityService.cleanup() (sessions, WebAuthn
    // challenges, provision rooms, invite codes, auth nonces) and
    // SettingsService.runCleanup() (rate limits, CAPTCHA challenges) plus
    // the API rate-limit fixed-window purge. See issue #1127 — auth_nonces
    // gained one row per authenticated request with nothing ever deleting
    // expired ones until this worker existed.
    startPeriodicCleanupWorker({
      identityService: deps.identityService,
      settingsService: deps.settingsService,
    })
    started.push('periodic-cleanup')

    // Signal retry queue drain: claims pending signal_message_queue rows
    // and attempts delivery, letting markFailed's own backoff/dead-letter
    // logic run. See issue #1127 — claimBatch() had no caller at all.
    startSignalQueueDrainWorker(
      createSignalQueueDrainOpts(this.db, () => deps.resolveAdapter('signal')),
    )
    started.push('signal-queue-drain')

    this.startedWorkers = started

    const missing = SCHEDULER_WORKER_NAMES.filter((name) => !started.includes(name))
    if (missing.length > 0) {
      // Should be unreachable — every name above is pushed unconditionally.
      // Guards against a future edit that reintroduces a conditional start
      // without updating this list, which is the exact failure class this
      // scheduler shipped with for retention/erasure/cleanup/signal-drain.
      throw new Error(`TaskScheduler.start() did not start: ${missing.join(', ')}`)
    }

    logger.info('Started', { workers: this.startedWorkers })
  }

  /**
   * Stop all background task workers.
   */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.startedWorkers = []

    stopBlastWorker()
    stopScheduledBlastPoller()
    stopRetentionPurgeWorker()
    stopAuditChainVerifyWorker()
    stopErasureExpiryWorker()
    stopReEncryptionWorker()
    stopPeriodicCleanupWorker()
    stopSignalQueueDrainWorker()

    logger.info('Stopped')
  }
}
