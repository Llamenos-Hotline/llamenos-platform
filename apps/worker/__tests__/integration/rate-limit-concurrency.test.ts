/**
 * Rate limiter atomicity — real PostgreSQL (#1492).
 *
 * `SettingsService.checkRateLimit` was read-modify-write: SELECT the timestamp
 * array, filter it in JS, append, then upsert the whole array back. Two
 * concurrent requests on the same key both read the same array, both append
 * their own timestamp, and the second write overwrites the first — so N
 * simultaneous requests are recorded as one. The limiter therefore undercounts
 * precisely under the parallel traffic it exists to stop (invite enumeration,
 * credential grinding).
 *
 * A sequential test cannot catch this: 6 requests one after another are
 * counted correctly both before and after the fix. Only genuinely simultaneous
 * requests on distinct connections expose it, which is why this needs real
 * PostgreSQL rather than a mocked `db`.
 *
 * Also covers the tiered `rateLimit()` middleware path (which goes through the
 * already-atomic `checkApiRateLimit` fixed-window counter) with
 * `ENVIRONMENT=production`, so the enforcing path is exercised rather than the
 * development bypass.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { Hono } from 'hono'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { SettingsService } from '../../services/settings'
import { rateLimit, RATE_LIMIT_TIERS } from '../../middleware/rate-limit'
import type { AppEnv } from '../../types'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_rate_limit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/settings.ts rateLimits + apiRateLimits.
const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.rate_limits (
    key         TEXT PRIMARY KEY,
    timestamps  JSONB NOT NULL DEFAULT '[]'::jsonb
  );
  CREATE TABLE ${TEST_SCHEMA}.api_rate_limits (
    key           TEXT PRIMARY KEY,
    count         INTEGER NOT NULL DEFAULT 1,
    window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`

const JSONB_TYPE = {
  to: 3802,
  from: [3802],
  serialize: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
  parse: (v: string) => {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  },
}

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let settings: SettingsService

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)

  // A multi-connection pool is required: the race only exists when the
  // concurrent requests run on distinct connections.
  testSql = postgres(DATABASE_URL, {
    max: 16,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE },
  })
  const db = drizzle({ client: testSql, schema }) as unknown as Database
  settings = new SettingsService(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE rate_limits`
  await testSql`TRUNCATE TABLE api_rate_limits`
})

/** Count of timestamps persisted for a key — the limiter's own bookkeeping. */
async function storedCount(key: string): Promise<number> {
  const rows = await testSql<{ n: number }[]>`
    SELECT jsonb_array_length(timestamps) AS n FROM rate_limits WHERE key = ${key}
  `
  return rows.length === 0 ? 0 : Number(rows[0]!.n)
}

/** Shift every stored timestamp back by `ms`, simulating elapsed wall time. */
async function ageStoredTimestamps(key: string, ms: number): Promise<void> {
  await testSql`
    UPDATE rate_limits
    SET timestamps = (
      SELECT jsonb_agg((a.t::numeric - ${ms})::bigint)
      FROM jsonb_array_elements(timestamps) AS a(t)
    )
    WHERE key = ${key}
  `
}

describe('SettingsService.checkRateLimit under concurrency (#1492)', () => {
  it('admits exactly maxPerMinute of N simultaneous requests on one key', async () => {
    const max = 5
    const n = 20
    const key = 'invite-redeem:concurrent'

    const results = await Promise.all(
      Array.from({ length: n }, () =>
        settings.checkRateLimit({ key, maxPerMinute: max }),
      ),
    )

    const admitted = results.filter((r) => !r.limited).length
    expect(admitted).toBe(max)
    expect(results.filter((r) => r.limited)).toHaveLength(n - max)
  })

  it('does not lose requests across repeated concurrent bursts', async () => {
    const max = 5
    const key = 'auth-login:concurrent'

    // First burst consumes the budget.
    const first = await Promise.all(
      Array.from({ length: max }, () =>
        settings.checkRateLimit({ key, maxPerMinute: max }),
      ),
    )
    expect(first.filter((r) => !r.limited)).toHaveLength(max)

    // Everything in a second concurrent burst is over budget.
    const second = await Promise.all(
      Array.from({ length: 10 }, () =>
        settings.checkRateLimit({ key, maxPerMinute: max }),
      ),
    )
    expect(second.every((r) => r.limited)).toBe(true)
  })

  it('keys are independent — a burst on one key does not limit another', async () => {
    const max = 5
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        settings.checkRateLimit({ key: `invite-redeem:ip-${i}`, maxPerMinute: max }),
      ),
    )
    expect(results.every((r) => !r.limited)).toBe(true)
  })
})

