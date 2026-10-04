/**
 * Stale call reaper — periodically archives `active_calls` rows that have passed
 * their staleness TTL (ringing > 3 min, in-progress > 2 hours) into `call_records`,
 * across EVERY hub, regardless of whether any hub's dashboard has been opened
 * recently.
 *
 * `CallsService.getActiveCalls(hubId)` already does this lazily, as a side effect of
 * being called for a specific hub. A hub nobody has an open dashboard for — or whose
 * telephony provider stopped sending status callbacks — would otherwise accumulate
 * `active_calls` and `call_tokens` rows indefinitely. Routing itself does not get stuck
 * on these rows (`CallsService.getBusyPubkeys` applies its own TTL filter at query
 * time), but the operator-facing presence view for that hub is only ever as fresh as
 * its last read, and the rows themselves are a real resource leak. This worker runs
 * the same archive on a fixed schedule so it never depends on a read happening (#1136).
 */
import type { CallsService } from '../services/calls'
import { createLogger } from './logger'

const logger = createLogger('lib.stale-call-reaper')

/**
 * Check interval: every 2 minutes — tighter than the 3-minute ringing TTL so a
 * ringing call that nobody answered is reaped within one interval of going stale.
 */
const CHECK_INTERVAL_MS = 2 * 60 * 1000

let intervalId: ReturnType<typeof setInterval> | null = null

export function startStaleCallReaperWorker(callsService: CallsService): void {
  if (intervalId) return

  logger.info('Started stale call reaper worker')

  const check = async () => {
    try {
      const reaped = await callsService.reapStaleCalls()
      if (reaped > 0) {
        logger.info('Reaped stale call(s)', { count: reaped })
      }
    } catch (err) {
      logger.error('Stale call reap failed', { error: err })
    }
  }

  check()

  intervalId = setInterval(check, CHECK_INTERVAL_MS)
}

export function stopStaleCallReaperWorker(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    logger.info('Stopped stale call reaper worker')
  }
}
