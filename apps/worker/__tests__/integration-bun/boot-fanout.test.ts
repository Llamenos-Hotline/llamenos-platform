/**
 * The boot-time hub fan-out on a pool narrower than the hub count (#2586) —
 * real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest (the gate wraps Bun's SQL client):
 *   bun test apps/worker/__tests__/integration-bun/boot-fanout.test.ts
 *
 * The defect: `src/server/index.ts` awaits `warnOnUnroutableHubs` before it
 * serves, and that check asks three questions of EVERY active hub at once
 * (`Promise.all` over hubs × shifts / fallback group / voice switch). On a cold
 * pool that is a burst of 3 × hubs queries against a handful of connections.
 * Bun's SQL pool queues the surplus without bound and, under that burst,
 * sometimes never dispatches it: every connection sits idle in PostgreSQL while
 * the process waits on a result that is not coming. The server logged
 * "platform admin ensured" and then never listened — no error, no timeout, a
 * deploy that looks like a slow boot. Measured on the pre-#2752 code against a
 * 16-hub database: 15 of 24 boots hung (pool 4: 4/8, pool 8: 8/8, pool 10: 3/8).
 * It is not a hub-count threshold — Bun alone, with no application code, hung a
 * 10-connection pool on 15 queries.
 *
 * #2752's gate is the fix (it admits at most `max` operations, so the driver
 * never has a surplus to queue). This pins it at the place the hang was
 * observed, on a COLD pool each round — the lazily-opened connections are what
 * the burst races — because the gate's own tests exercise it on a fake client
 * and the pool-deadlock suite on transactions, and neither runs a read burst
 * wider than the pool through a real database.
 *
 * Every wait is bounded by `settlesWithin`, so a regression fails with a
 * pg_stat_activity dump instead of hanging the suite.
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`). Rows created here are deleted on
 * teardown.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { SQL } from 'bun'
import '../../db/pg-array-patch'
import { openDatabase, closeDatabase, type Database } from '../../db'
import type { Services } from '../../services'
import { ShiftsService } from '../../services/shifts'
import { SettingsService } from '../../services/settings'
import { warnOnUnroutableHubs } from '../../services/routing-readiness'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

/** Hubs this suite creates. Each costs 3 queries in the boot check. */
const HUBS = 16
/** Fresh cold pools opened, one per round: the race is in the pool's first burst. */
const ROUNDS = 6
/** Narrower than HUBS × 3 in every case; includes the sizes the hang was measured at. */
const POOL_SIZES = [2, 4, 8]

/** An un-gated connection for diagnostics and teardown — never part of the pools under test. */
const monitor = new SQL({ url: DATABASE_URL, max: 1 })

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const hubIds = Array.from({ length: HUBS }, (_, i) => `hub-boot-${i}-${suite}`)
const opened: Database[] = []
let seeded = false

async function seedHubs(): Promise<void> {
  if (seeded) return
  seeded = true
  // `status` defaults to active and a hub with no settings row takes every
  // channel, voice included, with no shift and no fallback group: each one is
  // a hub that "can ring nobody", which is what the check reports.
  await monitor`INSERT INTO hubs ${monitor(
    hubIds.map((id) => ({ id, name: id, slug: id, created_by: 'integration-test' })),
  )}`
}

/** The two services the boot check reads, wired as services/index.ts wires them, on `db`. */
function servicesOn(db: Database): Services {
  return { shifts: new ShiftsService(db), settings: new SettingsService(db) } as unknown as Services
}

/** Resolve with `work`, or fail after `ms` with what the database was doing — never hang. */
async function settlesWithin<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(async () => {
      const activity = await monitor`
        SELECT pid, state, wait_event_type, wait_event, left(query, 100) AS query
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`
      reject(new Error(`${what} did not settle within ${ms}ms — the pool never dispatched its queue. Connections: ${JSON.stringify(activity)}`))
    }, ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

afterAll(async () => {
  // A wedged pool never drains: close it hard.
  for (const db of opened) await (db as Database & { $client: { close(o: { timeout: number }): Promise<void> } }).$client.close({ timeout: 0 })
  await monitor`DELETE FROM hub_settings WHERE hub_id IN ${monitor(hubIds)}`
  await monitor`DELETE FROM hubs WHERE id IN ${monitor(hubIds)}`
  await monitor.close()
})

describe('warnOnUnroutableHubs on a cold pool narrower than the hub fan-out (#2586)', () => {
  for (const max of POOL_SIZES) {
    it(`completes on every one of ${ROUNDS} cold pools of ${max} connections (${HUBS * 3}+ queries in one burst)`, async () => {
      await seedHubs()
      for (let round = 0; round < ROUNDS; round++) {
        const db = openDatabase(DATABASE_URL, { name: `boot-${max}-${round}`, max, idleTimeout: 0, acquireTimeoutMs: 10_000 })
        opened.push(db)

        const unroutable = await settlesWithin(
          10_000,
          `boot hub check on a cold pool of ${max} (round ${round})`,
          warnOnUnroutableHubs(servicesOn(db)),
        )

        // The check must have actually answered for our hubs, not swallowed a
        // failure: warnOnUnroutableHubs catches everything and returns [].
        const reported = new Set(unroutable.map((h) => h.hubId))
        for (const id of hubIds) expect(reported.has(id)).toBe(true)

        await closeDatabase(db)
        opened.splice(opened.indexOf(db), 1)
      }
    }, 90_000)
  }
})
