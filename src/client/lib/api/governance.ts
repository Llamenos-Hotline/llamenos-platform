import { request, hp } from './client'
import type {
  ErasureRequest,
  ErasureConfig,
  ReEncryptionJob,
  RetentionSetting,
  RetentionPlatformFloor,
  PlatformBan,
  PlatformSettings,
} from '@protocol/schemas'

// --- EP08: Erasure, Retention, Bans, Platform Settings ---

// --- Erasure ---

export async function getMyErasureRequest() {
  return request<{ request: ErasureRequest | null }>(hp('/erasure/me'))
}

export async function createMyErasureRequest() {
  return request<{ request: ErasureRequest }>(hp('/erasure/me'), { method: 'POST' })
}

export async function cancelMyErasureRequest() {
  return request<{ ok: true }>(hp('/erasure/me'), { method: 'DELETE' })
}

export async function listErasureRequests(params?: { status?: string }) {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  const query = qs.toString()
  return request<{ requests: ErasureRequest[] }>(hp(`/erasure/requests${query ? `?${query}` : ''}`))
}

export async function adminEraseUser(userId: string, justification: string) {
  return request<{ ok: true }>(hp(`/erasure/${userId}`), {
    method: 'POST',
    body: JSON.stringify({ justification }),
  })
}

export async function remoteWipeDevice(userId: string, devicePubkey: string) {
  return request<{ ok: true }>(hp(`/erasure/${userId}/wipe-device/${encodeURIComponent(devicePubkey)}`), {
    method: 'POST',
  })
}

export async function getErasureConfig() {
  return request<{ config: ErasureConfig }>(hp('/erasure/config'))
}

export async function updateErasureConfig(data: { delayHours?: number; emergencyOverrideEnabled?: boolean }) {
  return request<{ config: ErasureConfig }>(hp('/erasure/config'), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function listReEncryptionJobs(params?: { userId?: string }) {
  const qs = new URLSearchParams()
  if (params?.userId) qs.set('userId', params.userId)
  const query = qs.toString()
  return request<{ jobs: ReEncryptionJob[] }>(hp(`/erasure/re-encryption-jobs${query ? `?${query}` : ''}`))
}

// --- Retention ---

export async function getRetentionSettings() {
  return request<{ settings: RetentionSetting[] }>(hp('/retention'))
}

export async function updateRetentionSettings(data: { category: string; retentionDays: number }) {
  return request<{ setting: RetentionSetting }>(hp('/retention'), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function getRetentionPlatformFloors() {
  return request<{ floors: RetentionPlatformFloor[] }>('/retention/platform-floors')
}

export async function updateRetentionPlatformFloor(data: { category: string; minRetentionDays: number }) {
  return request<{ floor: RetentionPlatformFloor }>('/retention/platform-floors', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// --- Platform Bans ---

export async function listPlatformBans(params?: { page?: number; limit?: number }) {
  const qs = new URLSearchParams()
  if (params?.page) qs.set('page', String(params.page))
  if (params?.limit) qs.set('limit', String(params.limit))
  const query = qs.toString()
  return request<{ bans: PlatformBan[]; total: number }>(`/bans/platform${query ? `?${query}` : ''}`)
}

export async function createPlatformBan(data: { phoneHash: string; reason: string }) {
  return request<{ ban: PlatformBan }>('/bans/platform', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function deletePlatformBan(id: string) {
  return request<{ ok: true }>(`/bans/platform/${id}`, { method: 'DELETE' })
}

export async function bulkImportPlatformBans(data: { phoneHashes: string[]; reason: string }) {
  return request<{ count: number }>('/bans/platform/bulk', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function searchPlatformBans(phoneHash: string) {
  return request<{ bans: (PlatformBan & { scope: 'hub' | 'platform' })[] }>(
    `/bans/platform/search?phoneHash=${encodeURIComponent(phoneHash)}`
  )
}

/** Promote a hub ban to platform scope. The number is re-entered: a hub's ban hash cannot be re-keyed without it. */
export async function promoteHubBan(banId: string, phone: string) {
  return request<{ ok: true }>('/bans/platform/promote', {
    method: 'POST',
    body: JSON.stringify({ banId, phone }),
  })
}

// --- Platform Settings ---

export async function getPlatformSettings() {
  return request<{ settings: PlatformSettings }>('/settings/platform')
}

export async function updatePlatformSettings(data: Partial<PlatformSettings>) {
  return request<{ settings: PlatformSettings }>('/settings/platform', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
