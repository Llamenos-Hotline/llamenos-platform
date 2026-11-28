import { DeletionConfirmed } from '@/lib/admin-deletion'
import { request, activeHubPath, hubPath } from './client'
import type { BanEntry, BanListResponse, BanCallResponse, BulkBanBody, BulkBanResponse, CreateBanBody, CreateBanResponse, OkResponse } from '@protocol/schemas'

export type { BanEntry }

// --- Ban List ---
//
// A hub's ban list exists only under its hub (#2463): with no active hub these throw
// NoActiveHubError instead of falling back to an unscoped path. The platform list is
// a different resource, `/admin/bans` (lib/api/governance.ts).

export async function listBans() {
  return request<BanListResponse>(activeHubPath('/bans'))
}

export async function addBan(data: CreateBanBody) {
  return request<CreateBanResponse>(activeHubPath('/bans'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function banAndHangup(callId: string, hubId: string, reason?: string) {
  return request<BanCallResponse>(
    hubPath(hubId, `/calls/${callId}/ban`),
    { method: 'POST', body: JSON.stringify({ reason }) },
  )
}

/** Lift a hub ban. Requires the admin's confirmation of exactly this ban (#2575). */
export async function removeBan(phoneHash: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'ban', phoneHash)
  return request<OkResponse>(activeHubPath(`/bans/${encodeURIComponent(phoneHash)}`), { method: 'DELETE' })
}

export async function bulkAddBans(data: BulkBanBody) {
  return request<BulkBanResponse>(activeHubPath('/bans/bulk'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/** Dismiss a ban that had to be re-entered, once its number is banned again (#2829). */
export async function dismissBanReentry(id: string) {
  return request<OkResponse>(activeHubPath(`/bans/reentries/${encodeURIComponent(id)}`), { method: 'DELETE' })
}
