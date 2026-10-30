/**
 * Scheduler-worker liveness gauges (#2323, B-WORKER-LIVENESS).
 *
 * The WorkerStalled alert can only see a worker that publishes
 * `llamenos_worker_last_success_timestamp_seconds`. These tests start every
 * REAL worker module (no vi.mock of the workers) against stub services that
 * make one tick succeed, and assert the gauge appears — so a worker that is
 * registered but never calls trackWorkerTick fails here, not silently in
 * production. The promtool rule tests prove the other half: that a missing
 * gauge fires the alert.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEDULER_WORKER_NAMES, type SchedulerWorkerName } from '@worker/services/scheduler'
import {
  WORKER_LAST_SUCCESS_METRIC,
  WORKER_TICK_INTERVAL_METRIC,
  WORKER_TICK_INTERVAL_MS,
  getWorkerLastSuccessSeconds,
  renderWorkerLivenessMetrics,
  trackWorkerTick,
} from '@worker/metrics/worker-liveness'
import { startBlastWorker, stopBlastWorker } from '@worker/lib/blast-delivery-worker'
import { startScheduledBlastPoller, stopScheduledBlastPoller } from '@worker/lib/blast-scheduled-poller'
import { startRetentionPurgeWorker, stopRetentionPurgeWorker } from '@worker/lib/retention-purge-worker'
import { startAuditChainVerifyWorker, stopAuditChainVerifyWorker } from '@worker/lib/audit-chain-verify-worker'
import { startErasureExpiryWorker, stopErasureExpiryWorker } from '@worker/lib/erasure-expiry-worker'
import { startReEncryptionWorker, stopReEncryptionWorker } from '@worker/lib/re-encryption-worker'
import { startPeriodicCleanupWorker, stopPeriodicCleanupWorker } from '@worker/lib/periodic-cleanup-worker'
import { startSignalQueueDrainWorker, stopSignalQueueDrainWorker } from '@worker/lib/signal-queue-drain-worker'
import { startStaleCallReaperWorker, stopStaleCallReaperWorker } from '@worker/lib/stale-call-reaper-worker'
import {
  startProviderRecordingSweepWorker,
  stopProviderRecordingSweepWorker,
} from '@worker/lib/provider-recording-sweep-worker'
import { startIncidentChecksWorker, stopIncidentChecksWorker } from '@worker/lib/incident-checks-worker'
import { startIncidentCloserWorker, stopIncidentCloserWorker } from '@worker/lib/incident-closer-worker'
import metricsRoutes from '@worker/routes/metrics'

/**
 * How to start each worker so that one tick completes cleanly. Typed as a
 * Record over SchedulerWorkerName so a new worker without a row is a compile
 * error; at runtime (vitest does not typecheck) the missing row fails the
 * per-worker test below instead.
 */
const DRIVERS: Record<SchedulerWorkerName, { start: () => void; stop: () => void }> = {
  'blast-delivery': {
    start: () =>
      startBlastWorker({
        blastsService: { getSendingBlasts: async () => [] } as never,
        settingsService: {} as never,
        resolveAdapter: async () => null as never,
        resolveIdentifier: async () => null,
      }),
    stop: stopBlastWorker,
  },
  'scheduled-blast-poller': {
    start: () => startScheduledBlastPoller({ getDueScheduledBlasts: async () => [] } as never),
    stop: stopScheduledBlastPoller,
  },
  'retention-purge': {
    start: () =>
      startRetentionPurgeWorker({
        retentionService: {} as never,
        auditService: {} as never,
        settingsService: { getPlatformSettings: async () => ({ retentionPurge: { enabled: false } }) } as never,
        providerMedia: {} as never,
      }),
    stop: stopRetentionPurgeWorker,
  },
  'audit-chain-verify': {
    start: () =>
      startAuditChainVerifyWorker({
        auditService: { listChainHubIds: async () => [] } as never,
        identityService: {} as never,
      }),
    stop: stopAuditChainVerifyWorker,
  },
  'erasure-expiry': {
    start: () =>
      startErasureExpiryWorker({
        erasureService: { getExpiredPendingRequests: async () => [] } as never,
        auditService: {} as never,
        hubShred: {} as never,
        providerMedia: {} as never,
        incidents: { runWorkerTick: (_name, _category, fn) => fn() },
      }),
    stop: stopErasureExpiryWorker,
  },
  're-encryption': {
    start: () => startReEncryptionWorker({ erasureService: { getQueuedReEncryptionJobs: async () => [] } as never }),
    stop: stopReEncryptionWorker,
  },
  'periodic-cleanup': {
    start: () =>
      startPeriodicCleanupWorker({
        identityService: { cleanup: async () => ({}) } as never,
        settingsService: {
          runCleanup: async () => ({ rateLimitEntriesDeleted: 0, captchaChallengesDeleted: 0 }),
          clearExpiredApiRateLimits: async () => undefined,
        } as never,
      }),
    stop: stopPeriodicCleanupWorker,
  },
  'signal-queue-drain': {
    start: () =>
      startSignalQueueDrainWorker({
        queue: { claimBatch: async () => [], cleanup: async () => 0 } as never,
        resolveSignalAdapter: async () => null,
      }),
    stop: stopSignalQueueDrainWorker,
  },
  'stale-call-reaper': {
    start: () => startStaleCallReaperWorker({ reapStaleCalls: async () => 0 } as never),
    stop: stopStaleCallReaperWorker,
  },
  'provider-recording-sweep': {
    start: () =>
      startProviderRecordingSweepWorker({
        retryPending: async () => ({ deleted: 0, failed: [] }),
      } as never),
    stop: stopProviderRecordingSweepWorker,
  },
  'incident-checks': {
    start: () => startIncidentChecksWorker({ runChecks: async () => ({ evaluated: 0, failed: 0 }) }),
    stop: stopIncidentChecksWorker,
  },
  'incident-closer': {
    start: () => startIncidentCloserWorker({ closeQuiet: async () => ({ closed: 0, updated: 0 }) }),
    stop: stopIncidentCloserWorker,
  },
}

