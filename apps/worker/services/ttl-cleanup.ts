import { eq, sql, lt } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings, captchas } from '../db/schema'
import {
  validateTTLOverrides,
  type TTLOverrides,
  type CleanupMetrics,
  emptyCleanupMetrics,
  resolveTTL,
} from '../lib/ttl'
import { createLogger } from '../lib/logger'
import { withRetry, isRetryableDbError } from '../lib/retry'
import { getCircuitBreaker } from '../lib/circuit-breaker'
import { ServiceError } from './service-error'
import { SINGLETON_ID, getSettings } from './system-settings-row'

const log = createLogger('services.settings')

/**
 * TTL overrides, and the periodic sweep of expired rate-limit entries and CAPTCHA challenges with
 * its metrics.
 */
export class TtlCleanupService {
  constructor(protected db: Database) {}

  async getTTLOverrides(): Promise<{ overrides: TTLOverrides }> {
    const row = await getSettings(this.db)
    return { overrides: (row.ttlOverrides as TTLOverrides) ?? {} }
  }

  async updateTTLOverrides(
    data: Record<string, unknown>,
  ): Promise<{ overrides: TTLOverrides }> {
    const error = validateTTLOverrides(data)
    if (error) {
      throw new ServiceError(400, error)
    }
    const row = await getSettings(this.db)
    const current = (row.ttlOverrides as TTLOverrides) ?? {}
    const updated: TTLOverrides = { ...current }
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'number') {
        updated[key] = value
      }
    }
    await this.db
      .update(systemSettings)
      .set({ ttlOverrides: updated })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { overrides: updated }
  }

  async getCleanupMetrics(): Promise<CleanupMetrics> {
    const row = await getSettings(this.db)
    const metrics = row.cleanupMetrics as CleanupMetrics | null
    return metrics && Object.keys(metrics).length > 0
      ? metrics
      : emptyCleanupMetrics()
  }

  /**
   * Run periodic cleanup of expired rate limits and captchas.
   * Called by the task scheduler instead of DO alarms.
   */
  async runCleanup(): Promise<CleanupMetrics> {
    log.info('Starting periodic cleanup')

    const cb = getCircuitBreaker({
      name: 'settings-cleanup',
      failureThreshold: 5,
      resetTimeoutMs: 5 * 60 * 1000, // 5 minutes
      onStateChange: (_name, _from, to) => {
        if (to === 'open') {
          log.error(
            'CRITICAL: Settings cleanup circuit opened — persistent cleanup failures detected',
            new Error('Circuit opened: settings-cleanup'),
          )
        } else if (to === 'closed') {
          log.info('Settings cleanup circuit recovered')
        }
      },
    })

    try {
      return await cb.execute(() =>
        withRetry(
          async () => {
            const row = await getSettings(this.db)
            const overrides = (row.ttlOverrides as TTLOverrides) ?? {}
            const metrics =
              (row.cleanupMetrics as CleanupMetrics) ?? emptyCleanupMetrics()
            const now = Date.now()

            // Clean up expired rate limit entries. Done entirely in SQL —
            // `select().from(rateLimits)` with no limit used to pull every
            // distinct rate-limit key in the table into Node memory on
            // every cleanup tick, unbounded in the number of distinct
            // clients ever seen (issue #1127). The CTE below trims stale
            // timestamps and deletes now-empty rows in one round trip,
            // returning only the keys it deleted.
            const rateLimitTTL = resolveTTL('rateLimit', overrides)
            const cutoffMs = now - rateLimitTTL
            const deletedRateLimits = await this.db.execute<{ key: string }>(sql`
              WITH trimmed AS (
                UPDATE rate_limits
                SET timestamps = COALESCE((
                  SELECT jsonb_agg(elem.v)
                  FROM jsonb_array_elements(rate_limits.timestamps) AS elem(v)
                  WHERE (elem.v)::numeric > ${cutoffMs}
                ), '[]'::jsonb)
                RETURNING key, timestamps
              )
              DELETE FROM rate_limits
              WHERE key IN (SELECT key FROM trimmed WHERE timestamps = '[]'::jsonb)
              RETURNING key
            `)
            metrics.rateLimitEntriesDeleted += deletedRateLimits.length

            // Clean up expired CAPTCHA challenges
            const captchaTTL = resolveTTL('captchaChallenge', overrides)
            const cutoff = new Date(now - captchaTTL)
            const deleted = await this.db
              .delete(captchas)
              .where(lt(captchas.createdAt, cutoff))
              .returning()
            metrics.captchaChallengesDeleted += deleted.length

            metrics.lastCleanupAt = new Date().toISOString()
            await this.db
              .update(systemSettings)
              .set({ cleanupMetrics: metrics })
              .where(eq(systemSettings.id, SINGLETON_ID))

            log.info('Periodic cleanup complete', {
              rateLimitEntriesDeleted: metrics.rateLimitEntriesDeleted,
              captchaChallengesDeleted: metrics.captchaChallengesDeleted,
            })
            return metrics
          },
          {
            maxAttempts: 3,
            baseDelayMs: 1_000,
            maxDelayMs: 10_000,
            isRetryable: isRetryableDbError,
            onRetry: (attempt, error) => {
              log.warn('Settings cleanup attempt failed, retrying', {
                attempt,
                error: error instanceof Error ? error.message : String(error),
              })
            },
          },
        ),
      )
    } catch (err) {
      log.error('Settings cleanup failed', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }
}
