/**
 * RetentionService — manages data retention configuration and purge execution.
 *
 * Per-hub retention settings with platform-enforced minimums.
 * Daily purge deletes records older than the configured retention period.
 */
import { eq, and, sql, lt, inArray, notInArray } from 'drizzle-orm'
import type { Database } from '../db'
import {
  retentionSettings,
  retentionPlatformFloors,
  callRecords,
  notes,
  auditLog,
} from '../db/schema'
import { ServiceError } from './settings'
import type { AuditService } from './audit'
import type { ProviderMediaEraser } from './provider-recordings'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.retention')

const VALID_CATEGORIES = ['call_records', 'notes', 'messages', 'audit_log'] as const
type RetentionCategory = (typeof VALID_CATEGORIES)[number]

function isValidCategory(cat: string): cat is RetentionCategory {
  return (VALID_CATEGORIES as readonly string[]).includes(cat)
}

/**
 * One category's purge in one hub. `keptCount` and `providerRecordingsRemaining`
 * are what the purge left behind on purpose — expired call records kept because
 * the provider still holds their audio, and the provider recordings it could not
 * delete. Counts only, never ids (operator decision B6).
 */
export interface RetentionPurgeResult {
  hubId: string
  category: string
  deletedCount: number
  keptCount: number
  providerRecordingsDeleted: number
  providerRecordingsRemaining: number
}

export class RetentionService {
  constructor(protected db: Database) {}

  // ---------------------------------------------------------------------------
  // Hub retention settings
  // ---------------------------------------------------------------------------

  async getSettings(hubId: string): Promise<(typeof retentionSettings.$inferSelect)[]> {
    return this.db
      .select()
      .from(retentionSettings)
      .where(eq(retentionSettings.hubId, hubId))
  }

  async upsertSettings(
    hubId: string,
    settings: { category: string; retentionDays: number }[],
    updatedBy: string,
  ): Promise<void> {
    for (const s of settings) {
      if (!isValidCategory(s.category)) {
        throw new ServiceError(400, `Invalid retention category: ${s.category}`)
      }
    }

    const floors = await this.getFloors()
    for (const s of settings) {
      const floor = floors.find((f) => f.category === s.category)
      if (floor && s.retentionDays < floor.minRetentionDays) {
        throw new ServiceError(
          400,
          `Retention for ${s.category} cannot be less than platform floor (${floor.minRetentionDays} days)`,
        )
      }
    }

    for (const s of settings) {
      await this.db
        .insert(retentionSettings)
        .values({
          hubId,
          category: s.category,
          retentionDays: s.retentionDays,
          updatedAt: new Date(),
          updatedBy,
        })
        .onConflictDoUpdate({
          target: [retentionSettings.hubId, retentionSettings.category],
          set: {
            retentionDays: s.retentionDays,
            updatedAt: new Date(),
            updatedBy,
          },
        })
    }
  }

  // ---------------------------------------------------------------------------
  // Platform floors
  // ---------------------------------------------------------------------------

  async getFloors(): Promise<(typeof retentionPlatformFloors.$inferSelect)[]> {
    return this.db.select().from(retentionPlatformFloors)
  }

  async upsertFloors(
    floors: { category: string; minRetentionDays: number }[],
    updatedBy: string,
  ): Promise<void> {
    for (const f of floors) {
      if (!isValidCategory(f.category)) {
        throw new ServiceError(400, `Invalid retention category: ${f.category}`)
      }
      await this.db
        .insert(retentionPlatformFloors)
        .values({
          category: f.category,
          minRetentionDays: f.minRetentionDays,
          updatedAt: new Date(),
          updatedBy,
        })
        .onConflictDoUpdate({
          target: retentionPlatformFloors.category,
          set: {
            minRetentionDays: f.minRetentionDays,
            updatedAt: new Date(),
            updatedBy,
          },
        })
    }
  }

  // ---------------------------------------------------------------------------
  // Purge execution
  // ---------------------------------------------------------------------------

