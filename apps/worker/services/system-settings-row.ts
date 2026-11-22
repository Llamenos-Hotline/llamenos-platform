/**
 * The `system_settings` singleton row: the one place it is read, and created on first read.
 */
import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings } from '../db/schema'

export const SINGLETON_ID = 1

 // 5 minutes

export async function getSettings(db: Database) {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.id, SINGLETON_ID))
  if (rows.length > 0) return rows[0]

  // Upsert the singleton
  const [row] = await db
    .insert(systemSettings)
    .values({ id: SINGLETON_ID })
    .onConflictDoNothing()
    .returning()
  // If onConflictDoNothing didn't insert (race), re-read
  if (!row) {
    const [existing] = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.id, SINGLETON_ID))
    return existing
  }
  return row
}

/**
 * THE decision whether cross-hub sharing is on. `CasesService.list` asks this
 * before it widens a listing past the path hub; the settings routes read it
 * through `PlatformSettingsService.getCrossHubSharingEnabled`. There is one stored
 * value (`system_settings.cross_hub_sharing_enabled`) and this is the one
 * place that reads it for a decision — the platform-settings feature flag of
 * the same name is a view of the same column, not a second store (#2605).
 */
export async function isCrossHubSharingEnabled(db: Database): Promise<boolean> {
  const row = await getSettings(db)
  return row.crossHubSharingEnabled ?? false
}
