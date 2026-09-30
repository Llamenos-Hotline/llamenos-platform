import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskScheduler, type TaskSchedulerDeps } from '@worker/services/scheduler'
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

vi.mock('@worker/lib/erasure-expiry-worker', () => ({
  startErasureExpiryWorker: vi.fn(),
  stopErasureExpiryWorker: vi.fn(),
}))

vi.mock('@worker/lib/re-encryption-worker', () => ({
  startReEncryptionWorker: vi.fn(),
  stopReEncryptionWorker: vi.fn(),
}))

vi.mock('@worker/lib/audit-chain-verify-worker', () => ({
  startAuditChainVerifyWorker: vi.fn(),
  stopAuditChainVerifyWorker: vi.fn(),
}))

import { startBlastWorker, stopBlastWorker } from '@worker/lib/blast-delivery-worker'
import { startScheduledBlastPoller, stopScheduledBlastPoller } from '@worker/lib/blast-scheduled-poller'
import { startRetentionPurgeWorker, stopRetentionPurgeWorker } from '@worker/lib/retention-purge-worker'
import { startErasureExpiryWorker, stopErasureExpiryWorker } from '@worker/lib/erasure-expiry-worker'
import { startReEncryptionWorker, stopReEncryptionWorker } from '@worker/lib/re-encryption-worker'
import { startAuditChainVerifyWorker, stopAuditChainVerifyWorker } from '@worker/lib/audit-chain-verify-worker'

/**
 * Every worker TaskScheduler knows about, paired with its start and stop
 * function. Adding a worker to the scheduler without adding it here makes
 * the "starts every worker" test fail on the count assertion, which is the
 * point: #1127 was three implemented, tested workers that production never
 * started, and the old test only ever looked at the blast worker.
 */
const ALL_WORKERS = [
  { name: 'blast delivery', start: startBlastWorker, stop: stopBlastWorker },
  { name: 'scheduled blast poller', start: startScheduledBlastPoller, stop: stopScheduledBlastPoller },
  { name: 'retention purge', start: startRetentionPurgeWorker, stop: stopRetentionPurgeWorker },
  { name: 'erasure expiry', start: startErasureExpiryWorker, stop: stopErasureExpiryWorker },
  { name: 're-encryption', start: startReEncryptionWorker, stop: stopReEncryptionWorker },
  { name: 'audit chain verify', start: startAuditChainVerifyWorker, stop: stopAuditChainVerifyWorker },
] as const

describe('TaskScheduler', () => {
  function setup() {
    const { db } = createMockDb()
    const scheduler = new TaskScheduler(db as any)
    return { db, scheduler }
  }

  /**
   * A complete dep set. TaskSchedulerDeps requires every service, so this
   * object failing to typecheck is the compile-time guard that stopped
   * src/server/index.ts from omitting retentionService and erasureService.
   */
  function makeDeps(): TaskSchedulerDeps {
    return {
      blastsService: {} as any,
      settingsService: {} as any,
      auditService: {} as any,
      identityService: {} as any,
      retentionService: {} as any,
      erasureService: {} as any,
      resolveAdapter: async () => null,
      resolveIdentifier: async () => null,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('start', () => {
    it.each(ALL_WORKERS)('starts the $name worker', ({ start }) => {
      const { scheduler } = setup()
      scheduler.start(makeDeps())
      expect(start).toHaveBeenCalledTimes(1)
    })

    it('starts every worker it knows about — none is silently skipped', () => {
      const { scheduler } = setup()
      scheduler.start(makeDeps())

      const notStarted = ALL_WORKERS.filter((w) => (w.start as any).mock.calls.length === 0)
      expect(notStarted.map((w) => w.name)).toEqual([])
    })

    it('is idempotent — does not start twice', () => {
      const { scheduler } = setup()
      const deps = makeDeps()

      scheduler.start(deps)
      scheduler.start(deps)

      for (const { start } of ALL_WORKERS) {
        expect(start).toHaveBeenCalledTimes(1)
      }
    })

    it('does not start workers when no deps provided', () => {
      const { scheduler } = setup()
      scheduler.start()

      for (const { start } of ALL_WORKERS) {
        expect(start).not.toHaveBeenCalled()
      }
    })
  })

  describe('stop', () => {
    it('stops every worker it started', () => {
      const { scheduler } = setup()
      scheduler.start(makeDeps())
      scheduler.stop()

      for (const { stop } of ALL_WORKERS) {
        expect(stop).toHaveBeenCalledTimes(1)
      }
    })

    it('is idempotent — does not error when not started', () => {
      const { scheduler } = setup()
      expect(() => scheduler.stop()).not.toThrow()
      expect(stopBlastWorker).not.toHaveBeenCalled()
    })

    it('is idempotent — does not error when stopped twice', () => {
      const { scheduler } = setup()
      scheduler.start(makeDeps())
      scheduler.stop()
      scheduler.stop()

      for (const { stop } of ALL_WORKERS) {
        expect(stop).toHaveBeenCalledTimes(1)
      }
    })
  })
})
