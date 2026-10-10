/**
 * DigestCronService — sends daily/weekly digest summaries to opted-in users.
 *
 * Runs on a schedule (called by the TaskScheduler or a cron endpoint).
 * For each user with digestCadence !== 'off', fetches recent auth events,
 * renders a summary, and dispatches via UserNotificationsService.
 */
import { createLogger } from '../lib/logger'
import type { Database } from '../db'
import { userSecurityPrefs } from '../db/schema/signal-notifications'
import { eq } from 'drizzle-orm'
import type { UserNotificationsService } from './user-notifications'
import type { SecurityPrefsService } from './security-prefs'
import { auditLog } from '../db/schema'
import { count, and, gte } from 'drizzle-orm'

const log = createLogger('services.digest-cron')

export class DigestCronService {
  constructor(
    private db: Database,
    private notifications: UserNotificationsService,
    private prefs: SecurityPrefsService
  ) {}

  /**
   * Send digests to all eligible users.
   * @param cadence - which cadence to process ('daily' | 'weekly')
   */
  async runDigests(cadence: 'daily' | 'weekly'): Promise<{ sent: number; skipped: number }> {
    const periodDays = cadence === 'daily' ? 1 : 7

    // Find all users with matching digest cadence and signal channel
    const eligibleRows = await this.db
      .select({ userPubkey: userSecurityPrefs.userPubkey })
      .from(userSecurityPrefs)
      .where(
        and(
          eq(userSecurityPrefs.digestCadence, cadence),
          eq(userSecurityPrefs.notificationChannel, 'signal')
        )
      )

    let sent = 0
    let skipped = 0

    for (const { userPubkey } of eligibleRows) {
      try {
        const since = new Date(Date.now() - periodDays * 86400 * 1000)

        // Count login events in the period
        const [loginResult] = await this.db
          .select({ n: count() })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.actorPubkey, userPubkey),
              eq(auditLog.action, 'login'),
              gte(auditLog.createdAt, since)
            )
          )

        // Count alert_sent events in the period
        const [alertResult] = await this.db
          .select({ n: count() })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.actorPubkey, userPubkey),
              eq(auditLog.action, 'signal_alert_sent'),
              gte(auditLog.createdAt, since)
            )
          )

        // Count failed login attempts (auth failures recorded as separate events)
        const [failedResult] = await this.db
          .select({ n: count() })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.actorPubkey, userPubkey),
              eq(auditLog.action, 'loginFailed'),
              gte(auditLog.createdAt, since)
            )
          )

        const result = await this.notifications.sendAlert(userPubkey, {
          type: 'digest',
          periodDays,
          loginCount: Number(loginResult?.n ?? 0),
          alertCount: Number(alertResult?.n ?? 0),
          failedCount: Number(failedResult?.n ?? 0),
        })

        if (result.delivered) {
          sent++
        } else {
          skipped++
        }
      } catch (err) {
        log.error('Digest failed for user', { userPubkey, err })
        skipped++
      }
    }

    log.info('Digest run complete', { cadence, sent, skipped })
    return { sent, skipped }
  }
}
