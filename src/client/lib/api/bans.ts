import { DeletionConfirmed } from '@/lib/admin-deletion'
import { request, hp, hubPath } from './client'
import type { BanEntry } from '@protocol/schemas'

export type { BanEntry }

// --- Ban List ---

export async function listBans() {
  return request<{ bans: BanEntry[] }>(hp('/bans'))
}

export async function addBan(data: { phone: string; reason: string }) {
  return request<{ ban: BanEntry }>(hp('/bans'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function banAndHangup(callId: string, hubId: string, reason?: string) {
  return request<{ banned: boolean; hungUp: boolean }>(
    hubPath(hubId, `/calls/${callId}/ban`),
    { method: 'POST', body: JSON.stringify({ reason }) },
  )
}

/** Lift a hub ban. Requires the admin's confirmation of exactly this ban (#2575). */
export async function removeBan(phoneHash: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'ban', phoneHash)
  return request<{ ok: true }>(hp(`/bans/${encodeURIComponent(phoneHash)}`), { method: 'DELETE' })
}

export async function bulkAddBans(data: { phones: string[]; reason: string }) {
  return request<{ count: number }>(hp('/bans/bulk'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