  /**
   * @param providerMedia deletes, at the telephony provider, the recordings of
   *   purged call records (#2297). Required: purging the row that holds a
   *   recording's handle without deleting the recording would leave the caller
   *   audio at the provider with nothing left to find it by.
   */
  async executePurge(
    auditService: AuditService,
    providerMedia: ProviderMediaEraser,
  ): Promise<RetentionPurgeResult[]> {
    const allSettings = await this.db.select().from(retentionSettings)
    const results: RetentionPurgeResult[] = []

    for (const setting of allSettings) {
      const cutoff = new Date(
        Date.now() - setting.retentionDays * 24 * 60 * 60 * 1000,
      )

      let deletedCount = 0
      let keptCount = 0
      let providerRecordingsDeleted = 0
      let providerRecordingsRemaining = 0

      switch (setting.category) {
        case 'call_records': {
          // Only purge terminal-state records — never delete active/ringing calls
          const TERMINAL_STATUSES = ['ended', 'missed', 'no-answer', 'rejected']
          const expired = and(
            eq(callRecords.hubId, setting.hubId),
            lt(callRecords.createdAt, cutoff),
            inArray(callRecords.status, TERMINAL_STATUSES),
          )
          // The provider's copies go first. A call whose recording the
          // provider would not delete keeps its record — and with it the
          // handle — so the next purge retries instead of orphaning the audio.
          const candidates = await this.db.select({ callId: callRecords.callId }).from(callRecords).where(expired)
          const media = await providerMedia.deleteForCalls(setting.hubId, candidates.map(r => r.callId))
          const kept = [...new Set(media.failed.map(f => f.callId))]
          keptCount = kept.length
          providerRecordingsDeleted = media.deleted
          providerRecordingsRemaining = media.failed.length
          if (kept.length > 0) {
            logger.error('Retention purge kept call records whose provider recordings could not be deleted', {
              hubId: setting.hubId,
              kept: kept.length,
            })
          }
          const result = await this.db
            .delete(callRecords)
            .where(kept.length > 0 ? and(expired, notInArray(callRecords.callId, kept)) : expired)
            .returning()
          deletedCount = result.length
          break
        }
        case 'notes': {
          const result = await this.db
            .delete(notes)
            .where(
              and(
                eq(notes.hubId, setting.hubId),
                lt(notes.createdAt, cutoff),
              ),
            )
            .returning()
          deletedCount = result.length
          break
        }
        case 'messages': {
          const result = await this.db.execute(sql`
            DELETE FROM messages
            WHERE conversation_id IN (
              SELECT id FROM conversations WHERE hub_id = ${setting.hubId}
            )
            AND created_at < ${cutoff.toISOString()}::timestamptz
            RETURNING id
          `)
          deletedCount = (result as unknown[]).length
          break
        }
        case 'audit_log': {
          const result = await this.db
            .delete(auditLog)
            .where(
              and(
                eq(auditLog.hubId, setting.hubId),
                lt(auditLog.createdAt, cutoff),
              ),
            )
            .returning()
          deletedCount = result.length
          break
        }
      }

      // A run that only KEPT records is still reported: an audit that showed
      // nothing would read as "nothing expired" while caller audio sat at the
      // provider and its records outlived their retention period.
      if (deletedCount > 0 || keptCount > 0 || providerRecordingsDeleted > 0 || providerRecordingsRemaining > 0) {
        const result: RetentionPurgeResult = {
          hubId: setting.hubId,
          category: setting.category,
          deletedCount,
          keptCount,
          providerRecordingsDeleted,
          providerRecordingsRemaining,
        }
        results.push(result)

        await auditService.log(
          'retentionPurgeExecuted',
          'system',
          { ...result, retentionDays: setting.retentionDays },
          setting.hubId,
        )
      }
    }

    logger.info('Retention purge complete', {
      hubsProcessed: allSettings.length,
      totalDeleted: results.reduce((sum, r) => sum + r.deletedCount, 0),
      totalKept: results.reduce((sum, r) => sum + r.keptCount, 0),
      providerRecordingsRemaining: results.reduce((sum, r) => sum + r.providerRecordingsRemaining, 0),
    })

    return results
  }
}
