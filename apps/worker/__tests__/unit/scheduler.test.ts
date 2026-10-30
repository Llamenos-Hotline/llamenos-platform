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

vi.mock('@worker/lib/stale-call-reaper-worker', () => ({
  startStaleCallReaperWorker: vi.fn(),
  stopStaleCallReaperWorker: vi.fn(),
}))

vi.mock('@worker/lib/provider-recording-sweep-worker', () => ({
  startProviderRecordingSweepWorker: vi.fn(),
  stopProviderRecordingSweepWorker: vi.fn(),
}))

vi.mock('@worker/lib/incident-checks-worker', () => ({
  startIncidentChecksWorker: vi.fn(),
  stopIncidentChecksWorker: vi.fn(),
}))

vi.mock('@worker/lib/incident-closer-worker', () => ({
  startIncidentCloserWorker: vi.fn(),
  stopIncidentCloserWorker: vi.fn(),
}))

import { startBlastWorker, stopBlastWorker } from '@worker/lib/blast-delivery-worker'
import { startScheduledBlastPoller, stopScheduledBlastPoller } from '@worker/lib/blast-scheduled-poller'
import { startRetentionPurgeWorker, stopRetentionPurgeWorker } from '@worker/lib/retention-purge-worker'
import { startAuditChainVerifyWorker, stopAuditChainVerifyWorker } from '@worker/lib/audit-chain-verify-worker'
import { startErasureExpiryWorker, stopErasureExpiryWorker } from '@worker/lib/erasure-expiry-worker'
import { startReEncryptionWorker, stopReEncryptionWorker } from '@worker/lib/re-encryption-worker'
import { startPeriodicCleanupWorker, stopPeriodicCleanupWorker } from '@worker/lib/periodic-cleanup-worker'
import {
  createSignalQueueDrainOpts,
  startSignalQueueDrainWorker,
  stopSignalQueueDrainWorker,
} from '@worker/lib/signal-queue-drain-worker'
import { startStaleCallReaperWorker, stopStaleCallReaperWorker } from '@worker/lib/stale-call-reaper-worker'
import {
  startProviderRecordingSweepWorker,
  stopProviderRecordingSweepWorker,
} from '@worker/lib/provider-recording-sweep-worker'
import { startIncidentChecksWorker, stopIncidentChecksWorker } from '@worker/lib/incident-checks-worker'
import { startIncidentCloserWorker, stopIncidentCloserWorker } from '@worker/lib/incident-closer-worker'

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
  { name: 'stale call reaper', start: startStaleCallReaperWorker, stop: stopStaleCallReaperWorker, dep: 'callsService' },
  { name: 'provider recording sweep', start: startProviderRecordingSweepWorker, stop: stopProviderRecordingSweepWorker, dep: 'providerMedia' },
  { name: 'incident checks', start: startIncidentChecksWorker, stop: stopIncidentChecksWorker, dep: 'incidents' },
  { name: 'incident closer', start: startIncidentCloserWorker, stop: stopIncidentCloserWorker, dep: 'incidents' },
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
    callsService: { __svc: 'calls' } as never,
    incidents: { __svc: 'incidents', setNotifier: vi.fn() } as never,
  }
}

function deps() {
  return {
    ...serviceDeps(),
    resolveAdapter: async () => null,
    resolveIdentifier: async () => null,
    providerMedia: { __svc: 'providerMedia' } as never,
    incidentNotifier: { __svc: 'incidentNotifier' } as never,
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

    // #1136: the stuck-call reaper must run on the scheduler like every other
    // background worker, not only lazily inside a dashboard read. There is no
    // "when callsService is omitted" case to assert any more: `callsService` is
    // a required field of TaskSchedulerServiceDeps, so an omission is a compile
    // error at the one call site that builds it (#1567) rather than a worker
    // that quietly never runs.
    it('hands the stale call reaper the calls service (#1136)', () => {
      const { scheduler } = setup()
      const d = deps()
      scheduler.start(d)
      expect(startStaleCallReaperWorker).toHaveBeenCalledWith(d.callsService)
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

    it('hands the provider-media eraser to every worker that deletes caller audio (#2297)', () => {
      const { scheduler } = setup()
      const d = deps()

      scheduler.start(d)

      // Purging a call record, shredding a hub and retrying a voicemail each
      // delete audio the telephony provider holds; without the eraser none could.
      expect(startRetentionPurgeWorker).toHaveBeenCalledWith(expect.objectContaining({ providerMedia: d.providerMedia }))
      expect(startErasureExpiryWorker).toHaveBeenCalledWith(expect.objectContaining({ providerMedia: d.providerMedia }))
      expect(startProviderRecordingSweepWorker).toHaveBeenCalledWith(d.providerMedia)
    })

    it('binds the incident notifier before any worker starts, and hands both incident workers the service (#2341)', () => {
      const { scheduler } = setup()
      const d = deps()
      const setNotifier = (d.incidents as unknown as { setNotifier: ReturnType<typeof vi.fn> }).setNotifier

      scheduler.start(d)

      expect(setNotifier).toHaveBeenCalledWith(d.incidentNotifier)
      // Bound before the first worker could produce an announcement.
      expect(setNotifier.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(startBlastWorker).mock.invocationCallOrder[0]!,
      )
      expect(startIncidentChecksWorker).toHaveBeenCalledWith(d.incidents)
      expect(startIncidentCloserWorker).toHaveBeenCalledWith(d.incidents)
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

    it('passes the hashing key, the KEK and configured queue retention to the drain worker', () => {
      const { db } = createMockDb()
      const scheduler = new TaskScheduler(db as never, 'a'.repeat(64), 'c'.repeat(64), 14)

      scheduler.start(deps())

      expect(createSignalQueueDrainOpts).toHaveBeenCalledWith(
        db,
        expect.any(Function),
        'a'.repeat(64),
        'c'.repeat(64),
        14,
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

    it('clears the started-workers list', () => {
      const { scheduler } = setup()
      scheduler.start(deps())
      scheduler.stop()

      expect(scheduler.getStartedWorkers()).toHaveLength(0)
    })
  })
})
