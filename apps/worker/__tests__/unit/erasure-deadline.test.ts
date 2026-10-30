/**
 * Where the erasure-deadline check runs (#2323) — unit tier.
 *
 * The defect was a deadline that could pass with no artefact anywhere because
 * the only thing reading `execute_at` was the worker that executes requests.
 * A check scheduled from that same worker reproduces it exactly: stop the
 * worker and the check stops too. So these tests fail if the check, or the
 * query behind it, is ever reachable from `erasure-expiry`.
 *
 * The check's behaviour against real PostgreSQL (and with the erasure worker
 * never started) is in __tests__/integration/erasure-deadline.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKER_TICK_INTERVAL_MS } from '@worker/metrics/worker-liveness'
import { erasureDeadlineCheck } from '@worker/services/erasure'
import { INCIDENT_CATEGORIES } from '@worker/services/incidents-categories'
import { startErasureExpiryWorker, stopErasureExpiryWorker } from '@worker/lib/erasure-expiry-worker'

const ROOT = path.resolve(__dirname, '../../../..')

/** Production files (not tests) under `dirs` whose source contains `needle`. A filesystem walk: the review gate runs in a .git-less export. */
function productionFilesContaining(needle: string, dirs: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(rel)
      } else if (rel.endsWith('.ts') && readFileSync(path.join(ROOT, rel), 'utf8').includes(needle)) {
        found.push(rel)
      }
    }
  }
  for (const dir of dirs) walk(dir)
  return found.sort()
}

describe('erasure-deadline check', () => {
  it('reports the erasure-deadline category, which reaches erasure:admin', () => {
    const check = erasureDeadlineCheck({ countOverdueForHub: async () => ({ count: 0, oldestAgeSeconds: null }) })
    expect(check.category).toBe('erasure-deadline')
    expect(check.kind).toBe('overdue')
    expect(INCIDENT_CATEGORIES[check.category].permission).toBe('erasure:admin')
  })

  it('passes a failure through — a check that cannot answer throws, never a sentinel', async () => {
    const check = erasureDeadlineCheck({
      countOverdueForHub: async () => {
        throw new Error('db down')
      },
    })
    await expect(check.check('hub-1', new Date())).rejects.toThrow('db down')
  })

  it('is registered only by the service registry, and its query is read only by the check', () => {
    expect(productionFilesContaining('erasureDeadlineCheck(', ['apps/worker', 'src/server'])).toEqual([
      'apps/worker/services/erasure.ts',
      'apps/worker/services/index.ts',
    ])
    expect(productionFilesContaining('.countOverdueForHub(', ['apps/worker', 'src/server'])).toEqual([
      'apps/worker/services/erasure.ts',
    ])
  })
})

describe('the erasure-expiry worker never runs the check that measures it', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    stopErasureExpiryWorker()
    vi.useRealTimers()
  })

  it('ticks through runWorkerTick for erasure-deadline, and never evaluates a check', async () => {
    const countOverdueForHub = vi.fn(async () => ({ count: 0, oldestAgeSeconds: null }))
    const runChecks = vi.fn(async () => ({ evaluated: 0, failed: 0 }))
    const runWorkerTick = vi.fn(<T>(_name: string, _category: string, fn: () => Promise<T>) => fn())
    startErasureExpiryWorker({
      erasureService: { getExpiredPendingRequests: async () => [], countOverdueForHub } as never,
      auditService: {} as never,
      hubShred: {} as never,
      providerMedia: {} as never,
      // Handed the whole surface on purpose: the type narrows it to the L2
      // hook, and this proves nothing else is reached at runtime either.
      incidents: { runWorkerTick, runChecks } as never,
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3 * WORKER_TICK_INTERVAL_MS['erasure-expiry'])

    expect(runWorkerTick).toHaveBeenCalledTimes(4)
    for (const call of runWorkerTick.mock.calls) {
      expect(call.slice(0, 2)).toEqual(['erasure-expiry', 'erasure-deadline'])
    }
    expect(runChecks).not.toHaveBeenCalled()
    expect(countOverdueForHub).not.toHaveBeenCalled()
  })

  it('a failing poll reaches runWorkerTick as a throw, so the L2 streak counts it', async () => {
    const thrown: unknown[] = []
    const runWorkerTick = vi.fn(async <T>(_name: string, _category: string, fn: () => Promise<T>) => {
      try {
        return await fn()
      } catch (err) {
        thrown.push(err)
        throw err
      }
    })
    startErasureExpiryWorker({
      erasureService: {
        getExpiredPendingRequests: async () => {
          throw new Error('poll failed')
        },
      } as never,
      auditService: {} as never,
      hubShred: {} as never,
      providerMedia: {} as never,
      incidents: { runWorkerTick },
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(thrown).toHaveLength(1)
    expect((thrown[0] as Error).message).toBe('poll failed')
  })
})
