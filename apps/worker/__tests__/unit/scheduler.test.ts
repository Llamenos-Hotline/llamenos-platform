import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  TaskScheduler,
  SCHEDULER_WORKER_NAMES,
  type TaskSchedulerServiceDeps,
} from '@worker/services/scheduler'
import { createMockDb } from './mock-db'

vi.mock('@worker/lib/blast-delivery-worker', () => ({
  startBlastWorker: vi.fn(),
  stopBlastWorker: vi.fn(),
}))

vi.mock('@worker/lib/blast-scheduled-poller', () => ({
  startScheduledBlastPoller: vi.fn(),
  stopScheduledBlastPoller: vi.fn(),
}))

vi.mock('@worker/lib/retention-purge-worker', () => ({
  startRetentionPurgeWorker: vi.fn(),
  stopRetentionPurgeWorker: vi.fn(),
}))

vi.mock('@worker/lib/audit-chain-verify-worker', () => ({
  startAuditChainVerifyWorker: vi.fn(),
  stopAuditChainVerifyWorker: vi.fn(),
}))

vi.mock('@worker/lib/erasure-expiry-worker', () => ({
  startErasureExpiryWorker: vi.fn(),
  stopErasureExpiryWorker: vi.fn(),
}))

vi.mock('@worker/lib/re-encryption-worker', () => ({
  startReEncryptionWorker: vi.fn(),
  stopReEncryptionWorker: vi.fn(),
}))

vi.mock('@worker/lib/periodic-cleanup-worker', () => ({
  startPeriodicCleanupWorker: vi.fn(),
  stopPeriodicCleanupWorker: vi.fn(),
}))

vi.mock('@worker/lib/signal-queue-drain-worker', () => ({
  startSignalQueueDrainWorker: vi.fn(),
  stopSignalQueueDrainWorker: vi.fn(),
  createSignalQueueDrainOpts: vi.fn((db: unknown, resolveSignalAdapter: unknown) => ({
    queue: { __mockDb: db },
    resolveSignalAdapter,
  })),
}))

import { startBlastWorker, stopBlastWorker } from '@worker/lib/blast-delivery-worker'
import { startScheduledBlastPoller, stopScheduledBlastPoller } from '@worker/lib/blast-scheduled-poller'
import { startRetentionPurgeWorker, stopRetentionPurgeWorker } from '@worker/lib/retention-purge-worker'
import { startAuditChainVerifyWorker, stopAuditChainVerifyWorker } from '@worker/lib/audit-chain-verify-worker'
import { startErasureExpiryWorker, stopErasureExpiryWorker } from '@worker/lib/erasure-expiry-worker'
import { startReEncryptionWorker, stopReEncryptionWorker } from '@worker/lib/re-encryption-worker'
import { startPeriodicCleanupWorker, stopPeriodicCleanupWorker } from '@worker/lib/periodic-cleanup-worker'
import { startSignalQueueDrainWorker, stopSignalQueueDrainWorker } from '@worker/lib/signal-queue-drain-worker'

/**
 * Every worker the scheduler owns, with the dependency whose absence used to
 * disable it silently. The table is asserted whole: a worker added to
 * `start()` without a row here, or a row whose dependency stops arriving, is
 * visible as a failure rather than as a worker nobody notices is gone.
 */
const WORKERS = [
  { name: 'blast delivery', start: startBlastWorker, stop: stopBlastWorker, dep: 'blastsService' },
  { name: 'scheduled blast poller', start: startScheduledBlastPoller, stop: stopScheduledBlastPoller, dep: 'blastsService' },
  { name: 'retention purge', start: startRetentionPurgeWorker, stop: stopRetentionPurgeWorker, dep: 'retentionService' },
  { name: 'audit chain verify', start: startAuditChainVerifyWorker, stop: stopAuditChainVerifyWorker, dep: 'identityService' },
  { name: 'erasure expiry', start: startErasureExpiryWorker, stop: stopErasureExpiryWorker, dep: 'erasureService' },
  { name: 're-encryption', start: startReEncryptionWorker, stop: stopReEncryptionWorker, dep: 'erasureService' },
  { name: 'periodic cleanup', start: startPeriodicCleanupWorker, stop: stopPeriodicCleanupWorker, dep: 'identityService' },
  { name: 'signal queue drain', start: startSignalQueueDrainWorker, stop: stopSignalQueueDrainWorker, dep: 'resolveAdapter' },
] as const

