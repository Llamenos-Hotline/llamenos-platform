/**
 * Retention purge worker — runs on a configurable interval,
 * checks if it's the configured purge hour, and executes the purge.
 */
import type { RetentionService } from '../services/retention'
import type { AuditService } from '../services/audit'
import type { SettingsService } from '../services/settings'
import type { ProviderMediaEraser } from '../services/provider-recordings'
import { createLogger } from './logger'
import { trackWorkerTick, WORKER_TICK_INTERVAL_MS } from '../metrics/worker-liveness'

const logger = createLogger('lib.retention-purge')

/** Check interval: every 30 minutes */
const CHECK_INTERVAL_MS = WORKER_TICK_INTERVAL_MS['retention-purge']

let intervalId: ReturnType<typeof setInterval> | null = null
let lastPurgeDate: string | null = null

interface RetentionPurgeWorkerOpts {
  retentionService: RetentionService
  auditService: AuditService
  settingsService: SettingsService
  /** Deletes purged calls' recordings at the provider first (#2297). */
  providerMedia: ProviderMediaEraser
}

export function startRetentionPurgeWorker(opts: RetentionPurgeWorkerOpts): void {
  if (intervalId) return

  logger.info('Started retention purge worker')

  const check = () =>
    trackWorkerTick('retention-purge', async () => {
      const platformSettings = await opts.settingsService.getPlatformSettings()
      const retentionPurge = (platformSettings as Record<string, unknown>)
        .retentionPurge as
        | { cronHourUtc?: number; enabled?: boolean }
        | undefined

      const enabled = retentionPurge?.enabled ?? true
      if (!enabled) return

      const cronHour = retentionPurge?.cronHourUtc ?? 3
      const now = new Date()
      const currentHour = now.getUTCHours()
      const today = now.toISOString().slice(0, 10)

      if (currentHour === cronHour && lastPurgeDate !== today) {
        lastPurgeDate = today
        logger.info('Executing retention purge', { cronHour, today })
        const results = await opts.retentionService.executePurge(
          opts.auditService,
          opts.providerMedia,
        )
        logger.info('Retention purge complete', {
          results: results.length,
          totalDeleted: results.reduce((s, r) => s + r.deletedCount, 0),
        })
      }
    }).catch((err) => {
      logger.error('Retention purge check failed', { error: err })
    })

  check()

  intervalId = setInterval(check, CHECK_INTERVAL_MS)
}

export function stopRetentionPurgeWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped retention purge worker')
  }
}