describe('SettingsService.checkRateLimit sequential semantics (unchanged)', () => {
  it('admits maxPerMinute then limits, and recovers after the window', async () => {
    const max = 5
    const key = 'invite-redeem:sequential'

    for (let i = 0; i < max; i++) {
      const r = await settings.checkRateLimit({ key, maxPerMinute: max })
      expect(r.limited).toBe(false)
    }

    const over = await settings.checkRateLimit({ key, maxPerMinute: max })
    expect(over.limited).toBe(true)

    // Window expiry: once the recorded timestamps fall outside the 60s window
    // the budget is restored.
    await ageStoredTimestamps(key, 61_000)
    const afterWindow = await settings.checkRateLimit({ key, maxPerMinute: max })
    expect(afterWindow.limited).toBe(false)
  })

  it('does not overcount — one request consumes exactly one unit', async () => {
    const key = 'webauthn:overcount'

    await settings.checkRateLimit({ key, maxPerMinute: 5 })
    expect(await storedCount(key)).toBe(1)

    await settings.checkRateLimit({ key, maxPerMinute: 5 })
    expect(await storedCount(key)).toBe(2)
  })

  it('a partially expired window only forgets the expired requests', async () => {
    const max = 5
    const key = 'auth-bootstrap:partial'

    // Three requests, aged past the window.
    for (let i = 0; i < 3; i++) {
      await settings.checkRateLimit({ key, maxPerMinute: max })
    }
    await ageStoredTimestamps(key, 61_000)

    // Budget is fully restored: max more requests are admitted, then limited.
    for (let i = 0; i < max; i++) {
      const r = await settings.checkRateLimit({ key, maxPerMinute: max })
      expect(r.limited).toBe(false)
    }
    expect((await settings.checkRateLimit({ key, maxPerMinute: max })).limited).toBe(true)
  })

  it('rejects invalid keys and bounds before touching the database', async () => {
    await expect(
      settings.checkRateLimit({ key: 'bad key!', maxPerMinute: 5 }),
    ).rejects.toThrow(/Invalid rate limit key/)
    await expect(
      settings.checkRateLimit({ key: 'ok:1', maxPerMinute: 0 }),
    ).rejects.toThrow(/maxPerMinute/)
  })
})

describe('rateLimit() tier middleware against real PostgreSQL', () => {
  function makeApp() {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('services', { settings } as unknown as AppEnv['Variables']['services'])
      await next()
    })
    app.use('/strict', rateLimit('strict'))
    app.get('/strict', (c) => c.json({ ok: true }))
    return app
  }

  function request(app: ReturnType<typeof makeApp>, ip: string, environment: string) {
    return app.fetch(
      new Request('http://local.test/strict', { headers: { 'CF-Connecting-IP': ip } }),
      { ENVIRONMENT: environment },
    )
  }

  it('admits exactly the strict budget out of N simultaneous requests', async () => {
    const app = makeApp()
    const max = RATE_LIMIT_TIERS.strict.maxRequests
    const n = 20

    const responses = await Promise.all(
      Array.from({ length: n }, () => request(app, '198.51.100.7', 'production')),
    )
    const statuses = responses.map((r) => r.status)

    expect(statuses.filter((s) => s === 200)).toHaveLength(max)
    expect(statuses.filter((s) => s === 429)).toHaveLength(n - max)
    for (const r of responses.filter((r) => r.status === 429)) {
      expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0)
    }
  })

  it('skips enforcement under ENVIRONMENT=development (documented bypass)', async () => {
    const app = makeApp()
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app, '198.51.100.8', 'development')),
    )
    expect(responses.every((r) => r.status === 200)).toBe(true)
  })
})
