import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import { systemSettings } from '../db/schema'
import type { SetupState } from '@shared/types'
import { DEFAULT_SETUP_STATE } from '@shared/types'
import { SINGLETON_ID, getSettings } from './system-settings-row'

/**
 * The setup-wizard progress stored on the `system_settings` singleton.
 */
export class SetupStateService {
  constructor(protected db: Database) {}

  async getSetupState(): Promise<SetupState> {
    const row = await getSettings(this.db)
    const state = row.setupState as SetupState | null
    return state && Object.keys(state).length > 0
      ? state
      : DEFAULT_SETUP_STATE
  }

  async updateSetupState(data: Partial<SetupState>): Promise<SetupState> {
    const current = await this.getSetupState()
    const updated = { ...current, ...data }
    await this.db
      .update(systemSettings)
      .set({ setupState: updated })
      .where(eq(systemSettings.id, SINGLETON_ID))
    return updated
  }
}
