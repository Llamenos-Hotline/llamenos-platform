/**
 * The connection-pool gate every root database handle runs through (#1208, #1264).
 *
 * Two defects this closes, both of which presented as a silent server hang:
 *
 * 1. **Hold-and-wait.** A transaction already owns one pooled connection, and
 *    usually a lock (the audit-chain advisory lock, a `FOR UPDATE` row). If code
 *    inside it awaits a query on the ROOT pool, it waits for a second
 *    connection while holding the first. Once concurrent transactions reach the
 *    pool size, every connection belongs to a transaction waiting for another
 *    one — or to a waiter queued on the lock the first one holds — and nothing
 *    can ever proceed. The production pool is 10, so this is normal load, not a
 *    stress artifact.
 *
 *    The gate makes that ordering impossible rather than rare: a root-pool
 *    operation issued while the calling async context is inside an open
 *    transaction throws {@link PoolReentryError} immediately, before it can
 *    wait on anything. Work inside a transaction goes through `tx`; work that
 *    needs its own connection runs before the transaction starts or after it
 *    commits. Nothing that holds a connection can then wait for another one, so
 *    the wait-for graph has no cycle through the pool.
 *
 * 2. **Silent exhaustion.** Bun's SQL pool queues a request for a connection
 *    indefinitely (`connectionTimeout` bounds only the TCP/auth handshake). The
 *    gate admits at most `max` root operations at once, so the driver always
 *    has a connection for each operation it admits, and it bounds the wait
 *    itself: a request still waiting after `acquireTimeoutMs` is rejected with
 *    {@link PoolExhaustedError}, which names the pool, what was waiting, for
 *    how long, and what is holding every connection.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import type { SQL } from 'bun'

/** A root-pool operation issued from inside an open transaction. */
export class PoolReentryError extends Error {
  override readonly name = 'PoolReentryError'
}

/** A root-pool operation that could not get a connection within the acquire timeout. */
export class PoolExhaustedError extends Error {
  override readonly name = 'PoolExhaustedError'
  constructor(
    message: string,
    readonly pool: string,
    readonly waitedMs: number,
    readonly waiting: string,
    readonly holders: ReadonlyArray<{ label: string; heldMs: number }>,
  ) {
    super(message)
  }
}

export interface PoolGateOptions {
  /** Names the pool in every error, so two pools in one process are told apart. */
  name: string
  /** Connections the driver pool holds; the gate admits exactly this many operations. */
  max: number
  /** How long an operation may wait for a connection before it fails loudly. */
  acquireTimeoutMs: number
  /**
   * Called with each error before it is thrown — the server wires its logger
   * here. Drizzle wraps a driver-level rejection in `DrizzleQueryError` (this
   * error as `cause`), which the route error handler logs as "Failed query", so
   * without this hook the attribution would never reach the log.
   */
  onExhausted?: (err: PoolExhaustedError) => void
  onReentry?: (err: PoolReentryError) => void
}

interface Lease {
  readonly label: string
  readonly since: number
}

interface Waiter {
  readonly label: string
  readonly grant: (lease: Lease) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** The open transaction the current async context runs inside, if any. */
interface TransactionScope {
  readonly pool: string
  readonly origin: string
  readonly since: number
  open: boolean
}

/**
 * Process-wide: one transaction context, whichever gate opened it. A transaction
 * on pool A that waits on pool B is the same hold-and-wait, so any open
 * transaction blocks every gated root operation.
 */
const transactionScope = new AsyncLocalStorage<TransactionScope>()

const SQL_LABEL_LENGTH = 120

function sqlLabel(query: string): string {
  const flat = query.replace(/\s+/g, ' ').trim()
  return flat.length > SQL_LABEL_LENGTH ? `${flat.slice(0, SQL_LABEL_LENGTH)}…` : flat
}

const OWN_FILE = fileURLToPath(import.meta.url)

/** The first stack frame outside this module and the driver: where the caller opened the transaction. */
function callerFrame(stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at '))
  const own = frames.find((f) =>
    /[/\\]/.test(f)
    && !f.includes(OWN_FILE)
    && !f.includes('node_modules')
    && !f.includes('drizzle-orm'),
  )
  return own ? own.slice(3).replace(/^<anonymous> /, '') : 'unknown caller'
}

/**
 * Run `fn` as if no transaction were open in the calling context — TEST
 * HARNESSES ONLY, to inject what a CONCURRENT request would do at a chosen
 * point inside a transaction (a race reproduction). Production code never has
 * a reason to: a second request does not inherit the first one's transaction,
 * and anything a transaction itself awaits is exactly the hold-and-wait the
 * guard exists to refuse.
 */
export function outsideTransaction<T>(fn: () => T): T {
  return transactionScope.exit(fn)
}

/** FIFO counting semaphore with a bounded, attributable wait. */
export class PoolGate {
  private readonly holders = new Set<Lease>()
  private readonly waiters: Waiter[] = []

  constructor(private readonly opts: PoolGateOptions) {
    if (!Number.isInteger(opts.max) || opts.max < 1) {
      throw new Error(`pool "${opts.name}": max must be a positive integer, got ${opts.max}`)
    }
    if (!Number.isFinite(opts.acquireTimeoutMs) || opts.acquireTimeoutMs <= 0) {
      throw new Error(`pool "${opts.name}": acquireTimeoutMs must be positive, got ${opts.acquireTimeoutMs}`)
    }
  }

  get name(): string {
    return this.opts.name
  }

