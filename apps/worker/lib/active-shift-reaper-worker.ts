/**
 * Active-shift reaper — deletes clock-ins whose heartbeat has stopped, for
 * EVERY hub, on a fixed schedule (#1142).
 *
 * `ActiveShiftsService.cleanupStale` used to have no caller, so a volunteer who
 * clocked in and then closed the app stayed in `active_shifts` for good: shown
 * on the admin roster, counted as a ring target, and — because the hub's
 * fallback group is only tried when nobody is both scheduled and clocked in —
 * keeping the fallback from ever being tried.
 *
 * Who RINGS does not depend on this worker running: `listClockedInPubkeys`
 * already ignores a stale heartbeat at query time. This worker is what removes
 * the rows, so the roster stays honest and the table does not grow without
 * bound — and it records each eviction in the audit log the way an explicit
 * clock-out is, since a volunteer leaving the roster is something an admin may
 * need to explain later.
 *
 * Period and staleness window come from `ActiveShiftsService.liveness`
 * (`ACTIVE_SHIFT_REAP_INTERVAL_SECONDS`, `ACTIVE_SHIFT_STALE_AFTER_MINUTES`).
 */
import type { ActiveShiftsService } from '../services/active-shifts'
import { audit, type AuditService } from '../services/audit'
import { createLogger } from './logger'
import { setWorkerTickInterval, trackWorkerTick } from '../metrics/worker-liveness'

const logger = createLogger('lib.active-shift-reaper')

let intervalId: ReturnType<typeof setInterval> | null = null

/** One reap. Exported for tests; the worker below calls it on an interval. */
export async function runActiveShiftReap(
  activeShifts: ActiveShiftsService,
  auditService: AuditService,
): Promise<number> {
  const { removed, evicted } = await activeShifts.cleanupStale()
  for (const { pubkey, hubId } of evicted) {
    try {
      await audit(auditService, 'shiftClockOut', pubkey, { reason: 'heartbeat_stale' }, undefined, hubId)
    } catch (err) {
      // The row is already gone; failing the tick would not bring it back.
      logger.error('Could not audit a stale clock-in eviction', { hubId, error: err })
    }
  }
  if (removed > 0) {
    logger.info('Evicted stale clock-in(s)', { count: removed })
  }
  return removed
}

export function startActiveShiftReaperWorker(deps: {
  activeShifts: ActiveShiftsService
  auditService: AuditService
}): void {
  if (intervalId) return

  const { reapIntervalMs, staleAfterMs } = deps.activeShifts.liveness
  // The liveness gauge is judged against the period this worker really runs at.
  setWorkerTickInterval('active-shift-reaper', reapIntervalMs)
  logger.info('Started active-shift reaper worker', { reapIntervalMs, staleAfterMs })

  const tick = () =>
    trackWorkerTick('active-shift-reaper', () => runActiveShiftReap(deps.activeShifts, deps.auditService))
      .catch((err) => {
        logger.error('Active-shift reap failed', { error: err })
      })

  tick()

  intervalId = setInterval(tick, reapIntervalMs)
}

export function stopActiveShiftReaperWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped active-shift reaper worker')
  }
}
