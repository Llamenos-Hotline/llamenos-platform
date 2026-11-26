import { request } from './client'
import type { MigrationStatusResponse } from '@protocol/schemas'

// --- Migration Status (Epic 286) ---

export async function getMigrationStatus() {
  return request<MigrationStatusResponse>('/settings/migrations')
}
