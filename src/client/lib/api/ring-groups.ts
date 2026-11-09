import { DeletionConfirmed } from '@/lib/admin-deletion'
import { request, activeHubPath } from './client'

// --- Ring Groups ---

export async function listRingGroups() {
  return request<{ ringGroups: Array<{ id: string; hubId: string; encryptedName: string; memberCount: number; createdAt: string }> }>(activeHubPath('/ring-groups'))
}

export async function getRingGroup(id: string) {
  return request<{ id: string; hubId: string; encryptedName: string; members: Array<{ pubkey: string; addedBy: string; createdAt: string }>; createdAt: string }>(activeHubPath(`/ring-groups/${id}`))
}

export async function createRingGroup(data: { id: string; encryptedName: string }) {
  return request<{ id: string; hubId: string; encryptedName: string; members: Array<{ pubkey: string; addedBy: string; createdAt: string }>; createdAt: string }>(activeHubPath('/ring-groups'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateRingGroup(id: string, data: { encryptedName: string }) {
  return request<{ id: string; hubId: string; encryptedName: string; members: Array<{ pubkey: string; addedBy: string; createdAt: string }>; createdAt: string }>(activeHubPath(`/ring-groups/${id}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

/** Delete a ring group. Requires the admin's confirmation of exactly this group (#2575). */
export async function deleteRingGroup(id: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'ringGroup', id)
  return request<{ ok: true }>(activeHubPath(`/ring-groups/${id}`), { method: 'DELETE' })
}

export async function addRingGroupMembers(id: string, pubkeys: string[]) {
  return request<{ id: string; hubId: string; encryptedName: string; members: Array<{ pubkey: string; addedBy: string; createdAt: string }>; createdAt: string }>(activeHubPath(`/ring-groups/${id}/members`), {
    method: 'POST',
    body: JSON.stringify({ pubkeys }),
  })
}

export async function removeRingGroupMembers(id: string, pubkeys: string[]) {
  return request<{ id: string; hubId: string; encryptedName: string; members: Array<{ pubkey: string; addedBy: string; createdAt: string }>; createdAt: string }>(activeHubPath(`/ring-groups/${id}/members`), {
    method: 'DELETE',
    body: JSON.stringify({ pubkeys }),
  })
}
