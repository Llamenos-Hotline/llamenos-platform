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
  startStaleCallReaperWorker,
  stopStaleCallReaperWorker,
} from '../lib/stale-call-reaper-worker'
import type { RetentionService } from './retention'
import type { ErasureService } from './erasure'
import type { AuditService } from './audit'
import type { IdentityService } from './identity'
import type { HubShredService } from './hub-shred'
import type { CallsService } from './calls'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.scheduler')

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
  callsService: CallsService
}

export interface TaskSchedulerDeps extends TaskSchedulerServiceDeps {
  resolveAdapter: AdapterResolver
  resolveIdentifier: (subscriberId: string) => Promise<string | null>
  onBlastProgress?: BlastProgressCallback
  onBlastStatusChange?: BlastStatusCallback
}

export class TaskScheduler {
  private started = false

  constructor(protected db: Database) {}

  /**
   * Start all background task workers.
   * Call this after all services are initialized.
   */
  start(deps: TaskSchedulerDeps): void {
    if (this.started) return
    this.started = true

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

    startScheduledBlastPoller(deps.blastsService)

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
      hubShred: deps.hubShred,
    })

    startReEncryptionWorker({
      erasureService: deps.erasureService,
    })

    // Stuck-call reaper: archives stale `active_calls` rows for EVERY hub on a
    // fixed schedule. Previously this only happened lazily, as a side effect of
    // `CallsService.getActiveCalls(hubId)` — so a hub with no open dashboard
    // leaked `active_calls`/`call_tokens` rows indefinitely (#1136).
    startStaleCallReaperWorker(deps.callsService)

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
    stopStaleCallReaperWorker()

    logger.info('Stopped')
  }
}
