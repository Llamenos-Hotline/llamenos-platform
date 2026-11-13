/**
 * Audited writes on a pool smaller than the number of concurrent writers
 * (#1208, #1264) — real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest (the gate wraps Bun's SQL client):
 *   bun test apps/worker/__tests__/integration-bun/pool-deadlock.test.ts
 *
 * The defect was hold-and-wait: a transaction holding a pooled connection and a
 * lock (the audit-chain advisory lock in the original report, a `FOR UPDATE`
 * row here) awaited a query on the ROOT pool. Once concurrent writers reach the
 * pool size, every connection belongs to a writer queued on that lock, the
 * holder waits forever for a connection, and the server hangs without a word.
 *
 * Every wait below is bounded by `settlesWithin`, so a regression fails with a
 * pg_stat_activity dump instead of hanging the suite.
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`). Rows created here are deleted on
 * teardown.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { SQL } from 'bun'
import { eq, inArray, sql } from 'drizzle-orm'
import '../../db/pg-array-patch'
import {
  openDatabase,
  closeDatabase,
  PoolExhaustedError,
  PoolReentryError,
  type Database,
} from '../../db'
import { auditLog, auditUserKeys, conversations, hubs } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { ConversationsService } from '../../services/conversations'
import { ErasureService } from '../../services/erasure'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

/** Smaller than WRITERS: the deadlock needs writers >= pool size. */
const POOL = 3
const WRITERS = 8

/** An un-gated connection for diagnostics and teardown — never part of the pools under test. */
const monitor = new SQL({ url: DATABASE_URL, max: 1 })

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const createdHubs: string[] = []
const createdActors: string[] = []
const opened: Database[] = []

function smallPool(name: string, max = POOL, acquireTimeoutMs = 5_000): Database {
  const db = openDatabase(DATABASE_URL, { name, max, idleTimeout: 0, acquireTimeoutMs })
  opened.push(db)
  return db
}

const actor = (): string => {
  const pubkey = randomBytes(32).toString('hex')
  createdActors.push(pubkey)
  return pubkey
}

/** Services wired the way services/index.ts wires them, on `db`. */
function servicesOn(db: Database) {
  const erasure = new ErasureService(db)
  const audit = new AuditService(db, {
    serverSecret: randomBytes(32),
    resolveAdminRecipients: async () => [],
    keyStore: erasure,
  })
  return { audit, conversations: new ConversationsService(db, 'ab'.repeat(32)) }
}

async function makeHub(db: Database, label: string): Promise<string> {
  const id = `hub-pool-${label}-${suite}`
  await db.insert(hubs).values({ id, name: id, slug: id, createdBy: 'integration-test' })
  createdHubs.push(id)
  return id
}

/** The gate's error: drizzle wraps a driver-level rejection in DrizzleQueryError, with it as `cause`. */
function gateError(err: unknown): unknown {
  return err instanceof PoolReentryError || err instanceof PoolExhaustedError ? err : (err as { cause?: unknown } | null)?.cause
}