/** A fixed instant well after any real clock this suite could run at. */
const T0_MS = Date.UTC(2030, 0, 1)

describe('worker liveness gauges', () => {
  it('declares a tick interval for exactly the workers the scheduler registers', () => {
    expect(Object.keys(WORKER_TICK_INTERVAL_MS).sort()).toEqual([...SCHEDULER_WORKER_NAMES].sort())
  })

  describe.each(SCHEDULER_WORKER_NAMES.map((name) => ({ name })))('$name', ({ name }) => {
    beforeEach(() => {
      vi.useFakeTimers({ now: T0_MS })
    })

    afterEach(() => {
      DRIVERS[name]?.stop()
      vi.useRealTimers()
    })

    it('publishes its last-success gauge once a tick completes', async () => {
      const driver = DRIVERS[name]
      expect(driver, `no test driver for scheduler worker "${name}"`).toBeDefined()
      const intervalMs = WORKER_TICK_INTERVAL_MS[name]
      expect(intervalMs, `no tick interval for scheduler worker "${name}"`).toBeGreaterThan(0)

      driver.start()
      // One full interval plus the longest initial delay any worker uses (60s),
      // so a worker whose first tick is deferred still gets one in.
      await vi.advanceTimersByTimeAsync(intervalMs + 61_000)

      const last = getWorkerLastSuccessSeconds(name)
      expect(last, `scheduler worker "${name}" never published ${WORKER_LAST_SUCCESS_METRIC}`).toBeDefined()
      expect(last).toBeGreaterThanOrEqual(T0_MS / 1000)
      expect(renderWorkerLivenessMetrics()).toContain(
        `${WORKER_LAST_SUCCESS_METRIC}{worker="${name}"} ${(last ?? NaN).toFixed(3)}`,
      )
    })
  })
})

describe('trackWorkerTick', () => {
  it('records nothing and rethrows when the tick throws, so the gauge goes stale', async () => {
    vi.resetModules()
    const fresh = await import('@worker/metrics/worker-liveness')

    await expect(
      fresh.trackWorkerTick('erasure-expiry', async () => {
        throw new Error('db unreachable')
      }),
    ).rejects.toThrow('db unreachable')

    expect(fresh.getWorkerLastSuccessSeconds('erasure-expiry')).toBeUndefined()
  })

  it('returns the tick result and records the completion time', async () => {
    vi.useFakeTimers({ now: T0_MS + 5_000 })
    try {
      await expect(trackWorkerTick('stale-call-reaper', async () => 7)).resolves.toBe(7)
      expect(getWorkerLastSuccessSeconds('stale-call-reaper')).toBe((T0_MS + 5_000) / 1000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('renderWorkerLivenessMetrics', () => {
  it('publishes every interval from boot but no last-success series until a tick completes', async () => {
    vi.resetModules()
    const fresh = await import('@worker/metrics/worker-liveness')

    const lines = fresh.renderWorkerLivenessMetrics()

    for (const name of SCHEDULER_WORKER_NAMES) {
      expect(lines).toContain(
        `${WORKER_TICK_INTERVAL_METRIC}{worker="${name}"} ${WORKER_TICK_INTERVAL_MS[name] / 1000}`,
      )
    }
    // Absent, not 0: a 0 would read as "succeeded at the epoch" and hide a
    // worker that never ran from the out-of-process rule.
    expect(lines.filter((l) => l.startsWith(`${WORKER_LAST_SUCCESS_METRIC}{`))).toEqual([])
  })
})

describe('GET /api/metrics/prometheus', () => {
  it('exposes both liveness families to the scraper', async () => {
    await trackWorkerTick('re-encryption', async () => undefined)

    const res = await metricsRoutes.request(
      '/prometheus',
      { headers: { Authorization: 'Bearer scrape-token' } },
      { METRICS_SCRAPE_TOKEN: 'scrape-token' },
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain(`# TYPE ${WORKER_TICK_INTERVAL_METRIC} gauge`)
    expect(body).toContain(`# TYPE ${WORKER_LAST_SUCCESS_METRIC} gauge`)
    for (const name of SCHEDULER_WORKER_NAMES) {
      expect(body).toContain(`${WORKER_TICK_INTERVAL_METRIC}{worker="${name}"}`)
    }
    expect(body).toMatch(new RegExp(`^${WORKER_LAST_SUCCESS_METRIC}\\{worker="re-encryption"\\} \\d+\\.\\d{3}$`, 'm'))
  })
})

describe('the WorkerStalled rule reads the gauges this module publishes', () => {
  // The promtool tests prove the rule against fixtures and this file proves the
  // app against the module's constants; this joins the two, so renaming a
  // metric on either side alone fails here instead of silencing the alert.
  const rules = readFileSync(
    path.resolve(__dirname, '../../../../deploy/ansible/roles/llamenos-prometheus/templates/alert-rules.yml.j2'),
    'utf8',
  )

  it.each([WORKER_LAST_SUCCESS_METRIC, WORKER_TICK_INTERVAL_METRIC])('references %s', (metric) => {
    expect(rules).toContain('alert: WorkerStalled')
    expect(rules).toContain(`${metric}{job="llamenos-app"}`)
  })
})
