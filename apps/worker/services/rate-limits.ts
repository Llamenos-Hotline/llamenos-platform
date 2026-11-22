import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { rateLimits, apiRateLimits } from '../db/schema'
import { ServiceError } from './service-error'

/**
 * Rate-limit counters: the per-key call limiter (`rate_limits`) and the API limiter (`api_rate_limits`).
 */
export class RateLimitService {
  constructor(protected db: Database) {}

  async checkRateLimit(data: {
    key: string
    maxPerMinute: number
  }): Promise<{ limited: boolean }> {
    if (!data.key || !/^[a-zA-Z0-9:_-]{1,256}$/.test(data.key)) {
      throw new ServiceError(400, 'Invalid rate limit key')
    }
    if (
      !Number.isInteger(data.maxPerMinute) ||
      data.maxPerMinute < 1 ||
      data.maxPerMinute > 1000
    ) {
      throw new ServiceError(
        400,
        'maxPerMinute must be an integer between 1 and 1000',
      )
    }

    const windowMs = 60_000

    // Single atomic statement (#1492). The previous implementation was a
    // read-modify-write: SELECT the array, filter and append in JS, then upsert
    // the whole array back. Concurrent requests on the same key all read the
    // same array and the last write won, so N simultaneous requests were
    // recorded as one — the limiter undercounted precisely under the parallel
    // traffic it exists to stop (invite enumeration, credential grinding).
    //
    // INSERT ... ON CONFLICT DO UPDATE takes a row lock and re-evaluates the
    // SET expression against the *committed* row, so concurrent callers are
    // serialised by PostgreSQL and each one observes every predecessor.
    //
    // The window is evaluated from the database's own clock (`now()`, the
    // transaction timestamp — stable for the whole statement) rather than from
    // Date.now(), so the stored timestamps and the expiry cutoff share one
    // clock and a skewed application server cannot widen or narrow the window.
    //
    // Retention is capped at maxPerMinute in-window entries before appending,
    // which bounds the row under a flood without changing any verdict: entries
    // dropped by the cap are strictly older than the ones kept, so whenever a
    // dropped entry would still be in-window the retained set already holds
    // maxPerMinute entries and the request is limited either way.
    const nowMs = sql`(EXTRACT(EPOCH FROM now()) * 1000)::bigint`
    const result = await this.db.execute<{ count: number }>(sql`
      INSERT INTO rate_limits (key, timestamps)
      VALUES (${data.key}, jsonb_build_array(${nowMs}))
      ON CONFLICT (key) DO UPDATE SET timestamps =
        COALESCE((
          SELECT jsonb_agg(recent.t)
          FROM (
            SELECT a.t
            FROM jsonb_array_elements(rate_limits.timestamps) AS a(t)
            WHERE (a.t)::numeric > ${nowMs} - ${windowMs}
            ORDER BY (a.t)::numeric DESC
            LIMIT ${data.maxPerMinute}
          ) AS recent
        ), '[]'::jsonb) || jsonb_build_array(${nowMs})
      RETURNING jsonb_array_length(timestamps) AS count
    `)

    const count = Number(result[0]?.count ?? 0)
    return { limited: count > data.maxPerMinute }
  }

  /**
   * Atomic fixed-window rate limit check. Returns whether the request is limited
   * and the Retry-After value in seconds.
   */
  async checkApiRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
  ): Promise<{ limited: boolean; retryAfterSeconds: number }> {
    const windowInterval = `${windowMs / 1000} seconds`

    const result = await this.db.execute<{ count: number; window_start: Date }>(sql`
      INSERT INTO api_rate_limits (key, count, window_start)
      VALUES (${key}, 1, NOW())
      ON CONFLICT (key) DO UPDATE
      SET count = CASE
        WHEN api_rate_limits.window_start < NOW() - ${windowInterval}::interval
        THEN 1
        ELSE api_rate_limits.count + 1
      END,
      window_start = CASE
        WHEN api_rate_limits.window_start < NOW() - ${windowInterval}::interval
        THEN NOW()
        ELSE api_rate_limits.window_start
      END
      RETURNING count, window_start
    `)

    const row = result[0]
    const count = Number(row?.count ?? 0)
    const windowStart = row?.window_start

    if (count > maxRequests) {
      const windowStartMs = windowStart instanceof Date
        ? windowStart.getTime()
        : new Date(String(windowStart)).getTime()
      const windowEndMs = windowStartMs + windowMs
      const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - Date.now()) / 1000))
      return { limited: true, retryAfterSeconds }
    }

    return { limited: false, retryAfterSeconds: 0 }
  }

  /**
   * Read-only rate limit check — reports whether a key is currently limited
   * WITHOUT consuming budget. Pair with checkApiRateLimit() on the failure
   * path to build failure-only counting (#1789): peek before doing the work,
   * increment only once an attempt has proven to be a failure, so conforming
   * callers are never charged against a brute-force budget.
   */
  async peekApiRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
  ): Promise<{ limited: boolean; retryAfterSeconds: number }> {
    const rows = await this.db
      .select({ count: apiRateLimits.count, windowStart: apiRateLimits.windowStart })
      .from(apiRateLimits)
      .where(eq(apiRateLimits.key, key))
      .limit(1)

    const row = rows[0]
    if (!row) return { limited: false, retryAfterSeconds: 0 }

    const windowStartMs = row.windowStart instanceof Date
      ? row.windowStart.getTime()
      : new Date(String(row.windowStart)).getTime()
    const windowEndMs = windowStartMs + windowMs

    // Window expired — the next increment resets the counter, so not limited.
    if (windowEndMs <= Date.now()) return { limited: false, retryAfterSeconds: 0 }

    if (row.count >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - Date.now()) / 1000))
      return { limited: true, retryAfterSeconds }
    }

    return { limited: false, retryAfterSeconds: 0 }
  }

  /** Clear API rate limit counters (new fixed-window table). */
  async clearApiRateLimits(prefix?: string): Promise<void> {
    if (prefix) {
      await this.db.delete(apiRateLimits).where(sql`${apiRateLimits.key} LIKE ${prefix + '%'}`)
    } else {
      await this.db.delete(apiRateLimits)
    }
  }

  /** Clear expired API rate limit windows (older than 10 minutes). */
  async clearExpiredApiRateLimits(): Promise<void> {
    await this.db.delete(apiRateLimits)
      .where(sql`${apiRateLimits.windowStart} < NOW() - INTERVAL '10 minutes'`)
  }

  /** Clear rate limit counters — used in BDD tests to prevent cross-scenario bleed.
   *  If prefix is provided, only clears keys starting with that prefix. */
  async clearRateLimits(prefix?: string): Promise<void> {
    if (prefix) {
      await this.db.delete(rateLimits).where(sql`${rateLimits.key} LIKE ${prefix + '%'}`)
    } else {
      await this.db.delete(rateLimits)
    }
  }
}