/** Resolve with `work`, or fail after `ms` with what the database was doing — never hang. */
async function settlesWithin<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(async () => {
      const activity = await monitor`
        SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid)::text AS blocked_by, left(query, 100) AS query
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`
      reject(new Error(`${what} did not settle within ${ms}ms — pool deadlock. Activity: ${JSON.stringify(activity)}`))
    }, ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

afterAll(async () => {
  // A deadlocked pool never drains: close it hard so its locks die with its connections.
  for (const db of opened) await (db as Database & { $client: { close(o: { timeout: number }): Promise<void> } }).$client.close({ timeout: 0 })
  if (createdHubs.length) {
    await monitor`DELETE FROM audit_log WHERE hub_id IN ${monitor(createdHubs)}`
    await monitor`DELETE FROM hubs WHERE id IN ${monitor(createdHubs)}`
  }
  if (createdActors.length) await monitor`DELETE FROM audit_user_keys WHERE user_pubkey IN ${monitor(createdActors)}`
  await monitor.close()
})

describe('audited writes on a pool smaller than the number of writers (#1208)', () => {
  it('concurrent audited re-wraps of one conversation all complete, and the audit chain is unbroken', async () => {
    // The route's own sequence (POST /conversations/:id/assignee-envelopes):
    // addAssigneeEnvelopes, then the audit entry. addAssigneeEnvelopes takes the
    // conversation row FOR UPDATE and then reads the assignee's devices — on the
    // root pool, before the fix. WRITERS-1 writers queued on that row hold every
    // other connection, so the holder waits on the pool forever.
    const db = smallPool('rewrap')
    const { audit, conversations: convs } = servicesOn(db)
    const hubId = await makeHub(db, 'rewrap')
    const assignee = actor()
    const [conv] = await db
      .insert(conversations)
      .values({ hubId, channelType: 'sms', assignedTo: assignee, status: 'active' })
      .returning({ id: conversations.id })
    const admin = actor()

    const writes = Array.from({ length: WRITERS }, async (_, n) => {
      const { added } = await convs.addAssigneeEnvelopes(conv.id, [])
      return audit.log('conversationAssigneeEnvelopesAdded', admin, { conversationId: conv.id, added, n }, hubId)
    })
    const entries = await settlesWithin(20_000, `${WRITERS} audited re-wraps on a pool of ${POOL}`, Promise.all(writes))

    expect(entries).toHaveLength(WRITERS)
    expect(entries.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: WRITERS }, (_, i) => i + 1))
    const verified = await audit.verifyChain(hubId)
    expect(verified.valid).toBe(true)
    expect(verified.totalEntries).toBe(WRITERS)
  }, 30_000)

  it('many actors appending to two chains concurrently — first-use key creation included — leave both chains unbroken', async () => {
    // Each actor's first entry also creates their audit key under the per-user
    // advisory lock; every entry takes its chain's advisory lock. Serialisation
    // must hold (one linear chain per hub, seq 1..n) without the pool wedging.
    const db = smallPool('chains')
    const { audit } = servicesOn(db)
    const chains = [await makeHub(db, 'chain-a'), await makeHub(db, 'chain-b')]
    const actors = Array.from({ length: 4 }, actor)
    const perActorPerChain = 3

    const writes = actors.flatMap((a) =>
      chains.flatMap((hubId) =>
        Array.from({ length: perActorPerChain }, (_, n) => audit.log('noteCreated', a, { n }, hubId)),
      ),
    )
    await settlesWithin(30_000, `${writes.length} concurrent audit appends on a pool of ${POOL}`, Promise.all(writes))

    for (const hubId of chains) {
      const rows = await db.select().from(auditLog).where(eq(auditLog.hubId, hubId)).orderBy(auditLog.seq)
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: actors.length * perActorPerChain }, (_, i) => i + 1))
      // Linear: each entry chains from exactly the one before it — no fork.
      rows.forEach((row, i) => expect(row.previousEntryHash).toBe(i === 0 ? null : rows[i - 1].entryHash))
      const verified = await audit.verifyChain(hubId)
      expect(verified.valid).toBe(true)
      expect(verified.totalEntries).toBe(rows.length)
    }
    const keys = await db.select().from(auditUserKeys).where(inArray(auditUserKeys.userPubkey, actors))
    expect(keys).toHaveLength(actors.length)
  }, 40_000)
})

describe('the pool gate', () => {
  it('refuses a root-pool query issued inside an open transaction, at once, and rolls the transaction back', async () => {
    const db = smallPool('reentry')
    const hubId = `hub-pool-reentry-${suite}`
    const started = Date.now()
    const attempt = db.transaction(async (tx) => {
      await tx.insert(hubs).values({ id: hubId, name: hubId, slug: hubId, createdBy: 'integration-test' })
      // The hold-and-wait shape: this transaction holds a connection and a row,
      // and asks the root pool for another connection.
      await db.select({ id: hubs.id }).from(hubs).limit(1)
    })
    const err = gateError(await settlesWithin(5_000, 'a re-entrant root query', attempt.then(() => null, (e: unknown) => e)))

    expect(err).toBeInstanceOf(PoolReentryError)
    expect(String((err as Error).message)).toContain('pool "reentry"')
    expect(String((err as Error).message)).toContain('pool-deadlock.test.ts')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await db.select({ id: hubs.id }).from(hubs).where(eq(hubs.id, hubId))).toEqual([])
  }, 10_000)

  it('fails an operation that cannot get a connection loudly — naming the pool, the waiter, the wait and the holders', async () => {
    const db = smallPool('exhaust', 2, 300)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const holders = Array.from({ length: 2 }, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`)
        await held
      }),
    )
    // Both holders are admitted before the probe asks.
    await Bun.sleep(50)

    const started = Date.now()
    const err = gateError(await settlesWithin(5_000, 'a query on an exhausted pool', db.execute(sql`SELECT 42 AS probe`).then(() => null, (e: unknown) => e)))
    const waited = Date.now() - started

    release()
    await Promise.all(holders)

    expect(err).toBeInstanceOf(PoolExhaustedError)
    const exhausted = err as PoolExhaustedError
    expect(exhausted.pool).toBe('exhaust')
    expect(exhausted.waiting).toContain('SELECT 42 AS probe')
    expect(exhausted.waitedMs).toBeGreaterThanOrEqual(300)
    expect(exhausted.holders).toHaveLength(2)
    expect(exhausted.holders.every((h) => h.label.startsWith('transaction from') && h.label.includes('pool-deadlock.test.ts'))).toBe(true)
    expect(exhausted.message).toContain('PostgreSQL pool "exhaust" exhausted')
    expect(waited).toBeLessThan(2_000)

    // Once a connection is released the pool serves again.
    const [row] = await db.execute<{ probe: number }>(sql`SELECT 42 AS probe`)
    expect(Number(row.probe)).toBe(42)
    await closeDatabase(db)
    opened.splice(opened.indexOf(db), 1)
  }, 10_000)
})
