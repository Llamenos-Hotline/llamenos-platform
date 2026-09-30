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
import type { RetentionService } from './retention'
import type { ErasureService } from './erasure'
import type { AuditService } from './audit'
import type { IdentityService } from './identity'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.scheduler')

export interface TaskSchedulerDeps {
  blastsService: BlastsService
  settingsService: SettingsService
  resolveAdapter: AdapterResolver
  resolveIdentifier: (subscriberId: string) => Promise<string | null>
  onBlastProgress?: BlastProgressCallback
  onBlastStatusChange?: BlastStatusCallback

  // These four were optional, and `start()` gated each worker behind an
  // `if (deps.x)`. src/server/index.ts omitted retentionService and
  // erasureService, so the retention-purge, erasure-expiry and
  // re-encryption workers never started in production -- and it
  // typechecked, because the deps were optional (#1127). For an
  // EU/GDPR-scoped deployment that meant data-retention deletion and
  // right-to-erasure expiry had never once executed.
  //
  // They are required now. Omitting one is a compile error, not a
  // silently disabled worker.
  retentionService: RetentionService
  auditService: AuditService
  erasureService: ErasureService
  identityService: IdentityService
}

export class TaskScheduler {
  private started = false

  constructor(protected db: Database) {}

  /**
   * Start all background task workers.
   * Call this after all services are initialized.
   */
  start(deps?: TaskSchedulerDeps): void {
    if (this.started) return
    this.started = true

    if (deps) {
      // Start blast delivery worker
      startBlastWorker({
        blastsService: deps.blastsService,
        settingsService: deps.settingsService,
        resolveAdapter: deps.resolveAdapter,
        resolveIdentifier: deps.resolveIdentifier,
        onProgress: deps.onBlastProgress,
        onStatusChange: deps.onBlastStatusChange,
      })

      // Start scheduled blast poller
      startScheduledBlastPoller(deps.blastsService)

      // No `if (deps.x)` guards: every dep is required by the type, so
      // every worker the scheduler knows about starts whenever the
      // scheduler starts. A future worker whose dep is forgotten fails
      // the build instead of quietly never running.
      startRetentionPurgeWorker({
        retentionService: deps.retentionService,
        auditService: deps.auditService,
        settingsService: deps.settingsService,
      })

      startAuditChainVerifyWorker({
        auditService: deps.auditService,
        identityService: deps.identityService,
      })

      startErasureExpiryWorker({
        erasureService: deps.erasureService,
        auditService: deps.auditService,
      })

      startReEncryptionWorker({
        erasureService: deps.erasureService,
      })
    }

    logger.info('Started')
  }

  /**
   * Stop all background task workers.
   */
  stop(): void {
    if (!this.started) return
    this.started = false

    stopBlastWorker()
    stopScheduledBlastPoller()
    stopRetentionPurgeWorker()
    stopAuditChainVerifyWorker()
    stopErasureExpiryWorker()
    stopReEncryptionWorker()

    logger.info('Stopped')
  }
}
