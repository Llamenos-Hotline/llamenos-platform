import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings } from '../db/schema'
import { SINGLETON_ID, getSettings } from './system-settings-row'

/**
 * Which case-management templates have been applied (`system_settings`).
 */
export class TemplateStateService {
  constructor(protected db: Database) {}

  async getAppliedTemplates(): Promise<{
    appliedTemplates: unknown[]
  }> {
    const row = await getSettings(this.db)
    return {
      appliedTemplates: (row.appliedTemplates as unknown[]) ?? [],
    }
  }

  async setAppliedTemplates(data: {
    appliedTemplates: unknown[]
  }): Promise<{ ok: true }> {
    await this.db
      .update(systemSettings)
      .set({ appliedTemplates: data.appliedTemplates })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return { ok: true }
  }
}