/** Distinguishable sentinels, so a mis-wired field is visible in the assertion. */
function serviceDeps(): TaskSchedulerServiceDeps {
  return {
    blastsService: { __svc: 'blasts' } as never,
    settingsService: { __svc: 'settings' } as never,
    retentionService: { __svc: 'retention' } as never,
    auditService: { __svc: 'audit' } as never,
    erasureService: { __svc: 'erasure' } as never,
    identityService: { __svc: 'identity' } as never,
    hubShred: { __svc: 'hubShred' } as never,
  }
}

function deps() {
  return {
    ...serviceDeps(),
    resolveAdapter: async () => null,
    resolveIdentifier: async () => null,
  }
}

describe('TaskScheduler', () => {
  function setup() {
    const { db } = createMockDb()
    const scheduler = new TaskScheduler(db as never)
    return { db, scheduler }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('has a table row for every worker the scheduler registers', () => {
    // Keeps WORKERS honest: a worker added to SCHEDULER_WORKER_NAMES without a
    // row above would otherwise be untested by every `it.each` below.
    expect(WORKERS).toHaveLength(SCHEDULER_WORKER_NAMES.length)
  })

  describe('start', () => {
    it.each(WORKERS)('starts the $name worker', ({ start }) => {
      const { scheduler } = setup()
      scheduler.start(deps())
      expect(start).toHaveBeenCalledTimes(1)
    })

    it('is idempotent — does not start twice', () => {
      const { scheduler } = setup()
      const d = deps()
      scheduler.start(d)
      scheduler.start(d)
      for (const { start } of WORKERS) expect(start).toHaveBeenCalledTimes(1)
    })

    it('hands the erasure expiry worker the hub shred executor (#1566)', () => {
      const { scheduler } = setup()
      const d = deps()
      scheduler.start(d)
      // The shred executor is the dependency whose absence made every hub
      // crypto-shred a no-op: the worker returned before executing it.
      expect(startErasureExpiryWorker).toHaveBeenCalledWith(
        expect.objectContaining({ hubShred: d.hubShred }),
      )
    })

    it('reports every registered worker as started — a future dep addition without wiring must fail loudly, not silently skip one', () => {
      const { scheduler } = setup()

      scheduler.start(deps())

      const started = scheduler.getStartedWorkers()
      expect(started).toHaveLength(SCHEDULER_WORKER_NAMES.length)
      for (const name of SCHEDULER_WORKER_NAMES) {
        expect(started).toContain(name)
      }
    })

    it('passes identityService and settingsService to the periodic cleanup worker (drives IdentityService.cleanup() / SettingsService.runCleanup())', () => {
      const { scheduler } = setup()
      const d = deps()

      scheduler.start(d)

      expect(startPeriodicCleanupWorker).toHaveBeenCalledWith({
        identityService: d.identityService,
        settingsService: d.settingsService,
      })
    })

    it('resolves the Signal adapter for the queue drain worker via resolveAdapter("signal")', async () => {
      const { scheduler } = setup()
      const resolveAdapter = vi.fn(async () => null)
      const d = { ...deps(), resolveAdapter }

      scheduler.start(d)

      const call = vi.mocked(startSignalQueueDrainWorker).mock.calls[0]![0] as {
        resolveSignalAdapter: () => Promise<unknown>
      }
      await call.resolveSignalAdapter()
      expect(resolveAdapter).toHaveBeenCalledWith('signal')
    })
  })

  describe('stop', () => {
    it.each(WORKERS)('stops the $name worker', ({ stop }) => {
      const { scheduler } = setup()
      scheduler.start(deps())
      scheduler.stop()
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('is idempotent — does not error when not started', () => {
      const { scheduler } = setup()
      expect(() => scheduler.stop()).not.toThrow()
      for (const { stop } of WORKERS) expect(stop).not.toHaveBeenCalled()
    })

    it('is idempotent — does not error when stopped twice', () => {
      const { scheduler } = setup()
      scheduler.start(deps())
      scheduler.stop()
      scheduler.stop()
      for (const { stop } of WORKERS) expect(stop).toHaveBeenCalledTimes(1)
    })

    it('clears the started-workers list', () => {
      const { scheduler } = setup()
      scheduler.start(deps())
      scheduler.stop()

      expect(scheduler.getStartedWorkers()).toHaveLength(0)
    })
  })
})
