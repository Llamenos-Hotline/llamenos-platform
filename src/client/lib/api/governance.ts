import { DeletionConfirmed } from '@/lib/admin-deletion'
import { banDigestBlind, banDigestFinalize } from '@/lib/platform'
import { request, hp } from './client'
import {
  BAN_DIGEST_EVALUATE_BATCH_MAX,
  type BanLookup,
  type BanDigestEvaluateResponse,
  type SearchBansEvaluateResponse,
  type SearchBansResponse,
  type BulkBanResponse,
} from '@protocol/schemas/bans'
import type { OkResponse } from '@protocol/schemas/common'
import type {
  ErasureRequest,
  MyErasureRequestResponse,
  ErasureConfig,
  EnvelopeRevocationJob,
  RetentionSetting,
  RetentionPlatformFloor,
  PlatformBanListResponse,
  PlatformSettings,
} from '@protocol/schemas'

// --- EP08: Erasure, Retention, Bans, Platform Settings ---

// --- Erasure ---

export async function getMyErasureRequest() {
  return request<MyErasureRequestResponse>(hp('/erasure/me'))
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

export async function listEnvelopeRevocationJobs(params?: { userId?: string }) {
  const qs = new URLSearchParams()
  if (params?.userId) qs.set('userId', params.userId)
  const query = qs.toString()
  return request<{ jobs: EnvelopeRevocationJob[] }>(hp(`/erasure/envelope-revocation-jobs${query ? `?${query}` : ''}`))
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
  return request<PlatformBanListResponse>(`/admin/bans${query ? `?${query}` : ''}`)
}

// A platform ban never carries the number (#2759). The number is blinded in Rust, the server
// evaluates the blinded element under the platform's ban key without learning the number, and
// the result is finalized here into the number's ban digest — the value the server matches an
// inbound call against. See `packages/crypto/src/ban_digest.rs`.

/** The platform ban digests of typed E.164 numbers, in order. The numbers never leave the device. */
export async function platformBanDigests(phones: string[]): Promise<string[]> {
  const digests: string[] = []
  for (let i = 0; i < phones.length; i += BAN_DIGEST_EVALUATE_BATCH_MAX) {
    const chunk = phones.slice(i, i + BAN_DIGEST_EVALUATE_BATCH_MAX)
    const blinds = await Promise.all(chunk.map((phone) => banDigestBlind(phone)))
    const { evaluatedElements } = await request<BanDigestEvaluateResponse>('/admin/bans/evaluate', {
      method: 'POST',
      body: JSON.stringify({ blindedElements: blinds.map((b) => b.blindedElementHex) }),
    })
    if (evaluatedElements.length !== chunk.length) {
      throw new Error('Ban evaluation returned a different number of elements than were sent')
    }
    digests.push(
      ...(await Promise.all(chunk.map((phone, j) => banDigestFinalize(phone, blinds[j].blindHex, evaluatedElements[j])))),
    )
  }
  return digests
}

export type { BanLookup }

/** A typed number's ban digest under every scope (no `hubId` = the platform), for search and promote. */
export async function banLookups(phone: string): Promise<BanLookup[]> {
  const blind = await banDigestBlind(phone)
  const { evaluations } = await request<SearchBansEvaluateResponse>(
    '/admin/bans/search/evaluate',
    { method: 'POST', body: JSON.stringify({ blindedElement: blind.blindedElementHex }) },
  )
  return Promise.all(
    evaluations.map(async ({ hubId, evaluatedElement }) => {
      const phoneHash = await banDigestFinalize(phone, blind.blindHex, evaluatedElement)
      return hubId === undefined ? { phoneHash } : { hubId, phoneHash }
    }),
  )
}

/** What an admin enters for a platform ban. The number stays on the device; only its digest is sent. */
export interface PlatformBanEntry {
  phone: string
  reason: string
}

/** What an admin enters for a bulk platform-ban import. */
export interface PlatformBanBulkEntry {
  phones: string[]
  reason: string
}

export async function createPlatformBan(data: PlatformBanEntry) {
  const [phoneHash] = await platformBanDigests([data.phone])
  return request<OkResponse>('/admin/bans', {
    method: 'POST',
    body: JSON.stringify({ phoneHash, reason: data.reason }),
  })
}

/** Lift a platform ban. Requires the admin's confirmation of exactly this ban (#2575). */
export async function deletePlatformBan(id: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'platformBan', id)
  return request<{ ok: true }>(`/admin/bans/${id}`, { method: 'DELETE' })
}

/** Dismiss a platform ban that had to be re-entered, once its number is banned again (#2829). */
export async function dismissPlatformBanReentry(id: string) {
  return request<{ ok: true }>(`/admin/bans/reentries/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function bulkImportPlatformBans(data: PlatformBanBulkEntry) {
  const phoneHashes = await platformBanDigests(data.phones)
  return request<BulkBanResponse>('/admin/bans/bulk', {
    method: 'POST',
    body: JSON.stringify({ phoneHashes, reason: data.reason }),
  })
}

/** A search result: a ban on any hub (`hubId`) or on the platform (`hubId` null). */
export type BanSearchResult = SearchBansResponse['bans'][number]

/** Search every hub's and the platform's ban list for a typed number, by its per-scope digests. */
export async function searchPlatformBans(phone: string) {
  return request<SearchBansResponse>('/admin/bans/search', {
    method: 'POST',
    body: JSON.stringify({ lookups: await banLookups(phone) }),
  })
}

/**
 * Promote a hub ban to platform scope. The number is re-entered and digested under both the
 * source hub's key and the platform's: the server checks the hub digest against the stored ban,
 * so a mistyped number cannot ban someone else, and stores the platform digest.
 */
export async function promoteHubBan(banId: string, sourceHubId: string, phone: string) {
  const lookups = await banLookups(phone)
  const source = lookups.find((l) => l.hubId === sourceHubId)
  const platform = lookups.find((l) => l.hubId === undefined)
  if (!source || !platform) throw new Error('No ban key for the source hub or the platform')
  return request<OkResponse>('/admin/bans/promote', {
    method: 'POST',
    body: JSON.stringify({ banId, sourcePhoneHash: source.phoneHash, phoneHash: platform.phoneHash }),
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
