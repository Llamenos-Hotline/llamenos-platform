import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskScheduler, type TaskSchedulerServiceDeps } from '@worker/services/scheduler'
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

import { startBlastWorker, stopBlastWorker } from '@worker/lib/blast-delivery-worker'
import { startScheduledBlastPoller, stopScheduledBlastPoller } from '@worker/lib/blast-scheduled-poller'
import { startRetentionPurgeWorker, stopRetentionPurgeWorker } from '@worker/lib/retention-purge-worker'
import { startAuditChainVerifyWorker, stopAuditChainVerifyWorker } from '@worker/lib/audit-chain-verify-worker'
import { startErasureExpiryWorker, stopErasureExpiryWorker } from '@worker/lib/erasure-expiry-worker'
import { startReEncryptionWorker, stopReEncryptionWorker } from '@worker/lib/re-encryption-worker'

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
  })
})
