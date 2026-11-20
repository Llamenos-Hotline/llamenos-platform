/**
 * PoolGate / gateClient (#1208, #1264) against a fake driver client — the
 * ordering and bookkeeping rules, without PostgreSQL. The real-database
 * reproduction is apps/worker/__tests__/integration-bun/pool-deadlock.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SQL } from 'bun'
import { PoolGate, PoolExhaustedError, PoolReentryError, gateClient, outsideTransaction } from './pool-gate'

/** The two driver calls drizzle makes on the root client, recorded and resolved on demand. */
function fakeClient() {
  const calls: string[] = []
  const query = (text: string) => {
    const run = async () => { calls.push(text); return [{ text }] }
    return { then: (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => run().then(a, b), values: () => run() }
  }
  const client = {
    unsafe: (text: string) => query(text),
    begin: async (...args: unknown[]) => {
      const body = args[args.length - 1] as (tx: unknown) => Promise<unknown>
      calls.push('BEGIN')
      const out = await body({ unsafe: (text: string) => query(`tx:${text}`) })
      calls.push('COMMIT')
      return out
    },
    close: async () => {},
  }
  return { client: client as unknown as SQL, calls }
}

const gate = (max: number, acquireTimeoutMs = 1_000) => new PoolGate({ name: 'unit', max, acquireTimeoutMs })

describe('PoolGate', () => {
  it('admits up to max at once and hands released slots to waiters in arrival order', async () => {
    const g = gate(2)
    const a = await g.acquire('a')
    const b = await g.acquire('b')
    const order: string[] = []
    const c = g.acquire('c').then((l) => { order.push('c'); return l })
    const d = g.acquire('d').then((l) => { order.push('d'); return l })
    expect(g.snapshot().waiting).toBe(2)

    g.release(b)
    const cl = await c
    g.release(a)
    await d
    expect(order).toEqual(['c', 'd'])
    expect(g.snapshot().holders.map((h) => h.label).sort()).toEqual(['c', 'd'])
    g.release(cl)
    expect(g.snapshot().holders.map((h) => h.label)).toEqual(['d'])
  })

  it('rejects a waiter after the acquire timeout with the pool, the waiter and the holders', async () => {
    const g = gate(1, 50)
    await g.acquire('holder-query')
    const err = await g.acquire('starved').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PoolExhaustedError)
    const e = err as PoolExhaustedError
    expect(e.pool).toBe('unit')
    expect(e.waiting).toBe('starved')
    expect(e.waitedMs).toBeGreaterThanOrEqual(50)
    expect(e.holders.map((h) => h.label)).toEqual(['holder-query'])
    expect(e.message).toContain('PostgreSQL pool "unit" exhausted')
    // A timed-out waiter is gone: it is not handed a slot later.
    expect(g.snapshot().waiting).toBe(0)
  })

  describe('when the runtime fires the acquire timer early', () => {
    // Bun fires a setTimeout(fn, ms) up to ~1ms before ms has elapsed, on the
    // monotonic clock too (measured: 14-17 of 60 25ms timers). CI caught the
    // gate reporting "waited 299ms" on a 300ms timeout. Node never fires early,
    // so this tier drives the gate's clock and timers by hand: the test decides
    // when a timer fires and what time it is when it does.
    let clock = 0
    let armed: Array<{ fn: () => void; ms: number }> = []
    beforeEach(() => {
      clock = 1_000
      armed = []
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
        armed.push({ fn, ms: ms ?? 0 })
        return armed.length as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout)
      vi.stubGlobal('clearTimeout', (() => {}) as typeof clearTimeout)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })
    /** Fire the most recently armed timer at the current clock. */
    const fireLatest = () => armed[armed.length - 1].fn()

    it('rejects no waiter before acquireTimeoutMs, and reports a wait of at least that', async () => {
      const g = gate(1, 300)
      await g.acquire('holder')
      let settled: unknown = 'pending'
      const starved = g.acquire('starved').then(() => 'granted', (e: unknown) => e)
      void starved.then((v) => { settled = v })
      expect(armed.map((t) => t.ms)).toEqual([300])

      clock += 299.4 // the timer fires 0.6ms short of its delay
      fireLatest()
      await Promise.resolve()
      expect(settled).toBe('pending')
      expect(g.snapshot().waiting).toBe(1)
      expect(armed.map((t) => t.ms)).toEqual([300, 1]) // re-armed for what is left

      clock += 0.6
      fireLatest()
      const err = await starved
      expect(err).toBeInstanceOf(PoolExhaustedError)
      expect((err as PoolExhaustedError).waitedMs).toBe(300)
      expect(g.snapshot().waiting).toBe(0)
    })

    it('a connection released after an early fire, before the deadline, still reaches the waiter', async () => {
      const g = gate(1, 300)
      const holder = await g.acquire('holder')
      const waiting = g.acquire('waiter')

      clock += 299.4
      fireLatest()
      g.release(holder)
      const lease = await waiting
      expect(lease.label).toBe('waiter')
      expect(g.snapshot().holders.map((h) => h.label)).toEqual(['waiter'])
      g.release(lease)
    })
  })

  it('ignores a double release', async () => {
    const g = gate(1)
    const a = await g.acquire('a')
    g.release(a)
    g.release(a)
    const b = await g.acquire('b')
    expect(g.snapshot().holders).toHaveLength(1)
    g.release(b)
  })

  it('refuses nonsense limits at construction', () => {
    expect(() => gate(0)).toThrow(/max must be a positive integer/)
    expect(() => new PoolGate({ name: 'x', max: 1, acquireTimeoutMs: 0 })).toThrow(/acquireTimeoutMs/)
  })
})

