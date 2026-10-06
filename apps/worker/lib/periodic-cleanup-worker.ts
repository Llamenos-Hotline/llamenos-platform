/**
 * Periodic cleanup worker — runs IdentityService.cleanup() and
 * SettingsService.runCleanup() on an interval, plus the API rate-limit
 * fixed-window purge.
 *
 * All three were implemented, unit-tested, and documented as "intended to
 * be called from a scheduled worker" — but had no caller. `auth_nonces`
 * gets one row per authenticated API request with a 5-minute TTL that
 * nothing acted on, so the table (and its index) grew without bound on the
 * auth hot path from the moment the server first served a request. See
 * issue #1127.
 */
import type { IdentityService } from '../services/identity'
import type { SettingsService } from '../services/settings'
import { createLogger } from './logger'

const logger = createLogger('lib.periodic-cleanup')

/**
 * Every 5 minutes — matches the shortest TTL being purged (auth nonces,
 * WebAuthn challenges both expire on a 5-minute window).
 */
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

export interface PeriodicCleanupWorkerOpts {
  identityService: IdentityService
  settingsService: SettingsService
}

let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Run one cleanup pass. Each sub-cleanup is independent — a failure in one
 * (already wrapped in its own circuit breaker/retry inside the service)
 * must not skip the others. Exported for tests; the scheduler calls it
 * through the worker below.
 */
export async function runPeriodicCleanup(opts: PeriodicCleanupWorkerOpts): Promise<void> {
  try {
    const result = await opts.identityService.cleanup()
    logger.info('Identity cleanup pass complete', result)
  } catch (err) {
    logger.error('Identity cleanup pass failed', { error: err })
  }

  try {
    const result = await opts.settingsService.runCleanup()
    logger.info('Settings cleanup pass complete', {
      rateLimitEntriesDeleted: result.rateLimitEntriesDeleted,
      captchaChallengesDeleted: result.captchaChallengesDeleted,
    })
  } catch (err) {
    logger.error('Settings cleanup pass failed', { error: err })
  }

  try {
    await opts.settingsService.clearExpiredApiRateLimits()
  } catch (err) {
    logger.error('API rate limit purge failed', { error: err })
  }
}

export function startPeriodicCleanupWorker(opts: PeriodicCleanupWorkerOpts): void {
  if (intervalId) return

  logger.info('Started periodic cleanup worker')

  const run = () => {
    runPeriodicCleanup(opts).catch((err) => {
      logger.error('Periodic cleanup run failed', { error: err })
    })
  }

  run()
  intervalId = setInterval(run, CLEANUP_INTERVAL_MS)
}

export function stopPeriodicCleanupWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped periodic cleanup worker')
  }
}
