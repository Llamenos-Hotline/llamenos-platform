import { DeletionConfirmed } from '@/lib/admin-deletion'
import { request, activeHubPath } from './client'
import type { CreateRingGroupBody, OkResponse, RingGroupDetailResponse, RingGroupListResponse, UpdateRingGroupBody } from '@protocol/schemas'

// --- Ring Groups ---

export async function listRingGroups() {
  return request<RingGroupListResponse>(activeHubPath('/ring-groups'))
}

export async function getRingGroup(id: string) {
  return request<RingGroupDetailResponse>(activeHubPath(`/ring-groups/${id}`))
}

export async function createRingGroup(data: CreateRingGroupBody) {
  return request<RingGroupDetailResponse>(activeHubPath('/ring-groups'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateRingGroup(id: string, data: UpdateRingGroupBody) {
  return request<RingGroupDetailResponse>(activeHubPath(`/ring-groups/${id}`), {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

/** Delete a ring group. Requires the admin's confirmation of exactly this group (#2575). */
export async function deleteRingGroup(id: string, confirmed: DeletionConfirmed) {
  DeletionConfirmed.require(confirmed, 'ringGroup', id)
  return request<OkResponse>(activeHubPath(`/ring-groups/${id}`), { method: 'DELETE' })
}

export async function addRingGroupMembers(id: string, pubkeys: string[]) {
  return request<RingGroupDetailResponse>(activeHubPath(`/ring-groups/${id}/members`), {
    method: 'POST',
    body: JSON.stringify({ pubkeys }),
  })
}

export async function removeRingGroupMembers(id: string, pubkeys: string[]) {
  return request<RingGroupDetailResponse>(activeHubPath(`/ring-groups/${id}/members`), {
    method: 'DELETE',
    body: JSON.stringify({ pubkeys }),
  })
}