describe('gateClient', () => {
  it('runs a root query once, however often the handle is awaited', async () => {
    const { client, calls } = fakeClient()
    const root = gateClient(client, gate(1))
    const q = root.unsafe('SELECT 1')
    await q
    await q
    expect(calls).toEqual(['SELECT 1'])
  })

  it('refuses a root query and a nested root transaction from inside a transaction, but not tx work', async () => {
    const { client, calls } = fakeClient()
    const root = gateClient(client, gate(2))
    const inner: unknown[] = []
    await root.begin(async (tx) => {
      await (tx as unknown as { unsafe(t: string): PromiseLike<unknown> }).unsafe('SELECT on tx')
      inner.push(await Promise.resolve(root.unsafe('SELECT on root')).catch((e: unknown) => e))
      inner.push(await root.begin(async () => 1).catch((e: unknown) => e))
    })
    expect(inner[0]).toBeInstanceOf(PoolReentryError)
    expect(inner[1]).toBeInstanceOf(PoolReentryError)
    expect((inner[0] as Error).message).toContain('"SELECT on root"')
    expect((inner[0] as Error).message).toContain('pool-gate.test.ts')
    expect(calls).toEqual(['BEGIN', 'tx:SELECT on tx', 'COMMIT'])
  })

  it('lets work a transaction spawned use the pool once the transaction has settled', async () => {
    const { client, calls } = fakeClient()
    const root = gateClient(client, gate(1))
    let later!: () => Promise<unknown>
    await root.begin(async () => {
      later = async () => await root.unsafe('SELECT after commit')
    })
    await later()
    expect(calls).toEqual(['BEGIN', 'COMMIT', 'SELECT after commit'])
  })

  it('allows a harness-injected concurrent request inside a transaction via outsideTransaction', async () => {
    const { client, calls } = fakeClient()
    const root = gateClient(client, gate(2))
    await root.begin(async () => {
      await outsideTransaction(async () => await root.unsafe('SELECT from another request'))
    })
    expect(calls).toEqual(['BEGIN', 'SELECT from another request', 'COMMIT'])
  })

  it('releases the slot when a transaction body throws', async () => {
    const { client } = fakeClient()
    const g = gate(1)
    const root = gateClient(client, g)
    await expect(root.begin(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(g.snapshot().holders).toEqual([])
    await root.unsafe('SELECT 1')
  })
})