  /** Current holders and waiters — what an exhaustion error reports. */
  snapshot(now = Date.now()): { holders: Array<{ label: string; heldMs: number }>; waiting: number } {
    return {
      holders: [...this.holders]
        .map((h) => ({ label: h.label, heldMs: now - h.since }))
        .sort((a, b) => b.heldMs - a.heldMs),
      waiting: this.waiters.length,
    }
  }

  /**
   * Throw if the calling async context is inside an open transaction: the
   * operation would wait on the pool while holding a pooled connection.
   */
  assertNotInTransaction(label: string): void {
    const scope = transactionScope.getStore()
    if (!scope?.open) return
    const err = new PoolReentryError(
      `pool "${this.opts.name}": "${label}" was issued on the root pool from inside an open ` +
      `transaction on pool "${scope.pool}" (begun ${Date.now() - scope.since}ms ago at ${scope.origin}). ` +
      'That transaction already holds a pooled connection and possibly locks; waiting on the pool for ' +
      `another one deadlocks the server once concurrent transactions reach the pool size (max=${this.opts.max}, #1208). ` +
      'Run it on the transaction handle, or before the transaction begins / after it commits.',
    )
    this.opts.onReentry?.(err)
    throw err
  }

  async acquire(label: string): Promise<Lease> {
    this.assertNotInTransaction(label)
    if (this.holders.size < this.opts.max && this.waiters.length === 0) {
      const lease: Lease = { label, since: Date.now() }
      this.holders.add(lease)
      return lease
    }
    return await new Promise<Lease>((resolve, reject) => {
      const since = Date.now()
      const waiter: Waiter = {
        label,
        grant: resolve,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter)
          if (at >= 0) this.waiters.splice(at, 1)
          reject(this.exhausted(label, since))
        }, this.opts.acquireTimeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  release(lease: Lease): void {
    if (!this.holders.delete(lease)) return
    const next = this.waiters.shift()
    if (!next) return
    clearTimeout(next.timer)
    const granted: Lease = { label: next.label, since: Date.now() }
    this.holders.add(granted)
    next.grant(granted)
  }

  private exhausted(label: string, since: number): PoolExhaustedError {
    const now = Date.now()
    const waitedMs = now - since
    const { holders, waiting } = this.snapshot(now)
    const shown = holders.slice(0, 5).map((h) => `${h.heldMs}ms: ${h.label}`).join('; ')
    const more = holders.length > 5 ? `; …${holders.length - 5} more` : ''
    const err = new PoolExhaustedError(
      `PostgreSQL pool "${this.opts.name}" exhausted: "${label}" waited ${waitedMs}ms for a connection ` +
      `and none was released. All ${holders.length}/${this.opts.max} connections are held ` +
      `(longest first — ${shown}${more}); ${waiting} other operation(s) still waiting. ` +
      'A connection held this long is a stuck transaction or a slow query, not load; ' +
      'raising PG_POOL_SIZE only moves the threshold (#1208).',
      this.opts.name,
      waitedMs,
      label,
      holders,
    )
    this.opts.onExhausted?.(err)
    return err
  }
}

/** One awaited root query: admitted by the gate when first awaited, released when it settles. */
class GatedQuery<T> implements PromiseLike<T> {
  private result: Promise<T> | undefined

  constructor(private readonly start: () => Promise<T>) {}

  then<A = T, B = never>(
    onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.result ??= this.start()
    return this.result.then(onFulfilled, onRejected)
  }
}

/** A transaction body as drizzle passes it: runs on the transaction's own connection. */
type TransactionBody<T> = SQL.TransactionContextCallback<T>

/** Shape of the root query handle drizzle's bun-sql session calls: `await unsafe(q, p)` and `await unsafe(q, p).values()`. */
export interface GatedUnsafeQuery extends PromiseLike<unknown> {
  values(): PromiseLike<unknown>
}

/**
 * The root client drizzle runs on: every operation it issues — a query or a
 * whole transaction — holds a gate lease for as long as it holds a connection.
 *
 * Only the surface drizzle uses is exposed (`unsafe`, `begin`, `close`). A
 * tagged-template call, `reserve()` or `file()` on the root client would bypass
 * the gate, so they do not exist on it.
 */
export function gateClient(client: SQL, gate: PoolGate) {
  async function admitted<T>(label: string, run: () => Promise<T>): Promise<T> {
    const lease = await gate.acquire(label)
    try {
      return await run()
    } finally {
      gate.release(lease)
    }
  }

  return {
    unsafe(query: string, params?: unknown[]): GatedUnsafeQuery {
      const label = sqlLabel(query)
      const all = new GatedQuery(() => admitted(label, async () => await client.unsafe(query, params)))
      return {
        then: all.then.bind(all),
        values: () => new GatedQuery(() => admitted(label, async () => await client.unsafe(query, params).values())),
      }
    },

    async begin<T>(...args: [TransactionBody<T>] | [string, TransactionBody<T>]): Promise<SQL.ContextCallbackResult<T>> {
      const [options, body] = args.length === 2 ? args : [undefined, args[0]]
      const origin = callerFrame(new Error().stack)
      return await admitted(`transaction from ${origin}`, async () => {
        const scope: TransactionScope = { pool: gate.name, origin, since: Date.now(), open: true }
        const run: TransactionBody<T> = (tx) => transactionScope.run(scope, () => body(tx))
        try {
          return options === undefined ? await client.begin(run) : await client.begin(options, run)
        } finally {
          // Work the transaction spawned but did not await may outlive it; once
          // the transaction has settled it holds nothing, so that work may use the pool.
          scope.open = false
        }
      })
    },

    async close(options?: { timeout?: number }): Promise<void> {
      await client.close(options)
    },
  }
}

export type GatedClient = ReturnType<typeof gateClient>
